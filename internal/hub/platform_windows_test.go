//go:build windows

package hub

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestWindowsCredentialProtection(t *testing.T) {
	s := []byte("test-token-not-a-real-credential")
	c, e := protect(s)
	if e != nil {
		t.Fatal(e)
	}
	if bytes.Contains(c, s) {
		t.Fatal("plaintext stored")
	}
	p, e := unprotect(c)
	if e != nil || !bytes.Equal(p, s) {
		t.Fatalf("roundtrip: %v", e)
	}
}
func TestWindowsReplaceExistingFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.json")
	if e := writeAtomic(p, []byte("first")); e != nil {
		t.Fatal(e)
	}
	if e := writeAtomic(p, []byte("second")); e != nil {
		t.Fatal(e)
	}
	b, _ := os.ReadFile(p)
	if string(b) != "second" {
		t.Fatal("replace failed")
	}
}
