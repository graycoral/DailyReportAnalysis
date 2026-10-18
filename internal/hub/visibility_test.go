package hub

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func visibilityApp(t *testing.T) *App {
	t.Helper()
	return &App{dir: t.TempDir(), secret: strings.Repeat("a", 64), address: "http://127.0.0.1:9000", config: defaultConfig(), snapshot: Snapshot{Catalog: seedCatalog(t)}}
}

func visibilityRequest(a *App, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Host = strings.TrimPrefix(a.address, "http://")
	r.Header.Set("Origin", a.address)
	r.Header.Set("X-AV-Request", "1")
	r.AddCookie(&http.Cookie{Name: "av_session", Value: a.secret})
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	return w
}

func TestReportVisibilityPersistsWithoutChangingReports(t *testing.T) {
	a := visibilityApp(t)
	before, _ := json.Marshal(a.snapshot)
	if err := writeAtomic(filepath.Join(a.dir, "snapshot.json"), before); err != nil {
		t.Fatal(err)
	}
	id := a.snapshot.Catalog.Reports[0].ID
	body := `{"action":"hide","report_id":"` + id + `"}`
	for i := 0; i < 2; i++ {
		if w := visibilityRequest(a, "POST", "/api/report-visibility", body); w.Code != 200 {
			t.Fatalf("hide: %d %s", w.Code, w.Body)
		}
	}
	// A new process/port and an updated snapshot retain the user's choice.
	restarted := visibilityApp(t)
	restarted.dir = a.dir
	restarted.address = "http://127.0.0.1:9001"
	restarted.snapshot.Commit = "new-commit"
	for _, endpoint := range []string{"/api/state", "/api/status"} {
		w := visibilityRequest(restarted, "GET", endpoint, "")
		var got struct {
			Visibility reportVisibility `json:"report_visibility"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got.Visibility.HiddenReports, []string{id}) {
			t.Fatalf("%s: %+v", endpoint, got)
		}
	}
	otherUser := visibilityApp(t)
	if len(otherUser.reportVisibility().HiddenReports) != 0 {
		t.Fatal("another user inherited hidden reports")
	}
	// Restore also clears IDs absent from the current published catalog.
	restarted.snapshot.Catalog.Reports = nil
	if w := visibilityRequest(restarted, "POST", "/api/report-visibility", `{"action":"restore-all"}`); w.Code != 200 {
		t.Fatalf("restore: %d %s", w.Code, w.Body)
	}
	if len(a.reportVisibility().HiddenReports) != 0 {
		t.Fatal("restore was not persisted")
	}
	after, _ := json.Marshal(a.snapshot)
	onDisk, err := os.ReadFile(filepath.Join(a.dir, "snapshot.json"))
	if err != nil || string(before) != string(after) || string(before) != string(onDisk) {
		t.Fatal("hiding or restoring changed the published snapshot")
	}
}

func TestReportVisibilityConcurrentHides(t *testing.T) {
	a := visibilityApp(t)
	var wg sync.WaitGroup
	for _, report := range a.snapshot.Catalog.Reports {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			w := visibilityRequest(a, "POST", "/api/report-visibility", `{"action":"hide","report_id":"`+id+`"}`)
			if w.Code != 200 {
				t.Errorf("hide: %d %s", w.Code, w.Body)
			}
		}(report.ID)
	}
	wg.Wait()
	if got := len(a.reportVisibility().HiddenReports); got != len(a.snapshot.Catalog.Reports) {
		t.Fatalf("concurrent requests lost a choice: %d", got)
	}
}

func TestReportVisibilitySelectedRestorePreservesOtherChoices(t *testing.T) {
	a := visibilityApp(t)
	first, second := a.snapshot.Catalog.Reports[0].ID, a.snapshot.Catalog.Reports[1].ID
	path := filepath.Join(a.dir, "report-visibility.json")
	if err := writeJSON(path, reportVisibility{HiddenReports: []string{first, second, "retired-id"}}); err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(a.snapshot)
	for i := 0; i < 2; i++ { // Repeated restore is idempotent, including removed catalog entries.
		body := `{"action":"restore","report_ids":["` + first + `","` + first + `","retired-id","already-visible"]}`
		if w := visibilityRequest(a, "POST", "/api/report-visibility", body); w.Code != 200 {
			t.Fatalf("selected restore: %d %s", w.Code, w.Body)
		}
	}
	if got := a.reportVisibility().HiddenReports; !reflect.DeepEqual(got, []string{second}) {
		t.Fatalf("unselected report changed: %v", got)
	}
	restarted := visibilityApp(t)
	restarted.dir = a.dir
	if got := restarted.reportVisibility().HiddenReports; !reflect.DeepEqual(got, []string{second}) {
		t.Fatalf("selection was not persisted: %v", got)
	}
	after, _ := json.Marshal(a.snapshot)
	if string(before) != string(after) {
		t.Fatal("selected restore modified the published catalog")
	}
}

func TestReportVisibilityConcurrentHideAndRestore(t *testing.T) {
	a := visibilityApp(t)
	first, second := a.snapshot.Catalog.Reports[0].ID, a.snapshot.Catalog.Reports[1].ID
	if err := writeJSON(filepath.Join(a.dir, "report-visibility.json"), reportVisibility{HiddenReports: []string{first}}); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for _, body := range []string{`{"action":"restore","report_ids":["` + first + `"]}`, `{"action":"hide","report_id":"` + second + `"}`} {
		wg.Add(1)
		go func(body string) {
			defer wg.Done()
			if w := visibilityRequest(a, "POST", "/api/report-visibility", body); w.Code != 200 {
				t.Errorf("change: %d %s", w.Code, w.Body)
			}
		}(body)
	}
	wg.Wait()
	if got := a.reportVisibility().HiddenReports; !reflect.DeepEqual(got, []string{second}) {
		t.Fatalf("concurrent change was lost: %v", got)
	}
}

func TestReportVisibilityRejectsInvalidRequestsAndStorageFailures(t *testing.T) {
	a := visibilityApp(t)
	for _, tc := range []struct {
		method, body string
		code         int
	}{
		{"GET", "", 405}, {"POST", "{", 400}, {"POST", `{"action":"delete"}`, 400},
		{"POST", `{"action":"hide","report_id":"../missing"}`, 404},
		{"POST", `{"action":"restore","report_ids":[]}`, 400},
		{"POST", `{"action":"restore","report_ids":"bad-type"}`, 400},
	} {
		if w := visibilityRequest(a, tc.method, "/api/report-visibility", tc.body); w.Code != tc.code {
			t.Fatalf("%+v: %d", tc, w.Code)
		}
	}
	path := filepath.Join(a.dir, "report-visibility.json")
	if err := os.WriteFile(path, []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if a.reportVisibility().Error == "" {
		t.Fatal("unreadable settings were silently ignored")
	}
	if w := visibilityRequest(a, "POST", "/api/report-visibility", `{"action":"hide","report_id":"`+a.snapshot.Catalog.Reports[0].ID+`"}`); w.Code != 500 {
		t.Fatal("unreadable settings were overwritten")
	}
	if w := visibilityRequest(a, "POST", "/api/report-visibility", `{"action":"restore","report_ids":["one"]}`); w.Code != 500 {
		t.Fatal("selective restore overwrote unreadable settings")
	}
	if b, _ := os.ReadFile(path); string(b) != "broken" {
		t.Fatal("unreadable settings were changed")
	}
	if w := visibilityRequest(a, "POST", "/api/report-visibility", `{"action":"restore-all"}`); w.Code != 200 || a.reportVisibility().Error != "" {
		t.Fatal("explicit restore did not repair settings")
	}
	// A file where the data directory should be makes saving fail on all OSes.
	a.dir = path
	if w := visibilityRequest(a, "POST", "/api/report-visibility", `{"action":"restore-all"}`); w.Code != 500 {
		t.Fatal("failed save reported success")
	}
}
