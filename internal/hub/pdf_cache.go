package hub

import (
	"os"
	"sync"
	"time"
)

const pdfCacheLimit = 64 << 20
const pdfCacheTTL = 2 * time.Minute

type pdfCacheEntry struct {
	data []byte
	info os.FileInfo
	used time.Time
}

// Plaintext exists only in bounded process memory. Deletion and on-disk changes
// invalidate it; the timer releases idle entries even when no further PDF is read.
type pdfCache struct {
	mu      sync.Mutex
	entries map[string]pdfCacheEntry
	bytes   int
	timer   *time.Timer
}

func (c *pdfCache) read(path string, decrypt func([]byte) ([]byte, error)) ([]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	info, err := os.Stat(path)
	if err != nil {
		c.remove(path)
		return nil, err
	}
	now := time.Now()
	if entry, ok := c.entries[path]; ok && now.Sub(entry.used) < pdfCacheTTL &&
		entry.info.Size() == info.Size() && entry.info.ModTime() == info.ModTime() && os.SameFile(entry.info, info) {
		entry.used = now
		c.entries[path] = entry
		return entry.data, nil
	}
	c.remove(path)
	encrypted, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	data, err := decrypt(encrypted)
	if err != nil || len(data) > pdfCacheLimit {
		return data, err
	}
	for c.bytes+len(data) > pdfCacheLimit {
		var oldest string
		var used time.Time
		for key, entry := range c.entries {
			if oldest == "" || entry.used.Before(used) {
				oldest, used = key, entry.used
			}
		}
		c.remove(oldest)
	}
	if c.entries == nil {
		c.entries = map[string]pdfCacheEntry{}
	}
	c.entries[path] = pdfCacheEntry{data: data, info: info, used: now}
	c.bytes += len(data)
	if c.timer == nil {
		c.timer = time.AfterFunc(pdfCacheTTL, c.expire)
	}
	return data, nil
}

func (c *pdfCache) remove(path string) {
	if entry, ok := c.entries[path]; ok {
		c.bytes -= len(entry.data)
		delete(c.entries, path)
	}
}
func (c *pdfCache) discard(path string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.remove(path)
}
func (c *pdfCache) expire() {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	next := pdfCacheTTL
	for path, entry := range c.entries {
		remaining := pdfCacheTTL - now.Sub(entry.used)
		if remaining <= 0 {
			c.remove(path)
		} else if remaining < next {
			next = remaining
		}
	}
	c.timer = nil
	if len(c.entries) > 0 {
		c.timer = time.AfterFunc(next, c.expire)
	}
}
func (c *pdfCache) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.timer != nil {
		c.timer.Stop()
		c.timer = nil
	}
	c.entries, c.bytes = nil, 0
}
