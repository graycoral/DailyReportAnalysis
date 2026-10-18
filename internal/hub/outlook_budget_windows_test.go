//go:build windows

package hub

import (
	"context"
	"strings"
	"testing"
)

func TestOutlookMarkdownIndependentOfFingerprintBudget(t *testing.T) {
	old := outlookScript
	defer func() { outlookScript = old }()
	start := "try { $ol = New-Object -ComObject Outlook.Application; $ns = $ol.GetNamespace('MAPI') } catch { Fail 'com' $_.Exception.Message }"
	for _, test := range []struct {
		name, setup  string
		fingerprints int
		fails        bool
	}{
		{"count", `$prefix=@();for($i=0;$i -lt 32;$i++){$prefix+=,[pscustomobject]@{Type=1;FileName="small$i.txt";Size=1;PropertyAccessor=$tiny}}`, 32, false},
		{"bytes", `$prefix=@([pscustomobject]@{Type=1;FileName='large.pdf';Size=52428800;PropertyAccessor=$large})`, 1, false},
		{"read-failure", `$prefix=@();for($i=0;$i -lt 32;$i++){$prefix+=,[pscustomobject]@{Type=1;FileName="small$i.txt";Size=1;PropertyAccessor=$tiny}};$attachment.PropertyAccessor=$broken`, 32, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := outlookBridgeFixture + `
$ns.item.Body='ordinary forwarded message'
$tiny=[pscustomobject]@{};$tiny|Add-Member ScriptMethod GetProperty {param($property) return ,([byte[]]@(65))}
$large=[pscustomobject]@{};$large|Add-Member ScriptMethod GetProperty {param($property) return ,(New-Object byte[] 52428800)}
$broken=[pscustomobject]@{};$broken|Add-Member ScriptMethod GetProperty {param($property) throw 'temporary read failure'}
` + test.setup + `
$ns.item.Attachments=@($prefix)+@($attachment)
`
			outlookScript = strings.Replace(old, start, fixture, 1)
			req := outlookReq{Op: "reports", Sources: []OutlookSource{{StoreID: "00AA", FolderID: "00BB"}}, Limit: 1, Terms: []string{importFixture}}
			var batch outlookBatch
			if err := runOutlook(context.Background(), req, &batch); err != nil {
				t.Fatal(err)
			}
			if len(batch.Items) != 1 || len(batch.Items[0].Fingerprints) != test.fingerprints {
				t.Fatalf("wrong fingerprint budget: %+v", batch)
			}
			if test.fails {
				if batch.Failed != 1 || len(batch.Cursors["00BB"].IDs) != 0 {
					t.Fatal("failed MD advanced cursor", batch)
				}
			} else if batch.Failed != 0 || len(batch.Items[0].Attachments) != 1 || batch.Items[0].Attachments[0].Body != importFixture || len(batch.Cursors["00BB"].IDs) != 1 {
				t.Fatal("fingerprint budget swallowed Markdown report", batch)
			}
		})
	}
}
