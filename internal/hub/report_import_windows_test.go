//go:build windows

package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMarkdownBatchPreservesLegacyOutlookAndDuplicateIDs(t *testing.T) {
	a := localApp(t)
	r, err := parseReport([]byte(importFixture), "report.md", nil)
	if err != nil {
		t.Fatal(err)
	}
	legacy := importedReport{Report: r, Origin: "outlook-report", Hash: bodyHash(r.Body)}
	if err = a.saveReports(reportArchive{Reports: []importedReport{legacy}}); err != nil {
		t.Fatal(err)
	}
	results, err := a.importMarkdownBatch([]markdownFile{{"one.md", []byte(importFixture)}, {"duplicate.md", []byte(importFixture)}})
	if err != nil || len(results) != 2 || results[0].Status != "added" || results[1].Status != "unchanged" || results[0].ID == legacy.ID || results[0].ID != results[1].ID {
		t.Fatalf("batch identities: %+v %v", results, err)
	}
	x, err := (&App{dir: a.dir}).viewReports()
	if err != nil || len(x.Reports) != 2 || x.Reports[0].ID != legacy.ID || x.Reports[0].Origin != "outlook-report" || x.Reports[1].Origin != "markdown" {
		t.Fatalf("persisted origins: %+v %v", x, err)
	}
}

func TestGitHubDisabledKeepsOutlookAndManualReports(t *testing.T) {
	a := localApp(t)
	r, err := parseReport([]byte(importFixture), "report.md", nil)
	if err != nil {
		t.Fatal(err)
	}
	mail := importedReport{Report: r, Origin: "outlook-report", Hash: bodyHash(r.Body)}
	mail.ID = "outlook-2026-10-15"
	if err = a.saveReports(reportArchive{Reports: []importedReport{mail}}); err != nil {
		t.Fatal(err)
	}
	a.config.Offline = true
	if _, _, err = a.importMarkdown("report.md", []byte(importFixture)); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(a.reportPath())
	if err != nil {
		t.Fatal(err)
	}
	for _, enabled := range []bool{false, true, false} {
		a.config.Offline = !enabled
		w := call(t, a.routes(), "GET", "/api/local/reports", "")
		var archive reportArchive
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &archive) != nil || len(archive.Reports) != 2 {
			t.Fatal("GitHub setting changed local reports", w.Code, w.Body)
		}
		if !a.hasReport(mail.ID) {
			t.Fatal("Outlook report became inaccessible")
		}
		w = call(t, a.routes(), "GET", "/api/local/reports/download?id="+mail.ID, "")
		if w.Code != 200 || w.Body.String() != importFixture {
			t.Fatal("Outlook report download blocked")
		}
	}
	after, err := os.ReadFile(a.reportPath())
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("GitHub visibility modified local archive", err)
	}
}

func TestImportedReportsEncryptedSeparateAndPersistent(t *testing.T) {
	a := localApp(t)
	h := a.routes()
	w := call(t, h, "POST", "/api/local/reports/import?name=2026-10-15.md", importFixture)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"added"`) {
		t.Fatalf("import: %d %s", w.Code, w.Body)
	}
	w = call(t, h, "POST", "/api/local/reports/import?name=2026-10-15.md", importFixture)
	if !strings.Contains(w.Body.String(), `"status":"unchanged"`) {
		t.Fatal(w.Body)
	}
	x, e := (&App{dir: a.dir}).viewReports()
	if e != nil || len(x.Reports) != 1 {
		t.Fatalf("restart: %v %+v", e, x)
	}
	b, _ := os.ReadFile(a.reportPath())
	if bytes.Contains(b, []byte("운행 지역 확대")) {
		t.Fatal("plaintext local archive")
	}
	if strings.Contains(call(t, h, "GET", "/api/state", "").Body.String(), "Uber 운행 지역 확대") {
		t.Fatal("local report leaked into public state")
	}
	w = call(t, h, "POST", "/api/report-visibility", `{"action":"hide","report_id":"local-2026-10-15"}`)
	if w.Code != 200 {
		t.Fatal(w.Body)
	}
	w = call(t, h, "GET", "/api/local/reports/download?id=local-2026-10-15", "")
	if w.Code != 200 || w.Body.String() != importFixture {
		t.Fatal("MD roundtrip failed")
	}
	// Public updates must preserve the archive byte for byte, even if GitHub is unavailable.
	cfg := defaultConfig()
	cfg.Configured = true
	cfg.GitHubChoiceVersion = Version
	a.config = cfg
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "blocked", 403) }))
	defer srv.Close()
	withBase(srv.URL, func() { a.syncData() })
	if a.syncAvailability() != "auto_disabled" {
		t.Fatal(a.syncAvailability())
	}
	after, _ := os.ReadFile(a.reportPath())
	if !bytes.Equal(b, after) {
		t.Fatal("failed sync modified local reports")
	}
	a.pruneCache(Catalog{})
	if _, e := os.Stat(a.reportPath()); e != nil {
		t.Fatal(e)
	}
	if _, _, e := a.importMarkdown("bad.md", []byte("not a report")); e == nil {
		t.Fatal("bad report accepted")
	}
	if e := os.WriteFile(a.reportPath(), []byte("corrupt"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, _, e := a.importMarkdown("a.md", []byte(importFixture)); e == nil {
		t.Fatal("corrupt archive overwritten")
	}
	if after, _ := os.ReadFile(a.reportPath()); string(after) != "corrupt" {
		t.Fatal("corrupt archive destroyed")
	}
}

func TestOutlookFolderImportUsesOnlyFolderAndSubjectTags(t *testing.T) {
	a := localApp(t)
	source := OutlookSource{Name: "업무/관심기업", StoreID: "00AA", FolderID: "00BB", FolderName: "관심기업"}
	if e := a.editLocal(func(x *LocalIndex) error { x.Sources = []OutlookSource{source}; return nil }); e != nil {
		t.Fatal(e)
	}
	run := func(ctx context.Context, req outlookReq, out any) error {
		if len(req.Sources) != 1 || req.Sources[0].FolderID != "00BB" {
			t.Fatal("wrong folder scope")
		}
		*out.(*outlookBatch) = outlookBatch{Items: []outlookDocument{
			{FolderID: "00BB", Mail: MailRef{EntryID: "00CC", StoreID: "00AA", Subject: "Uber 데일리", Received: "2026-10-15T08:00:00", Folder: "관심기업"}, Body: importFixture},
			{FolderID: "00BB", Mail: MailRef{EntryID: "00DD", StoreID: "00AA", Subject: "일반 회의 안내", Received: "2026-10-15T09:00:00", Folder: "관심기업"}, Body: "private-body-marker Tesla"},
			{FolderID: "00FF", Mail: MailRef{EntryID: "00EE", StoreID: "00AA", Subject: "다른 폴더", Received: "2026-10-15T09:00:00"}},
		}, Cursors: map[string]outlookCursor{"00BB": {Time: "2026-10-15T09:00:00", IDs: []string{"00DD"}}}}
		return nil
	}
	a.importOutlookWith(run)
	x, e := a.viewReports()
	if e != nil || len(x.Reports) != 1 {
		t.Fatalf("import: %v %+v status=%+v", e, x, a.outlookImportView())
	}
	for _, r := range x.Reports {
		if len(r.Tags) == 0 || r.Tags[0] != "관심기업" {
			t.Fatalf("folder tag missing: %+v", r)
		}
		for _, co := range r.Companies {
			if co == "Tesla" {
				t.Fatal("company inferred from body")
			}
		}
	}
	a.importOutlookWith(run)
	x, _ = a.viewReports()
	if len(x.Reports) != 1 {
		t.Fatal("duplicate mail imported")
	}
	if len(x.Cursors["00BB"].IDs) != 1 {
		t.Fatal("cursor not saved")
	}
	p, _ := json.Marshal(x)
	if bytes.Contains(p, []byte("private-body-marker")) || bytes.Contains(p, []byte("일반 회의 안내")) {
		t.Fatal("ordinary mail stored")
	}
	// A source removed while Outlook is scanning may not add results afterwards.
	a.importOutlookWith(func(ctx context.Context, req outlookReq, out any) error {
		if e := a.editLocal(func(x *LocalIndex) error { x.Sources = nil; return nil }); e != nil {
			t.Fatal(e)
		}
		run(ctx, req, out)
		out.(*outlookBatch).Items[0].Body = strings.ReplaceAll(importFixture, "2026-10-15", "2026-10-16")
		return nil
	})
	x, _ = a.viewReports()
	if len(x.Reports) != 1 {
		t.Fatal("removed source still imported")
	}
}

func TestOutlookSourceFolderIdentity(t *testing.T) {
	a := OutlookSource{StoreID: "00AA", FolderID: "00BB", FolderName: "리포트"}
	b := a
	b.FolderID = "00CC"
	if sameSource(a, b) {
		t.Fatal("different folders treated as same source")
	}
	b.FolderID = "bad-folder"
	if _, e := checkSource(b); e == nil {
		t.Fatal("bad folder ID accepted")
	}
	c := localApp(t)
	os.Mkdir(filepath.Join(c.dir, ".git"), 0700)
	if _, _, e := c.importMarkdown("a.md", []byte(importFixture)); e == nil {
		t.Fatal("local report saved in repository")
	}
}

func TestOutlookPipePreservesLargeUnicodeInput(t *testing.T) {
	old := outlookScript
	defer func() { outlookScript = old }()
	outlookScript = `$req=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))); [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @{op=$req.op; value=$req.terms[0]} -Compress))))`
	value := strings.Repeat("한글📁", 10000)
	var out struct {
		Op    string `json:"op"`
		Value string `json:"value"`
	}
	if e := runOutlook(context.Background(), outlookReq{Op: "test", Terms: []string{value}}, &out); e != nil {
		t.Fatal(e)
	}
	if out.Op != "test" || out.Value != value {
		t.Fatal("pipe roundtrip mismatch")
	}
}

func TestOutlookBridgeFolderPagination(t *testing.T) {
	old := outlookScript
	defer func() { outlookScript = old }()
	start := "try { $ol = New-Object -ComObject Outlook.Application; $ns = $ol.GetNamespace('MAPI') } catch { Fail 'com' $_.Exception.Message }"

	if !strings.Contains(outlookScript, start) {
		t.Fatal("bridge preamble changed")
	}
	outlookScript = strings.Replace(outlookScript, start, outlookBridgeFixture, 1)
	req := outlookReq{Op: "reports", Sources: []OutlookSource{{StoreID: "00AA", FolderID: "00BB", FolderName: "자율주행"}}, Limit: 1, Terms: []string{importFixture}}
	var first outlookBatch
	if e := runOutlook(context.Background(), req, &first); e != nil {
		t.Fatal(e)
	}
	if first.Failed != 0 || len(first.Items) != 1 || !first.Pending || first.Items[0].Mail.EntryID != "00CC" || len(first.Items[0].Attachments) != 1 || first.Items[0].Attachments[0].Body != importFixture {
		t.Fatalf("first batch: %+v", first)
	}
	if first.Items[0].Conversation != "0123456789ABCDEF0123456789ABCDEF" || len(first.Items[0].Fingerprints) != 1 || first.Items[0].Fingerprints[0].SHA256 != digest(importFixture) {
		t.Fatal("conversation ID or attachment fingerprint missing from Outlook bridge")
	}
	req.Cursors = first.Cursors
	var second outlookBatch
	if e := runOutlook(context.Background(), req, &second); e != nil {
		t.Fatal(e)
	}
	if second.Failed != 0 || len(second.Items) != 1 || second.Items[0].Mail.EntryID != "00DD" || len(second.Cursors["00BB"].IDs) != 2 {
		t.Fatalf("second batch: %+v", second)
	}
}

const outlookBridgeFixture = `
$store=[pscustomobject]@{StoreID='00AA'}
$columns=[pscustomobject]@{}
$columns|Add-Member ScriptMethod Add {param($name)}
$rows=@()
foreach($id in '00CC','00DD') {
 $row=[pscustomobject]@{data=@{EntryID=$id;LastModificationTime=[datetime]'2026-10-15T08:00:00';ReceivedTime=[datetime]'2026-10-15T07:00:00';Subject='Uber 보고';SenderName='발행자';MessageClass='IPM.Note'}}
 $row|Add-Member ScriptMethod Item {param($name) return $this.data[$name]}
 $rows+=,$row
}
$table=[pscustomobject]@{Columns=$columns;rows=$rows;position=0;EndOfTable=$false}
$table|Add-Member ScriptMethod Sort {param($name,$descending)}
$table|Add-Member ScriptMethod GetNextRow { $row=$this.rows[$this.position];$this.position++;$this.EndOfTable=$this.position -ge $this.rows.Count;return $row }
$folder=[pscustomobject]@{Name='자율주행';table=$table}
$folder|Add-Member ScriptMethod GetTable {param($filter,$flags) return $this.table}
$accessor=[pscustomobject]@{data=[Text.Encoding]::UTF8.GetBytes([string]$req.terms[0])}
$accessor|Add-Member ScriptMethod GetProperty {param($property) return $this.data}
$attachment=[pscustomobject]@{FileName='report.md';Size=1000;PropertyAccessor=$accessor}
$ns=[pscustomobject]@{Stores=@($store);folder=$folder;item=[pscustomobject]@{Body=[string]$req.terms[0];Attachments=@($attachment);ConversationID='0123456789ABCDEF0123456789ABCDEF'}}
$ns|Add-Member ScriptMethod GetFolderFromID {param($id,$store) if($id -ne '00BB'){throw 'wrong folder'};return $this.folder}
$ns|Add-Member ScriptMethod GetItemFromID {param($id,$store) return $this.item}
`
