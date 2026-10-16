//go:build windows

package hub

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

var crypt32 = syscall.NewLazyDLL("crypt32.dll")
var kernel32 = syscall.NewLazyDLL("kernel32.dll")
var shell32 = syscall.NewLazyDLL("shell32.dll")

type blob struct {
	Len  uint32
	Data *byte
}

func protect(b []byte) ([]byte, error)   { return dpapi(b, true) }
func unprotect(b []byte) ([]byte, error) { return dpapi(b, false) }
func dpapi(b []byte, encrypt bool) ([]byte, error) {
	if len(b) == 0 {
		return nil, nil
	}
	in := blob{uint32(len(b)), &b[0]}
	var out blob
	name := "CryptUnprotectData"
	if encrypt {
		name = "CryptProtectData"
	}
	r, _, err := crypt32.NewProc(name).Call(uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0, 1, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, fmt.Errorf("Windows 자격 증명 암호화 오류: %w", err)
	}
	defer kernel32.NewProc("LocalFree").Call(uintptr(unsafe.Pointer(out.Data)))
	return append([]byte{}, unsafe.Slice(out.Data, out.Len)...), nil
}
func replaceFile(from, to string) error {
	a, e := syscall.UTF16PtrFromString(from)
	if e != nil {
		return e
	}
	b, e := syscall.UTF16PtrFromString(to)
	if e != nil {
		return e
	}
	r, _, err := kernel32.NewProc("MoveFileExW").Call(uintptr(unsafe.Pointer(a)), uintptr(unsafe.Pointer(b)), 9)
	if r == 0 {
		return err
	}
	return nil
}
func openBrowser(url string) error {
	verb, _ := syscall.UTF16PtrFromString("open")
	p, _ := syscall.UTF16PtrFromString(url)
	r, _, _ := shell32.NewProc("ShellExecuteW").Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(p)), 0, 0, 1)
	if r <= 32 {
		return errors.New("기본 브라우저를 열 수 없습니다.")
	}
	return nil
}
func notifyError(msg string) {
	text, _ := syscall.UTF16PtrFromString(msg)
	title, _ := syscall.UTF16PtrFromString("AV 리포트")
	syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), 0x10)
}
func platformCheck() error {
	type versionInfo struct {
		Size, Major, Minor, Build, Platform uint32
		CSD                                 [128]uint16
	}
	v := versionInfo{}
	v.Size = uint32(unsafe.Sizeof(v))
	r, _, _ := syscall.NewLazyDLL("ntdll.dll").NewProc("RtlGetVersion").Call(uintptr(unsafe.Pointer(&v)))
	if r != 0 || v.Major < 10 {
		return errors.New("Windows 10 이상이 필요합니다.")
	}
	return nil
}
func hideCommand(c *exec.Cmd) { c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }
func shortcut(target string) error {
	// Windows PowerShell is only used for an optional shortcut, not the app runtime.
	ps := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	if _, err := os.Stat(ps); err != nil {
		return errors.New("바로가기 생성 도구가 없습니다. 설치 폴더에서 실행할 수 있습니다.")
	}
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	script := "$ErrorActionPreference='Stop'; $w=New-Object -ComObject WScript.Shell; $p=Join-Path ([Environment]::GetFolderPath('Desktop')) 'AV Report Hub.lnk'; $s=$w.CreateShortcut($p); $s.TargetPath=" + quote(target) + "; $s.WorkingDirectory=" + quote(filepath.Dir(target)) + "; $s.IconLocation=" + quote(target+",0") + "; $s.Save()"
	cmd := exec.Command(ps, "-NoProfile", "-NonInteractive", "-Command", script)
	hideCommand(cmd)
	if err := cmd.Run(); err != nil {
		return errors.New("바로가기 생성이 허용되지 않았습니다. 설치 폴더에서 실행하세요.")
	}
	return nil
}
