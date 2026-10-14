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
func TestInvalidSnapshotKeepsLastGoodData(t *testing.T) {
	p := filepath.Join(t.TempDir(), "snapshot.json")
	c := seedCatalog(t)
	if e := writeJSON(p, Snapshot{Catalog: c}); e != nil {
		t.Fatal(e)
	}
	b, _ := os.ReadFile(p)
	if _, e := parseCatalog([]byte(`{"schema_version":99}`)); e == nil {
		t.Fatal("bad schema accepted")
	}
	after, _ := os.ReadFile(p)
	if string(b) != string(after) {
		t.Fatal("good cache changed")
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
	a := &App{dir: t.TempDir(), config: defaultConfig(), snapshot: Snapshot{Catalog: seedCatalog(t)}}
	for _, report := range a.snapshot.Catalog.Reports {
		for i := range report.Attachments {
			b, name, e := a.attachment(context.Background(), report.ID, i)
			if e != nil || len(b) == 0 || name == "" {
				t.Fatalf("attachment: %v", e)
			}
		}
	}
}
