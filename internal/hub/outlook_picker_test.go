package hub

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOutlookPickerSelectionAndCancellation(t *testing.T) {
	a := &App{dir: t.TempDir()}
	for _, selected := range []string{`D:\회사 메일\보관.pst`, ""} {
		t.Run(selected, func(t *testing.T) {
			h := a.outlookPickerHandler(func() (string, error) { return selected, nil })
			w := httptest.NewRecorder()
			h(w, httptest.NewRequest(http.MethodPost, "/api/outlook/pick", nil))
			var got struct {
				Path      string `json:"path"`
				Cancelled bool   `json:"cancelled"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if w.Code != http.StatusOK || got.Path != selected || got.Cancelled != (selected == "") {
				t.Fatalf("picker: %d %+v", w.Code, got)
			}
		})
	}
}

func TestOutlookPickerRejectsOverlappingDialogsAndRecovers(t *testing.T) {
	a := &App{dir: t.TempDir()}
	opened, closeDialog := make(chan struct{}), make(chan struct{})
	calls := 0
	h := a.outlookPickerHandler(func() (string, error) {
		calls++
		if calls == 1 {
			close(opened)
			<-closeDialog
			return "", errors.New("picker failed")
		}
		return "", nil
	})
	first := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		h(first, httptest.NewRequest(http.MethodPost, "/api/outlook/pick", nil))
	}()
	<-opened
	second := httptest.NewRecorder()
	h(second, httptest.NewRequest(http.MethodPost, "/api/outlook/pick", nil))
	close(closeDialog)
	<-done
	if second.Code != http.StatusConflict || calls != 1 {
		t.Fatalf("overlapping picker: %d, %d dialogs", second.Code, calls)
	}
	if first.Code != http.StatusInternalServerError {
		t.Fatalf("picker error: %d", first.Code)
	}
	third := httptest.NewRecorder()
	h(third, httptest.NewRequest(http.MethodPost, "/api/outlook/pick", nil))
	if third.Code != http.StatusOK || calls != 2 {
		t.Fatalf("picker did not recover: %d, %d calls", third.Code, calls)
	}
}

func TestOutlookPickerRequiresPostAndLocalStorage(t *testing.T) {
	a := &App{dir: t.TempDir()}
	h := a.outlookPickerHandler(func() (string, error) {
		t.Fatal("invalid request opened a file dialog")
		return "", nil
	})
	w := httptest.NewRecorder()
	h(w, httptest.NewRequest(http.MethodGet, "/api/outlook/pick", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET: %d", w.Code)
	}
	a.setup = true
	w = httptest.NewRecorder()
	h(w, httptest.NewRequest(http.MethodPost, "/api/outlook/pick", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("setup picker: %d", w.Code)
	}
}
