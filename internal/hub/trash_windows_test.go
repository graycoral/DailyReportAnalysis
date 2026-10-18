//go:build windows

package hub

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPDFTrashRestoreAndPermanentDeletion(t *testing.T) {
	a := localApp(t)
	f, err := a.addPDF("trash.pdf", []byte(secretPDF))
	if err != nil {
		t.Fatal(err)
	}
	request := func(action, id string, intended int) {
		t.Helper()
		w := visibilityRequest(a, "POST", "/api/local/trash", `{"kind":"pdf","action":"`+action+`","id":"`+id+`"}`)
		if w.Code != intended {
			t.Fatalf("%s: %d %s", action, w.Code, w.Body)
		}
	}
	request("trash", f.ID, 200)
	x, err := a.viewLocal()
	if err != nil || len(x.Files) != 0 {
		t.Fatalf("visible trash: %+v %v", x, err)
	}
	if _, err = os.Stat(a.blobPath(f.ID)); err != nil {
		t.Fatal("trash lost encrypted content", err)
	}
	if _, _, err = a.readPDF(f.ID); err == nil {
		t.Fatal("trash remains accessible through file endpoint")
	}
	request("restore", f.ID, 200)
	b, _, err := a.readPDF(f.ID)
	if err != nil || string(b) != secretPDF {
		t.Fatal("restore changed content", err)
	}
	request("delete", "../outside", 400)
	request("trash", f.ID, 200)
	request("delete", f.ID, 200)
	if _, err = os.Stat(a.blobPath(f.ID)); !os.IsNotExist(err) {
		t.Fatal("permanent delete retained blob", err)
	}
	request("restore", f.ID, 400)
}

func TestReportBatchTrashAndPermanentDeletion(t *testing.T) {
	a := visibilityApp(t)
	id := a.snapshot.Catalog.Reports[0].ID
	other := a.snapshot.Catalog.Reports[1].ID
	req := func(endpoint, body string, code int) {
		t.Helper()
		w := visibilityRequest(a, "POST", endpoint, body)
		if w.Code != code {
			t.Fatalf("%s: %d %s", endpoint, w.Code, w.Body)
		}
	}
	req("/api/report-visibility", `{"action":"hide","report_ids":["`+id+`","missing"]}`, 404)
	if len(a.reportVisibility().HiddenReports) != 0 {
		t.Fatal("invalid batch partially hid reports")
	}
	req("/api/report-visibility", `{"action":"hide","report_ids":["`+id+`","`+other+`"]}`, 200)
	req("/api/reports/delete", `{"report_ids":["`+id+`"]}`, 200)
	req("/api/report-visibility", `{"action":"restore-all"}`, 200)
	v := a.reportVisibility()
	if len(v.DeletedReports) != 1 || v.DeletedReports[0] != id {
		t.Fatal("restore-all discarded permanent deletion", v)
	}
	for _, r := range a.snapshot.Catalog.Reports {
		if r.ID == id {
			t.Fatal("deleted report remains in snapshot")
		}
	}
	raw, err := os.ReadFile(filepath.Join(a.dir, "snapshot.json"))
	if err != nil {
		t.Fatal(err)
	}
	var saved Snapshot
	if err = json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	for _, r := range saved.Catalog.Reports {
		if r.ID == id {
			t.Fatal("deleted body remains on disk")
		}
	}
	// A subsequently published copy is excluded before being cached again.
	if len(withoutReports(Catalog{Reports: []Report{{ID: id}, {ID: other}}}, v.DeletedReports).Reports) != 1 {
		t.Fatal("sync resurrected deleted content")
	}
}

func TestNotePurgeVersionAndHistory(t *testing.T) {
	a := localApp(t)
	root, err := a.notesRoot()
	if err != nil {
		t.Fatal(err)
	}
	n, err := a.noteSave(root, noteInput{Path: "purge.md", Body: "first"})
	if err != nil {
		t.Fatal(err)
	}
	original := n
	n, err = a.noteSave(root, noteInput{ID: n.ID, Path: n.Path, Body: "second", Version: n.Version})
	if err != nil {
		t.Fatal(err)
	}
	request := func(id, version string, code int) {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"id": id, "version": version})
		w := visibilityRequest(a, "POST", "/api/notes/purge", string(body))
		if w.Code != code {
			t.Fatalf("purge: %d %s", w.Code, w.Body)
		}
	}
	request(n.ID, original.Version, 409)
	request("../outside", "", 400)
	request(n.ID, n.Version, 200)
	if _, err = os.Stat(filepath.Join(root, n.Path)); !os.IsNotExist(err) {
		t.Fatal("note retained", err)
	}
	if _, err = os.Stat(filepath.Join(root, ".avhub", "history", n.ID)); !os.IsNotExist(err) {
		t.Fatal("history retained", err)
	}
	w := visibilityRequest(a, "GET", "/api/notes/trash", "")
	if strings.Contains(w.Body.String(), n.ID) {
		t.Fatal("purged note is restorable")
	}
}
