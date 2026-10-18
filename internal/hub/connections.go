package hub

// Offline document recommendations. These are references between documents, never
// additions to the published company/event assertions. Everything mutable is DPAPI
// encrypted under local/, and no model or network service participates.
import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
)

type connectionAlias struct {
	Kind    string   `json:"kind"`
	Name    string   `json:"name"`
	Aliases []string `json:"aliases"`
}
type mailFingerprint struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
}
type indexedMail struct {
	Mail         MailRef           `json:"mail"`
	FolderID     string            `json:"folder_id"`
	Conversation string            `json:"conversation,omitempty"`
	Attachments  []mailFingerprint `json:"attachments,omitempty"`
}
type connectionReason struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
}
type documentConnection struct {
	ID      string             `json:"id"`
	From    string             `json:"from"`
	To      string             `json:"to"`
	Status  string             `json:"status"`
	Score   int                `json:"score"`
	Reasons []connectionReason `json:"reasons"`
	Decided string             `json:"decided,omitempty"`
}
type connectionStore struct {
	Cursors   map[string]outlookCursor      `json:"cursors"`
	Aliases   []connectionAlias             `json:"aliases"`
	Mails     map[string]indexedMail        `json:"mails"`
	Decisions map[string]documentConnection `json:"decisions"`
}
type connectionDocument struct {
	ID           string   `json:"id"`
	Kind         string   `json:"kind"`
	Source       string   `json:"source"`
	Title        string   `json:"title"`
	Date         string   `json:"date"`
	ReportID     string   `json:"report_id,omitempty"`
	FileID       string   `json:"file_id,omitempty"`
	Mail         *MailRef `json:"mail,omitempty"`
	Text         string   `json:"-"`
	Conversation string   `json:"-"`
	Hashes       []string `json:"-"`
}
type connectionsView struct {
	Documents    []connectionDocument `json:"documents"`
	Connections  []documentConnection `json:"connections"`
	Aliases      []connectionAlias    `json:"aliases"`
	Truncated    bool                 `json:"truncated"`
	IndexedMails int                  `json:"indexed_mails"`
}

func defaultConnectionAliases() []connectionAlias {
	return []connectionAlias{
		{Kind: "company", Name: "현대자동차", Aliases: []string{"현대차", "Hyundai Motor"}},
		{Kind: "company", Name: "Waymo", Aliases: []string{"웨이모"}},
		{Kind: "company", Name: "Tesla", Aliases: []string{"테슬라"}},
	}
}
func (a *App) connectionPath() string { return filepath.Join(a.localDir(), "connections.bin") }

// Caller holds localMu; decryption errors must never reset user decisions.
func (a *App) loadConnections() (connectionStore, error) {
	x := connectionStore{Cursors: map[string]outlookCursor{}, Aliases: defaultConnectionAliases(), Mails: map[string]indexedMail{}, Decisions: map[string]documentConnection{}}
	b, e := os.ReadFile(a.connectionPath())
	if os.IsNotExist(e) {
		return x, nil
	}
	if e == nil {
		b, e = unprotect(b)
	}
	if e == nil {
		e = json.Unmarshal(b, &x)
	}
	if e != nil {
		return x, errors.New("자료 연결 기록을 읽지 못했습니다. 저장한 Windows 계정과 자료 폴더를 확인하세요.")
	}
	if x.Mails == nil {
		x.Mails = map[string]indexedMail{}
	}
	if x.Cursors == nil {
		x.Cursors = map[string]outlookCursor{}
	}
	if x.Decisions == nil {
		x.Decisions = map[string]documentConnection{}
	}
	if x.Aliases == nil {
		x.Aliases = []connectionAlias{}
	}
	return x, nil
}
func (a *App) saveConnections(x connectionStore) error {
	b, e := json.Marshal(x)
	if e == nil {
		b, e = protect(b)
	}
	if e != nil {
		return e
	}
	return writeAtomic(a.connectionPath(), b)
}
func digest(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func connectionMailID(m MailRef) string {
	return "mail:" + digest(strings.ToUpper(m.StoreID)+"\n"+strings.ToUpper(m.EntryID))
}
func connectionID(a, b string) string {
	if a > b {
		a, b = b, a
	}
	return digest(a + "\n" + b)
}

var fingerprintPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func cleanIndexedMail(doc outlookDocument, mail MailRef) indexedMail {
	m := indexedMail{Mail: mail, FolderID: doc.FolderID}
	// Older Outlook versions can return a subject in ConversationID. Only an
	// actual 16-byte conversation ID is accepted as strong thread evidence.
	if len(doc.Conversation) == 32 && mapiHex.MatchString(doc.Conversation) {
		m.Conversation = strings.ToUpper(doc.Conversation)
	}
	for _, f := range doc.Fingerprints {
		if len(m.Attachments) >= 32 {
			break
		}
		f.SHA256 = strings.ToLower(f.SHA256)
		if fingerprintPattern.MatchString(f.SHA256) {
			m.Attachments = append(m.Attachments, mailFingerprint{Name: cleanText(f.Name, 200), SHA256: f.SHA256})
		}
	}
	return m
}
func normalizeAliases(in []connectionAlias) ([]connectionAlias, error) {
	if len(in) > 200 {
		return nil, errors.New("사전은 최대 200개 항목을 등록할 수 있습니다.")
	}
	out := []connectionAlias{}
	used := map[string]bool{}
	for _, a := range in {
		a.Name = strings.Join(strings.Fields(cleanText(a.Name, 80)), " ")
		if (a.Kind != "company" && a.Kind != "project") || len([]rune(a.Name)) < 2 || len(a.Aliases) > 20 {
			return nil, errors.New("기업·프로젝트 구분, 2자 이상의 대표 이름과 별칭(최대 20개)을 확인하세요.")
		}
		aliases := []string{}
		own := map[string]bool{}
		for i, s := range append([]string{a.Name}, a.Aliases...) {
			s = strings.Join(strings.Fields(cleanText(s, 80)), " ")
			key := strings.ToLower(s)
			if len([]rune(s)) < 2 {
				return nil, errors.New("별칭은 2자 이상으로 입력하세요.")
			}
			if own[key] {
				continue
			}
			if used[key] {
				return nil, errors.New("같은 이름·별칭을 여러 항목에 등록할 수 없습니다: " + s)
			}
			own[key] = true
			used[key] = true
			if i > 0 {
				aliases = append(aliases, s)
			}
		}
		a.Aliases = aliases
		out = append(out, a)
	}
	return out, nil
}

var connectionCode = regexp.MustCompile(`(?i)\b[A-Z][A-Z0-9]{1,15}(?:[-_][A-Z0-9]{2,16})+\b`)
var connectionWord = regexp.MustCompile(`[\pL\pN]{2,}`)
var connectionURL = regexp.MustCompile(`https?://\S+`)
var connectionDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
var connectionStop = map[string]bool{}

func init() {
	for _, s := range strings.Fields("re fw fwd 회신 전달 보고 보고서 리포트 동향 주간 월간 일일 데일리 업데이트 신규 확인 없음 관련 공유 안내 요청 검토 자료 첨부 참고 회사 기업 프로젝트 문서 report daily weekly monthly update news review the and for with from this that pdf pptx docx xlsx md") {
		connectionStop[s] = true
	}
}
func connectionTokens(s string) map[string]bool {
	m := map[string]bool{}
	s = connectionURL.ReplaceAllString(strings.ToLower(s), "")
	for _, w := range connectionWord.FindAllString(s, -1) {
		if connectionStop[w] || len([]rune(w)) < 2 {
			continue
		}
		letters := false
		for _, c := range w {
			if unicode.IsLetter(c) {
				letters = true
			}
		}
		if letters {
			m[w] = true
		}
		if len(m) >= 80 {
			break
		}
	}
	return m
}

type compiledConnectionAlias struct {
	connectionAlias
	patterns []*regexp.Regexp
	words    map[string]bool
}

func compileConnectionAliases(aliases []connectionAlias) []compiledConnectionAlias {
	out := make([]compiledConnectionAlias, 0, len(aliases))
	for _, a := range aliases {
		c := compiledConnectionAlias{connectionAlias: a, words: map[string]bool{}}
		for _, name := range append([]string{a.Name}, a.Aliases...) {
			// Boundaries stop short Latin aliases matching inside unrelated names.
			suffix := ""
			letters := []rune(name)
			if len(letters) > 0 && unicode.In(letters[len(letters)-1], unicode.Hangul) {
				suffix = `(?:은|는|이|가|와|과|의|을|를|에|에서|으로|로)?`
			}
			c.patterns = append(c.patterns, regexp.MustCompile(`(?i)(^|[^\pL\pN])`+regexp.QuoteMeta(name)+suffix+`($|[^\pL\pN])`))
			for w := range connectionTokens(name) {
				c.words[w] = true
			}
		}
		out = append(out, c)
	}
	return out
}

type connectionFeatures struct {
	values map[string]string
	words  map[string]bool
	date   time.Time
}

func documentFeatures(d connectionDocument, aliases []connectionAlias) connectionFeatures {
	return compiledDocumentFeatures(d, compileConnectionAliases(aliases))
}
func compiledDocumentFeatures(d connectionDocument, aliases []compiledConnectionAlias) connectionFeatures {
	f := connectionFeatures{values: map[string]string{}, words: connectionTokens(d.Text)}
	if len(d.Date) >= 10 {
		f.date, _ = time.Parse("2006-01-02", d.Date[:10])
	}
	if d.Conversation != "" && d.Mail != nil {
		f.values["thread:"+strings.ToUpper(d.Mail.StoreID)+":"+d.Conversation] = "같은 Outlook 메일 대화"
	}
	for _, h := range d.Hashes {
		if fingerprintPattern.MatchString(h) {
			f.values["file:"+h] = "동일한 파일 내용"
		}
	}
	for _, code := range connectionCode.FindAllString(connectionURL.ReplaceAllString(d.Text, ""), -1) {
		if connectionDate.MatchString(code) || !strings.ContainsAny(code, "0123456789") {
			continue
		}
		f.values["code:"+strings.ToUpper(code)] = "문서·프로젝트 번호 일치: " + strings.ToUpper(code)
	}
	for _, a := range aliases {
		for _, pattern := range a.patterns {
			if pattern.MatchString(d.Text) {
				label := "기업명 일치: "
				if a.Kind == "project" {
					label = "프로젝트명 일치: "
				}
				f.values[a.Kind+":"+strings.ToLower(a.Name)] = label + a.Name
				// A company name is not also an independent keyword reason.
				for w := range a.words {
					delete(f.words, w)
				}
				for w := range f.words {
					for _, p := range a.patterns {
						if p.MatchString(w) {
							delete(f.words, w)
							break
						}
					}
				}
				break
			}
		}
	}
	return f
}
func scoreConnection(a, b connectionDocument, fa, fb connectionFeatures) documentConnection {
	c := documentConnection{ID: connectionID(a.ID, b.ID), From: a.ID, To: b.ID, Status: "suggested", Reasons: []connectionReason{}}
	keys := []string{}
	for k := range fa.values {
		if _, ok := fb.values[k]; ok {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	counted := map[string]bool{}
	for _, k := range keys {
		kind := strings.SplitN(k, ":", 2)[0]
		c.Reasons = append(c.Reasons, connectionReason{Kind: kind, Text: fa.values[k]})
		if !counted[kind] {
			c.Score += map[string]int{"thread": 100, "file": 100, "code": 85, "project": 70, "company": 25}[kind]
			counted[kind] = true
		}
	}
	words := []string{}
	for w := range fa.words {
		if fb.words[w] {
			words = append(words, w)
		}
	}
	sort.Strings(words)
	if len(words) >= 2 {
		c.Score += 35
		if len(words) >= 3 {
			c.Score += 10
		}
		if len(words) > 5 {
			words = words[:5]
		}
		c.Reasons = append(c.Reasons, connectionReason{Kind: "keywords", Text: "공통 핵심어: " + strings.Join(words, ", ")})
	}
	if !fa.date.IsZero() && !fb.date.IsZero() {
		days := fa.date.Sub(fb.date).Hours() / 24
		if days < 0 {
			days = -days
		}
		if days <= 30 {
			c.Score += 15
			c.Reasons = append(c.Reasons, connectionReason{Kind: "date", Text: "자료 날짜가 30일 이내"})
		}
	}
	return c
}

// Inverted feature postings avoid comparing every document with every other.
// Large common groups use recent neighbours; the UI explicitly reports truncation.
func recommendConnections(docs []connectionDocument, aliases []connectionAlias, decisions map[string]documentConnection) ([]documentConnection, bool) {
	compiled := compileConnectionAliases(aliases)
	features := make([]connectionFeatures, len(docs))
	postings := map[string][]int{}
	byID := map[string]int{}
	for i, d := range docs {
		byID[d.ID] = i
		features[i] = compiledDocumentFeatures(d, compiled)
		for k := range features[i].values {
			postings[k] = append(postings[k], i)
		}
		for w := range features[i].words {
			postings["word:"+w] = append(postings["word:"+w], i)
		}
	}
	out := []documentConnection{}
	truncated := false
	for i, a := range docs {
		candidates := map[int]bool{}
		add := func(key string) {
			p := postings[key]
			pos := sort.SearchInts(p, i)
			start := pos - 80
			if start < 0 {
				start = 0
			}
			if start > 0 {
				truncated = true
			}
			for _, j := range p[start:pos] {
				candidates[j] = true
			}
		}
		for k := range features[i].values {
			add(k)
		}
		for w := range features[i].words {
			add("word:" + w)
		}
		for j := range candidates {
			b := docs[j]
			if a.ReportID != "" && b.ReportID == a.ReportID {
				continue
			}
			id := connectionID(a.ID, b.ID)
			if _, ok := decisions[id]; ok {
				continue
			}
			c := scoreConnection(a, b, features[i], features[j])
			if c.Score >= 60 {
				out = append(out, c)
			}
		}
		// Keep memory bounded even for large mail folders, with deterministic ranking.
		if len(out) > 1000 {
			sortConnections(out)
			out = out[:300]
			truncated = true
		}
	}
	sortConnections(out)
	if len(out) > 300 {
		out = out[:300]
		truncated = true
	}
	for _, saved := range decisions {
		_, a := byID[saved.From]
		_, b := byID[saved.To]
		if a && b {
			out = append(out, saved)
		}
	}
	sortConnections(out)
	return out, truncated
}
func sortConnections(xs []documentConnection) {
	sort.Slice(xs, func(i, j int) bool {
		if xs[i].Score != xs[j].Score {
			return xs[i].Score > xs[j].Score
		}
		return xs[i].ID < xs[j].ID
	})
}

// Caller holds localMu. Existing documents only; no Outlook call or PDF parsing here.
func (a *App) connectionDocuments(x connectionStore) ([]connectionDocument, []connectionAlias, error) {
	local, e := a.loadLocal()
	if e != nil {
		return nil, nil, e
	}
	archive, e := a.loadReports()
	if e != nil {
		return nil, nil, e
	}
	visibility := a.reportVisibility()
	if visibility.Error != "" {
		return nil, nil, errors.New(visibility.Error)
	}
	hidden := map[string]bool{}
	for _, id := range visibility.HiddenReports {
		hidden[id] = true
	}
	a.mu.RLock()
	reports := append([]Report{}, a.githubSnapshot().Catalog.Reports...)
	a.mu.RUnlock()
	aliases := append([]connectionAlias{}, x.Aliases...)
	known := map[string]bool{}
	for _, a := range aliases {
		for _, s := range append([]string{a.Name}, a.Aliases...) {
			known[strings.ToLower(s)] = true
		}
	}
	for _, r := range reports {
		for _, name := range r.Companies {
			if !known[strings.ToLower(name)] && len([]rune(name)) >= 2 {
				aliases = append(aliases, connectionAlias{Kind: "company", Name: name})
				known[strings.ToLower(name)] = true
			}
		}
	}
	docs := []connectionDocument{}
	byID := map[string]int{}
	add := func(d connectionDocument) {
		if _, ok := byID[d.ID]; ok {
			return
		}
		byID[d.ID] = len(docs)
		docs = append(docs, d)
	}
	mailReports := map[string]string{}
	for _, r := range archive.Reports {
		if r.Mail != nil {
			mailReports[connectionMailID(*r.Mail)] = r.ID
		}
		if hidden[r.ID] {
			continue
		}
		source := "daily"
		if r.Origin == "outlook-report" {
			source = "outlook"
		}
		add(connectionDocument{ID: "r:" + r.ID, Kind: "report", Source: source, Title: r.Title, Date: r.Date, ReportID: r.ID, Text: r.Title + " " + func() string {
			if r.Mail != nil {
				return r.Mail.Subject
			}
			return ""
		}()})
	}
	for _, r := range reports {
		if !hidden[r.ID] {
			add(connectionDocument{ID: "r:" + r.ID, Kind: "report", Source: "daily", Title: r.Title, Date: r.Date, ReportID: r.ID, Text: r.Title})
		}
	}
	for _, m := range x.Mails {
		allowed := false
		for _, s := range local.Sources {
			if s.FolderID != "" && strings.EqualFold(s.FolderID, m.FolderID) && strings.EqualFold(s.StoreID, m.Mail.StoreID) {
				allowed = true
				break
			}
		}
		if !allowed {
			continue
		}
		id := connectionMailID(m.Mail)
		rid := mailReports[id]
		if rid != "" && hidden[rid] {
			continue
		}
		d := connectionDocument{ID: id, Kind: "mail", Source: "outlook", Title: m.Mail.Subject, Date: m.Mail.Received, Mail: &m.Mail, ReportID: rid, Text: m.Mail.Subject, Conversation: m.Conversation}
		for _, f := range m.Attachments {
			d.Text += " " + f.Name
			d.Hashes = append(d.Hashes, f.SHA256)
		}
		add(d)
	}
	for _, m := range local.Mails {
		if !hidden[m.Report] {
			copy := m.MailRef
			add(connectionDocument{ID: connectionMailID(copy), Kind: "mail", Source: "outlook", Title: copy.Subject, Date: copy.Received, Mail: &copy, Text: copy.Subject})
		}
	}
	filesChanged := false
	for i := range local.Files {
		f := &local.Files[i]
		// Upgrade older encrypted PDFs once, without introducing a plaintext copy.
		if f.SHA256 == "" && localIDPattern.MatchString(f.ID) {
			b, err := os.ReadFile(a.blobPath(f.ID))
			if err == nil {
				b, err = unprotect(b)
			}
			if err == nil {
				h := sha256.Sum256(b)
				f.SHA256 = hex.EncodeToString(h[:])
				filesChanged = true
			}
		}
		add(connectionDocument{ID: "pdf:" + f.ID, Kind: "pdf", Source: "local", Title: f.Name, FileID: f.ID, Date: f.Added, Text: f.Name, Hashes: []string{f.SHA256}})
	}
	if filesChanged {
		if e := a.saveLocal(local); e != nil {
			return nil, nil, e
		}
	}
	sort.Slice(docs, func(i, j int) bool {
		if docs[i].Date != docs[j].Date {
			return docs[i].Date < docs[j].Date
		}
		return docs[i].ID < docs[j].ID
	})
	return docs, aliases, nil
}
func (a *App) connectionsRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/local/connections", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			http.Error(w, "GET 또는 POST를 사용하세요.", 405)
			return
		}
		if r.Method == http.MethodPost && !post(w, r) {
			return
		}
		a.localMu.Lock()
		locked := true
		defer func() {
			if locked {
				a.localMu.Unlock()
			}
		}()
		if e := a.localBlocked(); e != nil {
			http.Error(w, e.Error(), 400)
			return
		}
		x, e := a.loadConnections()
		if e != nil {
			http.Error(w, e.Error(), 400)
			return
		}
		if r.Method == http.MethodPost {
			var v struct {
				Action  string            `json:"action"`
				From    string            `json:"from"`
				To      string            `json:"to"`
				Status  string            `json:"status"`
				Aliases []connectionAlias `json:"aliases"`
			}
			if e = decodeBody(r, &v); e != nil {
				http.Error(w, e.Error(), 400)
				return
			}
			switch v.Action {
			case "dictionary":
				x.Aliases, e = normalizeAliases(v.Aliases)
			case "decision":
				if v.From == v.To || (v.Status != "accepted" && v.Status != "rejected" && v.Status != "reset") {
					e = errors.New("자료와 처리 상태를 확인하세요.")
					break
				}
				id := connectionID(v.From, v.To)
				if v.Status == "reset" {
					delete(x.Decisions, id)
					break
				}
				docs, aliases, err := a.connectionDocuments(x)
				if err != nil {
					e = err
					break
				}
				var from, to *connectionDocument
				for i := range docs {
					if docs[i].ID == v.From {
						from = &docs[i]
					}
					if docs[i].ID == v.To {
						to = &docs[i]
					}
				}
				if from == nil || to == nil {
					e = errors.New("현재 자료에서 연결 대상을 찾을 수 없습니다.")
					break
				}
				c := scoreConnection(*from, *to, documentFeatures(*from, aliases), documentFeatures(*to, aliases))
				if c.Score < 60 {
					if old, ok := x.Decisions[id]; ok {
						c = old
					} else {
						e = errors.New("연결 근거가 변경되었습니다. 후보를 새로 확인하세요.")
						break
					}
				}
				c.Status = v.Status
				c.Decided = time.Now().In(kst).Format(time.RFC3339)
				x.Decisions[id] = c
			default:
				e = errors.New("지원하지 않는 자료 연결 요청입니다.")
			}
			if e != nil {
				http.Error(w, e.Error(), 400)
				return
			}
			if e = a.saveConnections(x); e != nil {
				localFail(w, "connections", e)
				return
			}
			writeResponse(w, map[string]bool{"ok": true})
			return
		}
		docs, aliases, e := a.connectionDocuments(x)
		if e != nil {
			http.Error(w, e.Error(), 400)
			return
		}
		a.localMu.Unlock()
		locked = false
		links, truncated := recommendConnections(docs, aliases, x.Decisions)
		count := 0
		for _, d := range docs {
			if d.Kind == "mail" {
				count++
			}
		}
		writeResponse(w, connectionsView{Documents: docs, Connections: links, Aliases: x.Aliases, Truncated: truncated, IndexedMails: count})
	})
}
