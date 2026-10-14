"""Publisher-side import. End users do not need Python or SQLite installed."""
import argparse, hashlib, json, re, shutil, sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def build(workspace, manifest):
    catalog = json.loads((ROOT/'data/catalog.json').read_text())
    existing = {r['id']: r for r in catalog['reports']}
    records, audit = [], []
    companies = ['Uber','Avride','Bolt','Mobileye','카카오모빌리티','쏘카','May Mobility','Waymo','Tesla','Zoox','Kodiak','Einride','NVIDIA','Mercedes','Wayve','Lucid','Momenta','Volvo','Waabi','Aurora','Pony.ai','WeRide','현대자동차','Faraday Future']
    for email in manifest:
        match = re.search(r'(\d{4}-\d{2}-\d{2}) - (.+)', email['subject'])
        if not match: continue
        date, title = match.groups()
        if any(r['id'] == date for r in records): raise ValueError('Duplicate date '+date)
        folder = workspace/('report-output' if date=='2026-09-20' else f'daily-{date}/output')
        attachments = []
        for att in email['attachments']:
            source=folder/att['name']
            recovered=ROOT/'build/mail-attachments'/att['name']
            if recovered.exists():source=recovered
            if not source.exists() or source.stat().st_size != att['size']:
                raise ValueError(f'Attachment name/size mismatch: {source}')
            dest=ROOT/'data/reports'/date/att['name'];dest.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(source,dest)
            shutil.copyfile(source,ROOT/'internal/hub/seed'/att['name'])
            attachments.append(dict(name=att['name'],path=dest.relative_to(ROOT).as_posix(),sha256=hashlib.sha256(source.read_bytes()).hexdigest()))
        attachments.sort(key=lambda a: 0 if a['name'].endswith('.md') else 1)
        body=(folder/f'autonomous_driving_daily_{date}.md').read_text()
        urls=list(dict.fromkeys(re.findall(r'https?://[^\s<>\)\]]+',body)))
        sources=[dict(title=u.split('/')[2],url=u.rstrip('.,')) for u in urls]
        bullets=[]
        for line in body.splitlines():
            if line.startswith('- ') or line.startswith('* '):
                text=re.sub(r'\[([^\]]+)\]\([^\)]+\)',r'\1',line[2:]).replace('**','')
                if 'http' not in text and len(text)>25: bullets.append(text)
            if len(bullets)==2:break
        report=existing.get(date,dict(id=date,date=date,title=title,summary=' '.join(bullets)[:420],companies=[c for c in companies if c.lower() in body.lower()],tags=['과거 발송본','신규 없음' if title=='주요 신규 업데이트 없음' else '동향']))
        report.update(body_markdown=body,attachments=attachments)
        if date not in existing:report['sources']=sources
        records.append(report)
        audit.append(dict(date=date,title=title,verification='Gmail SENT 제목·첨부 파일명·바이트 크기 대조; 로컬 원본 보관',attachments=attachments))
    catalog['reports']=sorted(records,key=lambda r:r['date'],reverse=True)
    # A report date is not an event date. Archive entries are explicitly labelled.
    catalog['events']=[e for e in catalog['events'] if not e['id'].startswith('archive-')]
    for r in records:
        if r['id']=='2026-10-14':continue
        catalog['events'].append(dict(id='archive-'+r['id'],date=r['date'],title=r['title'],status='보고일',report_id=r['id'],detail='해당 날짜 발송본의 보관 기록입니다. 사건 발생일 또는 계획 달성일을 뜻하지 않습니다.',companies=r['companies'],sources=r['sources'][:2]))
    dbpath=ROOT/'data/reports.sqlite';dbpath.unlink(missing_ok=True)
    db=sqlite3.connect(dbpath)
    db.executescript('''
    PRAGMA foreign_keys=ON;
    CREATE TABLE reports(id TEXT PRIMARY KEY,date TEXT NOT NULL,title TEXT NOT NULL,summary TEXT NOT NULL,body_markdown TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE sources(report_id TEXT REFERENCES reports(id),title TEXT,url TEXT);
    CREATE TABLE attachments(report_id TEXT REFERENCES reports(id),name TEXT,path TEXT,sha256 TEXT,PRIMARY KEY(report_id,name));
    CREATE TABLE entities(id TEXT PRIMARY KEY,label TEXT,kind TEXT);
    CREATE TABLE events(id TEXT PRIMARY KEY,report_id TEXT REFERENCES reports(id),date TEXT,status TEXT,payload TEXT);
    CREATE TABLE relations(id TEXT PRIMARY KEY,report_id TEXT REFERENCES reports(id),source_id TEXT REFERENCES entities(id),target_id TEXT REFERENCES entities(id),evidence TEXT,payload TEXT);
    CREATE TABLE related(from_id TEXT REFERENCES reports(id),to_id TEXT REFERENCES reports(id),reason TEXT);
    CREATE VIRTUAL TABLE report_search USING fts5(report_id UNINDEXED,title,summary,body_markdown,tokenize='trigram');
    ''')
    for r in catalog['reports']:
        db.execute('INSERT INTO reports VALUES(?,?,?,?,?,?)',(r['id'],r['date'],r['title'],r['summary'],r['body_markdown'],json.dumps(r,ensure_ascii=False)))
        db.execute('INSERT INTO report_search VALUES(?,?,?,?)',(r['id'],r['title'],r['summary'],r['body_markdown']))
        db.executemany('INSERT INTO sources VALUES(?,?,?)',[(r['id'],s['title'],s['url']) for s in r['sources']])
        db.executemany('INSERT INTO attachments VALUES(?,?,?,?)',[(r['id'],a['name'],a['path'],a['sha256']) for a in r['attachments']])
    for e in catalog['entities']:db.execute('INSERT INTO entities VALUES(?,?,?)',(e['id'],e['label'],e['kind']))
    for e in catalog['events']:db.execute('INSERT INTO events VALUES(?,?,?,?,?)',(e['id'],e['report_id'],e['date'],e['status'],json.dumps(e,ensure_ascii=False)))
    for r in catalog['relations']:db.execute('INSERT INTO relations VALUES(?,?,?,?,?,?)',(r['id'],r['report_id'],r['from'],r['to'],r['evidence'],json.dumps(r,ensure_ascii=False)))
    for r in catalog['related']:db.execute('INSERT INTO related VALUES(?,?,?)',(r['from'],r['to'],r['reason']))
    db.commit()
    assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    assert not db.execute('PRAGMA foreign_key_check').fetchall()
    assert db.execute("SELECT count(*) FROM report_search WHERE report_search MATCH 'Tesla'").fetchone()[0]>0
    assert db.execute("SELECT count(*) FROM reports WHERE body_markdown LIKE '%학교구역%'").fetchone()[0]>0
    # Viewer projection is exported from DB, so it is the same tested archive.
    catalog['reports']=[json.loads(row[0]) for row in db.execute('SELECT payload FROM reports ORDER BY date DESC')]
    db.close()
    catalog['database']=dict(name='reports.sqlite',path='data/reports.sqlite',sha256=hashlib.sha256(dbpath.read_bytes()).hexdigest())
    for p in [ROOT/'data/catalog.json',ROOT/'internal/hub/seed/catalog.json']:p.write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n')
    shutil.copyfile(dbpath,ROOT/'internal/hub/seed/reports.sqlite')
    (ROOT/'data/import-audit.json').write_text(json.dumps(dict(count=len(records),from_date=min(r['date'] for r in records),through_date=max(r['date'] for r in records),records=audit),ensure_ascii=False,indent=2)+'\n')
    print(f'Imported {len(records)} reports, {sum(len(r["attachments"]) for r in records)} attachments. SQLite integrity, foreign keys and English/Korean searches passed.')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--workspace',type=Path,required=True);p.add_argument('--manifest',type=Path,required=True);a=p.parse_args();build(a.workspace,json.loads(a.manifest.read_text()))
