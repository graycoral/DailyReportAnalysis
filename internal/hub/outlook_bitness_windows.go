package hub

import (
	"debug/pe"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// Extended MAPI must run in the installed Outlook's architecture. COM automation
// alone worked across architectures, so select the matching built-in PowerShell.
func init() {
	defaultPath := outlookPowerShell
	outlookPowerShell = func() string {
		if registeredOutlookIs32Bit() {
			path := filepath.Join(os.Getenv("SystemRoot"), "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe")
			if _, err := os.Stat(path); err == nil {
				return path
			}
		}
		return defaultPath()
	}
}

func registeredOutlookIs32Bit() bool {
	name, _ := syscall.UTF16PtrFromString(`CLSID\{0006F03A-0000-0000-C000-000000000046}\LocalServer32`)
	for _, view := range []uint32{syscall.KEY_WOW64_64KEY, syscall.KEY_WOW64_32KEY} {
		var key syscall.Handle
		if syscall.RegOpenKeyEx(syscall.HKEY_CLASSES_ROOT, name, 0, syscall.KEY_QUERY_VALUE|view, &key) != nil {
			continue
		}
		buf := make([]byte, 32768)
		size := uint32(len(buf))
		var typ uint32
		err := syscall.RegQueryValueEx(key, nil, nil, &typ, &buf[0], &size)
		syscall.RegCloseKey(key)
		if err != nil || typ != syscall.REG_SZ || size < 2 || size > uint32(len(buf)) {
			continue
		}
		chars := make([]uint16, int(size)/2)
		for i := range chars {
			chars[i] = binary.LittleEndian.Uint16(buf[i*2:])
		}
		path := outlookExecutable(syscall.UTF16ToString(chars))
		file, err := pe.Open(path)
		if err != nil {
			continue
		}
		machine := file.Machine
		file.Close()
		return machine == pe.IMAGE_FILE_MACHINE_I386
	}
	return false
}

func outlookExecutable(command string) string {
	command = strings.TrimSpace(command)
	if strings.HasPrefix(command, `"`) {
		path, _, ok := strings.Cut(command[1:], `"`)
		if ok {
			return path
		}
		return ""
	}
	if end := strings.Index(strings.ToLower(command), ".exe"); end >= 0 {
		return command[:end+4]
	}
	return ""
}
