package hub

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"time"
)

// Trash keeps the encrypted file and its connections until explicit permanent deletion.
func (a *App) localTrash(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		a.localMu.Lock()
		defer a.localMu.Unlock()
		if err := a.localBlocked(); err != nil {
			localFail(w, "trash", err)
			return
		}
		x, err := a.loadLocal()
		if err != nil {
			localFail(w, "trash", err)
			return
		}
		x.Files = slices.DeleteFunc(x.Files, func(f LocalFile) bool { return f.Deleted == "" })
		x.Mails = slices.DeleteFunc(x.Mails, func(m MailLink) bool { return m.Deleted == "" })
		x.Sources = nil
		writeResponse(w, x)
		return
	}
	if !post(w, r) {
		return
	}
	var in struct {
		Action string  `json:"action"`
		Kind   string  `json:"kind"`
		ID     string  `json:"id"`
		Mail   MailRef `json:"mail"`
	}
	if err := decodeBody(r, &in); err != nil {
		localFail(w, "trash", err)
		return
	}
	if in.Action != "trash" && in.Action != "restore" && in.Action != "delete" {
		http.Error(w, "잘못된 휴지통 요청입니다.", 400)
		return
	}
	if in.Kind == "pdf" && !localIDPattern.MatchString(in.ID) {
		http.Error(w, "잘못된 PDF ID입니다.", 400)
		return
	}
	if in.Kind == "pdf" && in.Action == "delete" {
		if err := a.purgePDF(in.ID); err != nil {
			localFail(w, "trash", err)
			return
		}
		writeResponse(w, map[string]bool{"ok": true})
		return
	}
	err := a.editLocal(func(x *LocalIndex) error {
		stamp := ""
		if in.Action == "trash" {
			stamp = time.Now().UTC().Format(time.RFC3339Nano)
		}
		if in.Kind == "pdf" {
			for i := range x.Files {
				if x.Files[i].ID == in.ID {
					x.Files[i].Deleted = stamp
					return nil
				}
			}
		} else if in.Kind == "mail" {
			found := false
			for i := 0; i < len(x.Mails); i++ {
				m := &x.Mails[i]
				if m.EntryID != in.Mail.EntryID || m.StoreID != in.Mail.StoreID || m.Path != in.Mail.Path {
					continue
				}
				found = true
				if in.Action == "delete" {
					x.Mails = append(x.Mails[:i], x.Mails[i+1:]...)
					i--
				} else {
					m.Deleted = stamp
				}
			}
			if found {
				return nil
			}
		}
		return errors.New("자료를 찾을 수 없습니다.")
	})
	if err != nil {
		localFail(w, "trash", err)
		return
	}
	writeResponse(w, map[string]bool{"ok": true})
}

func (a *App) purgePDF(id string) error {
	if !localIDPattern.MatchString(id) {
		return errors.New("잘못된 PDF ID입니다.")
	}
	a.localMu.Lock()
	defer a.localMu.Unlock()
	if err := a.localBlocked(); err != nil {
		return err
	}
	x, err := a.loadLocal()
	if err != nil {
		return err
	}
	if !slices.ContainsFunc(x.Files, func(f LocalFile) bool { return f.ID == id }) {
		return errors.New("내 자료를 찾을 수 없습니다.")
	}
	before := x
	x.Files = slices.DeleteFunc(slices.Clone(x.Files), func(f LocalFile) bool { return f.ID == id })
	// A failed metadata save must leave the original file intact. If Windows
	// refuses removal, restore its metadata so the user can retry from the list.
	if err = a.saveLocal(x); err != nil {
		return err
	}
	if err = os.Remove(a.blobPath(id)); err != nil && !os.IsNotExist(err) {
		return errors.Join(err, a.saveLocal(before))
	}
	a.pdfCache.discard(a.blobPath(id))
	return nil
}

// The published repository and the original Outlook mailbox are never edited.
// Permanent deletion removes this PC's copy and remembers IDs across later syncs.
func withoutReports(c Catalog, ids []string) Catalog {
	chosen := func(id string) bool { return slices.Contains(ids, id) }
	c.Reports = slices.DeleteFunc(slices.Clone(c.Reports), func(r Report) bool { return chosen(r.ID) })
	c.Events = slices.DeleteFunc(slices.Clone(c.Events), func(e Event) bool { return chosen(e.ReportID) })
	c.Relations = slices.DeleteFunc(slices.Clone(c.Relations), func(e Relation) bool { return chosen(e.ReportID) })
	c.Related = slices.DeleteFunc(slices.Clone(c.Related), func(e Related) bool { return chosen(e.From) || chosen(e.To) })
	if len(ids) > 0 {
		c.Database = nil
	} // The immutable DB also contains deleted report bodies.
	return c
}

func (a *App) permanentlyDeleteReports(w http.ResponseWriter, r *http.Request) {
	if !post(w, r) {
		return
	}
	var in struct {
		IDs []string `json:"report_ids"`
	}
	if err := decodeBody(r, &in); err != nil || len(in.IDs) == 0 {
		http.Error(w, "삭제할 리포트를 선택하세요.", 400)
		return
	}
	a.syncLock.Lock()
	defer a.syncLock.Unlock()
	a.mu.Lock()
	defer a.mu.Unlock()
	a.localMu.Lock()
	defer a.localMu.Unlock()
	a.visibilityMu.Lock()
	defer a.visibilityMu.Unlock()
	fail := func(err error) { localFail(w, "report delete", err) }
	if err := a.localBlocked(); err != nil {
		fail(err)
		return
	}
	v, err := a.loadReportVisibility()
	if err != nil {
		fail(err)
		return
	}
	x, err := a.loadReports()
	if err != nil {
		fail(err)
		return
	}
	for _, id := range in.IDs {
		if !slices.ContainsFunc(a.snapshot.Catalog.Reports, func(r Report) bool { return r.ID == id }) && !slices.ContainsFunc(x.Reports, func(r importedReport) bool { return r.ID == id }) && !slices.Contains(v.DeletedReports, id) {
			http.Error(w, "리포트를 찾을 수 없습니다.", 404)
			return
		}
	}
	for _, id := range in.IDs {
		if !slices.Contains(v.DeletedReports, id) {
			v.DeletedReports = append(v.DeletedReports, id)
		}
	}
	// Persist the tombstone before removing bodies, so interrupted operations remain retryable.
	if err = writeJSON(filepath.Join(a.dir, "report-visibility.json"), v); err != nil {
		fail(err)
		return
	}
	x.Reports = slices.DeleteFunc(x.Reports, func(r importedReport) bool { return slices.Contains(in.IDs, r.ID) })
	if err = a.saveReports(x); err != nil {
		fail(err)
		return
	}
	snap := a.snapshot
	snap.Catalog = withoutReports(snap.Catalog, v.DeletedReports)
	if err = writeJSON(filepath.Join(a.dir, "snapshot.json"), snap); err != nil {
		fail(err)
		return
	}
	a.snapshot = snap
	if err = a.pruneCache(snap.Catalog); err != nil {
		fail(err)
		return
	}
	v.HiddenReports = slices.DeleteFunc(v.HiddenReports, func(id string) bool { return slices.Contains(in.IDs, id) })
	if err = writeJSON(filepath.Join(a.dir, "report-visibility.json"), v); err != nil {
		fail(err)
		return
	}
	writeResponse(w, v)
}
