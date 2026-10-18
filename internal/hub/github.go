package hub

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var errNoAttachment = errors.New("첨부파일이 없습니다.")

type githubClient struct {
	config Config
	token  string
	client *http.Client
	base   string
}

// Header timeouts are short; body transfer of large DB/attachments is bounded by the caller's context only.
func newGitHub(c Config, token string) *githubClient {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.ResponseHeaderTimeout = 45 * time.Second
	t.TLSHandshakeTimeout = 20 * time.Second
	return &githubClient{c, token, &http.Client{Transport: t, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		return errors.New("예상하지 않은 GitHub 리디렉션입니다.")
	}}, apiBase}
}

var apiBase = "https://api.github.com" // overridden in tests

// Caller holds mu. A failed update remains retryable, including after a network change.
func (a *App) syncAvailability() string {
	if a.syncing {
		return "checking"
	}
	if a.config.Offline {
		return "offline"
	}
	if !a.config.Configured {
		return "unconfigured"
	}
	if a.syncState == "" {
		return "unknown"
	}
	return a.syncState
}
func (g *githubClient) get(ctx context.Context, path, accept string, limit int64) ([]byte, error) {
	b, _, e := g.getETag(ctx, path, accept, "", limit)
	return b, e
}

// etag enables a conditional request; a 304 returns (nil, etag, nil) and does not count toward the API rate limit.
func (g *githubClient) getETag(ctx context.Context, path, accept, etag string, limit int64) ([]byte, string, error) {
	req, e := http.NewRequestWithContext(ctx, "GET", g.base+path, nil)
	if e != nil {
		return nil, "", e
	}
	req.Header.Set("User-Agent", "AVReportHub/"+Version)
	req.Header.Set("Accept", accept)
	if g.token != "" {
		req.Header.Set("Authorization", "Bearer "+g.token)
	}
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	resp, e := g.client.Do(req)
	if e != nil {
		log.Printf("github %s: %v", path, e)
		return nil, "", errors.New("GitHub에 연결할 수 없습니다. 인터넷·회사 프록시·인증서를 확인하세요.")
	}
	defer resp.Body.Close()
	if resp.StatusCode == 304 && etag != "" {
		return nil, etag, nil
	}
	if resp.StatusCode != 200 {
		log.Printf("github %s: status %d", path, resp.StatusCode)
		switch resp.StatusCode {
		case 401:
			return nil, "", errors.New("GitHub 인증 정보가 만료되었거나 잘못되었습니다.")
		case 403:
			return nil, "", errors.New("GitHub 접근 권한 또는 API 사용량을 확인하세요.")
		case 404:
			return nil, "", errors.New("저장소·브랜치·데이터 파일이 없거나 읽기 권한이 없습니다.")
		}
		return nil, "", fmt.Errorf("GitHub 응답 오류 (%d)", resp.StatusCode)
	}
	b, e := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if e != nil {
		return nil, "", e
	}
	if int64(len(b)) > limit {
		return nil, "", errors.New("데이터 크기가 허용 범위를 초과했습니다.")
	}
	return b, resp.Header.Get("ETag"), nil
}
func (g *githubClient) repoPath() string { return "/repos/" + g.config.Owner + "/" + g.config.Repo }
func (g *githubClient) commit(ctx context.Context) (string, error) {
	sha, _, e := g.commitETag(ctx, "")
	return sha, e
}

// With a prior etag, an unchanged branch yields sha=="" and the same etag.
func (g *githubClient) commitETag(ctx context.Context, etag string) (string, string, error) {
	b, tag, e := g.getETag(ctx, g.repoPath()+"/commits/"+url.PathEscape(g.config.Branch), "application/vnd.github+json", etag, 2<<20)
	if e != nil {
		return "", "", e
	}
	if b == nil {
		return "", tag, nil
	}
	var v struct {
		SHA string `json:"sha"`
	}
	e = json.Unmarshal(b, &v)
	if e != nil || len(v.SHA) != 40 {
		return "", "", errors.New("GitHub 버전 정보를 읽을 수 없습니다.")
	}
	return v.SHA, tag, nil
}
func (g *githubClient) content(ctx context.Context, p, commit string, max int64) ([]byte, error) {
	parts := strings.Split(p, "/")
	for i := range parts {
		parts[i] = url.PathEscape(parts[i])
	}
	return g.get(ctx, g.repoPath()+"/contents/"+strings.Join(parts, "/")+"?ref="+url.QueryEscape(commit), "application/vnd.github.raw+json", max)
}
func (g *githubClient) catalog(ctx context.Context, commit string) (Catalog, error) {
	b, e := g.content(ctx, "data/catalog.json", commit, 25<<20)
	if e != nil {
		return Catalog{}, e
	}
	return parseCatalog(b)
}
func (a *App) readToken() (string, error) {
	b, e := os.ReadFile(filepath.Join(a.dir, "token.bin"))
	if os.IsNotExist(e) {
		return "", nil
	}
	if e != nil {
		return "", e
	}
	p, e := unprotect(b)
	return string(p), e
}
func (a *App) syncData() {
	if !a.syncLock.TryLock() {
		return
	}
	defer a.syncLock.Unlock()
	a.mu.Lock()
	cfg := a.config
	old := a.snapshot
	a.syncing = true
	a.status = "최신 자료 확인 중"
	a.mu.Unlock()
	var err error
	defer func() {
		a.mu.Lock()
		defer a.mu.Unlock()
		a.syncing = false
		if err != nil {
			log.Printf("sync failed: %v", err)
			a.status = err.Error()
			a.syncState = "unavailable"
		} else {
			a.syncState = "ready"
		}
	}()
	if !cfg.Configured || cfg.Offline {
		err = errors.New("GitHub 연결을 먼저 설정하세요. 현재는 포함된 자료를 보여줍니다.")
		return
	}
	token, e := a.readToken()
	if e != nil {
		err = e
		return
	}
	g := newGitHub(cfg, token)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	sameOrigin := old.Origin == cfg.Owner+"/"+cfg.Repo
	etag := ""
	if sameOrigin {
		etag = old.ETag
	}
	commit, etag, e := g.commitETag(ctx, etag)
	if e != nil {
		err = e
		return
	}
	snap := old
	switch {
	case commit == "":
		log.Printf("sync: branch unchanged (304), commit %s", old.Commit)
	case commit != old.Commit || !sameOrigin:
		c, e := g.catalog(ctx, commit)
		if e != nil {
			err = e
			return
		}
		if old.Catalog.Database != nil && c.Database == nil {
			err = errors.New("게시 저장소에 전체 DB가 아직 없습니다. 현재 보관 자료를 유지합니다.")
			return
		}
		log.Printf("sync: new commit %s, %d reports", commit, len(c.Reports))
		snap = Snapshot{Commit: commit, Origin: cfg.Owner + "/" + cfg.Repo, Catalog: c}
	}
	snap.ETag = etag
	snap.SyncedAt = time.Now().In(kst).Format(time.RFC3339)
	if e = a.ensureDatabase(ctx, snap, g); e != nil {
		err = e
		return
	}
	if e = writeJSON(filepath.Join(a.dir, "snapshot.json"), snap); e != nil {
		err = e
		return
	}
	a.mu.Lock()
	a.snapshot = snap
	a.status = "최신 자료 확인 완료"
	a.mu.Unlock()
	a.pruneCache(snap.Catalog)
}

// Remove cached DB/attachment files the current catalog no longer references.
func (a *App) pruneCache(c Catalog) {
	keep := map[string]bool{}
	if c.Database != nil {
		keep[c.Database.SHA256+".sqlite"] = true
	}
	for _, r := range c.Reports {
		for _, at := range r.Attachments {
			keep[at.SHA256] = true
		}
	}
	for _, sub := range []string{"databases", "attachments"} {
		entries, e := os.ReadDir(filepath.Join(a.dir, sub))
		if e != nil {
			continue
		}
		for _, en := range entries {
			if en.IsDir() || keep[en.Name()] || strings.HasPrefix(en.Name(), ".pending-") {
				continue
			}
			if e := os.Remove(filepath.Join(a.dir, sub, en.Name())); e == nil {
				log.Printf("pruned %s/%s", sub, en.Name())
			}
		}
	}
}

// Keep immutable SQLite snapshots alongside the matching JSON display projection.
// No SQLite engine or AI runtime is needed on the user's PC.
func (a *App) ensureDatabase(ctx context.Context, snap Snapshot, g *githubClient) error {
	db := snap.Catalog.Database
	if db == nil {
		return nil
	}
	target := filepath.Join(a.dir, "databases", db.SHA256+".sqlite")
	valid := func(b []byte) bool {
		h := sha256.Sum256(b)
		return hex.EncodeToString(h[:]) == db.SHA256 && len(b) > 16 && string(b[:16]) == "SQLite format 3\x00"
	}
	if b, e := os.ReadFile(target); e == nil && valid(b) {
		return nil
	}
	b, e := assets.ReadFile("seed/reports.sqlite")
	if e != nil || !valid(b) {
		if g == nil || snap.Commit == "" {
			log.Printf("database %s: embedded seed does not match and no remote available", db.SHA256)
			return errors.New("DB 원본을 준비할 수 없습니다.")
		}
		log.Printf("database %s: downloading from %s", db.SHA256, snap.Commit)
		b, e = g.content(ctx, db.Path, snap.Commit, 90<<20)
		if e != nil {
			return e
		}
	}
	if !valid(b) {
		log.Printf("database %s: downloaded file failed verification", db.SHA256)
		return errors.New("DB 파일 검증에 실패했습니다. 기존 자료는 유지됩니다.")
	}
	return writeAtomic(target, b)
}
func (a *App) attachment(ctx context.Context, rid string, index int) ([]byte, string, error) {
	a.mu.RLock()
	snap := a.snapshot
	cfg := a.config
	a.mu.RUnlock()
	var att Attachment
	found := false
	for _, r := range snap.Catalog.Reports {
		if r.ID == rid && index >= 0 && index < len(r.Attachments) {
			att = r.Attachments[index]
			found = true
			break
		}
	}
	if !found {
		return nil, "", errNoAttachment
	}
	cache := filepath.Join(a.dir, "attachments", att.SHA256)
	check := func(b []byte) bool { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) == att.SHA256 }
	if b, e := os.ReadFile(cache); e == nil && check(b) {
		return b, att.Name, nil
	}
	// Starter attachments are embedded; fresh downloads always use the same published commit.
	if b, e := assets.ReadFile("seed/" + filepath.Base(att.Path)); e == nil && check(b) {
		return b, att.Name, nil
	}
	if snap.Commit == "" || cfg.Offline || snap.Origin != cfg.Owner+"/"+cfg.Repo {
		return nil, "", errors.New("이 첨부는 GitHub 연결 후 받을 수 있습니다.")
	}
	token, e := a.readToken()
	if e != nil {
		return nil, "", e
	}
	log.Printf("attachment %s: downloading %s", att.SHA256, att.Path)
	b, e := newGitHub(cfg, token).content(ctx, att.Path, snap.Commit, 90<<20)
	if e != nil {
		return nil, "", e
	}
	if !check(b) {
		log.Printf("attachment %s: hash mismatch", att.SHA256)
		return nil, "", errors.New("첨부파일 검증에 실패했습니다. 기존 자료는 유지됩니다.")
	}
	if e = writeAtomic(cache, b); e != nil {
		return nil, "", e
	}
	return b, att.Name, nil
}
