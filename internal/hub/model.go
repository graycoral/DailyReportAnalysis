package hub

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const Version = "0.1.6"

var slug = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$`)
var datePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
var kst = time.FixedZone("Asia/Seoul", 9*60*60)

type Config struct {
	Owner      string `json:"owner"`
	Repo       string `json:"repo"`
	Branch     string `json:"branch"`
	SyncTime   string `json:"sync_time"`
	Configured bool   `json:"configured"`
	Offline    bool   `json:"offline"`
}
type Source struct {
	Title string `json:"title"`
	URL   string `json:"url"`
}
type Attachment struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}
type Report struct {
	ID          string       `json:"id"`
	Date        string       `json:"date"`
	Title       string       `json:"title"`
	Summary     string       `json:"summary"`
	Companies   []string     `json:"companies"`
	Tags        []string     `json:"tags"`
	Body        string       `json:"body_markdown"`
	Sources     []Source     `json:"sources"`
	Attachments []Attachment `json:"attachments"`
}
type Event struct {
	ID        string   `json:"id"`
	Date      string   `json:"date"`
	Title     string   `json:"title"`
	Status    string   `json:"status"`
	ReportID  string   `json:"report_id"`
	Detail    string   `json:"detail"`
	Companies []string `json:"companies"`
	Sources   []Source `json:"sources"`
}
type Entity struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Kind  string `json:"kind"`
}
type Relation struct {
	ID       string   `json:"id"`
	From     string   `json:"from"`
	To       string   `json:"to"`
	Label    string   `json:"label"`
	Status   string   `json:"status"`
	ReportID string   `json:"report_id"`
	Evidence string   `json:"evidence"`
	Sources  []Source `json:"sources"`
}
type Related struct {
	From   string `json:"from"`
	To     string `json:"to"`
	Reason string `json:"reason"`
}
type Catalog struct {
	Database  *Attachment `json:"database,omitempty"`
	Schema    int         `json:"schema_version"`
	Published string      `json:"published_at"`
	Reports   []Report    `json:"reports"`
	Events    []Event     `json:"events"`
	Entities  []Entity    `json:"entities"`
	Relations []Relation  `json:"relations"`
	Related   []Related   `json:"related"`
}
type Snapshot struct {
	Commit   string  `json:"commit"`
	ETag     string  `json:"etag,omitempty"`
	SyncedAt string  `json:"synced_at"`
	Origin   string  `json:"origin"`
	Catalog  Catalog `json:"catalog"`
}

func defaultConfig() Config {
	return Config{Owner: "graycoral", Repo: "DailyReportAnalysis", Branch: "main", SyncTime: "08:00"}
}
func (c Config) Validate() error {
	if !slug.MatchString(c.Owner) || !slug.MatchString(c.Repo) {
		return errors.New("GitHub 소유자와 저장소 이름을 확인하세요.")
	}
	if len(c.Branch) == 0 || len(c.Branch) > 120 || strings.ContainsAny(c.Branch, "\r\n?#") {
		return errors.New("브랜치 이름을 확인하세요.")
	}
	if _, e := time.Parse("15:04", c.SyncTime); e != nil {
		return errors.New("갱신 시간은 08:00처럼 입력하세요.")
	}
	return nil
}

var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// Validate also normalises nil slices to empty ones so the UI can iterate them unconditionally.
func (c Catalog) Validate() error {
	if c.Database != nil && (c.Database.Path != "data/reports.sqlite" || !hashPattern.MatchString(c.Database.SHA256)) {
		return errors.New("DB 경로 또는 해시가 잘못되었습니다.")
	}
	if c.Schema != 1 {
		return fmt.Errorf("지원하지 않는 데이터 버전: %d", c.Schema)
	}
	ids := map[string]bool{}
	entities := map[string]bool{}
	for i := range c.Reports {
		r := &c.Reports[i]
		if !slug.MatchString(r.ID) || ids[r.ID] || !datePattern.MatchString(r.Date) || r.Title == "" {
			return errors.New("리포트 ID·날짜·제목이 잘못되었거나 중복입니다.")
		}
		ids[r.ID] = true
		if _, err := time.Parse("2006-01-02", r.Date); err != nil {
			return errors.New("잘못된 리포트 날짜입니다.")
		}
		for _, a := range r.Attachments {
			if !safeRepoPath(a.Path) || !hashPattern.MatchString(a.SHA256) {
				return errors.New("첨부 경로 또는 해시가 잘못되었습니다.")
			}
		}
		if r.Companies == nil {
			r.Companies = []string{}
		}
		if r.Tags == nil {
			r.Tags = []string{}
		}
		if r.Sources == nil {
			r.Sources = []Source{}
		}
		if r.Attachments == nil {
			r.Attachments = []Attachment{}
		}
	}
	for _, e := range c.Entities {
		if !slug.MatchString(e.ID) || entities[e.ID] {
			return errors.New("잘못된 관계 노드입니다.")
		}
		entities[e.ID] = true
	}
	for i := range c.Events {
		e := &c.Events[i]
		if !ids[e.ReportID] {
			return errors.New("사건의 근거 리포트가 없습니다.")
		}
		if _, err := time.Parse("2006-01-02", e.Date); err != nil {
			return errors.New("잘못된 사건 날짜입니다.")
		}
		if e.Companies == nil {
			e.Companies = []string{}
		}
	}
	for _, r := range c.Relations {
		if !entities[r.From] || !entities[r.To] || !ids[r.ReportID] || r.Evidence == "" || len(r.Sources) == 0 {
			return errors.New("관계의 노드 또는 근거가 없습니다.")
		}
	}
	for _, r := range c.Related {
		if !ids[r.From] || !ids[r.To] || r.Reason == "" {
			return errors.New("잘못된 연관 리포트입니다.")
		}
	}
	return nil
}
func safeRepoPath(p string) bool {
	return strings.HasPrefix(p, "data/reports/") && !strings.Contains(p, "..") && !strings.ContainsAny(p, "\\\r\n?#")
}
func writeAtomic(path string, b []byte) error {
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".pending-")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if _, e = f.Write(b); e != nil {
		f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	return replaceFile(name, path)
}
func writeJSON(path string, v any) error {
	b, e := json.MarshalIndent(v, "", "  ")
	if e != nil {
		return e
	}
	return writeAtomic(path, b)
}
func parseCatalog(b []byte) (Catalog, error) {
	var c Catalog
	e := json.Unmarshal(b, &c)
	if e == nil {
		e = c.Validate()
	}
	return c, e
}
