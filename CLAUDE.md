# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AV Report Hub: a Windows-only local viewer (Go, zero external modules) for pre-analyzed autonomous-driving daily reports. The end user's PC runs **no AI and no dev tools** — it downloads already-verified data (`data/catalog.json`, `data/reports.sqlite`, MD/PPTX attachments) from this GitHub repo and shows it in the default browser via a loopback HTTP server. All analysis, fact-checking, and relation extraction happens off-PC at publish time. `AGENTS.md` holds the project's hard rules; follow them.

## Commands

Go is required (CI pins `1.27.2`; `go.mod` says `1.24`). `CGO_ENABLED=0`.

```powershell
go test ./internal/...                  # unit tests (Windows-only tests: DPAPI, file replace)
go test ./internal/hub -run TestLocalServerRejectsForeignOriginAndHost   # single test
go vet ./...
go run ./cmd/viewer --no-browser --data-dir ./build/test-data   # dev run; prints the /open?key= URL
go run ./cmd/viewer --self-test --data-dir ./build/test-data    # validates embedded seed + storage, exits
./scripts/build.ps1                     # full pipeline: test → build both EXEs → self-test → scripts/smoke.ps1 → dist/ zip
node -e "new Function(require('fs').readFileSync('internal/hub/web/app.js','utf8'))"   # JS syntax check — nothing in the Go pipeline parses app.js, so a stray newline inside a string literal ships a blank UI
```

`cmd/setup` cannot build until `dist/AVReportHub.exe` has been copied to `cmd/setup/payload/` (build.ps1 does this; the payload is gitignored). `scripts/smoke.ps1` spawns the built Setup and Viewer EXEs and exercises install → launch → `/api/download` over HTTP. `scripts/check-ui.cjs` is a Playwright script that references paths not in the repo (`build/viewer`, `build/chromium`); it is not run by CI.

Publisher-only: `python scripts/import-history.py --workspace … --manifest …` rebuilds `data/reports.sqlite`, both `catalog.json` copies, and `data/import-audit.json`. Never needed on user PCs.

## Architecture

Everything lives in `internal/hub` (package `hub`). `cmd/viewer` and `cmd/setup` are one-liners calling `hub.Run(setup bool, payload []byte)`; Setup embeds the Viewer EXE as `payload` and writes it to `%LOCALAPPDATA%\AVReportHub\bin\`.

- `app.go` — `Run()` (flag parsing, data dir, single-instance via `instance-{viewer|setup}.json`, listener on `127.0.0.1:0`), `scheduler()` (30s ticker; syncs once per day after `config.sync_time` KST, 15-min retry), `routes()` (all `/api/*` handlers + the auth/CSRF wrapper), setup/install flow.
- `github.go` — GitHub REST client (commit SHA → contents at that SHA), `syncData()`, `ensureDatabase()`, `attachment()`.
- `model.go` — `Config`, `Catalog` and its `Validate()`, `writeAtomic`/`writeJSON`. `Version` constant lives here.
- `local.go` — "내 자료": user-dropped PDFs and Outlook mail links, `/api/local*` and `/api/outlook/*`. **This data must never leave the PC**: the index (`local/index.bin`) and PDF copies (`local/<id>.bin`) are DPAPI-encrypted, kept out of `catalog`/`snapshot`/`/api/state`, logged only by id/size/count, and refused when the data dir is inside a git work tree. No sync/prune/GitHub path may read `local/`. Only PDFs are stored; `.pst/.ost/.msg` are never copied.
- `outlook.go` + `outlook.ps1` — classic Outlook bridge: Windows PowerShell runs the embedded script (`-EncodedCommand`, I/O as base64 UTF-8 JSON) to list stores, search mail metadata via `Folder.GetTable` DASL `LIKE`, and open a mail. Mail bodies are never returned or stored; only EntryID/StoreID/subject/sender/date/folder. PSTs are mounted into the Outlook profile with `AddStoreEx`; OSTs only via the profile's own mailbox. New Outlook and PowerShell Constrained Language Mode are unsupported (clear error).
- `platform_windows.go` / `platform_other.go` — DPAPI (`protect`/`unprotect`), `MoveFileExW` replace, `ShellExecute`, `MessageBox`, desktop shortcut via PowerShell. Non-Windows stubs exist only so tests/dev builds compile; the product is Windows-only.
- `web/` — embedded vanilla HTML/CSS/JS SPA, no external fonts or CDN (CSP forbids them). `app.js` renders four tabs — search, timeline, evidence graph (`renderGraph`, circular SVG), and the force-directed map (`renderMap`, hand-rolled simulation with drag/zoom) — plus the detail pane; the markdown renderer is a small hand-written one. Chips with `data-company`/`data-tag` are filter shortcuts; the active tab is mirrored in `location.hash`. Map palette teal/blue/amber was validated with the dataviz skill's `validate_palette.js`.
- `seed/` — embedded copy of `data/catalog.json`, `data/reports.sqlite`, and all attachments so the app works offline on first run. `build.ps1` overwrites `seed/catalog.json` from `data/catalog.json`; the SQLite and attachments are only refreshed by `import-history.py`. **Seed DB SHA-256 must match `catalog.json`'s `database.sha256` or the app refuses to start** (`ensureDatabase` at startup; `--self-test` catches this).

### Request security model (`routes()` wrapper in app.go)

Every request must: match `Host` to the bound address (DNS-rebinding guard), carry the `av_session` cookie equal to the per-process 64-hex secret (set by `/open?key=…`, `SameSite=Strict`, `HttpOnly`), and — for non-GET — be `POST` with `Origin` == server address and header `X-AV-Request: 1`. Strict CSP, no CDN, no external assets. Any new endpoint automatically inherits this; don't bypass the wrapper.

### Sync and data pinning

1. `GET /repos/{owner}/{repo}/commits/{branch}` → SHA.
2. If SHA (or origin repo) changed, fetch `data/catalog.json` **at that SHA**, `parseCatalog` → `Validate()`; on failure keep the previous snapshot untouched.
3. `ensureDatabase`: SQLite is verified by SHA-256 + `SQLite format 3\0` header and stored immutably at `databases/<sha256>.sqlite`. Attachments likewise cached at `attachments/<sha256>` on first click, resolved from embedded seed first, then GitHub at the pinned SHA.
4. `snapshot.json` written atomically; in-memory `a.snapshot` swapped under `a.mu`.

The app never writes to the catalog; it is a pure projection. Reports, events, relations, and `related` links must all come from the publisher per `docs/DATA_CONTRACT.md` (relations require `evidence` + ≥1 source + a `report_id`; attachment paths must start with `data/reports/` with no `..`).

### Data files

- `data/reports/YYYY-MM-DD/*.md|*.pptx` — original sent reports; `catalog.json` `attachments[]` carries their sha256.
- `data/catalog.json` (schema_version 1) — what the UI reads: `reports[]` (with full `body_markdown`), `events[]` (status `계획`/`보고일`/…), `entities[]`, `relations[]`, `related[]`, `database{}`.
- `data/import-audit.json` — provenance of the historical import.
- Report changes and catalog changes must land in the **same commit** (client pins a SHA).

## Conventions and constraints worth knowing

- UI strings, error messages, and docs are Korean; keep new user-facing text Korean.
- Code style is deliberately terse (short identifiers, multiple statements per line, minimal comments). Match it rather than reformatting.
- Diagnostics go through the standard `log` package; `Run()` redirects it to `app.log` in the data dir. Sync, DB, attachment and install failures are logged there — keep that up when adding failure paths. Never log tokens.
- `Version` in `internal/hub/model.go` is the single source of truth: CI reads it to name the GitHub release (`v<Version>`) and refuses a tag push whose name differs. README and `docs/RELEASE_NOTES.md` mention the version in prose and must be updated by hand.
- Sync uses `If-None-Match` with the ETag stored in `snapshot.json`; a 304 on the commits endpoint skips the catalog fetch and doesn't count against the rate limit. The daily scheduler adds a per-process 0–10 min random jitter. After a successful sync, `pruneCache` deletes unreferenced files under `databases/` and `attachments/`.
- The UI polls `GET /api/status` (small) every 4 s and fetches `GET /api/state` (full catalog) only when `commit` changes or on forced refresh.
- CI (`.github/workflows/windows.yml`) ignores pushes touching only `data/**`; daily data publishes do not need an EXE rebuild because the viewer syncs from GitHub. A rebuild is only needed when `internal/`, `cmd/`, or `web/` change, or to refresh the embedded seed.
- GitHub is read unauthenticated for the public repo (60 req/h per IP); an optional fine-grained token (Contents: read) is stored DPAPI-encrypted in `token.bin` and never logged or returned by `/api/state` (only `has_token`).
