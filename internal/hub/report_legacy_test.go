package hub

import (
	"errors"
	"strings"
	"testing"
)

const legacyMailReport = `---
title: 글로벌 자율주행·로보택시 데일리
info: 2026-09-21
---
# 글로벌 자율주행·로보택시 데일리
## Executive Summary
- 샘플 운행 소식
## 주요 신규 업데이트
- 샘플 업데이트
## 기업·지역별 상세 내용
- 샘플 기업 현황
## 규제·안전
- 샘플 안전 현황
## 기술·공급망
- 샘플 기술 현황
## References
1. 샘플 출처
https://example.com/report
2. 두 번째 출처: https://example.com/second
## 작성 기준
https://example.com/not-a-reference
`

func TestOutlookHistoricalFormatsPreserveOriginal(t *testing.T) {
	for _, body := range []string{
		legacyMailReport,
		strings.ReplaceAll(strings.Replace(legacyMailReport, "title: 글로벌 자율주행·로보택시 데일리\ninfo: 2026-09-21", "title: Autonomous Driving Daily Report — 2026-09-21\ninfo: 자율주행 데일리 리포트", 1), "기업·지역별 상세 내용", "기업별 L4 점검"),
		strings.ReplaceAll(legacyMailReport, "기업·지역별 상세 내용", "기업·지역별 상세"),
	} {
		r, err := parseOutlookReport([]byte(body), "daily_2026-09-21.md", nil)
		if err != nil || r.Date != "2026-09-21" || r.Body != body || len(r.Sources) != 2 || r.Sources[1].URL != "https://example.com/second" {
			t.Fatalf("historical format: %+v %v", r, err)
		}
		if _, err := parseReport([]byte(body), "daily_2026-09-21.md", nil); err == nil {
			t.Fatal("manual format validation relaxed")
		}
	}
}

func TestOutlookHistoricalValidation(t *testing.T) {
	for name, body := range map[string]string{
		"missing date":         strings.ReplaceAll(legacyMailReport, "2026-09-21", ""),
		"invalid date":         strings.ReplaceAll(legacyMailReport, "2026-09-21", "2026-09-31"),
		"ordinary memo":        strings.ReplaceAll(legacyMailReport, "글로벌 자율주행·로보택시 데일리", "회의 메모"),
		"missing section":      strings.ReplaceAll(legacyMailReport, "## 주요 신규 업데이트", "## 메모"),
		"no references":        strings.ReplaceAll(legacyMailReport, "https://example.com/", "example.com/"),
		"invalid URL":          strings.ReplaceAll(legacyMailReport, "https://example.com/report", "https://user:password@example.com/report"),
		"undefined R citation": strings.ReplaceAll(legacyMailReport, "샘플 운행 소식", "샘플 운행 소식 [R1]"),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseOutlookReport([]byte(body), "daily.md", nil); err == nil {
				t.Fatal("invalid historical report accepted")
			}
		})
	}
	if _, err := parseOutlookReport([]byte(legacyMailReport), "2026-09-22.md", nil); err == nil {
		t.Fatal("filename date mismatch accepted")
	}
	noUpdates := strings.ReplaceAll(legacyMailReport, "info: 2026-09-21", "info: 2026-09-21 주요 신규 업데이트 없음")
	if _, err := parseOutlookReport([]byte(noUpdates), "daily.md", nil); !errors.Is(err, errNoUpdates) {
		t.Fatal("no-update report accepted", err)
	}
}

func TestReportSectionsCanSpanSlides(t *testing.T) {
	body := strings.Replace(importFixture, "# 주요 신규 업데이트", "# 주요 신규 업데이트\n- 첫 슬라이드\n# 주요 신규 업데이트", 1)
	body = strings.Replace(body, "# Reference", "# Reference\n- 첫 출처 슬라이드\n# Reference", 1)
	if _, err := parseReport([]byte(body), "daily.md", nil); err != nil {
		t.Fatal(err)
	}
	body += "\n# Executive Summary\n"
	if _, err := parseReport([]byte(body), "daily.md", nil); err == nil {
		t.Fatal("out-of-order section accepted")
	}
}
