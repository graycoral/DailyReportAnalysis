package hub

// Notes are ordinary UTF-8 Markdown files. This store deliberately does not use
// the published catalog, encrypted report archive, or GitHub synchronization.
import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const noteMax = 2 << 20

var errNoteConflict = errors.New("다른 창이나 편집기에서 파일이 변경되었습니다. 최신 내용과 비교하거나 내 내용을 사본으로 저장하세요.")
var noteWiki = regexp.MustCompile(`\[\[([^\]\n]+)\]\]`)
var noteLocalLink = regexp.MustCompile(`(!?\[[^\]\n]*\]\()([^\s)]+)(\))`)
var noteReferenceLink = regexp.MustCompile(`(?m)^([ ]{0,3}\[(?:\\.|[^\]\\\r\n])+\]:[ \t]*(?:\r?\n[ ]{0,3})?)(<[^<>\r\n]+>|[^\s<>]+)`)
var noteTag = regexp.MustCompile(`(?:^|\s)#([\p{L}\p{N}_/-]+)`)
var noteIDPattern = regexp.MustCompile(`^n-[a-f0-9]{24}$`)
var noteDevicePattern = regexp.MustCompile(`^(COM|LPT)[0-9¹²³]$`)

type Note struct {
	ID       string   `json:"id"`
	Path     string   `json:"path"`
	Title    string   `json:"title"`
	Body     string   `json:"body"`
	Tags     []string `json:"tags"`
	Reports  []string `json:"reports"`
	Version  string   `json:"version"`
	Modified string   `json:"modified"`
	raw      []byte
}
type noteInput struct {
	ID       string   `json:"id"`
	Path     string   `json:"path"`
	Body     string   `json:"body"`
	Tags     []string `json:"tags"`
	Reports  []string `json:"reports"`
	Version  string   `json:"version"`
	Revision string   `json:"revision"`
	Root     string   `json:"root"`
}
type noteListing struct {
	Root     string   `json:"root"`
	Notes    []Note   `json:"notes"`
	Folders  []string `json:"folders"`
	Warnings []string `json:"warnings"`
	Revision string   `json:"revision,omitempty"`
	Delta    bool     `json:"delta,omitempty"`
	Deleted  []string `json:"deleted,omitempty"`
}
type noteTrash struct {
	ID      string `json:"id"`
	Path    string `json:"path"`
	Deleted string `json:"deleted"`
}

func noteHash(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func noteRandom() string {
	b := make([]byte, 12)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func (a *App) notesRoot() (string, error) {
	root := filepath.Join(a.dir, "notes")
	b, e := os.ReadFile(filepath.Join(a.dir, "notes-settings.json"))
	if e == nil {
		var v struct {
			Root string `json:"root"`
		}
		if e = json.Unmarshal(b, &v); e != nil {
			return "", e
		}
		if v.Root != "" {
			root = v.Root
		}
	} else if !os.IsNotExist(e) {
		return "", e
	}
	root, e = filepath.Abs(root)
	if e != nil {
		return "", e
	}
	if e = os.MkdirAll(root, 0700); e != nil {
		return "", e
	}
	return filepath.EvalSymlinks(root)
}

// Reject Windows device names, alternate streams and path traversal on all OSes.
func noteClean(rel string) (string, error) {
	rel = strings.ReplaceAll(rel, "\\", "/")
	if rel == "" || path.IsAbs(rel) || path.Clean(rel) != rel {
		return "", errors.New("올바른 상대 경로를 입력하세요.")
	}
	for _, part := range strings.Split(rel, "/") {
		base := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
		bad := part == "" || strings.HasPrefix(part, ".") || strings.TrimSpace(part) != part || strings.HasSuffix(part, ".") || strings.ContainsAny(part, "<>:\"|?*\x00") || utf8.RuneCountInString(part) > 180
		for _, r := range part {
			if r < 32 {
				bad = true
			}
		}
		if bad || base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || noteDevicePattern.MatchString(base) {
			return "", errors.New("폴더·파일 이름에 사용할 수 없는 문자가 있습니다.")
		}
	}
	return rel, nil
}

// Internal paths have already been constructed from validated IDs. Check every
// existing ancestor to prevent symlinks/junctions from escaping the chosen vault.
func notePath(root, rel string) (string, error) {
	p := filepath.Join(root, filepath.FromSlash(rel))
	back, e := filepath.Rel(root, p)
	if e != nil || back == ".." || strings.HasPrefix(back, ".."+string(filepath.Separator)) || filepath.IsAbs(back) {
		return "", errors.New("노트 폴더 밖의 경로는 사용할 수 없습니다.")
	}
	for cur := p; cur != root; cur = filepath.Dir(cur) {
		info, e := os.Lstat(cur)
		if os.IsNotExist(e) {
			continue
		}
		if e != nil {
			return "", e
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("노트 폴더의 심볼릭 링크는 지원하지 않습니다.")
		}
		resolved, e := filepath.EvalSymlinks(cur)
		if e != nil {
			return "", e
		}
		r, e := filepath.Rel(root, resolved)
		if e != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
			return "", errors.New("노트 폴더 밖의 연결 경로입니다.")
		}
	}
	return p, nil
}
func noteRead(root, rel string) ([]byte, error) {
	p, e := notePath(root, rel)
	if e != nil {
		return nil, e
	}
	f, e := os.Open(p)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, noteMax+1))
	if e == nil && len(b) > noteMax {
		return nil, errors.New("노트 파일은 2MB 이하만 열 수 있습니다.")
	}
	return b, e
}
func noteStrings(v []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, s := range v {
		s = strings.TrimSpace(s)
		if s != "" && !seen[s] && len(s) < 500 {
			out = append(out, s)
			seen[s] = true
		}
	}
	return out
}
func noteDecode(rel string, b []byte, modified time.Time) Note {
	n := Note{ID: "n-" + noteHash([]byte(strings.ToLower(rel)))[:24], Path: rel, Title: strings.TrimSuffix(path.Base(rel), path.Ext(rel)), Body: string(b), Tags: []string{}, Reports: []string{}, Version: noteHash(b), Modified: modified.UTC().Format(time.RFC3339Nano), raw: b}
	s := strings.TrimPrefix(strings.ReplaceAll(string(b), "\r\n", "\n"), "\ufeff")
	if strings.HasPrefix(s, "---\n") {
		if end := strings.Index(s[4:], "\n---"); end >= 0 {
			end += 4
			tail := end + 4
			if tail == len(s) || s[tail] == '\n' {
				keep := []string{}
				for _, line := range strings.Split(s[4:end], "\n") {
					key, val, ok := strings.Cut(line, ":")
					if ok {
						switch key {
						case "avhub_id":
							var id string
							if json.Unmarshal([]byte(strings.TrimSpace(val)), &id) == nil && noteIDPattern.MatchString(id) {
								n.ID = id
								continue
							}
						case "avhub_tags":
							if json.Unmarshal([]byte(strings.TrimSpace(val)), &n.Tags) == nil {
								continue
							}
						case "avhub_reports":
							if json.Unmarshal([]byte(strings.TrimSpace(val)), &n.Reports) == nil {
								continue
							}
						}
					}
					keep = append(keep, line)
				}
				n.Body = strings.TrimPrefix(s[tail:], "\n")
				if strings.TrimSpace(strings.Join(keep, "\n")) != "" {
					n.Body = "---\n" + strings.Join(keep, "\n") + "\n---\n" + n.Body
				}
			}
		}
	}
	n.Tags = noteStrings(n.Tags)
	n.Reports = noteStrings(n.Reports)
	return n
}
func noteEncode(n Note) []byte {
	id, _ := json.Marshal(n.ID)
	tags, _ := json.Marshal(noteStrings(n.Tags))
	reports, _ := json.Marshal(noteStrings(n.Reports))
	meta := "avhub_id: " + string(id) + "\navhub_tags: " + string(tags) + "\navhub_reports: " + string(reports) + "\n"
	// Managed keys are never accepted from the editable body (including imported
	// front matter), so duplicate IDs cannot override this note's identity.
	body := noteDecode(n.Path, []byte(n.Body), time.Time{}).Body
	body = strings.TrimPrefix(strings.ReplaceAll(body, "\r\n", "\n"), "\ufeff")
	validFrontMatter := false
	if strings.HasPrefix(body, "---\n") && !strings.HasPrefix(body[4:], "---\n") && body[4:] != "---" {
		for _, line := range strings.Split(body[4:], "\n") {
			if line == "---" {
				validFrontMatter = true
				break
			}
		}
	}
	if validFrontMatter {
		return []byte("---\n" + meta + body[4:])
	}
	return []byte("---\n" + meta + "---\n" + body)
}
func noteScan(root string) (noteListing, error) {
	return scanNotes(root, nil)
}
func scanNotes(root string, cache *noteCache) (noteListing, error) {
	v := noteListing{Root: root, Notes: []Note{}, Folders: []string{}, Warnings: []string{}}
	ids := map[string]string{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if p == root {
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		if _, e = noteClean(rel); e != nil {
			v.Warnings = append(v.Warnings, rel+": 지원하지 않는 이름")
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		// Validate each directory once. Unchanged regular files need only a stat;
		// changed files still pass the full path check before being read.
		if d.IsDir() || d.Type()&os.ModeSymlink != 0 {
			if _, e = notePath(root, rel); e != nil {
				v.Warnings = append(v.Warnings, rel+": "+e.Error())
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
		}
		if d.IsDir() {
			if rel != "첨부" {
				v.Folders = append(v.Folders, rel)
			}
			return nil
		}
		if !strings.EqualFold(filepath.Ext(p), ".md") {
			return nil
		}
		info, e := d.Info()
		if e != nil {
			return e
		}
		if info.Size() > noteMax {
			v.Warnings = append(v.Warnings, rel+": 2MB를 초과해 열지 않았습니다.")
			return nil
		}
		var n Note
		cached, reused := noteCacheEntry{}, false
		if cache != nil {
			cached, reused = cache.files[rel]
			reused = reused && cached.info.Size() == info.Size() && cached.info.ModTime().Equal(info.ModTime()) && os.SameFile(cached.info, info)
		}
		if reused {
			n = cached.note
		} else {
			b, err := noteRead(root, rel)
			if err != nil {
				return err
			}
			if !utf8.Valid(b) {
				v.Warnings = append(v.Warnings, rel+": UTF-8 파일이 아닙니다.")
				return nil
			}
			n = noteDecode(rel, b, info.ModTime())
		}
		if cache != nil {
			cache.scanned[rel] = noteCacheEntry{note: n, info: info}
		}
		if prev, ok := ids[n.ID]; ok {
			return fmt.Errorf("노트 ID가 중복됩니다: %s, %s. 복사한 파일의 avhub_id 줄을 제거하세요.", prev, rel)
		}
		ids[n.ID] = rel
		v.Notes = append(v.Notes, n)
		return nil
	})
	sort.Slice(v.Notes, func(i, j int) bool { return v.Notes[i].Modified > v.Notes[j].Modified })
	sort.Strings(v.Folders)
	return v, err
}
func noteFind(notes []Note, id string) (Note, error) {
	for _, n := range notes {
		if n.ID == id {
			return n, nil
		}
	}
	return Note{}, os.ErrNotExist
}
func noteResolve(notes []Note, from, target string) string {
	target = strings.SplitN(strings.SplitN(target, "|", 2)[0], "#", 2)[0]
	target = strings.TrimSpace(strings.TrimSuffix(target, ".md"))
	if target == "" {
		return ""
	}
	for _, candidate := range []string{path.Clean(path.Join(path.Dir(from), target)) + ".md", target + ".md"} {
		for _, n := range notes {
			if strings.EqualFold(n.Path, candidate) {
				return n.ID
			}
		}
	}
	match := ""
	for _, n := range notes {
		if strings.EqualFold(n.Title, target) {
			if match != "" {
				return ""
			}
			match = n.ID
		}
	}
	return match
}
func noteRelative(from, to string) string {
	p, e := filepath.Rel(filepath.FromSlash(path.Dir(from)), filepath.FromSlash(to))
	if e != nil {
		return to
	}
	return filepath.ToSlash(p)
}
func noteRewrite(body, from, to, oldPath, newPath, id string, notes []Note) string {
	return noteProse(body, func(prose string) string { return noteRewriteLinks(prose, from, to, oldPath, newPath, id, notes) })
}

// Do not rename links inside code samples or user-owned YAML metadata.
func noteProse(body string, transform func(string) string) string {
	var out strings.Builder
	var prose strings.Builder
	flush := func() {
		text := prose.String()
		prose.Reset()
		for len(text) > 0 {
			start := strings.IndexByte(text, '`')
			if start < 0 {
				out.WriteString(transform(text))
				break
			}
			count := 1
			for start+count < len(text) && text[start+count] == '`' {
				count++
			}
			end := strings.Index(text[start+count:], strings.Repeat("`", count))
			if end < 0 {
				out.WriteString(transform(text))
				break
			}
			end += start + count + count
			out.WriteString(transform(text[:start]))
			out.WriteString(text[start:end])
			text = text[end:]
		}
	}
	fence := ""
	front := strings.HasPrefix(body, "---\n")
	for i, line := range strings.SplitAfter(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if front {
			flush()
			out.WriteString(line)
			if i > 0 && trimmed == "---" {
				front = false
			}
			continue
		}
		leading := len(line) - len(strings.TrimLeft(line, " "))
		if leading <= 3 && (strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~")) {
			flush()
			ch := trimmed[0]
			count := 0
			for count < len(trimmed) && trimmed[count] == ch {
				count++
			}
			if fence == "" {
				fence = trimmed[:count]
			} else if ch == fence[0] && count >= len(fence) && strings.TrimSpace(trimmed[count:]) == "" {
				fence = ""
			}
			out.WriteString(line)
			continue
		}
		if fence != "" || strings.HasPrefix(line, "    ") || strings.HasPrefix(line, "\t") {
			flush()
			out.WriteString(line)
			continue
		}
		prose.WriteString(line)
	}
	flush()
	return out.String()
}
func noteRewriteLinks(body, from, to, oldPath, newPath, id string, notes []Note) string {
	body = noteWiki.ReplaceAllStringFunc(body, func(m string) string {
		inner := m[2 : len(m)-2]
		target := strings.SplitN(strings.SplitN(inner, "|", 2)[0], "#", 2)[0]
		resolved := noteResolve(notes, from, inner)
		if resolved == id {
			return "[[" + strings.TrimSuffix(newPath, ".md") + inner[len(target):] + "]]"
		}
		if from != to && resolved != "" {
			n, _ := noteFind(notes, resolved)
			return "[[" + strings.TrimSuffix(n.Path, ".md") + inner[len(target):] + "]]"
		}
		return m
	})
	rewriteTarget := func(value string) string {
		u, e := url.Parse(value)
		if e != nil || u.IsAbs() || u.Host != "" || u.Path == "" || strings.HasPrefix(u.Path, "/") {
			return value
		}
		target := path.Clean(path.Join(path.Dir(from), u.Path))
		if strings.EqualFold(target, oldPath) {
			target = newPath
		} else if from == to {
			return value
		}
		u.Path = noteRelative(to, target)
		u.RawPath = ""
		return u.String()
	}
	body = noteLocalLink.ReplaceAllStringFunc(body, func(m string) string {
		parts := noteLocalLink.FindStringSubmatch(m)
		return parts[1] + rewriteTarget(parts[2]) + parts[3]
	})
	return noteReferenceLink.ReplaceAllStringFunc(body, func(m string) string {
		parts := noteReferenceLink.FindStringSubmatch(m)
		target := parts[2]
		if strings.HasPrefix(target, "<") {
			return parts[1] + "<" + rewriteTarget(target[1:len(target)-1]) + ">"
		}
		return parts[1] + rewriteTarget(target)
	})
}
func noteHistory(root string, n Note) error {
	p, e := notePath(root, ".avhub/history/"+n.ID)
	if e != nil {
		return e
	}
	name := time.Now().UTC().Format("20060102T150405.000000000") + "-" + noteRandom()[:6] + ".md"
	if e = writeAtomic(filepath.Join(p, name), n.raw); e != nil {
		return e
	}
	if e = writeAtomic(filepath.Join(p, name+".path"), []byte(n.Path)); e != nil {
		return e
	}
	entries, e := os.ReadDir(p)
	if e != nil {
		return e
	}
	// Bound disk usage to the latest 50 full revisions per note.
	versions := []fs.DirEntry{}
	for _, f := range entries {
		if !f.IsDir() && strings.HasSuffix(f.Name(), ".md") {
			versions = append(versions, f)
		}
	}
	if len(versions) > 50 {
		for _, f := range versions[:len(versions)-50] {
			if e = os.Remove(filepath.Join(p, f.Name())); e != nil {
				return e
			}
			if e = os.Remove(filepath.Join(p, f.Name()+".path")); e != nil && !os.IsNotExist(e) {
				return e
			}
		}
	}
	return nil
}

type noteChange struct {
	path          string
	before, after []byte
}

func noteCommit(root string, changes []noteChange) error {
	// Validate every precondition before the first write. A failed multi-file rename
	// rolls back completed writes; each replaced document also has a history copy.
	for _, c := range changes {
		p, e := notePath(root, c.path)
		if e != nil {
			return e
		}
		b, e := os.ReadFile(p)
		if c.before == nil {
			if !os.IsNotExist(e) {
				return errNoteConflict
			}
		} else if e != nil || noteHash(b) != noteHash(c.before) {
			return errNoteConflict
		}
	}
	done := []noteChange{}
	for _, c := range changes {
		p, e := notePath(root, c.path)
		if e == nil {
			b, re := os.ReadFile(p)
			if c.before == nil {
				if !os.IsNotExist(re) {
					e = errNoteConflict
				}
			} else if re != nil || noteHash(b) != noteHash(c.before) {
				e = errNoteConflict
			}
		}
		if e == nil {
			if c.after == nil {
				e = os.Remove(p)
			} else {
				e = writeAtomic(p, c.after)
			}
		}
		if e != nil {
			for i := len(done) - 1; i >= 0; i-- {
				d := done[i]
				q, qe := notePath(root, d.path)
				if qe != nil {
					e = errors.Join(e, qe)
					continue
				}
				// Do not undo another editor's newer write while rolling back.
				actual, readErr := os.ReadFile(q)
				if d.after == nil && !os.IsNotExist(readErr) || d.after != nil && (readErr != nil || !bytes.Equal(actual, d.after)) {
					e = errors.Join(e, errNoteConflict)
					continue
				}
				if d.before == nil {
					qe = os.Remove(q)
				} else {
					qe = writeAtomic(q, d.before)
				}
				if qe != nil {
					e = errors.Join(e, qe)
				}
			}
			return e
		}
		done = append(done, c)
	}
	return nil
}
func (a *App) noteSave(root string, in noteInput) (Note, error) {
	rel, e := noteClean(in.Path)
	if e != nil {
		return Note{}, e
	}
	if !strings.EqualFold(path.Ext(rel), ".md") {
		return Note{}, errors.New("노트 파일은 .md 확장자를 사용하세요.")
	}
	if !utf8.ValidString(in.Body) || len(in.Body) > noteMax-4096 {
		return Note{}, errors.New("노트는 UTF-8, 2MB 이하로 작성하세요.")
	}
	c := a.noteStore(root)
	if !c.ready {
		if e := c.scan(); e != nil {
			return Note{}, e
		}
	}
	n := Note{ID: "n-" + noteRandom(), Path: rel, Body: in.Body, Tags: noteStrings(in.Tags), Reports: noteStrings(in.Reports)}
	var old Note
	if in.ID != "" {
		old, e = a.noteGet(root, in.ID)
		if e != nil {
			return Note{}, errNoteConflict
		}
		if in.Version != old.Version {
			return Note{}, errNoteConflict
		}
		n.ID = old.ID
	}
	if existing, ok := c.paths[strings.ToLower(rel)]; ok {
		if c.files[existing].note.ID != n.ID {
			p, err := notePath(root, existing)
			if err != nil {
				return Note{}, err
			}
			if _, err := os.Stat(p); os.IsNotExist(err) {
				c.remove(existing)
			} else if err != nil {
				return Note{}, err
			} else {
				return Note{}, errors.New("같은 경로의 노트가 있습니다. 다른 이름을 사용하세요.")
			}
		}
	}
	if len(n.Tags) > 100 || len(n.Reports) > 100 {
		return Note{}, errors.New("태그·리포트 연결은 각각 100개 이하로 지정하세요.")
	}
	changes := []noteChange{}
	if old.ID != "" && old.Path != rel {
		// Windows case-only renames are ambiguous across file systems; require a distinct intermediate name.
		if strings.EqualFold(old.Path, rel) {
			return Note{}, errors.New("대소문자만 바꾸려면 다른 이름으로 변경한 뒤 다시 바꾸세요.")
		}
		v, e := a.noteList(root, "")
		if e != nil {
			return Note{}, e
		}
		n.Body = noteRewrite(n.Body, old.Path, rel, old.Path, rel, n.ID, v.Notes)
		for _, other := range v.Notes {
			if other.ID == n.ID {
				continue
			}
			body := noteRewrite(other.Body, other.Path, other.Path, old.Path, rel, n.ID, v.Notes)
			if body != other.Body {
				if e = noteHistory(root, other); e != nil {
					return Note{}, e
				}
				updated := other
				updated.Body = body
				changes = append(changes, noteChange{other.Path, other.raw, noteEncode(updated)})
			}
		}
	}
	raw := noteEncode(n)
	if len(raw) > noteMax {
		return Note{}, errors.New("연결 정보와 본문을 합한 노트 크기가 2MB를 초과합니다.")
	}
	if old.ID != "" {
		if string(raw) == string(old.raw) && old.Path == rel {
			return old, nil
		}
		if e = noteHistory(root, old); e != nil {
			return Note{}, e
		}
	}
	if old.ID != "" && old.Path != rel {
		changes = append(changes, noteChange{rel, nil, raw}, noteChange{old.Path, old.raw, nil})
	} else {
		changes = append(changes, noteChange{rel, old.raw, raw})
	}
	if e = a.noteCommit(root, changes); e != nil {
		return Note{}, e
	}
	return a.noteStore(root).files[rel].note, nil
}
func (a *App) notesRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/notes", a.notesHandler)
	mux.HandleFunc("/api/notes/", a.notesHandler)
}
func (a *App) notesHandler(w http.ResponseWriter, r *http.Request) {
	a.notesMu.Lock()
	locked := true
	unlock := func() {
		if locked {
			locked = false
			a.notesMu.Unlock()
		}
	}
	defer unlock()
	root, e := a.notesRoot()
	if e != nil {
		http.Error(w, e.Error(), 500)
		return
	}
	op := strings.TrimPrefix(r.URL.Path, "/api/notes")
	op = strings.TrimPrefix(op, "/")
	get := op == "" || op == "get" || op == "history" || op == "trash" || op == "asset"
	if get && r.Method != http.MethodGet {
		http.Error(w, "GET required", 405)
		return
	}
	if !get && !post(w, r) {
		return
	}
	in := noteInput{}
	if !get && op != "image" {
		if e = json.NewDecoder(http.MaxBytesReader(w, r.Body, noteMax+65536)).Decode(&in); e != nil {
			http.Error(w, "요청을 읽을 수 없습니다.", 400)
			return
		}
	}
	fail := func(err error) {
		unlock()
		code := 400
		if errors.Is(err, errNoteConflict) {
			code = 409
		} else if os.IsNotExist(err) {
			code = 404
		}
		http.Error(w, err.Error(), code)
	}
	respond := func(value any, err error) {
		if err != nil {
			fail(err)
		} else {
			unlock()
			writeResponse(w, value)
		}
	}
	switch op {
	case "":
		v, e := a.noteList(root, r.URL.Query().Get("since"))
		respond(v, e)
	case "get":
		n, e := a.noteGet(root, r.URL.Query().Get("id"))
		respond(n, e)
	case "save":
		n, e := a.noteSave(root, in)
		respond(n, e)
	case "folder":
		rel, e := noteClean(in.Path)
		if e == nil {
			var p string
			p, e = notePath(root, rel)
			if e == nil {
				e = os.MkdirAll(p, 0700)
			}
		}
		respond(map[string]bool{"ok": true}, e)
	case "delete":
		n, e := a.noteGet(root, in.ID)
		if e != nil {
			fail(e)
			return
		}
		if n.Version != in.Version {
			fail(errNoteConflict)
			return
		}
		p, e := notePath(root, ".avhub/trash/"+n.ID)
		if e != nil {
			fail(e)
			return
		}
		if e = writeAtomic(filepath.Join(p, "note.md"), n.raw); e != nil {
			fail(e)
			return
		}
		if e = writeJSON(filepath.Join(p, "info.json"), noteTrash{n.ID, n.Path, time.Now().UTC().Format(time.RFC3339Nano)}); e != nil {
			fail(e)
			return
		}
		e = a.noteCommit(root, []noteChange{{n.Path, n.raw, nil}})
		respond(map[string]bool{"ok": true}, e)
	case "purge":
		if !noteIDPattern.MatchString(in.ID) {
			fail(errors.New("잘못된 노트 ID입니다."))
			return
		}
		// Resolve and check the exact, ID-scoped folders before any removal.
		paths := []string{}
		for _, sub := range []string{"trash", "history"} {
			p, err := notePath(root, ".avhub/"+sub+"/"+in.ID)
			if err != nil {
				fail(err)
				return
			}
			paths = append(paths, p)
		}
		n, err := a.noteGet(root, in.ID)
		if err == nil {
			if n.Version != in.Version {
				fail(errNoteConflict)
				return
			}
			if err = a.noteCommit(root, []noteChange{{n.Path, n.raw, nil}}); err != nil {
				fail(err)
				return
			}
		} else if !os.IsNotExist(err) {
			fail(err)
			return
		}
		for _, p := range paths {
			if err = os.RemoveAll(p); err != nil {
				fail(err)
				return
			}
		}
		respond(map[string]bool{"ok": true}, nil)
	case "trash":
		items := []noteTrash{}
		p, e := notePath(root, ".avhub/trash")
		if e != nil {
			fail(e)
			return
		}
		entries, e := os.ReadDir(p)
		if e != nil && !os.IsNotExist(e) {
			fail(e)
			return
		}
		for _, f := range entries {
			if !f.IsDir() || !noteIDPattern.MatchString(f.Name()) {
				continue
			}
			q, e := notePath(root, ".avhub/trash/"+f.Name()+"/info.json")
			if e != nil {
				continue
			}
			b, e := os.ReadFile(q)
			var t noteTrash
			if e == nil && json.Unmarshal(b, &t) == nil {
				items = append(items, t)
			}
		}
		sort.Slice(items, func(i, j int) bool { return items[i].Deleted > items[j].Deleted })
		respond(items, nil)
	case "restore-trash":
		if !noteIDPattern.MatchString(in.ID) {
			fail(errors.New("잘못된 노트 ID입니다."))
			return
		}
		p, e := notePath(root, ".avhub/trash/"+in.ID)
		if e != nil {
			fail(e)
			return
		}
		b, e := noteRead(root, ".avhub/trash/"+in.ID+"/info.json")
		var t noteTrash
		if e != nil {
			fail(e)
			return
		}
		if e = json.Unmarshal(b, &t); e != nil {
			fail(e)
			return
		}
		if _, e = noteClean(t.Path); e != nil {
			fail(e)
			return
		}
		raw, e := noteRead(root, ".avhub/trash/"+in.ID+"/note.md")
		if e != nil {
			fail(e)
			return
		}
		n := noteDecode(t.Path, raw, time.Now())
		v, e := a.noteList(root, "")
		if e != nil {
			fail(e)
			return
		}
		if _, e = noteFind(v.Notes, n.ID); e == nil {
			fail(errors.New("같은 노트가 이미 있습니다."))
			return
		}
		for i := 1; ; i++ {
			target, e := notePath(root, n.Path)
			if e != nil {
				fail(e)
				return
			}
			if _, e = os.Stat(target); os.IsNotExist(e) {
				break
			}
			n.Path = strings.TrimSuffix(t.Path, ".md") + fmt.Sprintf(" (복원 %d).md", i)
		}
		if n.Path != t.Path {
			n.Body = noteRewrite(n.Body, t.Path, n.Path, t.Path, n.Path, n.ID, append(v.Notes, n))
			raw = noteEncode(n)
		}
		e = a.noteCommit(root, []noteChange{{n.Path, nil, raw}})
		if e == nil {
			e = os.Remove(filepath.Join(p, "info.json"))
		}
		respond(noteDecode(n.Path, raw, time.Now()), e)
	case "history":
		id := r.URL.Query().Get("id")
		if !noteIDPattern.MatchString(id) {
			fail(errors.New("잘못된 노트 ID입니다."))
			return
		}
		p, e := notePath(root, ".avhub/history/"+id)
		if e != nil {
			fail(e)
			return
		}
		entries, e := os.ReadDir(p)
		if e != nil && !os.IsNotExist(e) {
			fail(e)
			return
		}
		revs := []map[string]string{}
		for i := len(entries) - 1; i >= 0; i-- {
			f := entries[i]
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".md") {
				continue
			}
			info, e := f.Info()
			if e == nil {
				revs = append(revs, map[string]string{"revision": f.Name(), "modified": info.ModTime().UTC().Format(time.RFC3339Nano)})
			}
		}
		respond(revs, nil)
	case "restore-version":
		if !noteIDPattern.MatchString(in.ID) || !regexp.MustCompile(`^[0-9T.]+-[a-f0-9]{6}\.md$`).MatchString(in.Revision) {
			fail(errors.New("잘못된 저장 기록입니다."))
			return
		}
		p, e := notePath(root, ".avhub/history/"+in.ID+"/"+in.Revision)
		if e != nil {
			fail(e)
			return
		}
		b, e := os.ReadFile(p)
		if e != nil {
			fail(e)
			return
		}
		n := noteDecode(in.Path, b, time.Now())
		originalPath, pathErr := notePath(root, ".avhub/history/"+in.ID+"/"+in.Revision+".path")
		if pathErr != nil {
			fail(pathErr)
			return
		}
		if oldPath, readErr := os.ReadFile(originalPath); readErr == nil && string(oldPath) != in.Path {
			if _, e = noteClean(string(oldPath)); e != nil {
				fail(e)
				return
			}
			listing, scanErr := a.noteList(root, "")
			if scanErr != nil {
				fail(scanErr)
				return
			}
			n.Body = noteRewrite(n.Body, string(oldPath), in.Path, string(oldPath), in.Path, n.ID, listing.Notes)
		} else if readErr != nil && !os.IsNotExist(readErr) {
			fail(readErr)
			return
		}
		in.Body = n.Body
		in.Tags = n.Tags
		in.Reports = n.Reports
		n, e = a.noteSave(root, in)
		respond(n, e)
	case "root", "pick-root":
		if op == "pick-root" {
			in.Root, e = pickNotesFolder()
			if e != nil {
				fail(e)
				return
			}
			if in.Root == "" {
				respond(map[string]bool{"cancelled": true}, nil)
				return
			}
		}
		if !filepath.IsAbs(in.Root) {
			fail(errors.New("노트 폴더의 절대 경로를 입력하세요."))
			return
		}
		target, e := filepath.Abs(in.Root)
		if e != nil {
			fail(e)
			return
		}
		for p := target; ; p = filepath.Dir(p) {
			if _, e = os.Stat(filepath.Join(p, ".git")); e == nil {
				fail(errors.New("노트 폴더는 Git 저장소 밖에서 선택하세요."))
				return
			}
			if filepath.Dir(p) == p {
				break
			}
		}
		if e = os.MkdirAll(target, 0700); e != nil {
			fail(e)
			return
		}
		target, e = filepath.EvalSymlinks(target)
		if e != nil {
			fail(e)
			return
		}
		for p := target; ; p = filepath.Dir(p) {
			if _, e = os.Stat(filepath.Join(p, ".git")); e == nil {
				fail(errors.New("노트 폴더는 Git 저장소 밖에서 선택하세요."))
				return
			}
			if filepath.Dir(p) == p {
				break
			}
		}
		v, e := noteScan(target)
		if e != nil {
			fail(e)
			return
		}
		f, e := os.CreateTemp(target, ".notes-check-")
		if e != nil {
			fail(e)
			return
		}
		f.Close()
		os.Remove(f.Name())
		e = writeJSON(filepath.Join(a.dir, "notes-settings.json"), map[string]string{"root": target})
		respond(v, e)
	case "open-root":
		respond(map[string]bool{"ok": true}, openBrowser(root))
	case "image":
		b, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 10<<20))
		if e != nil {
			fail(errors.New("이미지는 10MB 이하로 선택하세요."))
			return
		}
		mime := http.DetectContentType(b)
		ext := map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}[mime]
		if ext == "" {
			fail(errors.New("PNG, JPEG, GIF, WebP 이미지를 선택하세요."))
			return
		}
		rel := "첨부/" + noteRandom() + ext
		p, e := notePath(root, rel)
		if e == nil {
			e = writeAtomic(p, b)
		}
		respond(map[string]string{"path": rel}, e)
	case "asset":
		rel, e := noteClean(r.URL.Query().Get("path"))
		if e != nil {
			fail(e)
			return
		}
		p, e := notePath(root, rel)
		if e != nil {
			fail(e)
			return
		}
		f, e := os.Open(p)
		if e != nil {
			fail(e)
			return
		}
		defer f.Close()
		info, e := f.Stat()
		if e != nil || info.IsDir() || info.Size() > 10<<20 {
			fail(errors.New("이미지를 열 수 없습니다."))
			return
		}
		b := make([]byte, 512)
		n, _ := f.Read(b)
		mime := http.DetectContentType(b[:n])
		if mime != "image/png" && mime != "image/jpeg" && mime != "image/gif" && mime != "image/webp" {
			fail(errors.New("지원하지 않는 이미지입니다."))
			return
		}
		f.Seek(0, 0)
		w.Header().Set("Content-Type", mime)
		unlock()
		http.ServeContent(w, r, path.Base(rel), info.ModTime(), f)
	default:
		http.NotFound(w, r)
	}
}
