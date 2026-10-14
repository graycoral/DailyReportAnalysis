package hub

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type githubClient struct {
	config Config
	token  string
	client *http.Client
	base   string
}

func newGitHub(c Config, token string) *githubClient {
	return &githubClient{c, token, &http.Client{Timeout: 45 * time.Second, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		return errors.New("예상하지 않은 GitHub 리디렉션입니다.")
	}}, "https://api.github.com"}
}
func (g *githubClient) get(ctx context.Context, path, accept string, limit int64) ([]byte, error) {
	req, e := http.NewRequestWithContext(ctx, "GET", g.base+path, nil)
	if e != nil {
		return nil, e
	}
	req.Header.Set("User-Agent", "AVReportHub/"+Version)
	req.Header.Set("Accept", accept)
	if g.token != "" {
		req.Header.Set("Authorization", "Bearer "+g.token)
	}
	resp, e := g.client.Do(req)
	if e != nil {
		return nil, errors.New("GitHub에 연결할 수 없습니다. 인터넷·회사 프록시·인증서를 확인하세요.")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		switch resp.StatusCode {
		case 401:
			return nil, errors.New("GitHub 인증 정보가 만료되었거나 잘못되었습니다.")
		case 403:
			return nil, errors.New("GitHub 접근 권한 또는 API 사용량을 확인하세요.")
		case 404:
			return nil, errors.New("저장소·브랜치·데이터 파일이 없거나 읽기 권한이 없습니다.")
		}
		return nil, fmt.Errorf("GitHub 응답 오류 (%d)", resp.StatusCode)
	}
	b, e := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if e != nil {
		return nil, e
	}
	if int64(len(b)) > limit {
		return nil, errors.New("데이터 크기가 허용 범위를 초과했습니다.")
	}
	return b, nil
}
func (g *githubClient) repoPath() string { return "/repos/" + g.config.Owner + "/" + g.config.Repo }
func (g *githubClient) commit(ctx context.Context) (string, error) {
	b, e := g.get(ctx, g.repoPath()+"/commits/"+url.PathEscape(g.config.Branch), "application/vnd.github+json", 2<<20)
	if e != nil {
		return "", e
	}
	var v struct {
		SHA string `json:"sha"`
	}
	e = json.Unmarshal(b, &v)
	if e != nil || len(v.SHA) != 40 {
		return "", errors.New("GitHub 버전 정보를 읽을 수 없습니다.")
	}
	return v.SHA, nil
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
			a.status = err.Error()
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
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	commit, e := g.commit(ctx)
	if e != nil {
		err = e
		return
	}
	snap := old
	if commit != old.Commit || old.Origin != cfg.Owner+"/"+cfg.Repo {
		c, e := g.catalog(ctx, commit)
		if e != nil {
			err = e
			return
		}
		if old.Catalog.Database != nil && c.Database == nil {
			err = errors.New("게시 저장소에 전체 DB가 아직 없습니다. 현재 보관 자료를 유지합니다.")
			return
		}
		snap = Snapshot{Commit: commit, Origin: cfg.Owner + "/" + cfg.Repo, Catalog: c}
	}
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
			return errors.New("DB 원본을 준비할 수 없습니다.")
		}
		b, e = g.content(ctx, db.Path, snap.Commit, 90<<20)
		if e != nil {
			return e
		}
	}
	if !valid(b) {
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
		return nil, "", errors.New("첨부파일이 없습니다.")
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
	b, e := newGitHub(cfg, token).content(ctx, att.Path, snap.Commit, 90<<20)
	if e != nil {
		return nil, "", e
	}
	if !check(b) {
		return nil, "", errors.New("첨부파일 검증에 실패했습니다. 기존 자료는 유지됩니다.")
	}
	if e = writeAtomic(cache, b); e != nil {
		return nil, "", e
	}
	return b, att.Name, nil
}
