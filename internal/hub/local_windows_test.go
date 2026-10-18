//go:build windows

package hub

import (
	"bytes"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

const secretPDF = "%PDF-1.7\n사내-기밀-표식 internal-marker-42\n%%EOF"

func TestLocalPDFPreviewHTTP(t *testing.T) {
	a := localApp(t)
	f, err := a.addPDF("미리보기 보고서.pdf", []byte(secretPDF))
	if err != nil {
		t.Fatal(err)
	}
	h := a.routes()
	path := "/api/local/file?id=" + f.ID
	for _, tc := range []struct {
		name, method, query, byteRange string
		status                         int
		body, disposition, ancestors   string
	}{
		{"preview", "GET", "&view=1", "", 200, secretPDF, "inline", "'self'"},
		{"head", "HEAD", "&view=1", "", 200, "", "inline", "'self'"},
		{"page range", "GET", "&view=1", "bytes=0-7", 206, secretPDF[:8], "inline", "'self'"},
		{"download", "GET", "", "", 200, secretPDF, "attachment", "'none'"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, path+tc.query, nil)
			r.Host = "127.0.0.1:9000"
			r.AddCookie(&http.Cookie{Name: "av_session", Value: a.secret})
			if tc.byteRange != "" {
				r.Header.Set("Range", tc.byteRange)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status || w.Body.String() != tc.body {
				t.Fatalf("response: %d %q", w.Code, w.Body.String())
			}
			disposition, params, err := mime.ParseMediaType(w.Header().Get("Content-Disposition"))
			if err != nil || disposition != tc.disposition || params["filename"] != f.Name {
				t.Fatalf("disposition: %s", w.Header().Get("Content-Disposition"))
			}
			if w.Header().Get("Content-Type") != "application/pdf" || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatalf("missing PDF protections: %v", w.Header())
			}
			if !strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors "+tc.ancestors) {
				t.Fatalf("frame policy: %s", w.Header().Get("Content-Security-Policy"))
			}
			if tc.byteRange != "" && w.Header().Get("Content-Range") != "bytes 0-7/"+strconv.Itoa(len(secretPDF)) {
				t.Fatal("missing byte range metadata")
			}
			if tc.method == "HEAD" && w.Header().Get("Content-Length") != strconv.Itoa(len(secretPDF)) {
				t.Fatal("HEAD must report size without sending PDF bytes")
			}
		})
	}
	for _, method := range []string{"GET", "HEAD"} {
		r := httptest.NewRequest(method, path+"&view=1", nil)
		r.Host = "127.0.0.1:9000"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 403 || strings.Contains(w.Body.String(), "internal-marker-42") {
			t.Fatalf("unauthenticated %s: %d", method, w.Code)
		}
	}
	if w := call(t, h, "GET", "/", ""); !strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Fatal("app shell must still reject framing")
	}
	if w := call(t, h, "POST", path+"&view=1", ""); w.Code != 405 {
		t.Fatalf("PDF endpoint accepted mutation method: %d", w.Code)
	}
	if err := a.deletePDF(f.ID); err != nil {
		t.Fatal(err)
	}
	if w := call(t, h, "GET", path+"&view=1", ""); w.Code != 404 || !strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Fatal("deleted PDF must be unavailable and its error must not allow framing")
	}
}

func localApp(t *testing.T) *App {
	t.Helper()
	return githubSettingsApp(t)
}
func call(t *testing.T, h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Host = "127.0.0.1:9000"
	r.Header.Set("Origin", "http://127.0.0.1:9000")
	r.Header.Set("X-AV-Request", "1")
	r.AddCookie(&http.Cookie{Name: "av_session", Value: strings.Repeat("a", 64)})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

// Nothing the user adds may appear in plaintext on disk or in any catalog/state response.
func TestLocalPDFEncryptedAndKeptOutOfState(t *testing.T) {
	a := localApp(t)
	h := a.routes()
	w := call(t, h, "POST", "/api/local/add?name="+url.QueryEscape("기밀-보고서.pdf"), secretPDF)
	if w.Code != 200 {
		t.Fatalf("add: %d %s", w.Code, w.Body)
	}
	_, f, e := a.readPDF(strings.Split(strings.Split(w.Body.String(), `"id":"`)[1], `"`)[0])
	if e != nil || f.Name != "기밀-보고서.pdf" {
		t.Fatalf("read: %v %+v", e, f)
	}
	filepath.Walk(a.dir, func(p string, info os.FileInfo, err error) error {
		if info != nil && !info.IsDir() {
			b, _ := os.ReadFile(p)
			if bytes.Contains(b, []byte("internal-marker-42")) || bytes.Contains(b, []byte("기밀-보고서")) {
				t.Errorf("plaintext on disk: %s", p)
			}
		}
		return nil
	})
	if s := call(t, h, "GET", "/api/state", "").Body.String(); strings.Contains(s, "기밀-보고서") {
		t.Fatal("local file leaked into /api/state")
	}
	d := call(t, h, "GET", "/api/local/file?id="+f.ID, "")
	if b, _ := io.ReadAll(d.Body); string(b) != secretPDF || d.Header().Get("Content-Type") != "application/pdf" {
		t.Fatalf("download mismatch: %q", d.Header())
	}
	if _, e := os.Stat(filepath.Join(a.dir, "docs", "pdf", f.ID+".bin")); e != nil {
		t.Fatal("PDF not stored under docs/pdf")
	}
	(&App{dir: a.dir}).pruneCache(Catalog{})
	if _, e := os.Stat(a.blobPath(f.ID)); e != nil {
		t.Fatal("sync cache pruning touched local files")
	}
	if e := a.deletePDF(f.ID); e != nil {
		t.Fatal(e)
	}
	if _, e := os.Stat(a.blobPath(f.ID)); !os.IsNotExist(e) {
		t.Fatal("deleted PDF still on disk")
	}
}
func TestLocalRejectsNonPDFAndGitWorkTree(t *testing.T) {
	a := localApp(t)
	if _, e := a.addPDF("mail.pst", []byte("!BDN outlook data")); e == nil {
		t.Fatal("non-PDF accepted")
	}
	os.Mkdir(filepath.Join(a.dir, ".git"), 0700)
	if _, e := a.addPDF("a.pdf", []byte(secretPDF)); e == nil {
		t.Fatal("stored inside a git work tree")
	}
	if _, e := os.Stat(a.localDir()); !os.IsNotExist(e) {
		t.Fatal("local folder created inside a git work tree")
	}
	if _, e := os.Stat(a.pdfDir()); !os.IsNotExist(e) {
		t.Fatal("pdf folder created inside a git work tree")
	}
}

// PDFs saved by the first build sat in local/<id>.bin; loading the index moves them to docs/pdf.
func TestLocalMovesOldPDFLocation(t *testing.T) {
	a := localApp(t)
	f, e := a.addPDF("a.pdf", []byte(secretPDF))
	if e != nil {
		t.Fatal(e)
	}
	old := filepath.Join(a.localDir(), f.ID+".bin")
	if e = os.Rename(a.blobPath(f.ID), old); e != nil {
		t.Fatal(e)
	}
	b, _, e := a.readPDF(f.ID)
	if e != nil || string(b) != secretPDF {
		t.Fatalf("read after move: %v", e)
	}
	if _, e = os.Stat(old); !os.IsNotExist(e) {
		t.Fatal("old copy left behind")
	}
}
func TestLocalRejectsForeignOrigin(t *testing.T) {
	a := localApp(t)
	r := httptest.NewRequest("POST", "/api/local/add?name=a.pdf", strings.NewReader(secretPDF))
	r.Host = "127.0.0.1:9000"
	r.Header.Set("Origin", "https://evil.test")
	r.Header.Set("X-AV-Request", "1")
	r.AddCookie(&http.Cookie{Name: "av_session", Value: a.secret})
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("foreign origin: %d", w.Code)
	}
}

// Mail links keep only metadata, and only PST paths the user configured may be opened.
func TestMailLinkValidation(t *testing.T) {
	a := localApp(t)
	h := a.routes()
	report := a.snapshot.Catalog.Reports[0].ID
	if w := call(t, h, "POST", "/api/outlook/link", `{"report":"`+report+`","mail":{"entry_id":"00AB","store_id":"00CD","path":"C:\\other.pst","subject":"s"}}`); w.Code != 400 {
		t.Fatalf("unconfigured PST accepted: %d", w.Code)
	}
	if w := call(t, h, "POST", "/api/outlook/link", `{"report":"`+report+`","mail":{"entry_id":"not-hex","store_id":"00CD"}}`); w.Code != 400 {
		t.Fatalf("bad entry id accepted: %d", w.Code)
	}
	if w := call(t, h, "POST", "/api/outlook/link", `{"report":"no-such-report","mail":{"entry_id":"00AB","store_id":"00CD"}}`); w.Code != 400 {
		t.Fatalf("unknown report accepted: %d", w.Code)
	}
	if w := call(t, h, "POST", "/api/outlook/link", `{"report":"`+report+`","mail":{"entry_id":"00AB","store_id":"00CD","subject":"사내 메일 제목"}}`); w.Code != 200 {
		t.Fatalf("link: %d %s", w.Code, w.Body)
	}
	x, _ := a.viewLocal()
	if len(x.Mails) != 1 || x.Mails[0].Subject != "사내 메일 제목" {
		t.Fatalf("link not stored: %+v", x.Mails)
	}
	b, _ := os.ReadFile(filepath.Join(a.localDir(), "index.bin"))
	if bytes.Contains(b, []byte("사내 메일 제목")) {
		t.Fatal("mail subject stored in plaintext")
	}
	if w := call(t, h, "POST", "/api/outlook/source", `{"source":{"path":"relative.pst"}}`); w.Code != 400 {
		t.Fatalf("relative PST path accepted: %d", w.Code)
	}
	if w := call(t, h, "POST", "/api/outlook/search", `{"terms":[]}`); w.Code != 400 {
		t.Fatalf("empty search accepted: %d", w.Code)
	}
}
