"""Publisher regression checks; run: python -I scripts/check-import-history.py."""
import copy
from contextlib import closing
import hashlib
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("history", Path(__file__).with_name("import-history.py"))
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)
NO_UPDATE = "주요 신규 업데이트 없음"

class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.old_root = history.ROOT
        history.ROOT = self.root = Path(self.temp.name)
        self.addCleanup(setattr, history, "ROOT", self.old_root)
        (self.root/"data/reports").mkdir(parents=True)
        (self.root/"internal/hub/seed").mkdir(parents=True)
        self.cfg = dict(companies=["Waymo"], no_update_title=NO_UPDATE)
        (self.root/"data/companies.json").write_text(json.dumps(self.cfg), encoding="utf-8")

    def source(self, date, title, body="Waymo 운행 개시"):
        folder = self.root/"data/reports"/date
        folder.mkdir()
        file = folder/("daily_"+date+".md")
        file.write_text('---\ninfo: "'+title+'"\n---\n'+body, encoding="utf-8")
        return file

    def catalog(self, reports=()):
        return dict(schema_version=1, published_at="2026-10-14T00:00:00+09:00",
                    reports=list(reports), events=[], entities=[], relations=[], related=[])

    def check_outputs(self, catalog):
        published = json.loads((self.root/"data/catalog.json").read_text(encoding="utf-8"))
        self.assertEqual(published, catalog)
        self.assertEqual((self.root/"data/catalog.json").read_bytes(), (self.root/"internal/hub/seed/catalog.json").read_bytes())
        db_bytes = (self.root/"data/reports.sqlite").read_bytes()
        self.assertEqual(db_bytes, (self.root/"internal/hub/seed/reports.sqlite").read_bytes())
        self.assertEqual(hashlib.sha256(db_bytes).hexdigest(), catalog["database"]["sha256"])
        with closing(sqlite3.connect(self.root/"data/reports.sqlite")) as db:
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone(), ("ok",))
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
            payloads = [json.loads(row[0]) for row in db.execute("SELECT payload FROM reports ORDER BY date DESC")]
            self.assertEqual(payloads, catalog["reports"])
            self.assertEqual(db.execute("SELECT count(*) FROM report_search").fetchone()[0], len(payloads))

    def test_scan_next_update_and_unchanged_publish(self):
        kept = self.source("2030-01-01", "Waymo 운행 개시", NO_UPDATE+"\nWaymo 새 소식")
        self.source("2030-01-02", "  주요   신규 업데이트 없음 ")
        existing = {"2030-01-01": dict(id="2030-01-01", date="2030-01-01", title="Waymo 운행 개시",
                    summary="편집한 요약", companies=["Waymo"], tags=["과거 발송본", "운행"], sources=[])}
        records, audit = history.from_reports(existing, self.cfg)
        self.assertEqual([r["id"] for r in records], ["2030-01-01"])
        self.assertEqual([p.name for p in (self.root/"internal/hub/seed").iterdir()], [kept.name])
        catalog = self.catalog(existing.values())
        history.build(records, audit, catalog)
        self.assertEqual(catalog["reports"][0]["tags"], ["운행"])
        self.assertEqual(catalog["reports"][0]["summary"], "편집한 요약")
        self.assertIn(NO_UPDATE, catalog["reports"][0]["body_markdown"])
        self.check_outputs(catalog)
        # A future no-update report stays excluded; a real update is still added.
        self.source("2030-01-03", NO_UPDATE)
        self.source("2030-01-04", "Waymo 서비스 확대")
        existing = {r["id"]: r for r in catalog["reports"]}
        records, audit = history.from_reports(existing, self.cfg)
        history.build(records, audit, catalog)
        self.assertEqual([r["id"] for r in catalog["reports"]], ["2030-01-04", "2030-01-01"])
        self.check_outputs(catalog)
        before = [(self.root/p).read_bytes() for p in ["data/catalog.json", "data/reports.sqlite"]]
        records, audit = history.from_reports({r["id"]: r for r in catalog["reports"]}, self.cfg)
        history.build(records, audit, catalog, if_changed=True)
        self.assertEqual(before, [(self.root/p).read_bytes() for p in ["data/catalog.json", "data/reports.sqlite"]])

    def test_remove_old_report_and_references(self):
        self.source("2030-01-01", "Waymo 운행")
        records, audit = history.from_reports({}, self.cfg)
        empty = dict(records[0], id="2030-01-02", date="2030-01-02", title=NO_UPDATE)
        catalog = self.catalog([records[0], empty])
        catalog["entities"] = [dict(id="a", label="A", kind="기업"), dict(id="b", label="B", kind="기업")]
        catalog["events"] = [dict(id="empty-event", report_id=empty["id"], date=empty["date"], status="보고일")]
        catalog["relations"] = [dict(id="empty-relation", report_id=empty["id"], **{"from":"a", "to":"b"}, evidence="old")]
        catalog["related"] = [dict(**{"from":records[0]["id"], "to":empty["id"]}, reason="old")]
        original = copy.deepcopy(catalog)
        history.build(records+[empty], audit+[dict(date=empty["id"])], catalog)
        self.assertEqual(len(catalog["reports"]), 1)
        self.assertEqual(len(catalog["events"]), 1)  # regenerated archive for retained report
        self.assertEqual(catalog["relations"], [])
        self.assertEqual(catalog["related"], [])
        self.assertEqual(original["reports"][1]["title"], NO_UPDATE)
        self.assertEqual(json.loads((self.root/"data/import-audit.json").read_text(encoding="utf-8"))["count"], 1)
        self.check_outputs(catalog)

    def test_manifest_skips_before_attachment_lookup(self):
        manifest = [dict(subject="2030-01-02 - "+NO_UPDATE, attachments=[dict(name="missing.md", size=5)])]
        self.assertEqual(history.from_manifest(self.root, manifest, {}, self.cfg), ([], []))
        edited = {"2030-01-02": dict(title=NO_UPDATE)}
        manifest[0]["subject"] = "2030-01-02 - 이전 제목"
        self.assertEqual(history.from_manifest(self.root, manifest, edited, self.cfg), ([], []))

    def test_all_excluded_and_missing_inputs(self):
        with self.assertRaises(SystemExit):
            history.from_reports({}, self.cfg)
        self.source("2030-01-01", NO_UPDATE)
        records, audit = history.from_reports({}, self.cfg)
        catalog = self.catalog()
        history.build(records, audit, catalog)
        self.assertEqual(catalog["reports"], [])
        self.check_outputs(catalog)
        with self.assertRaises(SystemExit):
            history.from_manifest(self.root, [], {}, self.cfg)

if __name__ == "__main__":
    unittest.main()
