package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func githubSettingsApp(t *testing.T) *App {
	t.Helper()
	cfg := defaultConfig()
	cfg.Configured = true
	cfg.GitHubChoiceVersion = Version
	return &App{dir: t.TempDir(), config: cfg, address: "http://127.0.0.1:9000", secret: strings.Repeat("a", 64), snapshot: Snapshot{Catalog: seedCatalog(t), Origin: cfg.Owner + "/" + cfg.Repo, Commit: strings.Repeat("a", 40)}}
}

func githubSettingsRequest(t *testing.T, a *App, path string, config Config) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(config)
	r := httptest.NewRequest("POST", a.address+path, bytes.NewReader(body))
	r.Header.Set("Origin", a.address)
	r.Header.Set("X-AV-Request", "1")
	r.AddCookie(&http.Cookie{Name: "av_session", Value: a.secret})
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	return w
}

func TestGitHubFailureDisablesPersistentlyAndPreservesData(t *testing.T) {
	for _, code := range []int{401, 403, 404, 503, 0} {
		t.Run(http.StatusText(code), func(t *testing.T) {
			a := githubSettingsApp(t)
			a.snapshot.SyncedAt = "2026-10-18T09:00:00+09:00"
			before, _ := json.Marshal(a.snapshot)
			if err := writeJSON(filepath.Join(a.dir, "snapshot.json"), a.snapshot); err != nil {
				t.Fatal(err)
			}
			hits := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++; w.WriteHeader(code) }))
			defer srv.Close()
			if code == 0 {
				srv.Close()
			}
			withBase(srv.URL, func() { a.syncData(); a.syncData() })
			if !a.config.Offline || a.syncAvailability() != "auto_disabled" || hits > 1 {
				t.Fatalf("did not disable after failure: %+v hits=%d", a.config, hits)
			}
			after, _ := json.Marshal(a.snapshot)
			if !bytes.Equal(before, after) {
				t.Fatal("failed update changed cached catalog or timestamp")
			}
			var cfg Config
			b, err := os.ReadFile(filepath.Join(a.dir, "config.json"))
			if err != nil || json.Unmarshal(b, &cfg) != nil {
				t.Fatalf("persisted configuration: %v", err)
			}
			restarted := &App{dir: a.dir, config: cfg, snapshot: a.snapshot}
			if restarted.syncAvailability() != "auto_disabled" {
				t.Fatal("restart forgot automatic disablement")
			}
			withBase(srv.URL, func() { restarted.syncData() })
			if hits > 1 {
				t.Fatal("disabled integration sent another request")
			}
			r := a.snapshot.Catalog.Reports[0]
			if _, _, err := restarted.attachment(context.Background(), r.ID, 0); err == nil {
				t.Fatal("disabled integration served an embedded attachment")
			}
		})
	}
}

func TestGitHubSettingsDisablePreservesUnreadableCredentials(t *testing.T) {
	a := githubSettingsApp(t)
	token := []byte("opaque credential that this test cannot decrypt")
	p := filepath.Join(a.dir, "token.bin")
	if err := os.WriteFile(p, token, 0600); err != nil {
		t.Fatal(err)
	}
	cfg := a.config
	cfg.Offline = true
	w := githubSettingsRequest(t, a, "/api/install", cfg)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"ok":true`) || !a.config.Offline {
		t.Fatalf("disable failed: %d %s", w.Code, w.Body)
	}
	actual, _ := os.ReadFile(p)
	if !bytes.Equal(token, actual) {
		t.Fatal("disabling changed saved credentials")
	}
}

func TestGitHubSettingsFailedEnableAndRecovery(t *testing.T) {
	a := githubSettingsApp(t)
	a.config.Offline = true
	a.config.OfflineReason = "connection_failed"
	cfg := a.config
	cfg.Offline = false
	available := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !available {
			w.WriteHeader(503)
			return
		}
		if strings.Contains(r.URL.Path, "/commits/") {
			json.NewEncoder(w).Encode(map[string]string{"sha": strings.Repeat("b", 40)})
			return
		}
		json.NewEncoder(w).Encode(a.snapshot.Catalog)
	}))
	defer srv.Close()
	withBase(srv.URL, func() {
		for i := 0; i < 2; i++ {
			w := githubSettingsRequest(t, a, "/api/install", cfg)
			if w.Code != 200 || !strings.Contains(w.Body.String(), `"ok":true`) || !a.config.Offline || a.config.OfflineReason != "connection_failed" {
				t.Fatalf("failed enable: %d %s", w.Code, w.Body)
			}
		}
		available = true
		w := githubSettingsRequest(t, a, "/api/install", cfg)
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"ok":true`) || a.config.Offline || a.config.OfflineReason != "" || a.syncAvailability() != "ready" {
			t.Fatalf("recovery failed: %d %s", w.Code, w.Body)
		}
	})
}
