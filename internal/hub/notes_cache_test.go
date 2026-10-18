package hub

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNotesIncrementalListingAndExternalChanges(t *testing.T) {
	a := &App{dir: t.TempDir()}
	root, _ := a.notesRoot()
	first, err := a.noteSave(root, noteInput{Path: "first.md", Body: strings.Repeat("large body ", 4000)})
	if err != nil {
		t.Fatal(err)
	}
	second, err := a.noteSave(root, noteInput{Path: "second.md", Body: "second"})
	if err != nil {
		t.Fatal(err)
	}
	list := func(since string) (noteListing, int) {
		t.Helper()
		w := httptest.NewRecorder()
		a.notesHandler(w, httptest.NewRequest("GET", "/api/notes?since="+url.QueryEscape(since), nil))
		if w.Code != 200 {
			t.Fatal(w.Body)
		}
		var v noteListing
		if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
			t.Fatal(err)
		}
		return v, w.Body.Len()
	}
	initial, _ := list("")
	if initial.Delta || len(initial.Notes) != 2 || initial.Revision == "" {
		t.Fatal(initial)
	}
	before := a.notesCache.files[first.Path].note.raw
	unchanged, size := list(initial.Revision)
	if !unchanged.Delta || len(unchanged.Notes) != 0 || len(unchanged.Deleted) != 0 || size > 1024 {
		t.Fatal("unchanged poll resent documents", size)
	}
	if &before[0] != &a.notesCache.files[first.Path].note.raw[0] {
		t.Fatal("unchanged file was reread")
	}
	second, err = a.noteSave(root, noteInput{ID: second.ID, Path: second.Path, Version: second.Version, Body: "updated"})
	if err != nil {
		t.Fatal(err)
	}
	delta, size := list(initial.Revision)
	if !delta.Delta || len(delta.Notes) != 1 || delta.Notes[0].Body != "updated" || size > 2048 {
		t.Fatal("save delta included unchanged bodies", size)
	}
	// A rename by an external editor preserves avhub_id. A direct GET must find
	// the new path even before the next list poll.
	if err := os.Rename(filepath.Join(root, second.Path), filepath.Join(root, "moved.md")); err != nil {
		t.Fatal(err)
	}
	moved, err := a.noteGet(root, second.ID)
	if err != nil || moved.Path != "moved.md" {
		t.Fatal(moved, err)
	}
	if err := os.Remove(filepath.Join(root, first.Path)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "external.md"), []byte("external note"), 0600); err != nil {
		t.Fatal(err)
	}
	changed, _ := list(delta.Revision)
	if !changed.Delta || len(changed.Notes) != 2 || len(changed.Deleted) != 1 || changed.Deleted[0] != first.ID {
		t.Fatal(changed)
	}
	if _, err := a.noteGet(root, first.ID); !os.IsNotExist(err) {
		t.Fatal("deleted note remained addressable", err)
	}
	otherRoot := t.TempDir()
	if err := writeJSON(filepath.Join(a.dir, "notes-settings.json"), map[string]string{"root": otherRoot}); err != nil {
		t.Fatal(err)
	}
	reset, _ := list(changed.Revision)
	if reset.Delta || len(reset.Notes) != 0 || reset.Root != otherRoot {
		t.Fatal("old vault delta reused", reset)
	}
}

func TestNotesSingleFileValidationDoesNotTrustCachedTimestamp(t *testing.T) {
	a := &App{dir: t.TempDir()}
	root, _ := a.notesRoot()
	n, err := a.noteSave(root, noteInput{Path: "target.md", Body: "before"})
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(root, n.Path)
	info, _ := os.Stat(p)
	raw := bytes.Replace(n.raw, []byte("before"), []byte("AFTER!"), 1)
	if err := os.WriteFile(p, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(p, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if _, err := a.noteSave(root, noteInput{ID: n.ID, Path: n.Path, Version: n.Version, Body: "overwrite"}); err != errNoteConflict {
		t.Fatal("same-size same-time external edit overwritten", err)
	}
	actual, err := a.noteGet(root, n.ID)
	if err != nil || actual.Body != "AFTER!" {
		t.Fatal(actual, err)
	}
	if err := os.Remove(p); err != nil {
		t.Fatal(err)
	}
	recreated, err := a.noteSave(root, noteInput{Path: n.Path, Body: "new document"})
	if err != nil || recreated.ID == n.ID {
		t.Fatal("stale cache blocked recreating an externally deleted path", err)
	}
}

func TestNotesCacheRejectsDuplicateIDsAndSymlinks(t *testing.T) {
	a := &App{dir: t.TempDir()}
	root, _ := a.notesRoot()
	n, err := a.noteSave(root, noteInput{Path: "target.md", Body: "inside"})
	if err != nil {
		t.Fatal(err)
	}
	copyPath := filepath.Join(root, "copy.md")
	if err := os.WriteFile(copyPath, n.raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := a.noteList(root, ""); err == nil {
		t.Fatal("duplicate ID accepted")
	}
	if err := os.Remove(copyPath); err != nil {
		t.Fatal(err)
	}
	if _, err := a.noteList(root, ""); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside.md")
	os.WriteFile(outside, n.raw, 0600)
	os.Remove(filepath.Join(root, n.Path))
	if err := os.Symlink(outside, filepath.Join(root, n.Path)); err != nil {
		t.Skip("symlinks unavailable", err)
	}
	if _, err := a.noteGet(root, n.ID); err == nil {
		t.Fatal("cached path followed a symlink")
	}
}

func TestNotesRenameReferenceDefinitions(t *testing.T) {
	a := &App{dir: t.TempDir()}
	root, _ := a.notesRoot()
	target, err := a.noteSave(root, noteInput{Path: "old/target.md", Body: "![image][pic]\n\n[pic]: ../첨부/photo.png \"사진\"\n"})
	if err != nil {
		t.Fatal(err)
	}
	body := "[reference][doc] [collapsed][] [short]\n\n[doc]: old/target.md#part \"title\"\n[collapsed]: <old/target.md> 'title'\n[short]:\n  old/target.md\n[external]: https://example.com/old/target.md\n\n```md\n[code]: old/target.md\n```\n\n    [indent]: old/target.md\n`[inline]: old/target.md`\n"
	ref, err := a.noteSave(root, noteInput{Path: "references.md", Body: body})
	if err != nil {
		t.Fatal(err)
	}
	renamed, err := a.noteSave(root, noteInput{ID: target.ID, Path: "new/renamed note.md", Version: target.Version, Body: target.Body})
	if err != nil {
		t.Fatal(err)
	}
	ref, err = a.noteGet(root, ref.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"[doc]: new/renamed%20note.md#part \"title\"", "[collapsed]: <new/renamed%20note.md> 'title'", "[short]:\n  new/renamed%20note.md", "[external]: https://example.com/old/target.md", "[code]: old/target.md", "[indent]: old/target.md", "`[inline]: old/target.md`"} {
		if !strings.Contains(ref.Body, want) {
			t.Fatalf("missing %q in %s", want, ref.Body)
		}
	}
	if !strings.Contains(renamed.Body, "[pic]: ../") {
		t.Fatal("moving note broke reference-style image", renamed.Body)
	}
	rootMoved, err := a.noteSave(root, noteInput{ID: renamed.ID, Path: "at-root.md", Version: renamed.Version, Body: renamed.Body})
	if err != nil {
		t.Fatal(err)
	}
	decoded, _ := url.PathUnescape(rootMoved.Body)
	if !strings.Contains(decoded, "[pic]: 첨부/photo.png \"사진\"") {
		t.Fatal(decoded)
	}
}
