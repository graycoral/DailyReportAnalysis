package hub

import (
	"avreporthub/rag"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
)

func TestRagEnvironmentReadDoesNotInstall(t *testing.T) {
	a := &App{dir: t.TempDir()}
	s := a.ragEnvironment()
	if s.Ready || s.Busy || s.State != "missing" {
		t.Fatalf("unexpected initial status: %+v", s)
	}
	entries, err := os.ReadDir(a.dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("status read changed disk: %v %v", entries, err)
	}
}

func TestRagSetupMarkerRejectsIncompleteOrChangedEnvironment(t *testing.T) {
	a := &App{dir: t.TempDir()}
	marker := filepath.Join(a.ragRuntime(), "ready.json")
	if err := writeJSON(marker, map[string]string{"fingerprint": ragFingerprint()}); err != nil {
		t.Fatal(err)
	}
	if a.ragMarkerValid() {
		t.Fatal("marker without Python accepted")
	}
	if err := writeAtomic(a.ragPython(), []byte("placeholder")); err != nil {
		t.Fatal(err)
	}
	if a.ragMarkerValid() {
		t.Fatal("missing service source accepted")
	}
	entries, _ := rag.Files.ReadDir(".")
	for _, entry := range entries {
		b, _ := rag.Files.ReadFile(entry.Name())
		if err := writeAtomic(filepath.Join(a.ragRuntime(), entry.Name()), b); err != nil {
			t.Fatal(err)
		}
	}
	if !a.ragMarkerValid() {
		t.Fatal("complete source fingerprint not recognised")
	}
	if err := os.WriteFile(filepath.Join(a.ragRuntime(), "embed_core.py"), []byte("modified"), 0600); err != nil {
		t.Fatal(err)
	}
	if a.ragMarkerValid() {
		t.Fatal("modified service accepted")
	}
}

func TestRagSetupStorageAndEnvironment(t *testing.T) {
	dir := t.TempDir()
	if !ragStorageAllowed(dir) {
		t.Fatal("normal storage rejected")
	}
	if err := os.WriteFile(filepath.Join(dir, ".git"), []byte("gitdir: elsewhere"), 0600); err != nil {
		t.Fatal(err)
	}
	if ragStorageAllowed(filepath.Join(dir, "nested", "data")) {
		t.Fatal("git worktree storage accepted")
	}
	t.Setenv("AVHUB_DATA_DIR", "wrong")
	t.Setenv("RAG_INDEX", "wrong")
	t.Setenv("RAG_MODEL", "wrong")
	t.Setenv("PYTHONPATH", "unrelated-packages")
	a := &App{dir: dir}
	values := map[string]string{}
	for _, item := range a.ragCommandEnv() {
		key, value, _ := strings.Cut(item, "=")
		key = strings.ToUpper(key)
		if _, exists := values[key]; exists {
			t.Fatalf("duplicate environment key %s", key)
		}
		values[key] = value
	}
	if values["AVHUB_DATA_DIR"] != dir || values["RAG_INDEX"] != filepath.Join(dir, "rag", "index") || values["RAG_MODEL"] != "google/embeddinggemma-2" || values["PYTHONPATH"] != "" {
		t.Fatal("environment isolation failed")
	}
}

func TestRagSetupRoutesRejectUnsafeAndDuplicateRequests(t *testing.T) {
	a := &App{dir: t.TempDir(), address: "http://127.0.0.1:9000", secret: strings.Repeat("a", 64)}
	a.ragSetupChecked = true
	a.ragSetupState = ragSetupStatus{State: "installing", Busy: true}
	h := a.routes()
	for _, tc := range []struct {
		method, path, origin, cookie string
		code                         int
	}{
		{"POST", "/api/rag/setup", "https://foreign.test", a.secret, 403},
		{"POST", "/api/rag/setup", a.address, "", 403},
		{"GET", "/api/rag/setup", "", a.secret, 405},
		{"GET", "/api/rag/start", "", a.secret, 405},
	} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		r.Host = "127.0.0.1:9000"
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("X-AV-Request", "1")
		r.AddCookie(&http.Cookie{Name: "av_session", Value: tc.cookie})
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.code {
			t.Fatalf("%s: got %d want %d", tc.path, w.Code, tc.code)
		}
	}
	if runtime.GOOS == "windows" {
		r := httptest.NewRequest("POST", "/api/rag/setup", nil)
		r.Host = "127.0.0.1:9000"
		r.Header.Set("Origin", a.address)
		r.Header.Set("X-AV-Request", "1")
		r.AddCookie(&http.Cookie{Name: "av_session", Value: a.secret})
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 409 {
			t.Fatalf("duplicate setup: %d", w.Code)
		}
		a.ragSet(ragSetupStatus{State: "missing"})
		r = r.Clone(r.Context())
		r.URL.Path = "/api/rag/start"
		w = httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 409 {
			t.Fatalf("start without ready environment: %d", w.Code)
		}
	}
	entries, _ := os.ReadDir(a.dir)
	if len(entries) != 0 {
		t.Fatal("rejected request changed environment")
	}
}

func TestRagHealthDoesNotTrustStaleFileOrFalseHealth(t *testing.T) {
	a := &App{dir: t.TempDir()}
	key := strings.Repeat("b", 64)
	var healthy atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-RAG-Key") != key {
			t.Error("missing service authentication")
		}
		json.NewEncoder(w).Encode(map[string]bool{"ok": healthy.Load()})
	}))
	if err := writeJSON(filepath.Join(a.dir, "rag-service.json"), ragService{srv.URL, key}); err != nil {
		t.Fatal(err)
	}
	if a.ragHealthy() {
		t.Fatal("false health accepted")
	}
	healthy.Store(true)
	if !a.ragHealthy() {
		t.Fatal("healthy service rejected")
	}
	srv.Close()
	if a.ragHealthy() {
		t.Fatal("stale service file accepted")
	}
}
