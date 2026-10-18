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
	HiddenReports  []string `json:"hidden_reports"`
	DeletedReports []string `json:"deleted_reports,omitempty"`
	Error          string   `json:"error,omitempty"`
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
		Action    string   `json:"action"`
		ReportID  string   `json:"report_id"`
		ReportIDs []string `json:"report_ids"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&input); err != nil {
		http.Error(w, "잘못된 숨김 요청입니다.", http.StatusBadRequest)
		return
	}
	if input.Action != "hide" && input.Action != "restore" && input.Action != "restore-all" {
		http.Error(w, "지원하지 않는 숨김 요청입니다.", http.StatusBadRequest)
		return
	}
	if input.Action == "restore" && len(input.ReportIDs) == 0 {
		http.Error(w, "복원할 리포트를 선택하세요.", http.StatusBadRequest)
		return
	}
	if input.Action == "hide" {
		if input.ReportID != "" {
			input.ReportIDs = append(input.ReportIDs, input.ReportID)
		}
		if len(input.ReportIDs) == 0 {
			http.Error(w, "삭제할 리포트를 선택하세요.", 400)
			return
		}
		for _, id := range input.ReportIDs {
			if !a.hasReport(id) {
				http.Error(w, "리포트를 찾을 수 없습니다.", http.StatusNotFound)
				return
			}
		}
	}
	a.visibilityMu.Lock()
	defer a.visibilityMu.Unlock()
	v, loadErr := a.loadReportVisibility()
	if loadErr != nil && input.Action != "restore-all" {
		http.Error(w, "숨김 설정을 읽지 못했습니다.", 500)
		return
	}
	if input.Action == "restore-all" {
		v.HiddenReports = []string{}
	}
	if input.Action != "restore-all" {
		if input.Action == "hide" {
			for _, id := range input.ReportIDs {
				if !slices.Contains(v.HiddenReports, id) && !slices.Contains(v.DeletedReports, id) {
					v.HiddenReports = append(v.HiddenReports, id)
				}
			}
		}
		if input.Action == "restore" {
			chosen := make(map[string]bool, len(input.ReportIDs))
			for _, id := range input.ReportIDs {
				chosen[id] = true
			}
			v.HiddenReports = slices.DeleteFunc(v.HiddenReports, func(id string) bool { return chosen[id] })
		}
	}
	if err := writeJSON(filepath.Join(a.dir, "report-visibility.json"), v); err != nil {
		http.Error(w, "숨김 설정을 저장하지 못했습니다. 저장 폴더의 쓰기 권한과 여유 공간을 확인하세요.", http.StatusInternalServerError)
		return
	}
	writeResponse(w, v)
}
