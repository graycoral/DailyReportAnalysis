package hub

import (
	"net/http"
	"sync"
	"time"
)

// The browser cannot read a selected file's absolute path. Ask the local app
// to show a native picker, returning only the path (never the PST contents).
func (a *App) outlookPickerHandler(pick func() (string, error)) http.HandlerFunc {
	var picking sync.Mutex
	return func(w http.ResponseWriter, r *http.Request) {
		if !post(w, r) {
			return
		}
		if err := a.localBlocked(); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if !picking.TryLock() {
			http.Error(w, "파일 선택 창이 이미 열려 있습니다. 열린 창에서 파일을 선택하거나 취소하세요.", http.StatusConflict)
			return
		}
		defer picking.Unlock()
		// Browsing folders can take longer than the usual API write timeout.
		_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})
		path, err := pick()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeResponse(w, map[string]any{"path": path, "cancelled": path == ""})
	}
}
