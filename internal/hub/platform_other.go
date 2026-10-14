//go:build !windows

package hub

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
)

func protect(b []byte) ([]byte, error) {
	return nil, errors.New("토큰 저장은 Windows 배포본에서 지원합니다.")
}
func unprotect(b []byte) ([]byte, error) {
	return nil, errors.New("Windows 자격 증명은 이 환경에서 열 수 없습니다.")
}
func replaceFile(a, b string) error { return os.Rename(a, b) }
func openBrowser(u string) error    { return exec.Command("xdg-open", u).Start() }
func notifyError(m string)          { fmt.Fprintln(os.Stderr, m) }
func platformCheck() error          { return nil }
func hideCommand(c *exec.Cmd)       {}
func shortcut(t string) error       { return nil }
