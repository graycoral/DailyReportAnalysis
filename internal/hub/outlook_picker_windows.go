//go:build windows

package hub

import (
	"fmt"
	"runtime"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

// OPENFILENAMEW, including pointer-sized fields on both 32- and 64-bit Windows.
// https://learn.microsoft.com/windows/win32/api/commdlg/ns-commdlg-openfilenamew
type openFileName struct {
	Size                         uint32
	Owner, Instance              uintptr
	Filter, CustomFilter         *uint16
	MaxCustomFilter, FilterIndex uint32
	File                         *uint16
	MaxFile                      uint32
	FileTitle                    *uint16
	MaxFileTitle                 uint32
	InitialDir, Title            *uint16
	Flags                        uint32
	FileOffset, FileExtension    uint16
	DefaultExtension             *uint16
	CustomData, Hook             uintptr
	TemplateName                 *uint16
	Reserved                     uintptr
	ReservedWord, FlagsEx        uint32
}

func pickOutlookFile() (string, error) {
	// Shell dialogs and their error state belong to the calling Windows thread.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	ole32 := syscall.NewLazyDLL("ole32.dll")
	hr, _, _ := ole32.NewProc("CoInitializeEx").Call(0, 2) // COINIT_APARTMENTTHREADED
	if int32(hr) < 0 {
		return "", fmt.Errorf("파일 선택 창을 준비하지 못했습니다. 경로를 직접 입력해 추가하세요. (0x%08X)", uint32(hr))
	}
	defer ole32.NewProc("CoUninitialize").Call()
	filter := utf16.Encode([]rune("Outlook 데이터 파일 (*.pst; *.ost)\x00*.pst;*.ost\x00PST 파일 (*.pst)\x00*.pst\x00OST 파일 (*.ost)\x00*.ost\x00\x00"))
	title, _ := syscall.UTF16PtrFromString("Outlook PST·OST 파일 선택")
	file := make([]uint16, 32768)
	owner, _, _ := syscall.NewLazyDLL("user32.dll").NewProc("GetForegroundWindow").Call()
	dialog := openFileName{
		Owner: owner, Filter: &filter[0], FilterIndex: 1,
		File: &file[0], MaxFile: uint32(len(file)), Title: title,
		// EXPLORER | FILEMUSTEXIST | PATHMUSTEXIST | NOCHANGEDIR |
		// HIDEREADONLY | DONTADDTORECENT. Select one existing file only.
		Flags: 0x00080000 | 0x00001000 | 0x00000800 | 0x00000008 | 0x00000004 | 0x02000000,
	}
	dialog.Size = uint32(unsafe.Sizeof(dialog))
	comdlg32 := syscall.NewLazyDLL("comdlg32.dll")
	ok, _, _ := comdlg32.NewProc("GetOpenFileNameW").Call(uintptr(unsafe.Pointer(&dialog)))
	if ok == 0 {
		code, _, _ := comdlg32.NewProc("CommDlgExtendedError").Call()
		if code != 0 {
			return "", fmt.Errorf("파일 선택 창을 열지 못했습니다. 경로를 직접 입력해 추가하세요. (0x%04X)", code)
		}
		return "", nil // Closing the window or pressing Cancel is not an error.
	}
	return syscall.UTF16ToString(file), nil
}
