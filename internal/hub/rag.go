package hub

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// 멀티모달 검색 (optional, opt-in): a separately started Python service (rag/rag_server.py) on this PC
// loads the embedding model. The Go app only proxies to it — no model, no Python inside the EXE.
// The service announces itself in <data-dir>/rag-service.json ({address, key}); when that file is
// absent the tab shows setup instructions. PDFs sent here are stored by the service unencrypted under
// <LOCALAPPDATA>\AVReportHub\rag\index (outside any git work tree), which the UI warns about before upload. Nothing from this path touches catalog/sync.
type ragService struct {
	Address string `json:"address"`
	Key     string `json:"key"`
}

const ragMax = 50 << 20

var errRagDown = errors.New("AI 검색 서비스가 실행 중이 아닙니다. rag/rag_server.py를 먼저 실행하세요.")

func (a *App) ragServiceInfo() (ragService, error) {
	b, e := os.ReadFile(filepath.Join(a.dir, "rag-service.json"))
	if e != nil {
		return ragService{}, errRagDown
	}
	var s ragService
	if json.Unmarshal(b, &s) != nil || !strings.HasPrefix(s.Address, "http://127.0.0.1:") || len(s.Key) != 64 {
		return ragService{}, errRagDown
	}
	return s, nil
}

// ragProxy forwards one request to the local service. Only the path, query, body and two headers cross over.
func (a *App) ragProxy(w http.ResponseWriter, r *http.Request, method, path string, body io.Reader, contentType, fileName string, timeout time.Duration) {
	s, e := a.ragServiceInfo()
	if e != nil {
		writeResponse(w, map[string]any{"ok": false, "available": false, "error": e.Error()})
		return
	}
	req, e := http.NewRequestWithContext(r.Context(), method, s.Address+path, body)
	if e != nil {
		http.Error(w, e.Error(), 500)
		return
	}
	req.Header.Set("X-RAG-Key", s.Key)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if fileName != "" {
		req.Header.Set("X-File-Name", url.PathEscape(fileName))
		req.Header.Set("X-File-Name-Encoding", "percent-utf8")
	}
	res, e := (&http.Client{Timeout: timeout}).Do(req)
	if e != nil {
		log.Printf("rag: %v", e)
		writeResponse(w, map[string]any{"ok": false, "available": false, "error": errRagDown.Error()})
		return
	}
	defer res.Body.Close()
	w.Header().Set("Content-Type", res.Header.Get("Content-Type"))
	w.WriteHeader(res.StatusCode)
	_, _ = io.Copy(w, res.Body)
}

func (a *App) ragRoutes(mux *http.ServeMux) {
	a.ragSetupRoutes(mux)
	mux.HandleFunc("/api/rag/status", func(w http.ResponseWriter, r *http.Request) {
		a.ragProxy(w, r, "GET", "/health", nil, "", "", 5*time.Second)
	})
	mux.HandleFunc("/api/rag/map", func(w http.ResponseWriter, r *http.Request) {
		a.ragProxy(w, r, "GET", "/map", nil, "", "", 30*time.Second)
	})
	mux.HandleFunc("/api/rag/job", func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("id")
		if !localIDPattern.MatchString(id) {
			http.Error(w, "잘못된 작업 번호입니다.", 400)
			return
		}
		a.ragProxy(w, r, "GET", "/jobs?id="+id, nil, "", "", 5*time.Second)
	})
	mux.HandleFunc("/api/rag/demo", func(w http.ResponseWriter, r *http.Request) {
		q := ""
		if r.URL.Query().Get("fresh") == "1" {
			q = "?fresh=1"
		}
		a.ragProxy(w, r, "GET", "/demo"+q, nil, "", "", 30*time.Second)
	})
	mux.HandleFunc("/api/rag/page", func(w http.ResponseWriter, r *http.Request) {
		a.ragProxy(w, r, "GET", "/page?"+r.URL.RawQuery, nil, "", "", 10*time.Second)
	})
	mux.HandleFunc("/api/rag/index", func(w http.ResponseWriter, r *http.Request) {
		if !post(w, r) {
			return
		}
		name := filepath.Base(r.URL.Query().Get("name"))
		if name == "" || name == "." {
			http.Error(w, "파일 이름이 필요합니다.", 400)
			return
		}
		b, e := io.ReadAll(http.MaxBytesReader(w, r.Body, ragMax))
		if e != nil {
			http.Error(w, "50MB를 넘습니다.", 413)
			return
		}
		contentType := ragUploadType(name, b)
		if contentType == "" {
			http.Error(w, "PDF 또는 지원하는 이미지(PNG·JPG·WebP·GIF·BMP·TIFF·AVIF·HEIC·ICO)를 선택해 주세요.", 400)
			return
		}
		log.Printf("rag: index %d bytes", len(b))
		a.ragProxy(w, r, "POST", "/index", bytes.NewReader(b), contentType, name, 30*time.Second)
	})
	for _, p := range []string{"query", "delete"} {
		path := p
		mux.HandleFunc("/api/rag/"+path, func(w http.ResponseWriter, r *http.Request) {
			if !post(w, r) {
				return
			}
			b, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
			if e != nil {
				http.Error(w, e.Error(), 400)
				return
			}
			a.ragProxy(w, r, "POST", "/"+path, strings.NewReader(string(b)), "application/json", "", 2*time.Minute)
		})
	}
}

// This is a cheap format gate; the local service fully decodes every image before indexing.
func ragUploadType(name string, data []byte) string {
	ext := strings.ToLower(filepath.Ext(name))
	if ext == ".pdf" {
		if bytes.HasPrefix(data, []byte("%PDF")) {
			return "application/pdf"
		}
		return ""
	}
	allowed := map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".jfif": true, ".webp": true,
		".gif": true, ".bmp": true, ".tif": true, ".tiff": true, ".avif": true, ".heic": true, ".heif": true, ".ico": true}
	if !allowed[ext] {
		return ""
	}
	contentType := http.DetectContentType(data)
	if strings.HasPrefix(contentType, "image/") {
		return contentType
	}
	if bytes.HasPrefix(data, []byte{'I', 'I', 42, 0}) || bytes.HasPrefix(data, []byte{'M', 'M', 0, 42}) {
		return "image/tiff"
	}
	if len(data) >= 12 && string(data[4:8]) == "ftyp" {
		switch string(data[8:12]) {
		case "avif", "avis":
			return "image/avif"
		case "heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1":
			return "image/heif"
		}
	}
	return ""
}
