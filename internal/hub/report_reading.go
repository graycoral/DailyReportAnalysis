package hub

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
)

// Store only content fingerprints, never report titles, bodies or mail metadata.
// The file is per app profile, so browser changes and ephemeral loopback ports
// cannot reset reading history. Publication and document archives are untouched.
type reportReading struct {
	Initialized bool     `json:"initialized"`
	ReadKeys    []string `json:"read_keys"`
}

var readingKeyPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// Caller holds readingMu. Corrupt preferences are never silently overwritten.
func (a *App) loadReportReading() (reportReading, error) {
	v := reportReading{ReadKeys: []string{}}
	b, err := os.ReadFile(filepath.Join(a.dir, "report-reading.json"))
	if errors.Is(err, os.ErrNotExist) {
		return v, nil
	}
	if err != nil {
		return v, err
	}
	if err = json.Unmarshal(b, &v); err != nil {
		return v, err
	}
	for _, key := range v.ReadKeys {
		if !readingKeyPattern.MatchString(key) {
			return v, errors.New("invalid reading fingerprint")
		}
	}
	if v.ReadKeys == nil {
		v.ReadKeys = []string{}
	}
	return v, nil
}

func (a *App) handleReportReading(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && !post(w, r) {
		return
	}
	var input struct {
		Action   string   `json:"action"`
		ReadKeys []string `json:"read_keys"`
	}
	if r.Method == http.MethodPost {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&input); err != nil || (input.Action != "initialize" && input.Action != "read") || len(input.ReadKeys) > 50000 || (input.Action == "read" && len(input.ReadKeys) != 1) {
			http.Error(w, "잘못된 리포트 읽음 요청입니다.", http.StatusBadRequest)
			return
		}
		for _, key := range input.ReadKeys {
			if !readingKeyPattern.MatchString(key) {
				http.Error(w, "잘못된 리포트 식별자입니다.", http.StatusBadRequest)
				return
			}
		}
	}
	a.readingMu.Lock()
	defer a.readingMu.Unlock()
	v, err := a.loadReportReading()
	if err != nil {
		http.Error(w, "리포트 읽음 기록을 불러오지 못했습니다. 저장 폴더를 확인해 주세요.", http.StatusInternalServerError)
		return
	}
	changed := false
	if r.Method == http.MethodPost {
		if input.Action == "initialize" && !v.Initialized {
			v.Initialized = true
			v.ReadKeys = slices.Clone(input.ReadKeys)
			changed = true
		} else if input.Action == "read" {
			if !v.Initialized {
				http.Error(w, "읽음 기록 초기화 후 다시 시도하세요.", http.StatusConflict)
				return
			}
			if !slices.Contains(v.ReadKeys, input.ReadKeys[0]) {
				v.ReadKeys = append(v.ReadKeys, input.ReadKeys[0])
				changed = true
			}
		}
	}
	if changed {
		slices.Sort(v.ReadKeys)
		v.ReadKeys = slices.Compact(v.ReadKeys)
		if v.ReadKeys == nil {
			v.ReadKeys = []string{}
		}
		if err = writeJSON(filepath.Join(a.dir, "report-reading.json"), v); err != nil {
			http.Error(w, "리포트 읽음 기록을 저장하지 못했습니다. 저장 폴더의 쓰기 권한과 여유 공간을 확인하세요.", http.StatusInternalServerError)
			return
		}
	}
	writeResponse(w, v)
}
