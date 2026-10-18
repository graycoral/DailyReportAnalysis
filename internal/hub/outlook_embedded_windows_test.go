//go:build windows

package hub

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

func TestOutlookExecutableRegistration(t *testing.T) {
	for input, expected := range map[string]string{
		`"C:\Program Files\Office\OUTLOOK.EXE" /automation`:     `C:\Program Files\Office\OUTLOOK.EXE`,
		`C:\Program Files (x86)\Office\OUTLOOK.EXE /automation`: `C:\Program Files (x86)\Office\OUTLOOK.EXE`,
		`"unterminated`: "",
	} {
		if got := outlookExecutable(input); got != expected {
			t.Fatalf("registry command %q: %q", input, got)
		}
	}
}

func TestOutlookBridgeEmbeddedAttachmentsAndRetry(t *testing.T) {
	oldScript, oldReports := outlookScript, outlookReportScript
	defer func() { outlookScript, outlookReportScript = oldScript, oldReports }()
	start := "try { $ol = New-Object -ComObject Outlook.Application; $ns = $ol.GetNamespace('MAPI') } catch { Fail 'com' $_.Exception.Message }"
	fixture := outlookBridgeFixture + `
$ns.item.Body='forwarded message'
$ns.item.Attachments=@([pscustomobject]@{Type=5;FileName='original.msg';Size=12000})
`
	outlookScript = strings.Replace(oldScript, start, fixture, 1)
	// Mock only native MAPI; exercise production extraction, hashing, JSON and
	// cursor behavior without an Outlook installation or real mail in CI.
	mock := `$script:embeddedReader = $null
    function ReadEmbeddedReports($storeID,$entryID,$maximum) {
      if ($storeID -ne '00AA' -or $maximum -ne 8) {throw 'incorrect scope'}
      return [pscustomobject]@{Files=@([pscustomobject]@{Name='daily.md';Body=[string]$req.terms[0]});Failed=[int]$req.terms[1];Limited=0}
    }
`
	outlookReportScript = strings.Replace(oldReports, "$script:embeddedReader = $null", mock, 1)
	req := outlookReq{Op: "reports", Sources: []OutlookSource{{StoreID: "00AA", FolderID: "00BB"}}, Limit: 1, Terms: []string{importFixture, "0"}}
	var batch outlookBatch
	if err := runOutlook(context.Background(), req, &batch); err != nil {
		t.Fatal(err)
	}
	if batch.Failed != 0 || len(batch.Items) != 1 || len(batch.Items[0].Attachments) != 1 || batch.Items[0].Attachments[0].Body != importFixture || batch.Items[0].Body != "" || batch.Items[0].Mail.EntryID != "00CC" {
		t.Fatalf("embedded import: %+v", batch)
	}
	if len(batch.Items[0].Fingerprints) != 1 || batch.Items[0].Fingerprints[0].SHA256 != digest(importFixture) {
		t.Fatal("embedded MD fingerprint missing")
	}
	req.Cursors = batch.Cursors
	req.Terms[1] = "1"
	for attempt := 0; attempt < 2; attempt++ {
		var failed outlookBatch
		if err := runOutlook(context.Background(), req, &failed); err != nil {
			t.Fatal(err)
		}
		if failed.Failed != 1 || len(failed.Items) != 1 || failed.Items[0].Mail.EntryID != "00DD" || !reflect.DeepEqual(failed.Cursors, req.Cursors) {
			t.Fatalf("failed mail skipped rather than retried: %+v", failed)
		}
		req.Cursors = failed.Cursors
	}
}

func TestOutlookReaderUpgradeReplaysOnceAndDeduplicates(t *testing.T) {
	a, source := connectionsFixture(t)
	a.config.Offline = true
	rules, err := a.loadConnections()
	if err != nil {
		t.Fatal(err)
	}
	rules.Cursors[source.FolderID] = outlookCursor{Time: "2026-10-19T12:00:00", IDs: []string{"00FF"}}
	if err = a.saveConnections(rules); err != nil {
		t.Fatal(err)
	}
	run := func(_ context.Context, req outlookReq, out any) error {
		if len(req.Cursors) != 0 {
			t.Fatal("old reader cursor prevented rescan")
		}
		doc := outlookDocument{FolderID: source.FolderID, Mail: MailRef{EntryID: "00CC", StoreID: source.StoreID, Subject: "데일리", Folder: "업무"}}
		doc.Attachments = append(doc.Attachments, struct {
			Name string `json:"name"`
			Body string `json:"body"`
		}{"2026-09-21.md", legacyMailReport})
		duplicate := doc
		duplicate.Mail.EntryID = "00DD"
		rejected := doc
		rejected.Mail.EntryID = "00EE"
		rejected.Attachments = nil
		rejected.Body = "---\ninvalid report"
		*out.(*outlookBatch) = outlookBatch{Items: []outlookDocument{doc, duplicate, rejected}, Cursors: map[string]outlookCursor{source.FolderID: {Time: "2026-10-19T13:00:00", IDs: []string{"00EE"}}}}
		return nil
	}
	a.importOutlookWith(run)
	x, err := a.viewReports()
	if err != nil || len(x.Reports) != 1 || x.Reports[0].Origin != "outlook-report" || x.Reports[0].Mail == nil {
		t.Fatal("offline embedded report missing", err)
	}
	status := a.outlookImportView()
	if status.Added != 1 || status.Skipped != 1 || status.Rejected != 1 || !strings.Contains(status.Message, "MD 형식 확인 필요 1건") {
		t.Fatalf("wrong import diagnostics: %+v", status)
	}
	a.importOutlookWith(func(_ context.Context, req outlookReq, out any) error {
		cursor := req.Cursors[source.FolderID]
		if cursor.Time != "2026-10-19T13:00:00" || cursor.ReaderVersion != outlookReaderVersion {
			t.Fatal("upgraded cursor not reused", cursor)
		}
		*out.(*outlookBatch) = outlookBatch{Cursors: req.Cursors}
		return nil
	})
	x, err = a.viewReports()
	if err != nil || len(x.Reports) != 1 {
		t.Fatal("repeated scan duplicated reports", err)
	}
}
