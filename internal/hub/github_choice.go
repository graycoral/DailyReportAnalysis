package hub

import (
	"encoding/json"
	"net/http"
	"path/filepath"
)

// Version detection is entirely local. Legacy configurations without a recorded
// decision are prompted once when the upgraded viewer first starts.
// Caller holds mu.
func (a *App) githubChoiceRequired() bool {
	return !a.setup && a.config.GitHubChoiceVersion != Version
}

func (a *App) chooseGitHub(w http.ResponseWriter, r *http.Request) {
	if !post(w, r) {
		return
	}
	var input struct {
		Version string `json:"version"`
		Enabled *bool  `json:"enabled"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&input) != nil || input.Enabled == nil {
		http.Error(w, "GitHub 연동 여부를 선택하세요.", http.StatusBadRequest)
		return
	}
	if a.setup || input.Version != Version {
		http.Error(w, "현재 실행 중인 버전에서 다시 선택하세요. 화면을 새로고침해 주세요.", http.StatusConflict)
		return
	}
	a.syncLock.Lock()
	a.mu.Lock()
	cfg := a.config
	changed := cfg.GitHubChoiceVersion != Version
	if changed {
		cfg.Offline = !*input.Enabled
		cfg.OfflineReason = ""
		cfg.Configured = true
		cfg.GitHubChoiceVersion = Version
		if err := writeJSON(filepath.Join(a.dir, "config.json"), cfg); err != nil {
			a.mu.Unlock()
			a.syncLock.Unlock()
			http.Error(w, "선택을 저장하지 못했습니다. 다시 시도해 주세요.", http.StatusInternalServerError)
			return
		}
		a.config = cfg
		a.syncState = ""
		a.status = "GitHub 연동 설정을 저장했습니다."
	}
	a.mu.Unlock()
	a.syncLock.Unlock()
	writeResponse(w, map[string]any{"ok": true, "config": cfg, "github_choice_required": false})
	// Another tab may submit the same prompt. The first saved decision wins;
	// subsequent changes are made explicitly through settings.
	if changed && cfg.githubEnabled() {
		go a.syncData()
	}
}
