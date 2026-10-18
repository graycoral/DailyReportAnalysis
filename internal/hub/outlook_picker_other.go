//go:build !windows

package hub

import "errors"

func pickOutlookFile() (string, error) {
	return "", errors.New("파일 선택 창은 Windows에서 지원합니다. 경로를 직접 입력해 추가하세요.")
}
