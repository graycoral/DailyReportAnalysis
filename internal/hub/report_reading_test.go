package hub

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func readingRequest(a *App, action string, keys ...string) *httptest.ResponseRecorder {
	if action == "" {
		return visibilityRequest(a, "GET", "/api/report-reading", "")
	}
	b, _ := json.Marshal(map[string]any{"action": action, "read_keys": keys})
	return visibilityRequest(a, "POST", "/api/report-reading", string(b))
}

func readingView(t *testing.T, a *App) reportReading {
	t.Helper()
	w := readingRequest(a, "")
	if w.Code != 200 {
		t.Fatalf("reading state: %d %s", w.Code, w.Body)
	}
	var v reportReading
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestReportReadingBaselineAndRestart(t *testing.T) {
	a := visibilityApp(t)
	original, _ := json.Marshal(a.snapshot)
	oldKey, newKey := strings.Repeat("a", 64), strings.Repeat("b", 64)
	if v := readingView(t, a); v.Initialized || len(v.ReadKeys) != 0 {
		t.Fatalf("unexpected initial state: %+v", v)
	}
	for _, keys := range [][]string{{oldKey, oldKey}, {oldKey, newKey}} {
		if w := readingRequest(a, "initialize", keys...); w.Code != 200 {
			t.Fatalf("initialize: %d %s", w.Code, w.Body)
		}
	}
	if got := readingView(t, a); !got.Initialized || !reflect.DeepEqual(got.ReadKeys, []string{oldKey}) {
		t.Fatalf("a later refresh marked a new report read: %+v", got)
	}
	for range 2 {
		if w := readingRequest(a, "read", newKey); w.Code != 200 {
			t.Fatalf("read: %d %s", w.Code, w.Body)
		}
	}
	restarted := visibilityApp(t)
	restarted.dir = a.dir
	restarted.address = "http://127.0.0.1:9002"
	if got := readingView(t, restarted); !reflect.DeepEqual(got.ReadKeys, []string{oldKey, newKey}) {
		t.Fatalf("read history did not survive another process/port: %+v", got)
	}
	otherProfile := visibilityApp(t)
	if readingView(t, otherProfile).Initialized {
		t.Fatal("another profile inherited reading history")
	}
	after, _ := json.Marshal(a.snapshot)
	if string(after) != string(original) {
		t.Fatal("reading history changed published reports")
	}
	b, err := os.ReadFile(filepath.Join(a.dir, "report-reading.json"))
	if err != nil || strings.Contains(string(b), a.snapshot.Catalog.Reports[0].Title) {
		t.Fatal("preferences must contain only fingerprints")
	}
}

func TestReportReadingConcurrentWindows(t *testing.T) {
	a := visibilityApp(t)
	if w := readingRequest(a, "initialize"); w.Code != 200 {
		t.Fatalf("initialize: %s", w.Body)
	}
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if w := readingRequest(a, "read", fmt.Sprintf("%064x", i)); w.Code != 200 {
				t.Errorf("concurrent read: %d %s", w.Code, w.Body)
			}
		}()
	}
	wg.Wait()
	if got := readingView(t, a); len(got.ReadKeys) != 20 {
		t.Fatalf("lost concurrent changes: %+v", got)
	}
}

func TestReportReadingRejectsInvalidAndPreservesFailedWrites(t *testing.T) {
	a := visibilityApp(t)
	key := strings.Repeat("c", 64)
	if w := readingRequest(a, "read", key); w.Code != 409 {
		t.Fatalf("read before initialization: %d", w.Code)
	}
	for _, body := range []string{`{`, `{"action":"delete"}`, `{"action":"read","read_keys":[]}`, `{"action":"read","read_keys":["../private"]}`, `{"action":"initialize","read_keys":["a"]}`} {
		if w := visibilityRequest(a, "POST", "/api/report-reading", body); w.Code != 400 {
			t.Fatalf("accepted invalid input: %d %s", w.Code, body)
		}
	}
	if w := visibilityRequest(a, "DELETE", "/api/report-reading", ""); w.Code != 403 {
		t.Fatalf("unexpected method: %d", w.Code)
	}
	file := filepath.Join(a.dir, "report-reading.json")
	corrupt := []byte("broken preferences")
	if err := os.WriteFile(file, corrupt, 0600); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"", "initialize", "read"} {
		if w := readingRequest(a, action, key); w.Code != 500 {
			t.Fatalf("corrupt settings silently replaced: %d", w.Code)
		}
	}
	if got, _ := os.ReadFile(file); string(got) != string(corrupt) {
		t.Fatal("corrupt preference file was overwritten")
	}
	blocked := visibilityApp(t)
	blocked.dir = filepath.Join(blocked.dir, "not-a-directory")
	if err := os.WriteFile(blocked.dir, []byte("block"), 0600); err != nil {
		t.Fatal(err)
	}
	if w := readingRequest(blocked, "initialize", key); w.Code != 500 {
		t.Fatalf("storage failure not reported: %d", w.Code)
	}
}
