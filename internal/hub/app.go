package hub

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed web/* seed/*
var assets embed.FS

type App struct {
	dir, secret, address string
	setup                bool
	payload              []byte
	config               Config
	snapshot             Snapshot
	mu                   sync.RWMutex
	syncLock             sync.Mutex
	syncing              bool
	status               string
	server               *http.Server
}
type instance struct {
	Address string `json:"address"`
	Key     string `json:"key"`
}

func Run(setup bool, payload []byte) {
	dirFlag := flag.String("data-dir", "", "Data folder (testing / portable use)")
	noBrowser := flag.Bool("no-browser", false, "Do not launch browser")
	check := flag.Bool("self-test", false, "Validate embedded feed, UI and writable storage; exit")
	flag.Parse()
	if e := platformCheck(); e != nil {
		notifyError(e.Error())
		return
	}
	dir := *dirFlag
	if dir == "" {
		root := os.Getenv("LOCALAPPDATA")
		if root == "" {
			root, _ = os.UserConfigDir()
		}
		dir = filepath.Join(root, "AVReportHub")
	}
	if e := os.MkdirAll(dir, 0700); e != nil {
		notifyError("저장 폴더를 만들 수 없습니다: " + e.Error())
		return
	}
	lf, e := os.OpenFile(filepath.Join(dir, "app.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if e == nil {
		defer lf.Close()
		log.SetOutput(lf)
	}
	a := &App{dir: dir, setup: setup, payload: payload, config: defaultConfig(), status: "포함된 리포트"}
	if b, e := os.ReadFile(filepath.Join(dir, "config.json")); e == nil {
		var c Config
		if json.Unmarshal(b, &c) == nil && c.Validate() == nil {
			a.config = c
		}
	}
	b, _ := assets.ReadFile("seed/catalog.json")
	c, e := parseCatalog(b)
	if e != nil {
		notifyError("기본 데이터 오류: " + e.Error())
		return
	}
	a.snapshot = Snapshot{Catalog: c, Origin: "bundled"}
	if e = a.ensureDatabase(context.Background(), a.snapshot, nil); e != nil {
		notifyError("기본 DB 준비 실패: " + e.Error())
		return
	}
	if b, e := os.ReadFile(filepath.Join(dir, "snapshot.json")); e == nil {
		var s Snapshot
		if json.Unmarshal(b, &s) == nil && s.Catalog.Validate() == nil {
			a.snapshot = s
		}
	}
	if *check {
		if e := writeAtomic(filepath.Join(dir, "self-test.txt"), []byte("ok")); e != nil {
			panic(e)
		}
		fmt.Println("self-test passed: embedded feed, UI assets, storage")
		return
	}
	suffix := "viewer"
	if setup {
		suffix = "setup"
	}
	instancePath := filepath.Join(dir, "instance-"+suffix+".json")
	if b, e := os.ReadFile(instancePath); e == nil {
		var ins instance
		if json.Unmarshal(b, &ins) == nil && strings.HasPrefix(ins.Address, "http://127.0.0.1:") && len(ins.Key) == 64 {
			req, _ := http.NewRequest("GET", ins.Address+"/api/ping", nil)
			req.AddCookie(&http.Cookie{Name: "av_session", Value: ins.Key})
			client := http.Client{Timeout: time.Second, CheckRedirect: func(r *http.Request, v []*http.Request) error { return http.ErrUseLastResponse }}
			if res, e := client.Do(req); e == nil {
				res.Body.Close()
				if res.StatusCode == 200 {
					if !*noBrowser {
						_ = openBrowser(ins.Address + "/open?key=" + ins.Key)
					}
					return
				}
			}
		}
	}
	ln, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		notifyError("로컬 서버를 시작하지 못했습니다.")
		return
	}
	a.address = "http://" + ln.Addr().String()
	key := make([]byte, 32)
	if _, e = rand.Read(key); e != nil {
		panic(e)
	}
	a.secret = hex.EncodeToString(key)
	if e = writeJSON(instancePath, instance{a.address, a.secret}); e != nil {
		notifyError(e.Error())
		ln.Close()
		return
	}
	defer os.Remove(instancePath)
	a.server = &http.Server{Handler: a.routes(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 120 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
	go a.scheduler()
	if !setup && a.config.Configured && !a.config.Offline {
		go a.syncData()
	}
	fmt.Println(a.address + "/open?key=" + a.secret)
	if !*noBrowser {
		if e = openBrowser(a.address + "/open?key=" + a.secret); e != nil {
			notifyError(e.Error() + "\n" + a.address + "/open?key=" + a.secret)
		}
	}
	if e = a.server.Serve(ln); e != nil && !errors.Is(e, http.ErrServerClosed) {
		notifyError(e.Error())
	}
}
func (a *App) scheduler() {
	timer := time.NewTicker(30 * time.Second)
	defer timer.Stop()
	var lastAttempt time.Time
	for now := range timer.C {
		a.mu.RLock()
		c := a.config
		last := a.snapshot.SyncedAt
		a.mu.RUnlock()
		if a.setup || !c.Configured || c.Offline {
			continue
		}
		local := now.In(kst)
		due, _ := time.ParseInLocation("2006-01-02 15:04", local.Format("2006-01-02")+" "+c.SyncTime, kst)
		synced, _ := time.Parse(time.RFC3339, last)
		if !local.Before(due) && synced.Before(due) && now.Sub(lastAttempt) > 15*time.Minute {
			lastAttempt = now
			go a.syncData()
		}
	}
}
func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	web, _ := fs.Sub(assets, "web")
	mux.Handle("/", http.FileServer(http.FS(web)))
	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) { writeResponse(w, map[string]any{"version": Version}) })
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		a.mu.RLock()
		defer a.mu.RUnlock()
		_, te := os.Stat(filepath.Join(a.dir, "token.bin"))
		writeResponse(w, map[string]any{"version": Version, "setup": a.setup, "config": a.config, "data_dir": a.dir, "has_token": te == nil, "snapshot": a.snapshot, "syncing": a.syncing, "status": a.status})
	})
	mux.HandleFunc("/api/sync", func(w http.ResponseWriter, r *http.Request) {
		if !post(w, r) {
			return
		}
		go a.syncData()
		writeResponse(w, map[string]any{"ok": true})
	})
	mux.HandleFunc("/api/check", a.checkSettings)
	mux.HandleFunc("/api/install", a.install)
	mux.HandleFunc("/api/launch", func(w http.ResponseWriter, r *http.Request) {
		if !post(w, r) {
			return
		}
		if !a.setup {
			http.Error(w, "설정 프로그램에서 실행하세요.", 400)
			return
		}
		target := filepath.Join(a.dir, "bin", "AVReportHub.exe")
		cmd := exec.Command(target, "--data-dir", a.dir)
		hideCommand(cmd)
		if e := cmd.Start(); e != nil {
			http.Error(w, "프로그램을 실행할 수 없습니다: "+e.Error(), 500)
			return
		}
		writeResponse(w, map[string]any{"ok": true})
		go a.stop()
	})
	mux.HandleFunc("/api/exit", func(w http.ResponseWriter, r *http.Request) {
		if !post(w, r) {
			return
		}
		writeResponse(w, map[string]any{"ok": true})
		go a.stop()
	})
	mux.HandleFunc("/api/download", func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("id")
		index, e := strconv.Atoi(r.URL.Query().Get("index"))
		if e != nil {
			http.Error(w, "잘못된 첨부", 400)
			return
		}
		b, name, e := a.attachment(r.Context(), id, index)
		if e != nil {
			http.Error(w, e.Error(), 502)
			return
		}
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(b)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected := strings.TrimPrefix(a.address, "http://")
		if r.Host != expected {
			http.Error(w, "Invalid host", 403)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		if r.URL.Path == "/open" {
			if subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("key")), []byte(a.secret)) != 1 {
				http.Error(w, "Invalid session", 403)
				return
			}
			http.SetCookie(w, &http.Cookie{Name: "av_session", Value: a.secret, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		cookie, e := r.Cookie("av_session")
		if e != nil || subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(a.secret)) != 1 {
			http.Error(w, "프로그램 실행 파일로 화면을 열어 주세요.", 403)
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			if r.Method != "POST" || r.Header.Get("Origin") != a.address || r.Header.Get("X-AV-Request") != "1" {
				http.Error(w, "Invalid request", 403)
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}
func (a *App) stop() { time.Sleep(400 * time.Millisecond); _ = a.server.Shutdown(context.Background()) }
func post(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != "POST" {
		http.Error(w, "POST required", 405)
		return false
	}
	return true
}
func writeResponse(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}

type Settings struct {
	Config
	Automatic  bool   `json:"automatic"`
	Token      string `json:"token"`
	ClearToken bool   `json:"clear_token"`
}

func (a *App) settings(r *http.Request) (Settings, error) {
	var s Settings
	e := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 16384)).Decode(&s)
	if e != nil {
		return s, errors.New("설정을 읽을 수 없습니다.")
	}
	if e = s.Config.Validate(); e != nil {
		return s, e
	}
	s.Token = strings.TrimSpace(s.Token)
	if s.Token == "" && !s.ClearToken {
		a.mu.RLock()
		same := s.Owner == a.config.Owner && s.Repo == a.config.Repo
		a.mu.RUnlock()
		if same {
			s.Token, e = a.readToken()
		}
	}
	return s, e
}
func (a *App) validateSetup(ctx context.Context, s Settings) (*Snapshot, []string, error) {
	checks := []string{}
	if e := platformCheck(); e != nil {
		return nil, checks, e
	}
	checks = append(checks, "운영체제 및 내장 실행 환경 정상 (Git·Python 설치 불필요)")
	p := filepath.Join(a.dir, ".write-check")
	if e := writeAtomic(p, []byte("ok")); e != nil {
		return nil, checks, errors.New("저장 폴더 쓰기 권한이 없습니다.")
	}
	_ = os.Remove(p)
	checks = append(checks, "저장 폴더 생성·쓰기 확인 완료")
	checks = append(checks, "로컬 웹 서버 및 브라우저 연결 정상")
	if a.setup && s.Automatic {
		checks = append(checks, "기본 자료로 자동 설치; GitHub 최신화는 실행 직후 백그라운드 처리")
		return nil, checks, nil
	}
	if s.Offline {
		checks = append(checks, "오프라인 시작 선택: GitHub 연결은 나중에 설정")
		return nil, checks, nil
	}
	g := newGitHub(s.Config, s.Token)
	commit, e := g.commit(ctx)
	if e != nil {
		return nil, checks, e
	}
	checks = append(checks, "GitHub 저장소·브랜치 읽기 확인 완료")
	c, e := g.catalog(ctx, commit)
	if e != nil {
		return nil, checks, e
	}
	checks = append(checks, fmt.Sprintf("게시 데이터 검증 완료: 리포트 %d개", len(c.Reports)))
	snap := &Snapshot{Commit: commit, Origin: s.Owner + "/" + s.Repo, SyncedAt: time.Now().In(kst).Format(time.RFC3339), Catalog: c}
	if e = a.ensureDatabase(ctx, *snap, g); e != nil {
		return nil, checks, e
	}
	return snap, checks, nil
}
func (a *App) checkSettings(w http.ResponseWriter, r *http.Request) {
	if !post(w, r) {
		return
	}
	s, e := a.settings(r)
	if e != nil {
		http.Error(w, e.Error(), 400)
		return
	}
	_, checks, e := a.validateSetup(r.Context(), s)
	msg := ""
	if e != nil {
		msg = e.Error()
	}
	writeResponse(w, map[string]any{"ok": e == nil, "checks": checks, "error": msg})
}
func (a *App) install(w http.ResponseWriter, r *http.Request) {
	if !post(w, r) {
		return
	}
	a.syncLock.Lock()
	defer a.syncLock.Unlock()
	s, e := a.settings(r)
	if e != nil {
		http.Error(w, e.Error(), 400)
		return
	}
	snap, checks, e := a.validateSetup(r.Context(), s)
	if e != nil {
		writeResponse(w, map[string]any{"ok": false, "checks": checks, "error": e.Error()})
		return
	}
	var encrypted []byte
	if s.Token != "" {
		encrypted, e = protect([]byte(s.Token))
		if e != nil {
			http.Error(w, e.Error(), 500)
			return
		}
	}
	if a.setup {
		if len(a.payload) < 2 || string(a.payload[:2]) != "MZ" {
			http.Error(w, "실행 파일 패키지가 잘못되었습니다.", 500)
			return
		}
		if e = writeAtomic(filepath.Join(a.dir, "bin", "AVReportHub.exe"), a.payload); e != nil {
			http.Error(w, "실행 파일을 설치할 수 없습니다. 실행 중인 AV 리포트를 종료한 뒤 다시 시도하세요.", 500)
			return
		}
		checks = append(checks, "실행 파일 설치 완료")
	}
	tokenPath := filepath.Join(a.dir, "token.bin")
	if len(encrypted) > 0 {
		e = writeAtomic(tokenPath, encrypted)
	} else {
		e = os.Remove(tokenPath)
		if os.IsNotExist(e) {
			e = nil
		}
	}
	if e != nil {
		http.Error(w, "인증 정보를 저장할 수 없습니다.", 500)
		return
	}
	s.Configured = true
	if e = writeJSON(filepath.Join(a.dir, "config.json"), s.Config); e != nil {
		http.Error(w, e.Error(), 500)
		return
	}
	if snap != nil {
		if e = writeJSON(filepath.Join(a.dir, "snapshot.json"), snap); e != nil {
			http.Error(w, e.Error(), 500)
			return
		}
	}
	a.mu.Lock()
	a.config = s.Config
	if snap != nil {
		a.snapshot = *snap
	}
	a.status = "설정 완료"
	a.mu.Unlock()
	if a.setup {
		if e = shortcut(filepath.Join(a.dir, "bin", "AVReportHub.exe")); e != nil {
			checks = append(checks, e.Error())
		} else {
			checks = append(checks, "바탕화면 바로가기 생성 완료")
		}
	}
	writeResponse(w, map[string]any{"ok": true, "checks": checks, "installed_path": filepath.Join(a.dir, "bin", "AVReportHub.exe")})
}

// Only HTTP(S) source links are rendered by the browser; never run published code.
func validSource(s string) bool {
	u, e := url.Parse(s)
	return e == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != ""
}
