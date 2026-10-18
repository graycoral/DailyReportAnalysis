package hub

import (
	"errors"
	"strings"
	"testing"
)

const importFixture = `---
theme: default
title: 자율주행 데일리 리포트 2026-10-15
info: Uber 운행 지역 확대
fonts:
  sans: Noto Sans CJK KR
---
# Executive Summary
## 2026-10-15 · Uber 운행 지역 확대
- Uber가 운행 지역을 확대했다고 발표했다. [R1–R2]
- Tesla는 본문에만 있는 기업이다. [R1]
---
# 주요 신규 업데이트
## [신규] 운행 확대
발표와 계획을 구분한다. [R1]
# 기업/지역별 상세 내용
해당 없음
# 지정 6개사 L4 점검
| 기업 | 확인 결과 |
|---|---|
| Uber | 운행 확대 [R1] |
# May Mobility 심층 점검
신규 확인 사항 없음
# 규제·안전
해당 없음
# 기술·공급망
해당 없음
# Reference
- [R1] 공식 발표: https://example.com/one
- [R2] 공식 자료: https://example.com/two
[R1]: https://example.com/one
[R2]: https://example.com/two
`

func TestReportFormatImport(t *testing.T) {
	r, e := parseReport([]byte("\ufeff"+strings.ReplaceAll(importFixture, "\n", "\r\n")), "daily_2026-10-15.md", []string{"Uber", "Tesla", "Uber"})
	if e != nil {
		t.Fatal(e)
	}
	if r.Date != "2026-10-15" || r.Title != "Uber 운행 지역 확대" || len(r.Companies) != 1 || r.Companies[0] != "Uber" || len(r.Sources) != 2 {
		t.Fatalf("bad projection: %+v", r)
	}
	for _, tc := range []struct{ name, body, file string }{
		{"missing header", strings.TrimPrefix(importFixture, "---\n"), "a.md"},
		{"missing section", strings.ReplaceAll(importFixture, "# 지정 6개사 L4 점검", "# 아무 섹션"), "a.md"},
		{"invalid date", strings.ReplaceAll(importFixture, "2026-10-15", "2026-02-30"), "a.md"},
		{"mismatch", importFixture, "2026-10-16.md"},
		{"missing reference", strings.ReplaceAll(importFixture, "[R2]: https://example.com/two", ""), "a.md"},
		{"bad reference range", strings.ReplaceAll(importFixture, "R1–R2", "R2–R1"), "a.md"},
		{"unsafe source", strings.ReplaceAll(importFixture, "https://example.com/one", "javascript:alert(1)"), "a.md"},
		{"credentials in URL", strings.ReplaceAll(importFixture, "https://example.com/one", "https://name:password@example.com/one"), "a.md"},
		{"oversized", strings.Repeat("a", reportMax+1), "a.md"},
		{"binary", importFixture + "\x00", "a.md"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, e := parseReport([]byte(tc.body), tc.file, nil); e == nil {
				t.Fatal("invalid report accepted")
			}
		})
	}
	if _, e := parseReport([]byte(strings.ReplaceAll(importFixture, "info: Uber 운행 지역 확대", "info: 주요 신규 업데이트 없음")), "a.md", nil); !errors.Is(e, errNoUpdates) {
		t.Fatal(e)
	}
}

func TestImportedOriginsStaySeparateAndPreserveLegacyIDs(t *testing.T) {
	r, _ := parseReport([]byte(importFixture), "a.md", nil)
	x := reportArchive{Reports: []importedReport{{Report: r, Origin: "markdown", Hash: "manual"}}}
	mail := importedReport{Report: r, Origin: "outlook-report", Hash: "mail", Mail: &MailRef{Received: "2026-10-15T10:00:00"}}
	if got := mergeImported(&x, &mail); got != "added" || len(x.Reports) != 2 || mail.ID != "outlook-2026-10-15" || x.Reports[0].Hash != "manual" {
		t.Fatal("Outlook and manual reports did not remain independent")
	}
	if got := mergeImported(&x, &mail); got != "unchanged" || len(x.Reports) != 2 {
		t.Fatal("duplicate mail was added")
	}
	older := mail
	older.Hash = "older"
	older.Mail = &MailRef{Received: "2026-10-15T09:00:00"}
	if got := mergeImported(&x, &older); got != "kept" {
		t.Fatal("older mail replaced a newer edition")
	}
	// Existing Outlook records used local-DATE; neither links nor hidden preferences may break.
	legacy := reportArchive{Reports: []importedReport{{Report: r, Origin: "outlook-report", Hash: "old"}}}
	update := mail
	if got := mergeImported(&legacy, &update); got != "updated" || update.ID != r.ID {
		t.Fatal("legacy ID changed")
	}
	manual := importedReport{Report: r, Origin: "markdown", Hash: "manual"}
	if got := mergeImported(&legacy, &manual); got != "added" || manual.ID == r.ID {
		t.Fatal("manual import collided with a legacy Outlook ID")
	}
	manualID := manual.ID
	manual.Hash = "correction"
	if got := mergeImported(&legacy, &manual); got != "updated" || manual.ID != manualID || len(legacy.Reports) != 2 {
		t.Fatal("manual correction lost its identity")
	}
}

func TestReportFormatDocumentReference(t *testing.T) {
	b, e := assets.ReadFile("seed/autonomous_driving_daily_2026-10-14.md")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = parseReport(b, "2026-10-14.md", nil); e != nil {
		t.Fatal(e)
	}
}
