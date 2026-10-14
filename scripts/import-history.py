"""Publisher-side import. End users do not need Python or SQLite installed.

Two input modes:
  --from-reports            scan data/reports/YYYY-MM-DD/ (what GitHub Actions runs daily)
  --workspace/--manifest    legacy bulk import from a local report workspace + sent-mail manifest
Both rebuild data/reports.sqlite, data/catalog.json, internal/hub/seed/* and data/import-audit.json.
Existing report ids keep their edited summary/companies/tags/sources; only body and attachments are refreshed.
"""
import argparse, hashlib, json, re, shutil, sqlite3, sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
KST = timezone(timedelta(hours=9))
DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')

def settings():
    return json.loads((ROOT/'data/companies.json').read_text(encoding='utf-8'))

def frontmatter(body):
    m = re.match(r'^---\r?\n(.*?)\r?\n---', body, re.S)
    out = {}
    if m:
        for line in m.group(1).splitlines():
            k, sep, v = line.partition(':')
            if sep: out[k.strip()] = v.strip().strip('"\'')
    return out

# Mirror of substantive() in internal/hub/web/app.js: a company is tagged only if it appears outside
# "no news" lines ("Avride·Bolt…는 신규 확인 사항 없음"), reference entries and URLs. Keep both in sync.
NO_NEWS = re.compile(r'없음|없었다|없다\.|미확인|확인되지 않았다|반복하지 않았다|다루지 않았다|제외|점검 출처|Official Site|공식 사이트|공식 뉴스|뉴스룸|Newsroom', re.I)
URL = re.compile(r'https?://\S+')
REF_LINE = re.compile(r'^\s*(-\s*)?\[R?\d+\]|^\s*\d+\.\s|^\s*\*{0,2}(출처|References?|참고|Reference)\s*\*{0,2}\s*[:：]', re.I)

def substantive(text):
    lines = text.splitlines()
    keep = []
    for i, l in enumerate(lines):
        nxt = lines[i + 1] if i + 1 < len(lines) else ''
        if URL.search(l) and REF_LINE.search(l): continue
        if re.match(r'^\s*\d+\.\s', l) and re.match(r'^\s*https?://', nxt): continue
        if re.match(r'^\s*(-\s*)?\[R?\d+\]', l): continue
        if NO_NEWS.search(URL.sub('', l)): continue
        keep.append(URL.sub('', l))
    return '\n'.join(keep).lower()

def mentioned(cfg, title, body):
    low = title.lower() + '\n' + substantive(body)
    return [c for c in cfg['companies'] if c.lower() in low]

def derive(date, title, body, existing, cfg):
    if date in existing:
        return dict(existing[date])
    urls = list(dict.fromkeys(re.findall(r'https?://[^\s<>\)\]]+', body)))
    sources = [dict(title=u.split('/')[2], url=u.rstrip('.,')) for u in urls]
    bullets = []
    for line in body.splitlines():
        if line.startswith('- ') or line.startswith('* '):
            text = re.sub(r'\[([^\]]+)\]\([^\)]+\)', r'\1', line[2:]).replace('**', '')
            if 'http' not in text and len(text) > 25: bullets.append(text)
        if len(bullets) == 2: break
    return dict(id=date, date=date, title=title, summary=' '.join(bullets)[:420],
                companies=mentioned(cfg, title, body),
                tags=['신규 없음' if title == cfg['no_update_title'] else '동향'], sources=sources)

def att_entry(source, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    if source.resolve() != dest.resolve(): shutil.copyfile(source, dest)
    shutil.copyfile(source, ROOT/'internal/hub/seed'/dest.name)
    return dict(name=dest.name, path=dest.relative_to(ROOT).as_posix(), sha256=hashlib.sha256(source.read_bytes()).hexdigest())

def from_reports(existing, cfg):
    records, audit = [], []
    prior = {}
    try: prior = {a['date']: a.get('verification', '') for a in json.loads((ROOT/'data/import-audit.json').read_text(encoding='utf-8'))['records']}
    except Exception: pass
    for folder in sorted(p for p in (ROOT/'data/reports').iterdir() if p.is_dir() and DATE.match(p.name)):
        date = folder.name
        mds = sorted(folder.glob('*.md'))
        if not mds:
            print(f'skip {date}: no .md', file=sys.stderr); continue
        if len(mds) > 1:
            print(f'warning {date}: {len(mds)} .md files, using {mds[0].name} as the body (all are attached)', file=sys.stderr)
        body = mds[0].read_text(encoding='utf-8')
        fm = frontmatter(body)
        title = (existing.get(date) or {}).get('title') or fm.get('info') or fm.get('title') or f'자율주행 데일리 리포트 {date}'
        files = mds + sorted(folder.glob('*.pptx'))
        attachments = [att_entry(f, f) for f in files]
        r = derive(date, title, body, existing, cfg)
        r.update(body_markdown=body, attachments=attachments)
        records.append(r)
        audit.append(dict(date=date, title=title, verification=prior.get(date) or 'data/reports 폴더 스캔; SHA-256 기록', attachments=attachments))
    return records, audit

def from_manifest(workspace, manifest, existing, cfg):
    records, audit = [], []
    for email in manifest:
        match = re.search(r'(\d{4}-\d{2}-\d{2}) - (.+)', email['subject'])
        if not match: continue
        date, title = match.groups()
        if any(r['id'] == date for r in records): raise ValueError('Duplicate date '+date)
        folder = workspace/('report-output' if date == '2026-09-20' else f'daily-{date}/output')
        attachments = []
        for att in email['attachments']:
            source = folder/att['name']
            recovered = ROOT/'build/mail-attachments'/att['name']
            if recovered.exists(): source = recovered
            if not source.exists() or source.stat().st_size != att['size']:
                raise ValueError(f'Attachment name/size mismatch: {source}')
            attachments.append(att_entry(source, ROOT/'data/reports'/date/att['name']))
        attachments.sort(key=lambda a: 0 if a['name'].endswith('.md') else 1)
        body = (folder/f'autonomous_driving_daily_{date}.md').read_text(encoding='utf-8')
        r = derive(date, title, body, existing, cfg)
        r.update(body_markdown=body, attachments=attachments)
        records.append(r)
        audit.append(dict(date=date, title=title, verification='Gmail SENT 제목·첨부 파일명·바이트 크기 대조; 로컬 원본 보관', attachments=attachments))
    return records, audit

def build(records, audit, catalog, if_changed=False):
    if not records: raise SystemExit('no reports found')
    before = {k: v for k, v in catalog.items() if k not in ('published_at', 'database')}
    catalog['reports'] = sorted(records, key=lambda r: r['date'], reverse=True)
    # A report date is not an event date. Archive entries are explicitly labelled and only added
    # for reports that have no curated (non-archive) event of their own.
    curated = {e['report_id'] for e in catalog['events'] if not e['id'].startswith('archive-')}
    catalog['events'] = [e for e in catalog['events'] if not e['id'].startswith('archive-')]
    for r in catalog['reports']:
        if r['id'] in curated: continue
        catalog['events'].append(dict(id='archive-'+r['id'], date=r['date'], title=r['title'], status='보고일', report_id=r['id'],
            detail='해당 날짜 발송본의 보관 기록입니다. 사건 발생일 또는 계획 달성일을 뜻하지 않습니다.', companies=r['companies'], sources=r['sources'][:2]))
    ids = {r['id'] for r in records}
    for x in catalog['relations']:
        if x['report_id'] not in ids: raise ValueError(f'relation {x["id"]} references missing report {x["report_id"]}')
    dbpath = ROOT/'data/reports.sqlite'; tmp = dbpath.with_suffix('.tmp'); tmp.unlink(missing_ok=True)
    db = sqlite3.connect(tmp)
    db.executescript('''
    CREATE TABLE reports(id TEXT PRIMARY KEY,date TEXT,title TEXT,summary TEXT,body_markdown TEXT,payload TEXT);
    CREATE TABLE sources(report_id TEXT REFERENCES reports(id),title TEXT,url TEXT);
    CREATE TABLE attachments(report_id TEXT REFERENCES reports(id),name TEXT,path TEXT,sha256 TEXT);
    CREATE TABLE entities(id TEXT PRIMARY KEY,label TEXT,kind TEXT);
    CREATE TABLE events(id TEXT PRIMARY KEY,report_id TEXT REFERENCES reports(id),date TEXT,status TEXT,payload TEXT);
    CREATE TABLE relations(id TEXT PRIMARY KEY,report_id TEXT REFERENCES reports(id),from_id TEXT REFERENCES entities(id),to_id TEXT REFERENCES entities(id),evidence TEXT,payload TEXT);
    CREATE TABLE related(from_id TEXT REFERENCES reports(id),to_id TEXT REFERENCES reports(id),reason TEXT);
    CREATE VIRTUAL TABLE report_search USING fts5(report_id UNINDEXED,title,summary,body_markdown,tokenize='trigram');
    ''')
    for r in catalog['reports']:
        db.execute('INSERT INTO reports VALUES(?,?,?,?,?,?)', (r['id'], r['date'], r['title'], r['summary'], r['body_markdown'], json.dumps(r, ensure_ascii=False)))
        db.execute('INSERT INTO report_search VALUES(?,?,?,?)', (r['id'], r['title'], r['summary'], r['body_markdown']))
        db.executemany('INSERT INTO sources VALUES(?,?,?)', [(r['id'], s['title'], s['url']) for s in r['sources']])
        db.executemany('INSERT INTO attachments VALUES(?,?,?,?)', [(r['id'], a['name'], a['path'], a['sha256']) for a in r['attachments']])
    for e in catalog['entities']: db.execute('INSERT INTO entities VALUES(?,?,?)', (e['id'], e['label'], e['kind']))
    for e in catalog['events']: db.execute('INSERT INTO events VALUES(?,?,?,?,?)', (e['id'], e['report_id'], e['date'], e['status'], json.dumps(e, ensure_ascii=False)))
    for r in catalog['relations']: db.execute('INSERT INTO relations VALUES(?,?,?,?,?,?)', (r['id'], r['report_id'], r['from'], r['to'], r['evidence'], json.dumps(r, ensure_ascii=False)))
    for r in catalog['related']: db.execute('INSERT INTO related VALUES(?,?,?)', (r['from'], r['to'], r['reason']))
    db.commit()
    assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    assert not db.execute('PRAGMA foreign_key_check').fetchall()
    probe = next((c for r in catalog['reports'] for c in r['companies']), None)
    if probe: assert db.execute('SELECT count(*) FROM report_search WHERE report_search MATCH ?', ('"%s"' % probe,)).fetchone()[0] > 0
    # Viewer projection is exported from DB, so it is the same tested archive.
    catalog['reports'] = [json.loads(row[0]) for row in db.execute('SELECT payload FROM reports ORDER BY date DESC')]
    db.close()
    after = {k: v for k, v in catalog.items() if k not in ('published_at', 'database')}
    if if_changed and after == before and dbpath.exists() and hashlib.sha256(dbpath.read_bytes()).hexdigest() == catalog.get('database', {}).get('sha256'):
        tmp.unlink(); print('No report changes; catalog and database left untouched.'); return
    tmp.replace(dbpath)
    catalog['database'] = dict(name='reports.sqlite', path='data/reports.sqlite', sha256=hashlib.sha256(dbpath.read_bytes()).hexdigest())
    catalog['published_at'] = datetime.now(KST).replace(microsecond=0).isoformat()
    for p in [ROOT/'data/catalog.json', ROOT/'internal/hub/seed/catalog.json']:
        p.write_text(json.dumps(catalog, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    shutil.copyfile(dbpath, ROOT/'internal/hub/seed/reports.sqlite')
    (ROOT/'data/import-audit.json').write_text(json.dumps(dict(count=len(records), from_date=min(r['date'] for r in records), through_date=max(r['date'] for r in records), records=audit), ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(f'Imported {len(records)} reports, {sum(len(r["attachments"]) for r in records)} attachments. SQLite integrity, foreign keys and search passed.')

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--from-reports', action='store_true', help='scan data/reports/YYYY-MM-DD/')
    p.add_argument('--workspace', type=Path); p.add_argument('--manifest', type=Path)
    p.add_argument('--if-changed', action='store_true', help='do not rewrite outputs when the report set is unchanged')
    a = p.parse_args()
    catalog = json.loads((ROOT/'data/catalog.json').read_text(encoding='utf-8'))
    existing = {r['id']: r for r in catalog['reports']}
    cfg = settings()
    if a.from_reports:
        records, audit = from_reports(existing, cfg)
    elif a.workspace and a.manifest:
        records, audit = from_manifest(a.workspace, json.loads(a.manifest.read_text(encoding='utf-8')), existing, cfg)
    else:
        p.error('use --from-reports, or --workspace with --manifest')
    build(records, audit, catalog, a.if_changed)
