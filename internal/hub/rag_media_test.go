package hub

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
)

func TestRagMediaProxy(t *testing.T) {
	a := &App{dir: t.TempDir(), secret: strings.Repeat("a", 64), address: "http://127.0.0.1:9000", config: defaultConfig(), snapshot: Snapshot{Catalog: seedCatalog(t)}}
	key := strings.Repeat("b", 64)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-RAG-Key") != key {
			t.Error("missing service key")
		}
		body, _ := io.ReadAll(r.Body)
		name, err := url.PathUnescape(r.Header.Get("X-File-Name"))
		if err != nil {
			t.Fatal(err)
		}
		writeResponse(w, map[string]any{"ok": true, "name": name, "path": r.URL.Path, "body": base64.StdEncoding.EncodeToString(body), "type": r.Header.Get("Content-Type")})
	}))
	defer upstream.Close()
	if err := writeJSON(filepath.Join(a.dir, "rag-service.json"), ragService{upstream.URL, key}); err != nil {
		t.Fatal(err)
	}
	routes := a.routes()
	for _, test := range []struct {
		name string
		data []byte
		want int
	}{
		{"사진 100%.PNG", []byte("\x89PNG\r\n\x1a\nexample"), 200},
		{"scan.TIFF", []byte{'I', 'I', 42, 0, 0, 0, 0, 0}, 200},
		{"photo.heic", []byte("\x00\x00\x00\x18ftypheic"), 200},
		{"photo.avif", []byte("\x00\x00\x00\x18ftypavif"), 200},
		{"report.pdf", []byte("%PDF-1.4"), 200},
		{"fake.png", []byte("<html>not an image</html>"), 400},
		{"fake.pdf", []byte("not a pdf"), 400},
		{"script.svg", []byte("<svg/>"), 400},
	} {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/api/rag/index?name="+url.QueryEscape(test.name), bytes.NewReader(test.data))
			req.Host = "127.0.0.1:9000"
			req.Header.Set("Origin", a.address)
			req.Header.Set("X-AV-Request", "1")
			req.AddCookie(&http.Cookie{Name: "av_session", Value: a.secret})
			response := httptest.NewRecorder()
			routes.ServeHTTP(response, req)
			if response.Code != test.want {
				t.Fatalf("status %d: %s", response.Code, response.Body.String())
			}
			if test.want == 200 {
				var result map[string]any
				if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
					t.Fatal(err)
				}
				if result["name"] != test.name || result["body"] != base64.StdEncoding.EncodeToString(test.data) {
					t.Fatalf("upload changed: %v", result)
				}
			}
		})
	}
	req := httptest.NewRequest("GET", "/api/rag/map", nil)
	req.Host = "127.0.0.1:9000"
	req.AddCookie(&http.Cookie{Name: "av_session", Value: a.secret})
	response := httptest.NewRecorder()
	routes.ServeHTTP(response, req)
	var result map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &result)
	if response.Code != 200 || result["path"] != "/map" {
		t.Fatalf("map proxy: %s", response.Body.String())
	}

	payload := []byte(`{"doc":"abc123","page":2,"text":"무인 운행"}`)
	req = httptest.NewRequest("POST", "/api/rag/highlights", bytes.NewReader(payload))
	req.Host = "127.0.0.1:9000"
	req.Header.Set("Origin", a.address)
	req.Header.Set("X-AV-Request", "1")
	req.AddCookie(&http.Cookie{Name: "av_session", Value: a.secret})
	response = httptest.NewRecorder()
	routes.ServeHTTP(response, req)
	_ = json.Unmarshal(response.Body.Bytes(), &result)
	if response.Code != 200 || result["path"] != "/highlights" || result["body"] != base64.StdEncoding.EncodeToString(payload) {
		t.Fatalf("highlight proxy: %s", response.Body.String())
	}
}
