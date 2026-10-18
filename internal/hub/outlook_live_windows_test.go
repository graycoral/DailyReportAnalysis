//go:build windows

package hub

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Temporary diagnostic: private data stays in the bridge pipe and memory.
func TestLiveEmbeddedDiagnostic(t *testing.T) {
	if os.Getenv("AVHUB_LIVE_DIAGNOSTIC") != "1" {
		t.Skip("local Outlook diagnostic")
	}
	a := &App{dir: filepath.Join(os.Getenv("LOCALAPPDATA"), "AVReportHub")}
	local, err := a.viewLocal()
	if err != nil {
		t.Fatal(err)
	}
	old := outlookReportScript
	defer func() { outlookReportScript = old }()
	outlookReportScript = strings.Replace(outlookReportScript, "$table = $folder.GetTable($filter, 0)", `$filter = '@SQL="urn:schemas:httpmail:subject" LIKE ''%데일리%'''; $table = $folder.GetTable($filter, 0)`, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	var batch outlookBatch
	if err = runOutlook(ctx, outlookReq{Op: "reports", Sources: local.Sources, Limit: 100}, &batch); err != nil {
		t.Fatal(err)
	}
	t.Logf("scanned=%d items=%d failed=%d limited=%d", batch.Scanned, len(batch.Items), batch.Failed, batch.Limited)
	for _, doc := range batch.Items {
		for _, f := range doc.Attachments {
			report, err := parseReport([]byte(f.Body), f.Name, nil)
			if err != nil {
				t.Logf("file=%s error=%v", f.Name, err)
				if strings.Contains(f.Name,"09-20") || strings.Contains(f.Name,"10-16") || strings.Contains(f.Name,"10-02") {
					for _, line := range strings.Split(f.Body,"\n") { if strings.HasPrefix(line,"# ") || strings.HasPrefix(line,"## ") || strings.HasPrefix(line,"title:") || strings.HasPrefix(line,"info:") {t.Log(strings.TrimSpace(line))} }
				}
			} else {
				t.Logf("date=%s imported", report.Date)
			}
		}
	}
}
