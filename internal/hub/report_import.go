package hub

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const reportMax = 2 << 20

var errNoUpdates = errors.New("‘주요 신규 업데이트 없음’ 리포트는 목록에 추가하지 않습니다.")
var reportDate = regexp.MustCompile(`\b\d{4}-\d{2}-\d{2}\b`)
var reportHeading = regexp.MustCompile(`^#{1,2}\s+(.+?)\s*$`)
var refDefinition = regexp.MustCompile(`(?m)^\[R(\d+)\]:\s*(https://\S+)\s*$`)
var refUse = regexp.MustCompile(`\[R(\d+)(?:[–—-]R?(\d+))?\]`)

// This is a structural importer, not an analysis or fact-checking step. Tags use
// only explicit titles and the selected Outlook folder; never infer from a body.
func parseReport(b []byte, name string, companies []string) (Report, error) {
	r := Report{Companies: []string{}, Tags: []string{"동향"}, Sources: []Source{}, Attachments: []Attachment{}}
	if len(b) > reportMax || !utf8.Valid(b) || strings.ContainsRune(string(b), 0) {
		return r, errors.New("MD는 UTF-8 텍스트이며 2MB 이하여야 합니다.")
	}
	body := strings.TrimSpace(strings.TrimPrefix(strings.ReplaceAll(string(b), "\r\n", "\n"), "\ufeff"))
	lines := strings.Split(body, "\n")
	if len(lines) < 4 || lines[0] != "---" {
		return r, errors.New("REPORT_FORMAT.md의 머리말(---, title, info)이 필요합니다.")
	}
	fm := map[string]string{}
	end := -1
	for i := 1; i < len(lines); i++ {
		if lines[i] == "---" {
			end = i
			break
		}
		if strings.HasPrefix(lines[i], " ") || strings.HasPrefix(lines[i], "\t") {
			continue
		}
		key, value, ok := strings.Cut(lines[i], ":")
		if ok {
			fm[strings.TrimSpace(key)] = strings.Trim(strings.TrimSpace(value), `"'`)
		}
	}
	if end < 0 || fm["title"] == "" || fm["info"] == "" {
		return r, errors.New("머리말의 title·info와 닫는 ---를 확인하세요.")
	}
	r.Title = fm["info"]
	if strings.Join(strings.Fields(r.Title), "") == "주요신규업데이트없음" {
		return r, errNoUpdates
	}
	if reportDate.MatchString(r.Title) {
		return r, errors.New("info에는 날짜 대신 핵심 주제를 적으세요.")
	}
	r.Date = reportDate.FindString(fm["title"])
	if _, e := time.Parse("2006-01-02", r.Date); e != nil {
		return r, errors.New("title에 유효한 보고일 YYYY-MM-DD가 필요합니다.")
	}
	if date := reportDate.FindString(filepath.Base(name)); date != "" && date != r.Date {
		return r, errors.New("파일명 날짜와 title의 보고일이 다릅니다.")
	}
	required := []string{"Executive Summary", "주요 신규 업데이트", "기업/지역별 상세 내용", "지정 6개사 L4 점검", "May Mobility 심층 점검", "규제·안전", "기술·공급망", "Reference"}
	next, fenced, summaryDate := 0, false, false
	for _, line := range lines[end+1:] {
		if strings.HasPrefix(strings.TrimSpace(line), "```") || strings.HasPrefix(strings.TrimSpace(line), "~~~") {
			fenced = !fenced
			continue
		}
		if fenced {
			continue
		}
		if next == 1 && strings.HasPrefix(strings.TrimSpace(line), "## "+r.Date+" ") {
			summaryDate = true
		}
		m := reportHeading.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		// The reference report named in REPORT_FORMAT.md splits May Mobility
		// over two slides and combines regulation/supply-chain on one slide.
		name := m[1]
		if name == "May Mobility 심층 조사" {
			name = "May Mobility 심층 점검"
		}
		if next == 5 && name == "May Mobility 심층 점검" {
			continue
		}
		if name == "규제·안전 및 기술/공급망" {
			if next != 5 {
				return r, errors.New("필수 섹션의 순서를 REPORT_FORMAT.md와 맞춰 주세요.")
			}
			next = 7
			continue
		}
		if strings.HasPrefix(name, "Reference ·") && next == 8 {
			continue
		}
		for i, heading := range required {
			if name == heading {
				if i != next {
					return r, errors.New("필수 섹션의 순서를 REPORT_FORMAT.md와 맞춰 주세요.")
				}
				next++
			}
		}
	}
	if next != len(required) {
		return r, fmt.Errorf("필수 섹션이 없습니다: %s", required[next])
	}
	if !summaryDate {
		return r, errors.New("Executive Summary 아래에 title과 같은 보고일(## YYYY-MM-DD · 주제)이 필요합니다.")
	}
	defs := map[int]string{}
	for _, m := range refDefinition.FindAllStringSubmatch(body, -1) {
		n, _ := strconv.Atoi(m[1])
		u, e := url.Parse(m[2])
		if e != nil || u.Host == "" || u.User != nil {
			return r, errors.New("Reference URL을 확인하세요.")
		}
		if old, exists := defs[n]; exists && old != m[2] {
			return r, errors.New("같은 출처 번호에 서로 다른 URL이 있습니다.")
		}
		defs[n] = m[2]
	}
	if len(defs) == 0 {
		return r, errors.New("Reference에 [R1]: https://... 형식의 출처가 필요합니다.")
	}
	for _, m := range refUse.FindAllStringSubmatch(body, -1) {
		lo, _ := strconv.Atoi(m[1])
		hi := lo
		if m[2] != "" {
			hi, _ = strconv.Atoi(m[2])
		}
		if hi < lo || hi-lo > 1000 {
			return r, errors.New("출처 번호 범위를 확인하세요.")
		}
		for n := lo; n <= hi; n++ {
			if defs[n] == "" {
				return r, fmt.Errorf("Reference에 [R%d]의 HTTPS 주소가 없습니다.", n)
			}
		}
	}
	keys := make([]int, 0, len(defs))
	for k := range defs {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	for _, k := range keys {
		r.Sources = append(r.Sources, Source{Title: fmt.Sprintf("R%d", k), URL: defs[k]})
	}
	r.Companies = titleCompanies(r.Title, companies)
	bullets := []string{}
	for _, line := range lines[end+1:] {
		if strings.HasPrefix(line, "- ") && !strings.Contains(line, "http") {
			bullets = append(bullets, strings.ReplaceAll(strings.TrimPrefix(line, "- "), "**", ""))
		}
		if len(bullets) == 2 {
			break
		}
	}
	r.Summary = cleanText(strings.Join(bullets, " "), 420)
	r.ID, r.Body = "local-"+r.Date, body+"\n"
	return r, nil
}

func titleCompanies(title string, companies []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, c := range companies {
		if !seen[c] && strings.Contains(strings.ToLower(title), strings.ToLower(c)) {
			out = append(out, c)
			seen[c] = true
		}
	}
	sort.Strings(out)
	return out
}
func (a *App) knownCompanies() []string {
	a.mu.RLock()
	defer a.mu.RUnlock()
	out := []string{}
	for _, r := range a.githubSnapshot().Catalog.Reports {
		out = append(out, r.Companies...)
	}
	return out
}

type importedReport struct {
	Report
	Hash     string   `json:"hash"`
	Origin   string   `json:"origin"`
	Imported string   `json:"imported"`
	Mail     *MailRef `json:"mail,omitempty"`
}
type outlookCursor struct {
	Time string   `json:"time"`
	IDs  []string `json:"ids"`
	ReaderVersion int `json:"reader_version,omitempty"`
}
type reportArchive struct {
	Reports []importedReport         `json:"reports"`
	Cursors map[string]outlookCursor `json:"cursors"`
}

func (a *App) reportPath() string { return filepath.Join(a.localDir(), "reports.bin") }
func (a *App) cursorPath() string { return filepath.Join(a.localDir(), "outlook-cursors.bin") }

// Cursor-only updates must not rewrite the report bodies or change their UI revision.
func (a *App) loadOutlookCursors() (map[string]outlookCursor, error) {
	b, err := os.ReadFile(a.cursorPath())
	if err != nil {
		return nil, err
	}
	b, err = unprotect(b)
	if err != nil {
		return nil, err
	}
	cursors := map[string]outlookCursor{}
	err = json.Unmarshal(b, &cursors)
	return cursors, err
}
func (a *App) viewOutlookCursors() (map[string]outlookCursor, error) {
	a.localMu.Lock()
	defer a.localMu.Unlock()
	if err := a.localBlocked(); err != nil {
		return nil, err
	}
	cursors, err := a.loadOutlookCursors()
	if os.IsNotExist(err) {
		// Older versions stored cursors in the report archive.
		x, legacyErr := a.loadReports()
		return x.Cursors, legacyErr
	}
	return cursors, err
}
func (a *App) saveOutlookCursors(cursors map[string]outlookCursor) error {
	b, err := json.Marshal(cursors)
	if err == nil {
		b, err = protect(b)
	}
	if err != nil {
		return err
	}
	return writeAtomic(a.cursorPath(), b)
}
func (a *App) localReportRevision() string {
	s, e := os.Stat(a.reportPath())
	if e != nil {
		return ""
	}
	return fmt.Sprintf("%d-%d", s.ModTime().UnixNano(), s.Size())
}

// Caller holds localMu. Never overwrite an unreadable archive.
func (a *App) loadReports() (reportArchive, error) {
	x := reportArchive{Reports: []importedReport{}, Cursors: map[string]outlookCursor{}}
	b, e := os.ReadFile(a.reportPath())
	if os.IsNotExist(e) {
		b = nil
	} else if e != nil {
		return x, e
	}
	if b != nil {
		b, e = unprotect(b)
		if e != nil {
			return x, errors.New("가져온 자료를 열 수 없습니다. 저장한 Windows 계정으로 실행하세요.")
		}
		if e = json.Unmarshal(b, &x); e != nil {
			return x, errors.New("가져온 자료 목록이 손상되어 변경하지 않았습니다.")
		}
	}
	if cursors, err := a.loadOutlookCursors(); err == nil {
		x.Cursors = cursors
	} else if !os.IsNotExist(err) {
		return x, errors.New("Outlook 확인 기록을 읽지 못해 자료를 변경하지 않았습니다.")
	}
	if x.Reports == nil {
		x.Reports = []importedReport{}
	}
	if x.Cursors == nil {
		x.Cursors = map[string]outlookCursor{}
	}
	return x, nil
}
func (a *App) saveReports(x reportArchive) error {
	b, e := json.Marshal(x)
	if e != nil {
		return e
	}
	b, e = protect(b)
	if e != nil {
		return e
	}
	return writeAtomic(a.reportPath(), b)
}
func (a *App) viewReports() (reportArchive, error) {
	a.localMu.Lock()
	defer a.localMu.Unlock()
	if e := a.localBlocked(); e != nil {
		return reportArchive{}, e
	}
	return a.loadReports()
}
func bodyHash(s string) string {
	h := sha256.Sum256([]byte(strings.TrimSpace(strings.ReplaceAll(s, "\r\n", "\n"))))
	return hex.EncodeToString(h[:])
}
func mergeImported(x *reportArchive, r *importedReport) string {
	for i, old := range x.Reports {
		if old.Date != r.Date || old.Origin != r.Origin {
			continue
		}
		// Keep legacy IDs so saved PDF/mail links and hidden preferences still work.
		r.ID = old.ID
		if old.Hash == r.Hash && strings.Join(old.Tags, "\n") == strings.Join(r.Tags, "\n") {
			return "unchanged"
		}
		// Within the Outlook collection, retain the latest received edition.
		if r.Origin != "markdown" && old.Mail != nil && r.Mail != nil && old.Mail.Received > r.Mail.Received {
			return "kept"
		}
		x.Reports[i] = *r
		return "updated"
	}
	assignImportedID(r, func(id string) bool {
		for _, old := range x.Reports {
			if old.ID == id {
				return true
			}
		}
		return false
	})
	x.Reports = append(x.Reports, *r)
	return "added"
}

func assignImportedID(r *importedReport, used func(string) bool) {
	// Old Outlook records may already own local-DATE; never reuse a saved link's ID.
	r.ID = "local-" + r.Date
	if r.Origin == "outlook-report" {
		r.ID = "outlook-" + r.Date
	}
	if used(r.ID) {
		r.ID = r.Origin + "-" + r.Date
		base := r.ID
		for n := 2; used(r.ID); n++ {
			r.ID = fmt.Sprintf("%s-%d", base, n)
		}
	}
}
func (a *App) importMarkdown(name string, b []byte) (importedReport, string, error) {
	if !strings.EqualFold(filepath.Ext(name), ".md") {
		return importedReport{}, "", errors.New(".md 파일을 선택하세요.")
	}
	r, e := parseReport(b, name, a.knownCompanies())
	if e != nil {
		return importedReport{}, "", e
	}
	item := importedReport{Report: r, Hash: bodyHash(r.Body), Origin: "markdown", Imported: time.Now().In(kst).Format(time.RFC3339)}
	a.localMu.Lock()
	defer a.localMu.Unlock()
	if e = a.localBlocked(); e != nil {
		return item, "", e
	}
	x, e := a.loadReports()
	if e != nil {
		return item, "", e
	}
	status := mergeImported(&x, &item)
	if status == "added" || status == "updated" {
		e = a.saveReports(x)
	}
	return item, status, e
}
func (a *App) reportImportRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/local/reports/import-batch", a.importMarkdownBatchHandler)
	mux.HandleFunc("/api/local/reports", func(w http.ResponseWriter, r *http.Request) {
		x, e := a.viewReports()
		if e != nil {
			http.Error(w, e.Error(), 400)
			return
		}
		writeResponse(w, map[string]any{"reports": x.Reports, "revision": a.localReportRevision()})
	})
	mux.HandleFunc("/api/local/reports/import", func(w http.ResponseWriter, r *http.Request) {
		if !post(w, r) {
			return
		}
		b, e := io.ReadAll(http.MaxBytesReader(w, r.Body, reportMax))
		if e != nil {
			http.Error(w, "MD 파일은 2MB 이하여야 합니다.", 413)
			return
		}
		item, status, e := a.importMarkdown(r.URL.Query().Get("name"), b)
		if errors.Is(e, errNoUpdates) {
			writeResponse(w, map[string]any{"status": "skipped", "message": e.Error()})
			return
		}
		if e != nil {
			http.Error(w, e.Error(), 400)
			return
		}
		writeResponse(w, map[string]any{"status": status, "id": item.ID})
	})
	mux.HandleFunc("/api/local/reports/download", func(w http.ResponseWriter, r *http.Request) {
		x, e := a.viewReports()
		if e != nil {
			http.Error(w, e.Error(), 400)
			return
		}
		for _, item := range x.Reports {
			if item.ID == r.URL.Query().Get("id") && item.Body != "" {
				w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
				w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": item.Date + ".md"}))
				w.Write([]byte(item.Body))
				return
			}
		}
		http.NotFound(w, r)
	})
	a.outlookImportRoutes(mux)
}
