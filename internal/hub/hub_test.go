package hub

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func withBase(base string, f func()) {
	old := apiBase
	apiBase = base
	defer func() { apiBase = old }()
	f()
}
func seedCatalog(t *testing.T) Catalog {
	t.Helper()
	b, e := assets.ReadFile("seed/catalog.json")
	if e != nil {
		t.Fatal(e)
	}
	c, e := parseCatalog(b)
	if e != nil {
		t.Fatal(e)
	}
	return c
}
func TestPublishedRelationsRequireEvidence(t *testing.T) {
	c := seedCatalog(t)
	c.Relations[0].Evidence = ""
	if c.Validate() == nil {
		t.Fatal("relation without evidence accepted")
	}
}
func TestAttachmentTraversalRejected(t *testing.T) {
	c := seedCatalog(t)
	c.Reports[0].Attachments[0].Path = "data/reports/../../token.bin"
	if c.Validate() == nil {
		t.Fatal("path traversal accepted")
	}
}

// A remote catalog that fails validation must leave snapshot.json and the in-memory snapshot untouched.
func TestInvalidSnapshotKeepsLastGoodData(t *testing.T) {
	dir := t.TempDir()
	c := seedCatalog(t)
	good := Snapshot{Commit: strings.Repeat("a", 40), Origin: "graycoral/DailyReportAnalysis", Catalog: c}
	p := filepath.Join(dir, "snapshot.json")
	if e := writeJSON(p, good); e != nil {
		t.Fatal(e)
	}
	before, _ := os.ReadFile(p)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/graycoral/DailyReportAnalysis/commits/main":
			json.NewEncoder(w).Encode(map[string]string{"sha": strings.Repeat("b", 40)})
		case "/repos/graycoral/DailyReportAnalysis/contents/data/catalog.json":
			w.Write([]byte(`{"schema_version":99}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	cfg := defaultConfig()
	cfg.Configured = true
	cfg.GitHubChoiceVersion = Version
	a := &App{dir: dir, config: cfg, snapshot: good}
	withBase(srv.URL, func() { a.syncData() })
	after, _ := os.ReadFile(p)
	if string(before) != string(after) {
		t.Fatal("good cache changed")
	}
	if a.snapshot.Commit != good.Commit || a.status == "최신 자료 확인 완료" {
		t.Fatalf("bad catalog replaced snapshot: %q", a.status)
	}
	if a.config.Offline {
		t.Fatal("content validation error disabled GitHub integration")
	}
}
func TestConditionalRequestSkipsCatalog(t *testing.T) {
	c := seedCatalog(t)
	catalogHits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/graycoral/DailyReportAnalysis/commits/main":
			if r.Header.Get("If-None-Match") == `"etag-1"` {
				w.WriteHeader(304)
				return
			}
			w.Header().Set("ETag", `"etag-1"`)
			json.NewEncoder(w).Encode(map[string]string{"sha": strings.Repeat("b", 40)})
		case "/repos/graycoral/DailyReportAnalysis/contents/data/catalog.json":
			catalogHits++
			json.NewEncoder(w).Encode(c)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	cfg := defaultConfig()
	cfg.Configured = true
	cfg.GitHubChoiceVersion = Version
	a := &App{dir: t.TempDir(), config: cfg, snapshot: Snapshot{Catalog: c, Origin: "bundled"}}
	withBase(srv.URL, func() { a.syncData(); a.syncData() })
	if catalogHits != 1 || a.snapshot.ETag != `"etag-1"` || a.snapshot.Commit != strings.Repeat("b", 40) {
		t.Fatalf("catalog fetched %d times, etag %q, status %q", catalogHits, a.snapshot.ETag, a.status)
	}
}
func TestPruneCacheKeepsReferencedFiles(t *testing.T) {
	dir := t.TempDir()
	c := seedCatalog(t)
	keep := filepath.Join(dir, "attachments", c.Reports[0].Attachments[0].SHA256)
	stale := filepath.Join(dir, "attachments", strings.Repeat("f", 64))
	staleDB := filepath.Join(dir, "databases", strings.Repeat("e", 64)+".sqlite")
	for _, p := range []string{keep, stale, staleDB} {
		if e := writeAtomic(p, []byte("x")); e != nil {
			t.Fatal(e)
		}
	}
	(&App{dir: dir}).pruneCache(c)
	if _, e := os.Stat(keep); e != nil {
		t.Fatal("referenced attachment removed")
	}
	for _, p := range []string{stale, staleDB} {
		if _, e := os.Stat(p); e == nil {
			t.Fatalf("stale file kept: %s", p)
		}
	}
}
func TestValidateNormalisesNilSlices(t *testing.T) {
	c, e := parseCatalog([]byte(`{"schema_version":1,"reports":[{"id":"r1","date":"2026-01-01","title":"t"}],"events":[{"id":"e1","date":"2026-01-01","report_id":"r1"}]}`))
	if e != nil {
		t.Fatal(e)
	}
	if c.Reports[0].Companies == nil || c.Reports[0].Tags == nil || c.Reports[0].Attachments == nil || c.Events[0].Companies == nil {
		t.Fatal("nil slice not normalised")
	}
}
func TestLocalServerRejectsForeignOriginAndHost(t *testing.T) {
	a := &App{dir: t.TempDir(), secret: strings.Repeat("a", 64), address: "http://127.0.0.1:9000", config: defaultConfig(), snapshot: Snapshot{Catalog: seedCatalog(t)}}
	h := a.routes()
	for _, tc := range []struct {
		method, path, host, origin, cookie string
		want                               int
	}{{"GET", "/api/state", "evil.test", "", a.secret, 403}, {"GET", "/api/state", "127.0.0.1:9000", "", "", 403}, {"POST", "/api/sync", "127.0.0.1:9000", "https://evil.test", a.secret, 403}, {"GET", "/api/state", "127.0.0.1:9000", "", a.secret, 200}} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		r.Host = tc.host
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("X-AV-Request", "1")
		if tc.cookie != "" {
			r.AddCookie(&http.Cookie{Name: "av_session", Value: tc.cookie})
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Fatalf("%+v: %d", tc, w.Code)
		}
	}
}
func TestPinnedCatalogAndCredentialScope(t *testing.T) {
	commit := strings.Repeat("b", 40)
	c := seedCatalog(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer example" {
			t.Error("credential missing")
		}
		switch r.URL.Path {
		case "/repos/graycoral/DailyReportAnalysis/commits/main":
			json.NewEncoder(w).Encode(map[string]string{"sha": commit})
		case "/repos/graycoral/DailyReportAnalysis/contents/data/catalog.json":
			if r.URL.Query().Get("ref") != commit {
				t.Error("catalog not pinned")
			}
			json.NewEncoder(w).Encode(c)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	g := newGitHub(defaultConfig(), "example")
	g.base = srv.URL
	sha, e := g.commit(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	out, e := g.catalog(context.Background(), sha)
	if e != nil || len(out.Reports) != len(c.Reports) {
		t.Fatalf("catalog failed: %v", e)
	}
}
func TestEmbeddedAttachmentMatchesPublishedHash(t *testing.T) {
	a := githubSettingsApp(t)
	for _, report := range a.snapshot.Catalog.Reports {
		for i := range report.Attachments {
			b, name, e := a.attachment(context.Background(), report.ID, i)
			if e != nil || len(b) == 0 || name == "" {
				t.Fatalf("attachment: %v", e)
			}
		}
	}
}

func TestSetupStopsRunningViewerBeforeInstall(t *testing.T) {
	dir := t.TempDir()
	if stopRunningViewer(dir) {
		t.Fatal("no instance file: expected false")
	}
	a := &App{dir: dir, secret: strings.Repeat("b", 64), config: defaultConfig(), snapshot: Snapshot{Catalog: seedCatalog(t)}}
	srv := httptest.NewUnstartedServer(nil)
	a.address = "http://" + srv.Listener.Addr().String()
	a.server = &http.Server{Handler: a.routes()}
	srv.Config = a.server
	srv.Start()
	if e := writeJSON(filepath.Join(dir, "instance-viewer.json"), instance{a.address, a.secret}); e != nil {
		t.Fatal(e)
	}
	if !stopRunningViewer(dir) {
		t.Fatal("expected running viewer to be stopped")
	}
	if _, e := http.Get(a.address + "/api/ping"); e == nil {
		t.Fatal("viewer still answering after exit")
	}
}

func TestRagProxyRequiresServiceFileAndForwardsKey(t *testing.T) {
	dir := t.TempDir()
	a := &App{dir: dir, secret: strings.Repeat("c", 64), address: "http://127.0.0.1:9000", config: defaultConfig(), snapshot: Snapshot{Catalog: seedCatalog(t)}}
	h := a.routes()
	get := func(path string) (int, map[string]any) {
		r := httptest.NewRequest("GET", path, nil)
		r.Host = "127.0.0.1:9000"
		r.AddCookie(&http.Cookie{Name: "av_session", Value: a.secret})
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		var v map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &v)
		return w.Code, v
	}
	if code, v := get("/api/rag/status"); code != 200 || v["available"] != false {
		t.Fatalf("without service file: %d %v", code, v)
	}
	key := strings.Repeat("d", 64)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-RAG-Key") != key {
			http.Error(w, "unauthorized", 403)
			return
		}
		writeResponse(w, map[string]any{"ok": true, "path": r.URL.Path, "name": r.Header.Get("X-File-Name")})
	}))
	defer up.Close()
	if e := writeJSON(filepath.Join(dir, "rag-service.json"), ragService{up.URL, key}); e != nil {
		t.Fatal(e)
	}
	if code, v := get("/api/rag/status"); code != 200 || v["ok"] != true || v["path"] != "/health" {
		t.Fatalf("with service file: %d %v", code, v)
	}
	r := httptest.NewRequest("POST", "/api/rag/index?name=../x.pdf", strings.NewReader("%PDF-1.4 fake"))
	r.Host = "127.0.0.1:9000"
	r.Header.Set("Origin", a.address)
	r.Header.Set("X-AV-Request", "1")
	r.AddCookie(&http.Cookie{Name: "av_session", Value: a.secret})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var v map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &v)
	if w.Code != 200 || v["name"] != "x.pdf" {
		t.Fatalf("index: %d %s", w.Code, w.Body.String())
	}
}
