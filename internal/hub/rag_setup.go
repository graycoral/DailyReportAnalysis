package hub

import (
	"avreporthub/rag"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Setup is opt-in. GET only checks an existing installation, without downloads.
type ragSetupStatus struct {
	State          string `json:"state"`
	Message        string `json:"message"`
	Ready          bool   `json:"ready"`
	Busy           bool   `json:"busy"`
	PythonRequired bool   `json:"python_required"`
	Supported      bool   `json:"supported"`
}

func (a *App) ragRuntime() string { return filepath.Join(a.dir, "rag", "runtime") }
func (a *App) ragPython() string {
	return filepath.Join(a.ragRuntime(), ".venv", "Scripts", "python.exe")
}
func ragFingerprint() string {
	h := sha256.New()
	entries, _ := rag.Files.ReadDir(".")
	for _, entry := range entries {
		b, _ := rag.Files.ReadFile(entry.Name())
		h.Write([]byte(entry.Name()))
		h.Write([]byte{0})
		h.Write(b)
	}
	return hex.EncodeToString(h.Sum(nil))
}
func (a *App) ragMarkerValid() bool {
	b, err := os.ReadFile(filepath.Join(a.ragRuntime(), "ready.json"))
	var m struct {
		Fingerprint string `json:"fingerprint"`
	}
	if err != nil || json.Unmarshal(b, &m) != nil || m.Fingerprint != ragFingerprint() {
		return false
	}
	if _, err = os.Stat(a.ragPython()); err != nil {
		return false
	}
	// A marker alone must not bless missing or modified runtime scripts.
	entries, _ := rag.Files.ReadDir(".")
	for _, entry := range entries {
		want, _ := rag.Files.ReadFile(entry.Name())
		have, err := os.ReadFile(filepath.Join(a.ragRuntime(), entry.Name()))
		if err != nil || string(have) != string(want) {
			return false
		}
	}
	return true
}
func ragStorageAllowed(dir string) bool {
	dir, err := filepath.Abs(dir)
	if err != nil {
		return false
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return false
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return true
		}
		dir = parent
	}
}
func (a *App) ragEnvironment() ragSetupStatus {
	a.ragSetupMu.Lock()
	defer a.ragSetupMu.Unlock()
	if !a.ragSetupChecked {
		a.ragSetupChecked = true
		a.ragSetupState = ragSetupStatus{State: "missing", Message: "AI 검색을 사용하려면 환경을 설정해 주세요."}
		if runtime.GOOS != "windows" {
			a.ragSetupState.Message = "앱에서 환경 설정은 Windows에서 지원합니다."
		} else if a.ragMarkerValid() {
			a.ragSetupState = ragSetupStatus{State: "checking", Message: "설치된 패키지와 모델을 확인하고 있습니다.", Busy: true}
			ctx, cancel := context.WithCancel(context.Background())
			a.ragCancel = cancel
			go a.checkRagEnvironment(ctx)
		}
	}
	s := a.ragSetupState
	s.Supported = runtime.GOOS == "windows"
	return s
}
func (a *App) ragSet(s ragSetupStatus) {
	a.ragSetupMu.Lock()
	defer a.ragSetupMu.Unlock()
	a.ragSetupState = s
}
func (a *App) ragProgress(message string) {
	a.ragSetupMu.Lock()
	defer a.ragSetupMu.Unlock()
	a.ragSetupState.Message = message
}
func (a *App) stopRagTask() {
	a.ragSetupMu.Lock()
	defer a.ragSetupMu.Unlock()
	if a.ragCancel != nil {
		a.ragCancel()
	}
	if a.ragProcess != nil {
		_ = a.ragProcess.Kill()
	}
}
func (a *App) ragTrackProcess(ctx context.Context, p *os.Process) {
	a.ragSetupMu.Lock()
	defer a.ragSetupMu.Unlock()
	a.ragProcess = p
	if ctx.Err() != nil {
		_ = p.Kill()
	}
}
func (a *App) ragForgetProcess(p *os.Process) {
	a.ragSetupMu.Lock()
	defer a.ragSetupMu.Unlock()
	if a.ragProcess == p {
		a.ragProcess = nil
	}
}
func (a *App) ragCommandEnv() []string {
	// Use the same data dir as the viewer, including portable --data-dir installs.
	overrides := map[string]string{
		"AVHUB_DATA_DIR": a.dir, "RAG_INDEX": filepath.Join(a.dir, "rag", "index"),
		"RAG_DOCS": filepath.Join(a.dir, "rag", "demo"), "HF_HOME": filepath.Join(a.dir, "rag", "models"),
		"RAG_MODEL": "google/embeddinggemma-2", "HF_HUB_DISABLE_TELEMETRY": "1", "PYTHONUTF8": "1",
		"PYTHONNOUSERSITE": "1", "PIP_DISABLE_PIP_VERSION_CHECK": "1",
	}
	env := []string{}
	for _, item := range os.Environ() {
		key, _, _ := strings.Cut(item, "=")
		upper := strings.ToUpper(key)
		if _, ok := overrides[upper]; ok {
			continue
		}
		if upper == "PYTHONHOME" || upper == "PYTHONPATH" {
			continue
		}
		env = append(env, item)
	}
	for key, value := range overrides {
		env = append(env, key+"="+value)
	}
	return env
}
func (a *App) ragRun(ctx context.Context, timeout time.Duration, exe string, args ...string) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, args...)
	cmd.Env = a.ragCommandEnv()
	hideCommand(cmd)
	// Never capture pip output: proxy/index URLs can contain credentials.
	err := cmd.Start()
	if err == nil {
		a.ragTrackProcess(ctx, cmd.Process)
		err = cmd.Wait()
		a.ragForgetProcess(cmd.Process)
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}
func (a *App) checkRagEnvironment(ctx context.Context) {
	err := a.ragRun(ctx, 5*time.Minute, a.ragPython(), filepath.Join(a.ragRuntime(), "setup_env.py"), "--check")
	if err != nil {
		a.ragSet(ragSetupStatus{State: "error", Message: "설치된 환경을 확인하지 못했습니다. 환경 설정을 다시 실행해 주세요."})
		return
	}
	a.ragSet(ragSetupStatus{State: "ready", Ready: true, Message: "패키지와 모델 검증을 마쳤습니다. 검색 서비스를 시작해 주세요."})
}
func (a *App) ragSetupRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/rag/environment", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "GET required", 405)
			return
		}
		writeResponse(w, a.ragEnvironment())
	})
	for _, action := range []string{"setup", "start"} {
		action := action
		mux.HandleFunc("/api/rag/"+action, func(w http.ResponseWriter, r *http.Request) {
			if !post(w, r) {
				return
			}
			a.ragEnvironment()
			if runtime.GOOS != "windows" {
				http.Error(w, "Windows에서 지원하는 기능입니다.", 400)
				return
			}
			if !ragStorageAllowed(a.dir) {
				http.Error(w, "앱 데이터 폴더가 Git 저장소 안에 있습니다. 저장소 밖의 데이터 폴더로 앱을 실행해 주세요.", 400)
				return
			}
			if a.ragHealthy() {
				writeResponse(w, map[string]bool{"ok": true})
				return
			}
			a.ragSetupMu.Lock()
			if a.ragSetupState.Busy {
				a.ragSetupMu.Unlock()
				http.Error(w, "환경 작업이 이미 진행 중입니다.", 409)
				return
			}
			if action == "start" && !a.ragSetupState.Ready {
				a.ragSetupMu.Unlock()
				http.Error(w, "환경 설정을 먼저 완료해 주세요.", 409)
				return
			}
			if a.ragCancel != nil {
				a.ragCancel()
			}
			ctx, cancel := context.WithCancel(context.Background())
			a.ragCancel = cancel
			if action == "setup" {
				a.ragSetupState = ragSetupStatus{State: "installing", Busy: true, Message: "Python 환경을 확인하고 있습니다."}
			} else {
				a.ragSetupState = ragSetupStatus{State: "starting", Ready: true, Busy: true, Message: "검색 모델을 불러오고 있습니다."}
			}
			a.ragSetupMu.Unlock()
			if action == "setup" {
				go a.installRagEnvironment(ctx)
			} else {
				go a.startRagService(ctx)
			}
			writeResponse(w, map[string]bool{"ok": true})
		})
	}
}
func (a *App) findRagPython(ctx context.Context) (string, error) {
	candidates := [][]string{{a.ragPython()}, {"py", "-3.10"},
		{filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "Python", "Python310", "python.exe")},
		{filepath.Join(os.Getenv("ProgramFiles"), "Python310", "python.exe")}, {"python"}}
	const probe = "import sys,struct; assert sys.version_info[:2] == (3,10) and struct.calcsize('P') == 8; assert 'conda' not in sys.version.lower() and 'conda' not in sys.base_prefix.lower(); print(sys.executable)"
	for _, candidate := range candidates {
		executable, err := exec.LookPath(candidate[0])
		if err != nil || strings.Contains(strings.ToLower(filepath.ToSlash(executable)), "/microsoft/windowsapps/") {
			continue
		}
		check, cancel := context.WithTimeout(ctx, 10*time.Second)
		args := append(append([]string{}, candidate[1:]...), "-c", probe)
		cmd := exec.CommandContext(check, executable, args...)
		cmd.Env = a.ragCommandEnv()
		hideCommand(cmd)
		b, err := cmd.Output()
		cancel()
		if err == nil {
			p := strings.TrimSpace(string(b))
			if filepath.IsAbs(p) {
				if _, err = os.Stat(p); err == nil {
					return p, nil
				}
			}
		}
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
	}
	return "", errors.New("Python 3.10 x64 required")
}
func (a *App) installRagEnvironment(ctx context.Context) {
	fail := func(message string) { a.ragSet(ragSetupStatus{State: "error", Message: message}) }
	python, err := a.findRagPython(ctx)
	if err != nil {
		a.ragSet(ragSetupStatus{State: "error", PythonRequired: true, Message: "Python 3.10 64비트가 필요합니다. Python 공식 설치 프로그램으로 설치한 뒤 환경 설정을 다시 눌러 주세요."})
		return
	}
	dir := a.ragRuntime()
	if err = os.MkdirAll(dir, 0700); err != nil {
		fail("환경 폴더를 만들 수 없습니다. 앱 데이터 폴더의 쓰기 권한을 확인해 주세요.")
		return
	}
	marker := filepath.Join(dir, "ready.json")
	if err = os.Remove(marker); err != nil && !errors.Is(err, os.ErrNotExist) {
		fail("이전 환경 상태를 갱신할 수 없습니다. 폴더 권한을 확인해 주세요.")
		return
	}
	entries, _ := rag.Files.ReadDir(".")
	for _, entry := range entries {
		b, _ := rag.Files.ReadFile(entry.Name())
		if err = writeAtomic(filepath.Join(dir, entry.Name()), b); err != nil {
			fail("검색 서비스 파일을 준비하지 못했습니다. 폴더 권한을 확인해 주세요.")
			return
		}
	}
	steps := []struct {
		message string
		exe     string
		args    []string
		timeout time.Duration
	}{
		{"전용 Python 환경을 만들고 있습니다.", python, []string{"-m", "venv", filepath.Join(dir, ".venv")}, 2 * time.Minute},
		{"pip을 확인하고 있습니다.", a.ragPython(), []string{"-m", "ensurepip", "--upgrade"}, 2 * time.Minute},
		{"패키지 설치 도구를 준비하고 있습니다.", a.ragPython(), []string{"-m", "pip", "install", "--upgrade", "pip"}, 5 * time.Minute},
		{"CPU용 검색 엔진을 설치하고 있습니다. 처음에는 몇 분 걸릴 수 있습니다.", a.ragPython(), []string{"-m", "pip", "install", "torch", "--index-url", "https://download.pytorch.org/whl/cpu"}, 30 * time.Minute},
		{"PDF 처리와 임베딩 패키지를 설치하고 있습니다.", a.ragPython(), []string{"-m", "pip", "install", "-r", filepath.Join(dir, "requirements.txt")}, 30 * time.Minute},
		{"검색 모델을 내려받고 이미지·문장 검색을 검증하고 있습니다.", a.ragPython(), []string{filepath.Join(dir, "setup_env.py")}, 45 * time.Minute},
	}
	for i, step := range steps {
		// An existing dedicated environment does not need to recreate itself.
		if i == 0 && strings.EqualFold(filepath.Clean(python), filepath.Clean(a.ragPython())) {
			continue
		}
		a.ragProgress(step.message)
		if err = a.ragRun(ctx, step.timeout, step.exe, step.args...); err != nil {
			message := step.message + " 작업에 실패했습니다. 인터넷 연결, 프록시·방화벽, 디스크 공간을 확인한 뒤 다시 시도해 주세요."
			if errors.Is(err, context.DeadlineExceeded) {
				message = "작업 시간이 초과되었습니다. " + message
			}
			fail(message)
			return
		}
	}
	if err = writeJSON(marker, map[string]string{"fingerprint": ragFingerprint()}); err != nil {
		fail("환경 검증은 끝났지만 완료 상태를 저장하지 못했습니다. 폴더 권한을 확인해 주세요.")
		return
	}
	a.ragSet(ragSetupStatus{State: "ready", Ready: true, Message: "패키지와 모델 검증을 마쳤습니다. 검색 서비스를 시작해 주세요."})
}
func (a *App) ragHealthy() bool {
	s, err := a.ragServiceInfo()
	if err != nil {
		return false
	}
	req, err := http.NewRequest("GET", s.Address+"/health", nil)
	if err != nil {
		return false
	}
	req.Header.Set("X-RAG-Key", s.Key)
	client := &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	var status struct {
		OK bool `json:"ok"`
	}
	return res.StatusCode == 200 && json.NewDecoder(res.Body).Decode(&status) == nil && status.OK
}
func (a *App) startRagService(ctx context.Context) {
	fail := func() {
		a.ragSet(ragSetupStatus{State: "error", Ready: true, Message: "검색 서비스를 시작하지 못했습니다. 다시 시작하거나 환경 설정을 다시 실행해 주세요."})
	}
	cmd := exec.CommandContext(ctx, a.ragPython(), filepath.Join(a.ragRuntime(), "rag_server.py"))
	cmd.Env = append(a.ragCommandEnv(), "HF_HUB_OFFLINE=1", "TRANSFORMERS_OFFLINE=1")
	hideCommand(cmd)
	if cmd.Start() != nil {
		fail()
		return
	}
	a.ragTrackProcess(ctx, cmd.Process)
	done := make(chan error, 1)
	go func() {
		err := cmd.Wait()
		a.ragForgetProcess(cmd.Process)
		serviceFile := filepath.Join(a.dir, "rag-service.json")
		b, _ := os.ReadFile(serviceFile)
		var service struct{ PID int }
		if json.Unmarshal(b, &service) == nil && service.PID == cmd.Process.Pid {
			_ = os.Remove(serviceFile)
		}
		done <- err
	}()
	deadline := time.NewTimer(5 * time.Minute)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-done:
			fail()
			return
		case <-deadline.C:
			_ = cmd.Process.Kill()
			fail()
			return
		case <-ticker.C:
			if a.ragHealthy() {
				a.ragSet(ragSetupStatus{State: "ready", Ready: true, Message: "패키지와 모델 검증을 마쳤습니다. 검색 서비스를 시작해 주세요."})
				return
			}
		}
	}
}
