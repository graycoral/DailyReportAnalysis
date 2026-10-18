package hub

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Classic Outlook is driven through its COM object model by the built-in Windows PowerShell.
// Script/input and output cross the process boundary as base64 UTF-8 over pipes.
// Selected report folders additionally return candidate Markdown, never to a temporary file.
//
//go:embed outlook.ps1
var outlookScript string

//go:embed outlook_reports.ps1
var outlookReportScript string

//go:embed outlook_embedded.cs
var outlookEmbeddedSource string

var outlookPowerShell = func() string {
	return filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

type outlookReq struct {
	Op      string                   `json:"op"`
	Sources []OutlookSource          `json:"sources,omitempty"`
	Terms   []string                 `json:"terms,omitempty"`
	All     bool                     `json:"all,omitempty"`
	From    string                   `json:"from,omitempty"`
	To      string                   `json:"to,omitempty"`
	Limit   int                      `json:"limit,omitempty"`
	Mail    *MailRef                 `json:"mail,omitempty"`
	Cursors map[string]outlookCursor `json:"cursors,omitempty"`
}

func outlookMessage(code, msg string) string {
	switch code {
	case "clm":
		return "회사 보안 정책(PowerShell 제한 모드) 때문에 Outlook에 연결할 수 없습니다."
	case "com":
		return "클래식 Outlook에 연결할 수 없습니다. 클래식 Outlook이 설치·설정되어 있는지 확인하세요. (새 Outlook은 지원하지 않습니다)"
	case "item":
		return "메일을 찾을 수 없습니다. 이동·삭제되었거나 해당 PST가 연결되지 않았을 수 있습니다."
	case "source":
		return msg
	}
	return "Outlook 처리 중 오류가 발생했습니다: " + msg
}
func runOutlook(ctx context.Context, req outlookReq, out any) error {
	if runtime.GOOS != "windows" {
		return errors.New("Outlook 연결은 Windows에서만 지원합니다.")
	}
	in, e := json.Marshal(req)
	if e != nil {
		return e
	}
	script := strings.Replace(outlookScript, "# REPORT_IMPORT_CASE", outlookReportScript, 1)
	script = strings.Replace(script, "# EMBEDDED_REPORT_SOURCE", base64.StdEncoding.EncodeToString([]byte(outlookEmbeddedSource)), 1)
	ps := outlookPowerShell()
	cmd := exec.CommandContext(ctx, ps, "-NoProfile", "-NonInteractive", "-Command", "$s=[Console]::ReadLine(); & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s))))")
	cmd.Stdin = strings.NewReader(base64.StdEncoding.EncodeToString([]byte(script)) + "\n" + base64.StdEncoding.EncodeToString(in))
	hideCommand(cmd)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	re := cmd.Run()
	if ctx.Err() != nil {
		log.Printf("outlook %s: timeout", req.Op)
		return errors.New("Outlook 응답이 너무 늦습니다. 검색 범위를 줄이거나 Outlook 상태를 확인하세요.")
	}
	raw, de := base64.StdEncoding.DecodeString(strings.TrimSpace(stdout.String()))
	if de != nil || len(raw) == 0 {
		// stderr may echo mail data, so only its size is logged.
		log.Printf("outlook %s: run %v, stdout %d bytes, stderr %d bytes", req.Op, re, stdout.Len(), stderr.Len())
		return errors.New("Outlook 연결 도구를 실행하지 못했습니다. 클래식 Outlook 설치 여부와 회사 보안 정책을 확인하세요.")
	}
	var v struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if json.Unmarshal(raw, &v) == nil && (v.Error != "" || v.Code != "") {
		log.Printf("outlook %s: failed (%s)", req.Op, v.Code)
		return errors.New(outlookMessage(v.Code, v.Error))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}
