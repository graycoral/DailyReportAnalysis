package hub

import (
	"reflect"
	"strings"
	"testing"
)

func TestConnectionEvidence(t *testing.T) {
	aliases := defaultConnectionAliases()
	aliases = append(aliases, connectionAlias{Kind: "project", Name: "자율주행 실증", Aliases: []string{"AV Pilot"}})
	mail := &MailRef{StoreID: "00AA"}
	thread := strings.Repeat("A", 32)
	for _, tc := range []struct {
		name   string
		a, b   connectionDocument
		want   bool
		reason string
	}{
		{"company alone", connectionDocument{Text: "현대차", Date: "2026-10-01"}, connectionDocument{Text: "Hyundai Motor", Date: "2026-10-02"}, false, ""},
		{"alias and topic", connectionDocument{Text: "현대차 센서 공급", Date: "2026-10-01"}, connectionDocument{Text: "Hyundai Motor 센서 공급", Date: "2026-10-02"}, true, "company"},
		{"Korean particle", connectionDocument{Text: "현대차의 센서 공급", Date: "2026-10-01"}, connectionDocument{Text: "Hyundai Motor 센서 공급", Date: "2026-10-02"}, true, "company"},
		{"company particle not double counted", connectionDocument{Text: "현대차의 공급", Date: "2026-10-01"}, connectionDocument{Text: "현대차의 공급", Date: "2026-10-02"}, false, ""},
		{"different Korean company", connectionDocument{Text: "현대차증권 센서 공급", Date: "2026-10-01"}, connectionDocument{Text: "Hyundai Motor 센서 공급", Date: "2026-10-02"}, false, ""},
		{"project alias", connectionDocument{Text: "자율주행 실증 결과"}, connectionDocument{Text: "AV Pilot 현황"}, true, "project"},
		{"identifier", connectionDocument{Text: "검토 AV-2026-004"}, connectionDocument{Text: "도면 AV-2026-004"}, true, "code"},
		{"dates are not identifiers", connectionDocument{Text: "보고 2026-10-18"}, connectionDocument{Text: "계획 2026-10-18"}, false, ""},
		{"subject is not a thread", connectionDocument{Text: "주간 보고"}, connectionDocument{Text: "RE: 주간 보고"}, false, ""},
		{"real conversation", connectionDocument{Mail: mail, Conversation: thread}, connectionDocument{Mail: mail, Conversation: thread}, true, "thread"},
		{"different store", connectionDocument{Mail: mail, Conversation: thread}, connectionDocument{Mail: &MailRef{StoreID: "00BB"}, Conversation: thread}, false, ""},
		{"same bytes", connectionDocument{Hashes: []string{digest("file")}}, connectionDocument{Hashes: []string{digest("file")}}, true, "file"},
		{"missing hashes", connectionDocument{Hashes: []string{""}}, connectionDocument{Hashes: []string{""}}, false, ""},
		{"short alias boundary", connectionDocument{Text: "Waymo robotaxi expansion"}, connectionDocument{Text: "NotWaymo robotaxi expansion"}, false, ""},
		{"three keywords near dates", connectionDocument{Text: "센서 공급 일정", Date: "2026-10-01"}, connectionDocument{Text: "센서 공급 일정", Date: "2026-10-20"}, true, "keywords"},
		{"three keywords distant dates", connectionDocument{Text: "센서 공급 일정", Date: "2025-01-01"}, connectionDocument{Text: "센서 공급 일정", Date: "2026-10-20"}, false, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := scoreConnection(tc.a, tc.b, documentFeatures(tc.a, aliases), documentFeatures(tc.b, aliases))
			if (c.Score >= 60) != tc.want {
				t.Fatalf("score=%d reasons=%v", c.Score, c.Reasons)
			}
			if tc.want {
				found := false
				for _, r := range c.Reasons {
					found = found || r.Kind == tc.reason
				}
				if !found {
					t.Fatalf("missing %s: %+v", tc.reason, c)
				}
			}
		})
	}
}
func TestConnectionIdentityAndDecisions(t *testing.T) {
	if connectionMailID(MailRef{EntryID: "00aa", StoreID: "00BB"}) != connectionMailID(MailRef{EntryID: "00AA", StoreID: "00bb"}) {
		t.Fatal("MAPI casing changed identity")
	}
	if connectionMailID(MailRef{EntryID: "00AA", StoreID: "00BB"}) == connectionMailID(MailRef{EntryID: "00AA", StoreID: "00CC"}) {
		t.Fatal("stores collided")
	}
	a := connectionDocument{ID: "one", Text: "AV-1234"}
	b := connectionDocument{ID: "two", Text: "AV-1234"}
	docs := []connectionDocument{a, b}
	links, _ := recommendConnections(docs, nil, nil)
	if len(links) != 1 {
		t.Fatal(links)
	}
	saved := links[0]
	saved.Status = "rejected"
	saved.Decided = "2026-10-18"
	docs[1].Text = "a different topic"
	links, _ = recommendConnections(docs, nil, map[string]documentConnection{saved.ID: saved})
	if len(links) != 1 || !reflect.DeepEqual(links[0], saved) {
		t.Fatalf("rejection did not survive changed evidence: %+v", links)
	}
	links, _ = recommendConnections(docs, nil, nil)
	if len(links) != 0 {
		t.Fatal("reset invented a link")
	}
	if connectionID(a.ID, b.ID) != connectionID(b.ID, a.ID) {
		t.Fatal("pair ordering changed decision identity")
	}
}
func TestConnectionDictionaryValidation(t *testing.T) {
	for _, xs := range [][]connectionAlias{
		{{Kind: "person", Name: "invalid"}},
		{{Kind: "company", Name: "현대차", Aliases: []string{"h"}}},
		{{Kind: "company", Name: "Hyundai"}, {Kind: "project", Name: "hyundai"}},
	} {
		if _, e := normalizeAliases(xs); e == nil {
			t.Fatal("accepted invalid dictionary", xs)
		}
	}
	x, e := normalizeAliases([]connectionAlias{{Kind: "company", Name: "현대차", Aliases: []string{"Hyundai", "hyundai"}}})
	if e != nil || len(x[0].Aliases) != 1 {
		t.Fatal(x, e)
	}
}
