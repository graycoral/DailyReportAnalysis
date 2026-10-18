//go:build windows

package hub

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
)

func connectionsFixture(t *testing.T) (*App, OutlookSource) {
	t.Helper()
	a := localApp(t)
	source := OutlookSource{Name: "업무", StoreID: "00AA", FolderID: "00BB", FolderName: "업무"}
	if e := a.editLocal(func(x *LocalIndex) error { x.Sources = []OutlookSource{source}; return nil }); e != nil {
		t.Fatal(e)
	}
	return a, source
}
func readConnectionsResponse(t *testing.T, a *App) connectionsView {
	t.Helper()
	w := call(t, a.routes(), "GET", "/api/local/connections", "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	var v connectionsView
	if e := json.Unmarshal(w.Body.Bytes(), &v); e != nil {
		t.Fatal(e)
	}
	return v
}
func TestOrdinaryMailConnectionsOfflineLifecycle(t *testing.T) {
	a, _ := connectionsFixture(t)
	before := a.snapshot.Catalog
	batch := outlookBatch{Items: []outlookDocument{
		{FolderID: "00BB", Mail: MailRef{EntryID: "00CC", StoreID: "00AA", Subject: "기밀-사내 AV-2026-004 검토", Received: "2026-10-18T09:00:00", Folder: "업무"}, Body: "Ordinary secret body must not be saved"},
		{FolderID: "00BB", Mail: MailRef{EntryID: "00DD", StoreID: "00AA", Subject: "기밀-사내 AV-2026-004 결과", Received: "2026-10-18T10:00:00", Folder: "업무"}},
	}, Cursors: map[string]outlookCursor{"00BB": {Time: "2026-10-18T10:00:00", IDs: []string{"00DD"}}}}
	a.importOutlookWith(func(_ context.Context, _ outlookReq, out any) error { *out.(*outlookBatch) = batch; return nil })
	x, e := a.viewReports()
	if e != nil || len(x.Reports) != 0 {
		t.Fatal("ordinary mail became a report", e, x)
	}
	v := readConnectionsResponse(t, a)
	if v.IndexedMails != 2 {
		t.Fatal(v.IndexedMails)
	}
	var candidate *documentConnection
	for i := range v.Connections {
		if strings.HasPrefix(v.Connections[i].From, "mail:") && strings.HasPrefix(v.Connections[i].To, "mail:") {
			candidate = &v.Connections[i]
			break
		}
	}
	if candidate == nil {
		t.Fatal("missing identifier candidate", v.Connections)
	}
	postDecision := func(status string) {
		t.Helper()
		b, _ := json.Marshal(map[string]string{"action": "decision", "from": candidate.From, "to": candidate.To, "status": status})
		w := call(t, a.routes(), "POST", "/api/local/connections", string(b))
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body)
		}
	}
	postDecision("rejected")
	// Re-open the application against the same Windows-encrypted files.
	restarted := localApp(t)
	restarted.dir = a.dir
	a = restarted
	v = readConnectionsResponse(t, a)
	found := false
	for _, c := range v.Connections {
		if c.ID == candidate.ID {
			found = c.Status == "rejected"
		}
	}
	if !found {
		t.Fatal("excluded suggestion returned after restart")
	}
	postDecision("accepted")
	v = readConnectionsResponse(t, a)
	found = false
	for _, c := range v.Connections {
		if c.ID == candidate.ID {
			found = c.Status == "accepted" && len(c.Reasons) > 0
		}
	}
	if !found {
		t.Fatal("accept missing")
	}
	if !reflect.DeepEqual(before, a.snapshot.Catalog) {
		t.Fatal("modified published graph")
	}
	b, e := os.ReadFile(a.connectionPath())
	if e != nil || strings.Contains(string(b), "기밀-사내") {
		t.Fatal("plaintext metadata on disk", e)
	}
	plain, e := unprotect(b)
	if e != nil || strings.Contains(string(plain), "Ordinary secret body") {
		t.Fatal("ordinary body persisted", e)
	}
	for _, endpoint := range []string{"/api/state", "/api/status"} {
		w := call(t, a.routes(), "GET", endpoint, "")
		if strings.Contains(w.Body.String(), "기밀-사내") {
			t.Fatal("metadata exposed in " + endpoint)
		}
	}
	postDecision("reset")
	v = readConnectionsResponse(t, a)
	for _, c := range v.Connections {
		if c.ID == candidate.ID && c.Status != "suggested" {
			t.Fatal("reset failed")
		}
	}
	if e = a.editLocal(func(x *LocalIndex) error { x.Sources = nil; return nil }); e != nil {
		t.Fatal(e)
	}
	v = readConnectionsResponse(t, a)
	if v.IndexedMails != 0 {
		t.Fatal("removed source remains in recommendations")
	}
}
func TestConnectionsCorruptionAndHTTPValidation(t *testing.T) {
	a, _ := connectionsFixture(t)
	h := a.routes()
	for _, body := range []string{`{"action":"decision","from":"madeup","to":"also-madeup","status":"accepted"}`, `{"action":"dictionary","aliases":[{"kind":"company","name":"A"}]}`} {
		if w := call(t, h, "POST", "/api/local/connections", body); w.Code != 400 {
			t.Fatal(w.Code, w.Body)
		}
	}
	if w := call(t, h, http.MethodDelete, "/api/local/connections", ""); w.Code != http.StatusForbidden {
		t.Fatal(w.Code)
	}
	bad := []byte("unreadable encrypted store")
	if e := os.WriteFile(a.connectionPath(), bad, 0600); e != nil {
		t.Fatal(e)
	}
	if w := call(t, h, "POST", "/api/local/connections", `{"action":"dictionary","aliases":[]}`); w.Code != 400 {
		t.Fatal(w.Code)
	}
	got, _ := os.ReadFile(a.connectionPath())
	if string(got) != string(bad) {
		t.Fatal("overwrote corrupt index")
	}
}
func TestConnectionAttachmentFingerprint(t *testing.T) {
	a, _ := connectionsFixture(t)
	f, e := a.addPDF("다른 이름.pdf", []byte(secretPDF))
	if e != nil {
		t.Fatal(e)
	}
	a.importOutlookWith(func(_ context.Context, _ outlookReq, out any) error {
		*out.(*outlookBatch) = outlookBatch{Items: []outlookDocument{{FolderID: "00BB", Mail: MailRef{EntryID: "00CC", StoreID: "00AA", Subject: "파일 전달"}, Fingerprints: []mailFingerprint{{Name: "원본.pdf", SHA256: digest(secretPDF)}}}}}
		return nil
	})
	v := readConnectionsResponse(t, a)
	found := false
	for _, c := range v.Connections {
		if c.From == "pdf:"+f.ID || c.To == "pdf:"+f.ID {
			for _, r := range c.Reasons {
				found = found || r.Kind == "file"
			}
		}
	}
	if !found {
		t.Fatal("identical attachment/PDF not linked")
	}
}
