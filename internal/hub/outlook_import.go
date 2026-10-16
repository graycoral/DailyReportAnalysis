package hub

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type outlookImportStatus struct {
	Busy    bool   `json:"busy"`
	Pending bool   `json:"pending"`
	Message string `json:"message"`
	Checked string `json:"checked"`
	Added   int    `json:"added"`
	Updated int    `json:"updated"`
	Skipped int    `json:"skipped"`
}
type outlookDocument struct {
	Mail        MailRef `json:"mail"`
	FolderID    string  `json:"folder_id"`
	Body        string  `json:"body"`
	Attachments []struct {
		Name string `json:"name"`
		Body string `json:"body"`
	} `json:"attachments"`
}
type outlookBatch struct {
	Items   []outlookDocument        `json:"items"`
	Cursors map[string]outlookCursor `json:"cursors"`
	Pending bool                     `json:"pending"`
	Failed  int                      `json:"failed"`
	Scanned int                      `json:"scanned"`
}

func (a *App) outlookImportView() outlookImportStatus {
	a.outlookStatusMu.Lock()
	defer a.outlookStatusMu.Unlock()
	return a.outlookImportStatus
}
func (a *App) outlookScheduler() {
	a.importOutlookReports()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	last := time.Now()
	for now := range ticker.C {
		if s := a.outlookImportView(); s.Pending || now.Sub(last) >= 5*time.Minute {
			a.importOutlookReports()
			last = now
		}
	}
}
func (a *App) importOutlookReports() { a.importOutlookWith(runOutlook) }
func (a *App) importOutlookWith(run func(context.Context, outlookReq, any) error) {
	if !a.outlookImportMu.TryLock() {
		return
	}
	defer a.outlookImportMu.Unlock()
	index, e := a.viewLocal()
	if e != nil {
		return
	}
	sources := []OutlookSource{}
	for _, source := range index.Sources {
		if source.FolderID != "" {
			sources = append(sources, source)
		}
	}
	if len(sources) == 0 {
		a.outlookStatusMu.Lock()
		a.outlookImportStatus = outlookImportStatus{Message: "자동으로 가져올 Outlook 폴더를 선택하세요."}
		a.outlookStatusMu.Unlock()
		return
	}
	s := outlookImportStatus{Busy: true, Message: "지정한 Outlook 폴더 확인 중…"}
	a.outlookStatusMu.Lock()
	a.outlookImportStatus = s
	a.outlookStatusMu.Unlock()
	defer func() {
		s.Busy = false
		s.Checked = time.Now().In(kst).Format(time.RFC3339)
		if e != nil {
			s.Message = e.Error()
		}
		a.outlookStatusMu.Lock()
		a.outlookImportStatus = s
		a.outlookStatusMu.Unlock()
	}()
	x, e := a.viewReports()
	if e != nil {
		return
	}
	var batch outlookBatch
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	e = run(ctx, outlookReq{Op: "reports", Sources: sources, Cursors: x.Cursors, Limit: 100}, &batch)
	if e != nil {
		return
	}
	companies := a.knownCompanies()
	// Reload under the shared lock so a concurrent drop or source removal is preserved.
	a.localMu.Lock()
	defer a.localMu.Unlock()
	current, e := a.loadLocal()
	if e != nil {
		return
	}
	x, e = a.loadReports()
	if e != nil {
		return
	}
	allowed := map[string]OutlookSource{}
	for _, old := range sources {
		for _, now := range current.Sources {
			if sameSource(old, now) {
				allowed[now.FolderID] = now
			}
		}
	}
	for _, doc := range batch.Items {
		src, ok := allowed[doc.FolderID]
		if !ok || !strings.EqualFold(src.StoreID, doc.Mail.StoreID) {
			continue
		}
		mail, err := checkMail(doc.Mail, current.Sources)
		if err != nil {
			s.Skipped++
			continue
		}
		// Trust the actual selected folder name returned by Outlook, not content.
		folder := cleanText(mail.Folder, 120)
		if folder == "" {
			folder = src.FolderName
		}
		candidates := []struct {
			Name string
			Body string
		}{{"", doc.Body}}
		for _, at := range doc.Attachments {
			candidates = append(candidates, struct {
				Name string
				Body string
			}{at.Name, at.Body})
		}
		matched := false
		for _, candidate := range candidates {
			if candidate.Body == "" {
				continue
			}
			r, err := parseReport([]byte(candidate.Body), candidate.Name, companies)
			if errors.Is(err, errNoUpdates) {
				matched = true
				s.Skipped++
				continue
			}
			if err != nil {
				continue
			}
			matched = true
			// For mail-derived reports even company tags come from the mail subject only.
			r.Companies = titleCompanies(mail.Subject, companies)
			r.Tags = []string{folder, "동향"}
			item := importedReport{Report: r, Hash: bodyHash(r.Body), Origin: "outlook-report", Imported: time.Now().In(kst).Format(time.RFC3339), Mail: &mail}
			switch mergeImported(&x, item) {
			case "added":
				s.Added++
			case "updated":
				s.Updated++
			default:
				s.Skipped++
			}
		}
		if !matched {
			s.Skipped++
		}
	}
	for key, cursor := range batch.Cursors {
		if _, ok := allowed[key]; ok {
			x.Cursors[key] = cursor
		}
	}
	if e = a.saveReports(x); e != nil {
		return
	}
	s.Pending = batch.Pending
	s.Message = fmt.Sprintf("Outlook 확인 완료 · 추가 %d건 · 변경 %d건 · 중복·제외 %d건", s.Added, s.Updated, s.Skipped)
	if batch.Pending {
		s.Message += " · 남은 메일은 계속 가져옵니다."
	}
	if batch.Failed > 0 {
		s.Message += " · 일부 폴더·메일을 읽지 못했습니다. 다음 확인 때 다시 시도합니다."
	}
}
func (a *App) outlookImportRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/outlook/folders", func(w http.ResponseWriter, r *http.Request) {
		if !post(w, r) {
			return
		}
		var input struct {
			Source OutlookSource `json:"source"`
		}
		if e := decodeBody(r, &input); e != nil {
			http.Error(w, e.Error(), 400)
			return
		}
		if e := a.localBlocked(); e != nil {
			http.Error(w, e.Error(), 400)
			return
		}
		source, e := checkSource(input.Source)
		if e != nil {
			http.Error(w, e.Error(), 400)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
		defer cancel()
		var result struct {
			Folders []OutlookSource `json:"folders"`
		}
		if e = runOutlook(ctx, outlookReq{Op: "folders", Sources: []OutlookSource{source}}, &result); e != nil {
			http.Error(w, e.Error(), 502)
			return
		}
		if result.Folders == nil {
			result.Folders = []OutlookSource{}
		}
		writeResponse(w, result)
	})
	mux.HandleFunc("/api/outlook/import", func(w http.ResponseWriter, r *http.Request) {
		if !post(w, r) {
			return
		}
		if e := a.localBlocked(); e != nil {
			http.Error(w, e.Error(), 400)
			return
		}
		go a.importOutlookReports()
		writeResponse(w, map[string]any{"ok": true})
	})
}
