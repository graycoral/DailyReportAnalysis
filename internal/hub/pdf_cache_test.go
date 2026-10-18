package hub

import (
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestPDFCacheSharesDecryptAndInvalidatesChanges(t *testing.T) {
	var c pdfCache
	defer c.clear()
	path := filepath.Join(t.TempDir(), "document.bin")
	if err := writeAtomic(path, []byte("first")); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	decode := func(b []byte) ([]byte, error) { calls.Add(1); return b, nil }
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			b, err := c.read(path, decode)
			if err != nil || string(b) != "first" {
				t.Errorf("read: %q %v", b, err)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("duplicate decrypts: %d", calls.Load())
	}
	if err := writeAtomic(path, []byte("replacement")); err != nil {
		t.Fatal(err)
	}
	b, err := c.read(path, decode)
	if err != nil || string(b) != "replacement" || calls.Load() != 2 {
		t.Fatalf("stale cache: %q %v", b, err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := c.read(path, decode); err == nil || c.bytes != 0 {
		t.Fatal("deleted file served from cache")
	}
}

func TestPDFCacheBoundsAndExpiresIdleMemory(t *testing.T) {
	var c pdfCache
	defer c.clear()
	dir := t.TempDir()
	for _, name := range []string{"a", "b"} {
		path := filepath.Join(dir, name)
		if err := writeAtomic(path, []byte(name)); err != nil {
			t.Fatal(err)
		}
		if _, err := c.read(path, func([]byte) ([]byte, error) { return make([]byte, 33<<20), nil }); err != nil {
			t.Fatal(err)
		}
	}
	if c.bytes > pdfCacheLimit || len(c.entries) != 1 {
		t.Fatal("cache exceeded its memory budget")
	}
	c.mu.Lock()
	c.timer.Stop()
	for key, entry := range c.entries {
		entry.used = time.Now().Add(-pdfCacheTTL)
		c.entries[key] = entry
	}
	c.mu.Unlock()
	c.expire()
	if c.bytes != 0 || len(c.entries) != 0 || c.timer != nil {
		t.Fatal("idle plaintext retained")
	}
}
