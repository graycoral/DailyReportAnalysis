package hub

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"slices"
)

// Display preferences live in the current user's data directory, separately from
// the published snapshot, database, attachments and local document links.
type reportVisibility struct {
	HiddenReports []string `json:"hidden_reports"`
	Error         string   `json:"error,omitempty"`
}

// Caller holds visibilityMu. Never replace unreadable preferences when hiding.
func (a *App) loadReportVisibility() (reportVisibility, error) {
	v := reportVisibility{HiddenReports: []string{}}
	b, err := os.ReadFile(filepath.Join(a.dir, "report-visibility.json"))
	if errors.Is(err, os.ErrNotExist) {
		return v, nil
	}
	if err != nil {
		return v, err
	}
	if err = json.Unmarshal(b, &v); err != nil {
		return reportVisibility{HiddenReports: []string{}}, err
	}
	if v.HiddenReports == nil {
		v.HiddenReports = []string{}
	}
	return v, nil
}

func (a *App) reportVisibility() reportVisibility {
	a.visibilityMu.Lock()
	defer a.visibilityMu.Unlock()
	v, err := a.loadReportVisibility()
	if err != nil {
		v.Error = "숨김 설정을 읽지 못했습니다. 잠시 후 다시 시도하거나 전체 복원으로 숨김 설정을 초기화하세요."
	}
	return v
}

func (a *App) changeReportVisibility(w http.ResponseWriter, r *http.Request) {
	if !post(w, r) {
		return
	}
	var input struct {
		Action   string `json:"action"`
		ReportID string `json:"report_id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&input); err != nil {
		http.Error(w, "잘못된 숨김 요청입니다.", http.StatusBadRequest)
		return
	}
	if input.Action != "hide" && input.Action != "restore-all" {
		http.Error(w, "지원하지 않는 숨김 요청입니다.", http.StatusBadRequest)
		return
	}
	if input.Action == "hide" {
		a.mu.RLock()
		exists := slices.ContainsFunc(a.snapshot.Catalog.Reports, func(r Report) bool { return r.ID == input.ReportID })
		a.mu.RUnlock()
		if !exists {
			http.Error(w, "리포트를 찾을 수 없습니다.", http.StatusNotFound)
			return
		}
	}
	a.visibilityMu.Lock()
	defer a.visibilityMu.Unlock()
	v := reportVisibility{HiddenReports: []string{}}
	if input.Action == "hide" {
		var err error
		v, err = a.loadReportVisibility()
		if err != nil {
			http.Error(w, "숨김 설정을 읽지 못해 변경하지 않았습니다. 전체 복원 후 다시 시도하세요.", http.StatusInternalServerError)
			return
		}
		if !slices.Contains(v.HiddenReports, input.ReportID) {
			v.HiddenReports = append(v.HiddenReports, input.ReportID)
		}
	}
	if err := writeJSON(filepath.Join(a.dir, "report-visibility.json"), v); err != nil {
		http.Error(w, "숨김 설정을 저장하지 못했습니다. 저장 폴더의 쓰기 권한과 여유 공간을 확인하세요.", http.StatusInternalServerError)
		return
	}
	writeResponse(w, v)
}
