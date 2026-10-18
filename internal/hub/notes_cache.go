package hub

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"unicode/utf8"
)

type noteCacheEntry struct {
	note    Note
	info    os.FileInfo
	changed uint64
}

func readNoteEntry(root, rel string) (noteCacheEntry, error) {
	p, err := notePath(root, rel)
	if err != nil {
		return noteCacheEntry{}, err
	}
	f, err := os.Open(p)
	if err != nil {
		return noteCacheEntry{}, err
	}
	defer f.Close()
	// Read metadata from the same handle, before content. A later external edit
	// then invalidates this snapshot on the next scan instead of lending its new
	// timestamp to old bytes (also important for atomic external replacements).
	info, err := f.Stat()
	if err != nil {
		return noteCacheEntry{}, err
	}
	b, err := io.ReadAll(io.LimitReader(f, noteMax+1))
	if err != nil {
		return noteCacheEntry{}, err
	}
	if len(b) > noteMax {
		return noteCacheEntry{}, fmt.Errorf("%s: 2MB를 초과해 열지 않았습니다.", rel)
	}
	if !utf8.Valid(b) {
		return noteCacheEntry{}, fmt.Errorf("%s: UTF-8 파일이 아닙니다.", rel)
	}
	return noteCacheEntry{note: noteDecode(rel, b, info.ModTime()), info: info}, nil
}

// Owned by notesMu. Files are immutable snapshots; single-note operations always
// reread their target, so even an editor preserving size/mtime cannot bypass the
// optimistic write check. Directory scans read only changed files.
type noteCache struct {
	root, epoch    string
	sequence       uint64
	ready          bool
	files, scanned map[string]noteCacheEntry
	ids            map[string]string
	paths          map[string]string
	deleted        map[string]uint64
	listing        noteListing
}

func (a *App) noteStore(root string) *noteCache {
	if a.notesCache == nil || a.notesCache.root != root {
		a.notesCache = &noteCache{root: root, epoch: noteRandom(), files: map[string]noteCacheEntry{}, ids: map[string]string{}, paths: map[string]string{}, deleted: map[string]uint64{}}
	}
	return a.notesCache
}

func (c *noteCache) put(rel string, entry noteCacheEntry) error {
	if prev, ok := c.ids[entry.note.ID]; ok && prev != rel {
		return fmt.Errorf("노트 ID가 중복됩니다: %s, %s", prev, rel)
	}
	old, exists := c.files[rel]
	entry.changed = old.changed
	if !exists || old.note.ID != entry.note.ID || old.note.Version != entry.note.Version || old.note.Modified != entry.note.Modified {
		if exists && old.note.ID != entry.note.ID {
			c.remove(rel)
		}
		c.sequence++
		entry.changed = c.sequence
	}
	c.files[rel] = entry
	c.ids[entry.note.ID] = rel
	c.paths[strings.ToLower(rel)] = rel
	delete(c.deleted, entry.note.ID)
	return nil
}

func (c *noteCache) remove(rel string) {
	if old, ok := c.files[rel]; ok {
		c.sequence++
		c.deleted[old.note.ID] = c.sequence
		delete(c.ids, old.note.ID)
		delete(c.paths, strings.ToLower(rel))
		delete(c.files, rel)
	}
}

func (c *noteCache) scan() error {
	c.scanned = make(map[string]noteCacheEntry, len(c.files))
	v, err := scanNotes(c.root, c)
	if err != nil {
		c.ready = false
		c.scanned = nil
		return err
	}
	// Remove moved/deleted identities first so an external rename can retain ID.
	for rel, old := range c.files {
		entry, ok := c.scanned[rel]
		if !ok || entry.note.ID != old.note.ID {
			c.remove(rel)
		}
	}
	for rel, entry := range c.scanned {
		if err := c.put(rel, entry); err != nil {
			c.ready = false
			return err
		}
	}
	c.scanned = nil
	c.listing = v
	c.ready = true
	// Bound tombstones. A new epoch asks older clients for a fresh snapshot.
	if len(c.deleted) > 1024 {
		c.epoch = noteRandom()
		c.deleted = map[string]uint64{}
	}
	return nil
}

func (a *App) noteList(root, since string) (noteListing, error) {
	c := a.noteStore(root)
	if err := c.scan(); err != nil {
		return noteListing{}, err
	}
	v := c.listing
	v.Revision = c.epoch + ":" + strconv.FormatUint(c.sequence, 10)
	epoch, serial, ok := strings.Cut(since, ":")
	sequence, err := strconv.ParseUint(serial, 10, 64)
	if ok && err == nil && epoch == c.epoch && sequence <= c.sequence {
		v.Delta = true
		v.Notes = []Note{}
		for _, n := range c.listing.Notes {
			if c.files[n.Path].changed > sequence {
				v.Notes = append(v.Notes, n)
			}
		}
		for id, changed := range c.deleted {
			if changed > sequence {
				v.Deleted = append(v.Deleted, id)
			}
		}
	}
	return v, nil
}

func (a *App) noteGet(root, id string) (Note, error) {
	c := a.noteStore(root)
	if !c.ready {
		if err := c.scan(); err != nil {
			return Note{}, err
		}
	}
	for attempt := 0; attempt < 2; attempt++ {
		if rel, ok := c.ids[id]; ok {
			entry, err := readNoteEntry(root, rel)
			if err == nil {
				if entry.note.ID == id {
					return entry.note, c.put(rel, entry)
				}
			} else if !os.IsNotExist(err) {
				return Note{}, err
			}
		}
		if attempt == 0 {
			if err := c.scan(); err != nil {
				return Note{}, err
			}
		}
	}
	return Note{}, os.ErrNotExist
}

// Mutations update just their known paths. On failure the next request rescans,
// including partially rolled back changes, instead of trusting stale entries.
func (a *App) noteCommit(root string, changes []noteChange) error {
	c := a.noteStore(root)
	if err := noteCommit(root, changes); err != nil {
		c.ready = false
		return err
	}
	for _, change := range changes {
		c.remove(change.path)
	}
	for _, change := range changes {
		if change.after == nil {
			continue
		}
		entry, err := readNoteEntry(root, change.path)
		if err != nil {
			c.ready = false
			return err
		}
		if err := c.put(change.path, entry); err != nil {
			c.ready = false
			return err
		}
	}
	return nil
}
