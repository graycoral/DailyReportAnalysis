//go:build !windows

package hub

import "errors"

func pickNotesFolder() (string, error) {
	return "", errors.New("노트 폴더 경로를 직접 입력하세요.")
}
