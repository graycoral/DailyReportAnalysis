package hub

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// 내 자료: PDFs the user drops in, plus links to Outlook mail. All of it stays on this PC:
// the index and PDF copies are DPAPI-encrypted for the current Windows user under <data-dir>/local,
// never enter catalog/snapshot/state or logs, and no sync, prune or GitHub code path reads that folder.
// Ordinary mail links keep metadata only; matching daily reports have a separate encrypted archive.
const localMax = 50 << 20

var localIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var mapiHex = regexp.MustCompile(`^[A-Fa-f0-9]+$`)

// Outlook EntryID/StoreID: hex, and PST StoreIDs embed the file path, so allow long ones.
func mapiID(s string) bool { return len(s) >= 2 && len(s) <= 4096 && mapiHex.MatchString(s) }

type LocalFile struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Size    int      `json:"size"`
	Added   string   `json:"added"`
	Reports []string `json:"reports"`
}
type MailRef struct {
	EntryID  string `json:"entry_id"`
	StoreID  string `json:"store_id"`
	Path     string `json:"path,omitempty"`
	Subject  string `json:"subject"`
	Sender   string `json:"sender"`
	Received string `json:"received"`
	Folder   string `json:"folder"`
}
type MailLink struct {
	MailRef
	Report string `json:"report"`
	Linked string `json:"linked"`
}
type OutlookSource struct {
	Name       string `json:"name"`
	Path       string `json:"path,omitempty"`
	StoreID    string `json:"store_id,omitempty"`
	FolderID   string `json:"folder_id,omitempty"`
	FolderName string `json:"folder_name,omitempty"`
}
type LocalIndex struct {
	Files   []LocalFile     `json:"files"`
	Mails   []MailLink      `json:"mails"`
	Sources []OutlookSource `json:"sources"`
}

func (a *App) localDir() string          { return filepath.Join(a.dir, "local") }
func (a *App) pdfDir() string            { return filepath.Join(a.dir, "docs", "pdf") }
func (a *App) blobPath(id string) string { return filepath.Join(a.pdfDir(), id+".bin") }

// Local data must not sit inside a git work tree, where it could be committed and pushed by mistake.
func (a *App) localBlocked() error {
	if a.setup {
		return errors.New("설정 프로그램에서는 내 자료를 쓸 수 없습니다.")
	}
	d, e := filepath.Abs(a.dir)
	if e != nil {
		return e
	}
	for {
		if _, e := os.Stat(filepath.Join(d, ".git")); e == nil {
			return errors.New("저장 폴더가 Git 저장소 안에 있어 내 자료를 보관하지 않습니다: " + d)
		}
		p := filepath.Dir(d)
		if p == d {
			return nil
		}
		d = p
	}
}

// Caller holds localMu. An index that cannot be decrypted (other user/PC) is an error, never overwritten.
func (a *App) loadLocal() (LocalIndex, error) {
	x := LocalIndex{}
	b, e := os.ReadFile(filepath.Join(a.localDir(), "index.bin"))
	if e == nil {
		var p []byte
		if p, e = unprotect(b); e != nil {
			log.Printf("local index: %v", e)
			return x, errors.New("내 자료 목록을 열 수 없습니다. 자료를 추가한 Windows 계정으로 실행하세요.")
		}
		if e = json.Unmarshal(p, &x); e != nil {
			return x, errors.New("내 자료 목록이 손상되었습니다.")
		}
	} else if !os.IsNotExist(e) {
		return x, e
	}
	if x.Files == nil {
		x.Files = []LocalFile{}
	}
	for i := range x.Files {
		// PDFs added before docs/pdf existed lived next to the index; move them once.
		if id := x.Files[i].ID; localIDPattern.MatchString(id) {
			p, old := a.blobPath(id), filepath.Join(a.localDir(), id+".bin")
			if _, e := os.Stat(p); os.IsNotExist(e) {
				if _, e = os.Stat(old); e == nil {
					if e = os.MkdirAll(a.pdfDir(), 0700); e == nil {
						e = os.Rename(old, p)
					}
					if e != nil {
						log.Printf("local pdf move %s: %v", id, e)
					}
				}
			}
		}
		if x.Files[i].Reports == nil {
			x.Files[i].Reports = []string{}
		}
	}
	if x.Mails == nil {
		x.Mails = []MailLink{}
	}
	if x.Sources == nil {
		x.Sources = []OutlookSource{}
	}
	return x, nil
}
func (a *App) saveLocal(x LocalIndex) error {
	b, e := json.Marshal(x)
	if e != nil {
		return e
	}
	c, e := protect(b)
	if e != nil {
		return e
	}
	return writeAtomic(filepath.Join(a.localDir(), "index.bin"), c)
}
func (a *App) viewLocal() (LocalIndex, error) {
	a.localMu.Lock()
	defer a.localMu.Unlock()
	if e := a.localBlocked(); e != nil {
		return LocalIndex{}, e
	}
	return a.loadLocal()
}

// editLocal applies f to the index under localMu and saves it only when f succeeds.
func (a *App) editLocal(f func(*LocalIndex) error) error {
	a.localMu.Lock()
	defer a.localMu.Unlock()
	if e := a.localBlocked(); e != nil {
		return e
	}
	x, e := a.loadLocal()
	if e != nil {
		return e
	}
	if e = f(&x); e != nil {
		return e
	}
	return a.saveLocal(x)
}
func cleanText(s string, max int) string {
	s = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > max {
		s = string(r[:max])
	}
	return s
}
func cleanName(s string) string {
	if i := strings.LastIndexAny(s, `/\`); i >= 0 {
		s = s[i+1:]
	}
	s = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`<>:"|?*`, r) {
			return -1
		}
		return r
	}, s)
	if s = cleanText(s, 1000); s == "" || !utf8.ValidString(s) {
		s = "문서.pdf"
	}
	if !strings.EqualFold(filepath.Ext(s), ".pdf") {
		s += ".pdf"
	}
	if r := []rune(s); len(r) > 120 {
		s = string(r[len(r)-120:])
	}
	return s
}
func (a *App) hasReport(id string) bool {
	a.mu.RLock()
	for _, r := range a.snapshot.Catalog.Reports {
		if r.ID == id {
			a.mu.RUnlock()
			return true
		}
	}
	a.mu.RUnlock()
	x, e := a.viewReports()
	if e == nil {
		for _, r := range x.Reports {
			if r.ID == id {
				return true
			}
		}
	}
	return false
}
func (a *App) addPDF(name string, b []byte) (LocalFile, error) {
	head := b
	if len(head) > 1024 {
		head = head[:1024]
	}
	if !bytes.Contains(head, []byte("%PDF-")) {
		return LocalFile{}, errors.New("PDF 파일만 추가할 수 있습니다.")
	}
	k := make([]byte, 16)
	if _, e := rand.Read(k); e != nil {
		return LocalFile{}, e
	}
	f := LocalFile{ID: hex.EncodeToString(k), Name: cleanName(name), Size: len(b), Added: time.Now().In(kst).Format(time.RFC3339), Reports: []string{}}
	e := a.editLocal(func(x *LocalIndex) error {
		c, e := protect(b)
		if e != nil {
			return e
		}
		if e = writeAtomic(a.blobPath(f.ID), c); e != nil {
			return e
		}
		x.Files = append(x.Files, f)
		return nil
	})
	if e != nil {
		os.Remove(a.blobPath(f.ID))
	}
	return f, e
}
func (a *App) readPDF(id string) ([]byte, LocalFile, error) {
	missing := errors.New("내 자료를 찾을 수 없습니다.")
	if !localIDPattern.MatchString(id) {
		return nil, LocalFile{}, missing
	}
	x, e := a.viewLocal()
	if e != nil {
		return nil, LocalFile{}, e
	}
	for _, f := range x.Files {
		if f.ID == id {
			c, e := os.ReadFile(a.blobPath(id))
			if e != nil {
				return nil, f, missing
			}
			b, e := unprotect(c)
			if e != nil {
				return nil, f, errors.New("이 PDF는 추가한 Windows 계정에서만 열 수 있습니다.")
			}
			return b, f, nil
		}
	}
	return nil, LocalFile{}, missing
}
func (a *App) deletePDF(id string) error {
	e := a.editLocal(func(x *LocalIndex) error {
		for i, f := range x.Files {
			if f.ID == id {
				x.Files = append(x.Files[:i], x.Files[i+1:]...)
				return nil
			}
		}
		return errors.New("내 자료를 찾을 수 없습니다.")
	})
	if e == nil {
		e = os.Remove(a.blobPath(id))
		if os.IsNotExist(e) {
			e = nil
		}
	}
	return e
}
func (a *App) linkPDF(id, report string, on bool) error {
	if on && !a.hasReport(report) {
		return errors.New("리포트를 찾을 수 없습니다.")
	}
	return a.editLocal(func(x *LocalIndex) error {
		for i := range x.Files {
			f := &x.Files[i]
			if f.ID != id {
				continue
			}
			rs := []string{}
			for _, r := range f.Reports {
				if r != report {
					rs = append(rs, r)
				}
			}
			if on {
				rs = append(rs, report)
			}
			f.Reports = rs
			return nil
		}
		return errors.New("내 자료를 찾을 수 없습니다.")
	})
}

// A PST/OST is identified by its path, a profile mailbox by its StoreID; either must look like one.
func checkSource(s OutlookSource) (OutlookSource, error) {
	s.Name = cleanText(s.Name, 120)
	s.FolderName = cleanText(s.FolderName, 120)
	if s.FolderID != "" && (!mapiID(s.FolderID) || s.StoreID == "" || s.FolderName == "") {
		return s, errors.New("Outlook에서 가져올 폴더를 다시 선택하세요.")
	}
	if s.StoreID != "" {
		if !mapiID(s.StoreID) {
			return s, errors.New("Outlook 메일함 정보가 잘못되었습니다.")
		}
	} else {
		ext := strings.ToLower(filepath.Ext(s.Path))
		if !filepath.IsAbs(s.Path) || (ext != ".pst" && ext != ".ost") || strings.ContainsAny(s.Path, "\r\n\"") {
			return s, errors.New("PST 또는 OST 파일의 전체 경로를 입력하세요.")
		}
		if st, e := os.Stat(s.Path); e != nil || st.IsDir() {
			return s, errors.New("파일을 찾을 수 없습니다: " + s.Path)
		}
		if s.Name == "" {
			s.Name = filepath.Base(s.Path)
		}
	}
	if s.Name == "" {
		s.Name = "Outlook 메일함"
	}
	return s, nil
}
func sameSource(a, b OutlookSource) bool {
	if !strings.EqualFold(a.FolderID, b.FolderID) {
		return false
	}
	return (a.StoreID != "" && strings.EqualFold(a.StoreID, b.StoreID)) || (a.Path != "" && strings.EqualFold(a.Path, b.Path))
}

// Mail references come back from the browser, so re-check them and only allow PST paths the user configured.
func checkMail(m MailRef, sources []OutlookSource) (MailRef, error) {
	if !mapiID(m.EntryID) || !mapiID(m.StoreID) {
		return m, errors.New("메일 정보가 잘못되었습니다.")
	}
	if m.Path != "" {
		ok := false
		for _, s := range sources {
			ok = ok || strings.EqualFold(s.Path, m.Path)
		}
		if !ok {
			return m, errors.New("지정되지 않은 Outlook 파일입니다.")
		}
	}
	m.Subject, m.Sender, m.Folder, m.Received = cleanText(m.Subject, 300), cleanText(m.Sender, 120), cleanText(m.Folder, 300), cleanText(m.Received, 25)
	return m, nil
}
func searchTerms(ts []string) ([]string, error) {
	out := []string{}
	for _, t := range ts {
		if t = cleanText(t, 80); t != "" {
			out = append(out, t)
		}
	}
	if len(out) == 0 || len(out) > 12 {
		return nil, errors.New("검색어는 1~12개로 입력하세요.")
	}
	return out, nil
}
func decodeBody(r *http.Request, v any) error {
	if e := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 65536)).Decode(v); e != nil {
		return errors.New("요청을 읽을 수 없습니다.")
	}
	return nil
}
func localFail(w http.ResponseWriter, op string, e error) {
	log.Printf("%s: %v", op, e)
	http.Error(w, e.Error(), 400)
}
func (a *App) localRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/local", func(w http.ResponseWriter, r *http.Request) {
		x, e := a.viewLocal()
		if e != nil {
			writeResponse(w, map[string]any{"available": false, "reason": e.Error()})
			return
		}
		writeResponse(w, map[string]any{"available": true, "files": x.Files, "mails": x.Mails, "sources": x.Sources})
	})
	mux.HandleFunc("/api/local/add", func(w http.ResponseWriter, r *http.Request) {
		if !post(w, r) {
			return
		}
		b, e := io.ReadAll(http.MaxBytesReader(w, r.Body, localMax))
		if e != nil {
			http.Error(w, "파일은 50MB 이하만 추가할 수 있습니다.", 413)
			return
		}
		f, e := a.addPDF(r.URL.Query().Get("name"), b)
		if e != nil {
			localFail(w, "local add", e)
			return
		}
		log.Printf("local add %s (%d bytes)", f.ID, f.Size)
		writeResponse(w, f)
	})
	mux.HandleFunc("/api/local/file", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		b, f, e := a.readPDF(r.URL.Query().Get("id"))
		if e != nil {
			http.Error(w, e.Error(), 404)
			return
		}
		disp := "attachment"
		if r.URL.Query().Get("view") == "1" {
			disp = "inline"
			// Only the authenticated PDF response may be framed by our own UI.
			// All other responses retain frame-ancestors 'none'.
			w.Header().Set("Content-Security-Policy", strings.Replace(w.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'", "frame-ancestors 'self'", 1))
		}
		if h := mime.FormatMediaType(disp, map[string]string{"filename": f.Name}); h != "" {
			disp = h
		}
		w.Header().Set("Content-Disposition", disp)
		w.Header().Set("Content-Type", "application/pdf")
		// Native PDF viewers use HEAD and byte ranges while navigating large files.
		// Decrypted bytes stay in memory; no plaintext preview/cache file is written.
		http.ServeContent(w, r, f.Name, time.Time{}, bytes.NewReader(b))
	})
	mux.HandleFunc("/api/local/delete", func(w http.ResponseWriter, r *http.Request) {
		var v struct {
			ID string `json:"id"`
		}
		if !post(w, r) {
			return
		}
		if e := decodeBody(r, &v); e != nil {
			http.Error(w, e.Error(), 400)
			return
		}
		if e := a.deletePDF(v.ID); e != nil {
			localFail(w, "local delete", e)
			return
		}
		log.Printf("local delete %s", v.ID)
		writeResponse(w, map[string]any{"ok": true})
	})
	mux.HandleFunc("/api/local/link", func(w http.ResponseWriter, r *http.Request) {
		var v struct {
			ID     string `json:"id"`
			Report string `json:"report"`
			Remove bool   `json:"remove"`
		}
		if !post(w, r) {
			return
		}
		if e := decodeBody(r, &v); e != nil {
			http.Error(w, e.Error(), 400)
			return
		}
		if e := a.linkPDF(v.ID, v.Report, !v.Remove); e != nil {
			localFail(w, "local link", e)
			return
		}
		writeResponse(w, map[string]any{"ok": true})
	})
	mux.HandleFunc("/api/outlook/stores", func(w http.ResponseWriter, r *http.Request) {
		var v struct {
			Stores []OutlookSource `json:"stores"`
		}
		if !post(w, r) {
			return
		}
		if e := a.localBlocked(); e != nil {
			http.Error(w, e.Error(), 400)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
		defer cancel()
		if e := runOutlook(ctx, outlookReq{Op: "stores"}, &v); e != nil {
			http.Error(w, e.Error(), 502)
			return
		}
		writeResponse(w, v)
	})
	mux.HandleFunc("/api/outlook/pick", a.outlookPickerHandler(pickOutlookFile))
	mux.HandleFunc("/api/outlook/source", func(w http.ResponseWriter, r *http.Request) {
		var v struct {
			Source OutlookSource `json:"source"`
			Remove bool          `json:"remove"`
		}
		if !post(w, r) {
			return
		}
		if e := decodeBody(r, &v); e != nil {
			http.Error(w, e.Error(), 400)
			return
		}
		e := a.editLocal(func(x *LocalIndex) error {
			kept := []OutlookSource{}
			for _, s := range x.Sources {
				if !sameSource(s, v.Source) {
					kept = append(kept, s)
				}
			}
			if !v.Remove {
				s, e := checkSource(v.Source)
				if e != nil {
					return e
				}
				kept = append(kept, s)
			}
			x.Sources = kept
			return nil
		})
		if e != nil {
			localFail(w, "outlook source", e)
			return
		}
		if !v.Remove && v.Source.FolderID != "" {
			go a.importOutlookReports()
		}
		writeResponse(w, map[string]any{"ok": true})
	})
	mux.HandleFunc("/api/outlook/search", func(w http.ResponseWriter, r *http.Request) {
		var v struct {
			Terms    []string `json:"terms"`
			All      bool     `json:"all"`
			From, To string
		}
		if !post(w, r) {
			return
		}
		if e := decodeBody(r, &v); e != nil {
			http.Error(w, e.Error(), 400)
			return
		}
		terms, e := searchTerms(v.Terms)
		if e != nil || (v.From != "" && !datePattern.MatchString(v.From)) || (v.To != "" && !datePattern.MatchString(v.To)) {
			http.Error(w, "검색 조건을 확인하세요.", 400)
			return
		}
		x, e := a.viewLocal()
		if e == nil && len(x.Sources) == 0 {
			e = errors.New("내 자료 탭에서 검색할 Outlook 메일함이나 PST를 먼저 지정하세요.")
		}
		if e != nil {
			http.Error(w, e.Error(), 400)
			return
		}
		var out struct {
			Mails []MailRef `json:"mails"`
		}
		// Stay under the server's 120s WriteTimeout.
		ctx, cancel := context.WithTimeout(r.Context(), 100*time.Second)
		defer cancel()
		if e = runOutlook(ctx, outlookReq{Op: "search", Sources: x.Sources, Terms: terms, All: v.All, From: v.From, To: v.To, Limit: 30}, &out); e != nil {
			http.Error(w, e.Error(), 502)
			return
		}
		if out.Mails == nil {
			out.Mails = []MailRef{}
		}
		log.Printf("outlook search: %d terms, %d results", len(terms), len(out.Mails))
		writeResponse(w, out)
	})
	mux.HandleFunc("/api/outlook/link", func(w http.ResponseWriter, r *http.Request) {
		var v struct {
			Report string  `json:"report"`
			Mail   MailRef `json:"mail"`
			Remove bool    `json:"remove"`
		}
		if !post(w, r) {
			return
		}
		if e := decodeBody(r, &v); e != nil {
			http.Error(w, e.Error(), 400)
			return
		}
		if !v.Remove && !a.hasReport(v.Report) {
			http.Error(w, "리포트를 찾을 수 없습니다.", 400)
			return
		}
		e := a.editLocal(func(x *LocalIndex) error {
			kept := []MailLink{}
			for _, m := range x.Mails {
				if m.Report != v.Report || !strings.EqualFold(m.EntryID, v.Mail.EntryID) {
					kept = append(kept, m)
				}
			}
			if !v.Remove {
				m, e := checkMail(v.Mail, x.Sources)
				if e != nil {
					return e
				}
				kept = append(kept, MailLink{MailRef: m, Report: v.Report, Linked: time.Now().In(kst).Format(time.RFC3339)})
			}
			x.Mails = kept
			return nil
		})
		if e != nil {
			localFail(w, "outlook link", e)
			return
		}
		writeResponse(w, map[string]any{"ok": true})
	})
	mux.HandleFunc("/api/outlook/open", func(w http.ResponseWriter, r *http.Request) {
		var v struct {
			Mail MailRef `json:"mail"`
		}
		if !post(w, r) {
			return
		}
		if e := decodeBody(r, &v); e != nil {
			http.Error(w, e.Error(), 400)
			return
		}
		x, e := a.viewLocal()
		if e == nil {
			v.Mail, e = checkMail(v.Mail, x.Sources)
		}
		if e != nil {
			http.Error(w, e.Error(), 400)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
		defer cancel()
		if e = runOutlook(ctx, outlookReq{Op: "open", Mail: &v.Mail}, nil); e != nil {
			http.Error(w, e.Error(), 502)
			return
		}
		writeResponse(w, map[string]any{"ok": true})
	})
}
