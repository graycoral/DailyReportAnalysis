package hub

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNotesRoundTripConflictAndRename(t *testing.T) {
	a := &App{dir: t.TempDir()}
	root, e := a.notesRoot()
	if e != nil {
		t.Fatal(e)
	}
	save := func(in noteInput) Note {
		t.Helper()
		n, e := a.noteSave(root, in)
		if e != nil {
			t.Fatal(e)
		}
		return n
	}
	first := save(noteInput{Path: "분석/기업 A.md", Body: "---\ncustom: keep\n---\n# 한글\n![캡처](../첨부/test.png)\n", Tags: []string{"분석"}, Reports: []string{"report-1"}})
	b, e := os.ReadFile(filepath.Join(root, filepath.FromSlash(first.Path)))
	if e != nil || !bytes.Contains(b, []byte("avhub_reports: [\"report-1\"]")) {
		t.Fatalf("not a portable markdown file: %v", e)
	}
	if first.Body != "---\ncustom: keep\n---\n# 한글\n![캡처](../첨부/test.png)\n" {
		t.Fatal(first.Body)
	}
	other := save(noteInput{Path: "회의.md", Body: "[[분석/기업 A#한글|회사]]\n[원본](분석/기업%20A.md)"})
	renamed := save(noteInput{ID: first.ID, Path: "새 이름.md", Version: first.Version, Body: first.Body, Tags: first.Tags, Reports: first.Reports})
	decodedBody, _ := url.PathUnescape(renamed.Body)
	if renamed.ID != first.ID || !strings.Contains(decodedBody, "(첨부/test.png)") {
		t.Fatal("move broke stable ID or image", renamed)
	}
	v, e := noteScan(root)
	if e != nil {
		t.Fatal(e)
	}
	linked, _ := noteFind(v.Notes, other.ID)
	if !strings.Contains(linked.Body, "[[새 이름#한글|회사]]") || !strings.Contains(linked.Body, "%20") {
		t.Fatal("links not rewritten", linked.Body)
	}
	if _, e = os.Stat(filepath.Join(root, filepath.FromSlash(first.Path))); !os.IsNotExist(e) {
		t.Fatal("old file remains")
	}
	if _, e = a.noteSave(root, noteInput{ID: first.ID, Path: "새 이름.md", Version: first.Version, Body: "stale"}); !errors.Is(e, errNoteConflict) {
		t.Fatal("stale save accepted", e)
	}
	file := filepath.Join(root, "새 이름.md")
	external := append([]byte{}, renamed.raw...)
	external = append(external, []byte("\n외부 편집")...)
	os.WriteFile(file, external, 0600)
	if _, e = a.noteSave(root, noteInput{ID: renamed.ID, Path: renamed.Path, Version: renamed.Version, Body: "overwrite"}); !errors.Is(e, errNoteConflict) {
		t.Fatal("external conflict not detected", e)
	}
	actual, _ := os.ReadFile(file)
	if !bytes.Equal(actual, external) {
		t.Fatal("external content lost")
	}
	if _, e = a.noteSave(root, noteInput{Path: "새 이름.md", Body: "duplicate"}); e == nil {
		t.Fatal("duplicate overwritten")
	}
}
func TestNotesHTTPRecoveryAndBoundaries(t *testing.T) {
	a := &App{dir: t.TempDir()}
	request := func(op string, in any) *httptest.ResponseRecorder {
		t.Helper()
		var body []byte
		method := "GET"
		if in != nil {
			method = "POST"
			body, _ = json.Marshal(in)
		}
		w := httptest.NewRecorder()
		a.notesHandler(w, httptest.NewRequest(method, "/api/notes"+op, bytes.NewReader(body)))
		return w
	}
	readNote := func(w *httptest.ResponseRecorder) Note {
		t.Helper()
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body)
		}
		var n Note
		if e := json.Unmarshal(w.Body.Bytes(), &n); e != nil {
			t.Fatal(e)
		}
		return n
	}
	n := readNote(request("/save", noteInput{Path: "회의.md", Body: "첫 내용"}))
	n = readNote(request("/save", noteInput{ID: n.ID, Path: n.Path, Body: "둘째 내용", Version: n.Version}))
	w := request("/history?id="+n.ID, nil)
	var history []map[string]string
	json.Unmarshal(w.Body.Bytes(), &history)
	if len(history) != 1 {
		t.Fatal(w.Body)
	}
	n = readNote(request("/restore-version", noteInput{ID: n.ID, Path: n.Path, Version: n.Version, Revision: history[0]["revision"]}))
	if n.Body != "첫 내용" {
		t.Fatal(n.Body)
	}
	if w = request("/delete", noteInput{ID: n.ID, Version: "old"}); w.Code != 409 {
		t.Fatal("stale delete", w.Code)
	}
	if w = request("/delete", noteInput{ID: n.ID, Version: n.Version}); w.Code != 200 {
		t.Fatal(w.Body)
	}
	root, _ := a.notesRoot()
	if _, e := os.Stat(filepath.Join(root, "회의.md")); !os.IsNotExist(e) {
		t.Fatal("delete failed")
	}
	readNote(request("/save", noteInput{Path: "회의.md", Body: "새 노트"}))
	restored := readNote(request("/restore-trash", noteInput{ID: n.ID}))
	if restored.ID != n.ID || restored.Path == n.Path || restored.Body != "첫 내용" {
		t.Fatal(restored)
	}
	for _, p := range []string{"../escape.md", "C:/file.md", "con.md", "a/../b.md", "a:stream.md", ".avhub/internal.md", "a./x.md"} {
		if w = request("/save", noteInput{Path: p}); w.Code != 400 {
			t.Fatalf("unsafe %s: %d", p, w.Code)
		}
	}
	if w = request("/asset?path=../secret", nil); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if w = request("/asset?path="+url.QueryEscape(restored.Path), nil); w.Code == 200 {
		t.Fatal("served Markdown as image")
	}
	if w = request("/restore-version", noteInput{ID: n.ID, Revision: "../../secret"}); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if w = request("/root", noteInput{Root: "relative"}); w.Code != 400 {
		t.Fatal(w.Code)
	}
	vault := t.TempDir()
	// Match the canonical root returned by notesRoot, including Windows 8.3 aliases.
	vault, err := filepath.EvalSymlinks(vault)
	if err != nil {
		t.Fatal(err)
	}
	if w = request("/root", noteInput{Root: vault}); w.Code != 200 {
		t.Fatal(w.Body)
	}
	if newRoot, _ := a.notesRoot(); newRoot != vault {
		t.Fatal(newRoot)
	}
	if _, e := os.Stat(filepath.Join(root, restored.Path)); e != nil {
		t.Fatal("switch moved original data", e)
	}
	repo := t.TempDir()
	os.Mkdir(filepath.Join(repo, ".git"), 0700)
	if w = request("/root", noteInput{Root: filepath.Join(repo, "notes")}); w.Code != 400 {
		t.Fatal("repository selected")
	}
	// Mutating endpoints reject GET before decoding or touching note data.
	if w = request("/delete", nil); w.Code != http.StatusMethodNotAllowed {
		t.Fatal(w.Code)
	}
}
func TestNotesCommitPreflightAndMetadata(t *testing.T) {
	// Production callers pass the canonical path obtained from notesRoot.
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(root, "a.md"), []byte("a"), 0600)
	os.WriteFile(filepath.Join(root, "b.md"), []byte("external"), 0600)
	e := noteCommit(root, []noteChange{{"a.md", []byte("a"), []byte("changed")}, {"b.md", []byte("b"), []byte("new")}})
	if !errors.Is(e, errNoteConflict) {
		t.Fatal(e)
	}
	b, _ := os.ReadFile(filepath.Join(root, "a.md"))
	if string(b) != "a" {
		t.Fatal("partial write before failed preflight")
	}
	n := noteDecode("n.md", []byte("---\r\ncustom: value\r\n---\r\n한국어\r\n"), time.Now())
	n.ID = "n-" + noteRandom()
	n.Reports = []string{"id"}
	round := noteDecode(n.Path, noteEncode(n), time.Now())
	if round.ID != n.ID || round.Body != n.Body || round.Reports[0] != "id" {
		t.Fatal("metadata did not round trip", round)
	}
	outside := t.TempDir()
	if e = os.Symlink(outside, filepath.Join(root, "link")); e == nil {
		if _, e = notePath(root, "link/escape.md"); e == nil {
			t.Fatal("symlink escape")
		}
	}
}

func TestNotesRenamePreservesCodeAndHistoryImagePaths(t *testing.T) {
	a := &App{dir: t.TempDir()}
	root, _ := a.notesRoot()
	n, e := a.noteSave(root, noteInput{Path: "폴더/원본.md", Body: "![이미지](../첨부/a.png)"})
	if e != nil {
		t.Fatal(e)
	}
	body := "[[폴더/원본]]\n`[[폴더/원본]]`\n```md\n[[폴더/원본]]\n```\n~~~\n[[폴더/원본]]\n~~~\n"
	got := noteRewrite(body, "참조.md", "참조.md", n.Path, "이동.md", n.ID, []Note{n})
	if strings.Count(got, "[[이동]]") != 1 || strings.Count(got, "[[폴더/원본]]") != 3 {
		t.Fatal(got)
	}
	updated, e := a.noteSave(root, noteInput{ID: n.ID, Path: "이동.md", Version: n.Version, Body: n.Body})
	if e != nil {
		t.Fatal(e)
	}
	entries, _ := os.ReadDir(filepath.Join(root, ".avhub", "history", n.ID))
	var revision string
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".md") {
			revision = entry.Name()
		}
	}
	input, _ := json.Marshal(noteInput{ID: n.ID, Path: updated.Path, Version: updated.Version, Revision: revision})
	w := httptest.NewRecorder()
	a.notesHandler(w, httptest.NewRequest("POST", "/api/notes/restore-version", bytes.NewReader(input)))
	if w.Code != 200 {
		t.Fatal(w.Body)
	}
	var restored Note
	json.Unmarshal(w.Body.Bytes(), &restored)
	decoded, _ := url.PathUnescape(restored.Body)
	if !strings.Contains(decoded, "(첨부/a.png)") {
		t.Fatal("history restore broke moved image", decoded)
	}
}

func TestNotesAuthenticatedRoutesAndImageValidation(t *testing.T) {
	a := &App{dir: t.TempDir(), address: "http://127.0.0.1:12345", secret: strings.Repeat("a", 64)}
	h := a.routes()
	request := func(method, target, body string, auth, origin bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, a.address+target, strings.NewReader(body))
		if auth {
			r.AddCookie(&http.Cookie{Name: "av_session", Value: a.secret})
		}
		if origin {
			r.Header.Set("Origin", a.address)
			r.Header.Set("X-AV-Request", "1")
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if w := request("GET", "/api/notes", "", false, false); w.Code != 403 {
		t.Fatal("unauthenticated read", w.Code)
	}
	if w := request("POST", "/api/notes/save", `{"path":"test.md"}`, true, false); w.Code != 403 {
		t.Fatal("cross-origin write", w.Code)
	}
	if w := request("POST", "/api/notes/save", `{"path":"test.md","body":"<script>alert(1)</script>"}`, true, true); w.Code != 200 {
		t.Fatal(w.Body)
	}
	if w := request("POST", "/api/notes/image", `<svg onload="alert(1)"></svg>`, true, true); w.Code != 400 {
		t.Fatal("active SVG accepted", w.Code)
	}
	if w := request("GET", "/api/notes/asset?path=test.md", "", true, false); w.Code == 200 {
		t.Fatal("served note content as image")
	}
	if w := request("GET", "/", "", true, false); !strings.Contains(w.Body.String(), "notes-style-nonce") || !strings.Contains(w.Header().Get("Content-Security-Policy"), "'nonce-") {
		t.Fatal("editor style nonce missing")
	}
}

func TestNotesIncompleteMarkdownHeader(t *testing.T) {
	a := &App{dir: t.TempDir()}
	root, _ := a.notesRoot()
	for i, body := range []string{"---\n수평선 아래 내용", "---\n", "---\n---\n본문"} {
		n, e := a.noteSave(root, noteInput{Path: fmt.Sprintf("문서%d.md", i), Body: body})
		if e != nil {
			t.Fatal(e)
		}
		if strings.Contains(n.Body, "avhub_id:") {
			t.Fatal("managed metadata leaked into body", n.Body)
		}
		if n.Body != body {
			t.Fatalf("body changed: %q != %q", n.Body, body)
		}
		if _, e = a.noteSave(root, noteInput{ID: n.ID, Path: n.Path, Version: n.Version, Body: n.Body + "\n추가"}); e != nil {
			t.Fatal(e)
		}
	}
}
