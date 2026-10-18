package hub

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"time"
)

// Revisit selected folders once when embedded-message support is introduced.
const outlookReaderVersion = 1

type outlookImportStatus struct {
	Busy    bool   `json:"busy"`
	Pending bool   `json:"pending"`
	Message string `json:"message"`
	Checked string `json:"checked"`
	Added   int    `json:"added"`
	Updated int    `json:"updated"`
	Skipped int    `json:"skipped"`
	Rejected int   `json:"rejected"`
	Failed int     `json:"failed"`
	Limited int    `json:"limited"`
}
type outlookDocument struct {
	Mail         MailRef           `json:"mail"`
	FolderID     string            `json:"folder_id"`
	Conversation string            `json:"conversation"`
	Fingerprints []mailFingerprint `json:"fingerprints"`
	Body         string            `json:"body"`
	Attachments  []struct {
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
	Limited int                      `json:"limited"`
}

func (a *App) outlookImportView() outlookImportStatus {
	a.outlookStatusMu.Lock()
	defer a.outlookStatusMu.Unlock()
	return a.outlookImportStatus
}
func (a *App) outlookScheduler() {
	a.importOutlookReports()
	ticker := time.NewTicker(2 * time.Second)
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
	// Once per upgrade, revisit existing selected folders to index ordinary mail
	// metadata too. Dedicated cursors commit together with the encrypted index.
	a.localMu.Lock()
	rules, ruleErr := a.loadConnections()
	a.localMu.Unlock()
	if ruleErr != nil {
		e = ruleErr
		return
	}
	cursors := map[string]outlookCursor{}
	for key, cursor := range rules.Cursors {
		if cursor.ReaderVersion == outlookReaderVersion {
			cursors[key] = cursor
		}
	}
	var batch outlookBatch
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	e = run(ctx, outlookReq{Op: "reports", Sources: sources, Cursors: cursors, Limit: 100}, &batch)
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
	x, e := a.loadReports()
	if e != nil {
		return
	}
	rules, e = a.loadConnections()
	if e != nil {
		return
	}
	rulesChanged := false
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
		indexed := cleanIndexedMail(doc, mail)
		mailID := connectionMailID(mail)
		if old, exists := rules.Mails[mailID]; !exists || !reflect.DeepEqual(old, indexed) {
			rules.Mails[mailID] = indexed
			rulesChanged = true
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
				s.Rejected++
				continue
			}
			matched = true
			// For mail-derived reports even company tags come from the mail subject only.
			r.Companies = titleCompanies(mail.Subject, companies)
			r.Tags = []string{folder, "동향"}
			item := importedReport{Report: r, Hash: bodyHash(r.Body), Origin: "outlook-report", Imported: time.Now().In(kst).Format(time.RFC3339), Mail: &mail}
			switch mergeImported(&x, &item) {
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
	cursorsChanged := false
	for key, cursor := range batch.Cursors {
		if _, ok := allowed[key]; ok {
			cursor.ReaderVersion = outlookReaderVersion
			if old, exists := rules.Cursors[key]; !exists || !reflect.DeepEqual(old, cursor) {
				rules.Cursors[key] = cursor
				rulesChanged = true
			}
			if old, exists := x.Cursors[key]; !exists || !reflect.DeepEqual(old, cursor) {
				x.Cursors[key] = cursor
				cursorsChanged = true
			}
		}
	}
	if s.Added+s.Updated > 0 {
		if e = a.saveReports(x); e != nil {
			return
		}
	}
	if rulesChanged {
		if e = a.saveConnections(rules); e != nil {
			return
		}
	}
	// Reports are committed first: if cursor persistence fails, the next import
	// safely repeats the batch instead of skipping any unsaved reports.
	if cursorsChanged {
		if e = a.saveOutlookCursors(x.Cursors); e != nil {
			return
		}
	}
	s.Pending = batch.Pending
	s.Failed, s.Limited = batch.Failed, batch.Limited
	s.Message = fmt.Sprintf("Outlook 확인 완료 · 추가 %d건 · 변경 %d건 · 중복·제외 %d건", s.Added, s.Updated, s.Skipped)
	if s.Rejected > 0 {
		s.Message += fmt.Sprintf(" · MD 형식 확인 필요 %d건", s.Rejected)
	}
	if s.Limited > 0 {
		s.Message += fmt.Sprintf(" · 첨부 크기·개수 제한 %d건", s.Limited)
	}
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
