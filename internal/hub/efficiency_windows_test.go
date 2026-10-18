//go:build windows

package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestOutlookNoChangeAndCursorOnlyKeepReportRevision(t *testing.T) {
	a := localApp(t)
	source := OutlookSource{Name: "Reports", StoreID: "00AA", FolderID: "00BB", FolderName: "Reports"}
	if err := a.editLocal(func(x *LocalIndex) error { x.Sources = []OutlookSource{source}; return nil }); err != nil {
		t.Fatal(err)
	}
	if _, _, err := a.importMarkdown("report.md", []byte(importFixture)); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(a.reportPath())
	revision := a.localReportRevision()
	batch := outlookBatch{Cursors: map[string]outlookCursor{"00BB": {Time: "2026-10-16T08:00:00", IDs: []string{"00CC"}}}}
	run := func(_ context.Context, _ outlookReq, out any) error { *out.(*outlookBatch) = batch; return nil }
	a.importOutlookWith(run)
	cursorBefore, err := os.ReadFile(a.cursorPath())
	if err != nil {
		t.Fatal(err)
	}
	a.importOutlookWith(run)
	after, _ := os.ReadFile(a.reportPath())
	cursorAfter, _ := os.ReadFile(a.cursorPath())
	if !bytes.Equal(before, after) || a.localReportRevision() != revision {
		t.Fatal("cursor-only import rewrote report bodies")
	}
	if !bytes.Equal(cursorBefore, cursorAfter) {
		t.Fatal("unchanged cursor was re-encrypted")
	}
	x, err := (&App{dir: a.dir}).viewReports()
	if err != nil || x.Cursors["00BB"].Time != batch.Cursors["00BB"].Time || len(x.Reports) != 1 {
		t.Fatalf("restart: %+v %v", x, err)
	}
}

func TestMarkdownBatchMixedResultsAndNoopPersistence(t *testing.T) {
	a := localApp(t)
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, file := range []markdownFile{{"one.md", []byte(importFixture)}, {"two.md", []byte(strings.ReplaceAll(importFixture, "2026-10-15", "2026-10-16"))}, {"bad.md", []byte("bad")}, {"duplicate.md", []byte(importFixture)}} {
		part, err := writer.CreateFormFile("files", file.Name)
		if err != nil {
			t.Fatal(err)
		}
		part.Write(file.Body)
	}
	writer.Close()
	r := httptest.NewRequest("POST", "/api/local/reports/import-batch", &body)
	r.Host = "127.0.0.1:9000"
	r.Header.Set("Content-Type", writer.FormDataContentType())
	r.Header.Set("Origin", a.address)
	r.Header.Set("X-AV-Request", "1")
	r.AddCookie(&http.Cookie{Name: "av_session", Value: a.secret})
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	var result struct {
		Results []markdownResult `json:"results"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil {
		t.Fatalf("batch: %d %s", w.Code, w.Body)
	}
	for i, status := range []string{"added", "added", "error", "unchanged"} {
		if result.Results[i].Status != status {
			t.Fatalf("results: %+v", result.Results)
		}
	}
	x, err := a.viewReports()
	if err != nil || len(x.Reports) != 2 {
		t.Fatalf("archive: %+v %v", x, err)
	}
	before, _ := os.ReadFile(a.reportPath())
	if _, err = a.importMarkdownBatch([]markdownFile{{"one.md", []byte(importFixture)}}); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(a.reportPath())
	if !bytes.Equal(before, after) {
		t.Fatal("identical batch rewrote archive")
	}
}
