package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestInitialSnapshotDoesNotProvisionBundledReports(t *testing.T) {
	for _, kind := range []string{"fresh", "bundled", "corrupt", "synced"} {
		t.Run(kind, func(t *testing.T) {
			a := githubSettingsApp(t)
			want := a.snapshot
			path := filepath.Join(a.dir, "snapshot.json")
			switch kind {
			case "bundled":
				want.Origin, want.Commit = "bundled", ""
				if err := writeJSON(path, want); err != nil {
					t.Fatal(err)
				}
			case "synced":
				if err := writeJSON(path, want); err != nil {
					t.Fatal(err)
				}
			case "corrupt":
				if err := os.WriteFile(path, []byte("invalid"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			a.loadSnapshot()
			if kind == "synced" {
				if a.snapshot.Commit != want.Commit || len(a.snapshot.Catalog.Reports) == 0 {
					t.Fatal("synced cache not restored")
				}
			} else if len(a.snapshot.Catalog.Reports) != 0 || a.snapshot.Catalog.Database != nil {
				t.Fatal("unsynced installation contains published reports")
			}
			if _, err := os.Stat(filepath.Join(a.dir, "databases")); !os.IsNotExist(err) {
				t.Fatal("startup provisioned a database")
			}
		})
	}
}

func TestGitHubReportsRequireEnabledSyncedSource(t *testing.T) {
	for _, mode := range []string{"enabled", "offline", "failed", "unconfigured", "choice", "bundled", "other-repo"} {
		t.Run(mode, func(t *testing.T) {
			a := githubSettingsApp(t)
			r := a.snapshot.Catalog.Reports[0]
			a.snapshot.SyncedAt = "2026-10-18T08:00:00+09:00"
			switch mode {
			case "offline":
				a.config.Offline = true
			case "failed":
				a.config.Offline, a.config.OfflineReason = true, "connection_failed"
			case "unconfigured":
				a.config.Configured = false
			case "choice":
				a.config.GitHubChoiceVersion = "older"
			case "bundled":
				a.snapshot.Origin, a.snapshot.Commit = "bundled", ""
			case "other-repo":
				a.config.Repo = "Other"
			}
			before, _ := json.Marshal(a.snapshot)
			if err := writeJSON(filepath.Join(a.dir, "snapshot.json"), a.snapshot); err != nil {
				t.Fatal(err)
			}
			for _, endpoint := range []string{"/api/state", "/api/status", "/api/download?id=" + r.ID + "&index=0"} {
				w := visibilityRequest(a, "GET", endpoint, "")
				if endpoint == "/api/state" {
					var view struct {
						Snapshot Snapshot `json:"snapshot"`
					}
					if err := json.Unmarshal(w.Body.Bytes(), &view); err != nil {
						t.Fatal(err)
					}
					c := view.Snapshot.Catalog
					if mode == "enabled" {
						if len(c.Reports) == 0 {
							t.Fatal("enabled reports absent")
						}
					} else if len(c.Reports)+len(c.Events)+len(c.Relations)+len(c.Entities)+len(c.Related) != 0 || c.Database != nil || view.Snapshot.Commit != "" {
						t.Fatal("disabled source leaked into catalog", mode)
					}
					if mode == "offline" && view.Snapshot.SyncedAt != a.snapshot.SyncedAt {
						t.Fatal("disabling lost the last successful check time")
					}
				} else if endpoint == "/api/status" {
					var status struct {
						Commit string `json:"commit"`
					}
					if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil {
						t.Fatal(err)
					}
					if (status.Commit != "") != (mode == "enabled") {
						t.Fatal("poll cannot detect source visibility change")
					}
				} else if mode == "enabled" && w.Code != 200 || mode != "enabled" && w.Code != 404 {
					t.Fatal("download policy mismatch", w.Code)
				}
			}
			after, _ := os.ReadFile(filepath.Join(a.dir, "snapshot.json"))
			var restored Snapshot
			if err := json.Unmarshal(after, &restored); err != nil {
				t.Fatal(err)
			}
			after, _ = json.Marshal(restored)
			if !bytes.Equal(before, after) {
				t.Fatal("visibility changed the saved snapshot")
			}
		})
	}
}

func TestFirstGitHubSyncOnlyDownloadsAfterEnabled(t *testing.T) {
	a := githubSettingsApp(t)
	catalog := a.snapshot.Catalog
	a.loadSnapshot()
	a.config.Offline = true
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if r.URL.Path == "/repos/graycoral/DailyReportAnalysis/commits/main" {
			json.NewEncoder(w).Encode(map[string]string{"sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"})
		} else {
			json.NewEncoder(w).Encode(catalog)
		}
	}))
	defer srv.Close()
	withBase(srv.URL, func() {
		a.syncData()
		if hits != 0 || len(a.githubSnapshot().Catalog.Reports) != 0 {
			t.Fatal("disabled source downloaded reports")
		}
		a.config.Offline = false
		a.syncData()
		if hits != 2 || len(a.githubSnapshot().Catalog.Reports) == 0 {
			t.Fatal("enabled source did not sync", a.status)
		}
		a.config.Offline = true
		a.syncData()
		if hits != 2 || len(a.githubSnapshot().Catalog.Reports) != 0 {
			t.Fatal("disable did not hide/stop sync")
		}
		r := catalog.Reports[0]
		if _, _, err := a.attachment(context.Background(), r.ID, 0); err == nil {
			t.Fatal("disabled attachment served")
		}
		a.config.Offline = false
		if len(a.githubSnapshot().Catalog.Reports) == 0 {
			t.Fatal("cache lost on re-enable")
		}
	})
}
