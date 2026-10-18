package hub

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func chooseGitHubForTest(a *App, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", a.address+"/api/github-choice", strings.NewReader(body))
	r.Header.Set("Origin", a.address)
	r.Header.Set("X-AV-Request", "1")
	r.AddCookie(&http.Cookie{Name: "av_session", Value: a.secret})
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	return w
}

func waitForGitHubState(t *testing.T, a *App, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		a.mu.RLock()
		state := a.syncAvailability()
		a.mu.RUnlock()
		if state == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("GitHub state did not become", want)
}

func TestGitHubChoiceBlocksNetworkUntilSaved(t *testing.T) {
	a := githubSettingsApp(t)
	a.config.GitHubChoiceVersion = "0.0.1"
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1); w.WriteHeader(503) }))
	defer srv.Close()
	body := []byte("remote attachment")
	hash := sha256.Sum256(body)
	att := Attachment{Name: "remote.md", Path: "data/reports/remote.md", SHA256: hex.EncodeToString(hash[:])}
	a.snapshot.Commit = strings.Repeat("b", 40)
	a.snapshot.Origin = a.config.Owner + "/" + a.config.Repo
	a.snapshot.Catalog.Reports[0].Attachments = []Attachment{att}
	withBase(srv.URL, func() {
		if a.config.githubEnabled() || !a.githubChoiceRequired() || a.syncAvailability() != "choice_required" {
			t.Fatal("version change not detected")
		}
		a.syncData()
		if _, _, err := a.attachment(context.Background(), a.snapshot.Catalog.Reports[0].ID, 0); err == nil {
			t.Fatal("download allowed before decision")
		}
		if hits.Load() != 0 {
			t.Fatal("GitHub contacted before decision")
		}
		if err := writeAtomic(filepath.Join(a.dir, "attachments", att.SHA256), body); err != nil {
			t.Fatal(err)
		}
		if _, _, err := a.attachment(context.Background(), a.snapshot.Catalog.Reports[0].ID, 0); err == nil {
			t.Fatal("cached attachment served before decision")
		}
	})
}

func TestGitHubChoiceDeclinePersistsAndIgnoresStaleTab(t *testing.T) {
	a := githubSettingsApp(t)
	a.config.GitHubChoiceVersion = ""
	token := []byte("opaque existing credentials")
	if err := os.WriteFile(filepath.Join(a.dir, "token.bin"), token, 0600); err != nil {
		t.Fatal(err)
	}
	w := chooseGitHubForTest(a, `{"version":"`+Version+`","enabled":false}`)
	if w.Code != 200 || !a.config.Offline || a.githubChoiceRequired() {
		t.Fatalf("decline: %d %s", w.Code, w.Body)
	}
	b, _ := os.ReadFile(filepath.Join(a.dir, "config.json"))
	var cfg Config
	if json.Unmarshal(b, &cfg) != nil || (&App{config: cfg}).githubChoiceRequired() {
		t.Fatal("decision not persisted for restart")
	}
	actual, _ := os.ReadFile(filepath.Join(a.dir, "token.bin"))
	if string(actual) != string(token) {
		t.Fatal("decision touched credentials")
	}
	w = chooseGitHubForTest(a, `{"version":"`+Version+`","enabled":true}`)
	if w.Code != 200 || !a.config.Offline {
		t.Fatal("stale tab overwrote saved choice")
	}
	cfg.GitHubChoiceVersion = "older-version"
	if !(&App{config: cfg}).githubChoiceRequired() {
		t.Fatal("later version should prompt again")
	}
}

func TestGitHubChoiceEnableChecksAndDisablesOnFailure(t *testing.T) {
	for _, available := range []bool{true, false} {
		a := githubSettingsApp(t)
		a.config.GitHubChoiceVersion = "older-version"
		a.config.Offline = true
		c := a.snapshot.Catalog
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !available {
				w.WriteHeader(503)
				return
			}
			if strings.Contains(r.URL.Path, "/commits/") {
				json.NewEncoder(w).Encode(map[string]string{"sha": strings.Repeat("b", 40)})
				return
			}
			json.NewEncoder(w).Encode(c)
		}))
		withBase(srv.URL, func() {
			w := chooseGitHubForTest(a, `{"version":"`+Version+`","enabled":true}`)
			if w.Code != 200 {
				t.Fatalf("enable: %d %s", w.Code, w.Body)
			}
			want := "ready"
			if !available {
				want = "auto_disabled"
			}
			waitForGitHubState(t, a, want)
			a.mu.RLock()
			defer a.mu.RUnlock()
			if a.githubChoiceRequired() {
				t.Fatal("answered prompt reopened after connection check")
			}
		})
		srv.Close()
	}
}

func TestGitHubChoiceInvalidOrFailedSaveKeepsPrompt(t *testing.T) {
	a := githubSettingsApp(t)
	a.config.GitHubChoiceVersion = ""
	for _, body := range []string{`{}`, `{"version":"old","enabled":true}`, `{"version":"` + Version + `","enabled":null}`} {
		w := chooseGitHubForTest(a, body)
		if w.Code < 400 || !a.githubChoiceRequired() {
			t.Fatal("invalid decision was accepted")
		}
	}
	if err := os.Mkdir(filepath.Join(a.dir, "config.json"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(a.dir, "config.json", "keep"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	w := chooseGitHubForTest(a, `{"version":"`+Version+`","enabled":false}`)
	if w.Code != 500 || !a.githubChoiceRequired() || a.config.Offline {
		t.Fatalf("failed save changed choice: %d", w.Code)
	}
}

func TestGitHubChoiceExplicitSettingsAlsoRecordsVersion(t *testing.T) {
	a := githubSettingsApp(t)
	a.config.GitHubChoiceVersion = "older-version"
	cfg := a.config
	cfg.Offline = true
	w := githubSettingsRequest(t, a, "/api/install", cfg)
	if w.Code != 200 || a.githubChoiceRequired() {
		t.Fatalf("explicit settings did not record decision: %s", w.Body)
	}
	// Automatic setup preserves the previous version marker for the viewer prompt.
	a.setup = true
	a.config.GitHubChoiceVersion = "older-version"
	r := httptest.NewRequest("POST", "/api/install", strings.NewReader(`{"owner":"graycoral","repo":"DailyReportAnalysis","branch":"main","sync_time":"08:00","automatic":true,"github_choice_version":"`+Version+`"}`))
	s, err := a.settings(r)
	if err != nil || s.GitHubChoiceVersion != "older-version" {
		t.Fatal("automatic setup acknowledged a choice that was not made", err)
	}
}
