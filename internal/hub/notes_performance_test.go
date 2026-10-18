package hub

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func benchmarkNoteVault(b *testing.B) (*App, Note, string) {
	b.Helper()
	a := &App{dir: b.TempDir()}
	root, err := a.notesRoot()
	if err != nil {
		b.Fatal(err)
	}
	body := []byte(strings.Repeat("Markdown text. ", 2400))
	for i := 0; i < 1000; i++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("note-%04d.md", i)), body, 0600); err != nil {
			b.Fatal(err)
		}
	}
	n := noteDecode("note-0000.md", body, time.Now())
	w := httptest.NewRecorder()
	a.notesHandler(w, httptest.NewRequest("GET", "/api/notes", nil))
	if w.Code != 200 {
		b.Fatal(w.Body)
	}
	var listing noteListing
	if err := json.Unmarshal(w.Body.Bytes(), &listing); err != nil {
		b.Fatal(err)
	}
	return a, n, listing.Revision
}

func BenchmarkNotes1000(b *testing.B) {
	a, initial, revision := benchmarkNoteVault(b)
	for _, op := range []string{"get", "list", "delta", "save"} {
		b.Run(op, func(b *testing.B) {
			n := initial
			if op == "save" {
				var err error
				n, err = a.noteGet(a.notesCache.root, n.ID)
				if err != nil {
					b.Fatal(err)
				}
			}
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				w := httptest.NewRecorder()
				target := "/api/notes"
				method := "GET"
				var body []byte
				if op == "get" {
					target += "/get?id=" + n.ID
				}
				if op == "delta" {
					target += "?since=" + revision
				}
				if op == "save" {
					target += "/save"
					method = "POST"
					body, _ = json.Marshal(noteInput{ID: n.ID, Path: n.Path, Version: n.Version, Body: n.Body + "x"})
				}
				a.notesHandler(w, httptest.NewRequest(method, target, bytes.NewReader(body)))
				if w.Code != 200 {
					b.Fatal(w.Body)
				}
				if op == "save" {
					if err := json.Unmarshal(w.Body.Bytes(), &n); err != nil {
						b.Fatal(err)
					}
				}
				b.ReportMetric(float64(w.Body.Len()), "response-bytes")
			}
		})
	}
}
