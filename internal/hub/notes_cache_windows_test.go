//go:build windows

package hub

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestNotesGetAndSaveIgnoreLockedUnrelatedFile(t *testing.T) {
	a := &App{dir: t.TempDir()}
	root, _ := a.notesRoot()
	target, err := a.noteSave(root, noteInput{Path: "target.md", Body: "target"})
	if err != nil {
		t.Fatal(err)
	}
	sibling, err := a.noteSave(root, noteInput{Path: "unrelated.md", Body: "unrelated"})
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(root, sibling.Path)
	if err := os.WriteFile(p, append(sibling.raw, []byte(" external edit")...), 0600); err != nil {
		t.Fatal(err)
	}
	name, _ := syscall.UTF16PtrFromString(p)
	locked, err := syscall.CreateFile(name, syscall.GENERIC_READ, 0, nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(locked)
	if _, err := a.noteGet(root, target.ID); err != nil {
		t.Fatal("GET read an unrelated file", err)
	}
	if _, err := a.noteSave(root, noteInput{ID: target.ID, Path: target.Path, Version: target.Version, Body: "saved"}); err != nil {
		t.Fatal("save read an unrelated file", err)
	}
}
