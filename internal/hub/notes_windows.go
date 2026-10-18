//go:build windows

package hub

import (
	"errors"
	"runtime"
	"syscall"
	"unsafe"
)

func pickNotesFolder() (string, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	ole := syscall.NewLazyDLL("ole32.dll")
	hr, _, _ := ole.NewProc("CoInitializeEx").Call(0, 2)
	if int32(hr) < 0 {
		return "", errors.New("폴더 선택 창을 열 수 없습니다. 경로를 직접 입력하세요.")
	}
	defer ole.NewProc("CoUninitialize").Call()
	type browseInfo struct {
		Owner, Root     uintptr
		Display, Title  *uint16
		Flags           uint32
		Callback, Param uintptr
		Image           int32
	}
	title, _ := syscall.UTF16PtrFromString("노트를 저장할 폴더 선택 · 기존 파일은 이동하지 않습니다")
	display := make([]uint16, 260)
	owner, _, _ := syscall.NewLazyDLL("user32.dll").NewProc("GetForegroundWindow").Call()
	info := browseInfo{Owner: owner, Display: &display[0], Title: title, Flags: 0x41}
	id, _, _ := shell32.NewProc("SHBrowseForFolderW").Call(uintptr(unsafe.Pointer(&info)))
	if id == 0 {
		return "", nil
	}
	defer ole.NewProc("CoTaskMemFree").Call(id)
	buf := make([]uint16, 32768)
	ok, _, _ := shell32.NewProc("SHGetPathFromIDListW").Call(id, uintptr(unsafe.Pointer(&buf[0])))
	if ok == 0 {
		return "", errors.New("로컬 파일 폴더를 선택하세요.")
	}
	return syscall.UTF16ToString(buf), nil
}
