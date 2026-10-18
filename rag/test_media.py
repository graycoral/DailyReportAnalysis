"""Media indexing/graph regression tests. No model download or user files required."""
import io
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

import numpy as np
from PIL import Image

import embed_core as ec
import media
import rag_server as server


def encoded(fmt="PNG", color="red", **kwargs):
    output = io.BytesIO()
    Image.new("RGB", (32, 24), color).save(output, fmt, **kwargs)
    return output.getvalue()


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patches = [patch.object(ec, "INDEX_DIR", self.root), patch.object(server, "DOCS", self.root / "docs"),
                        patch.object(server, "META", self.root / "index.json"),
                        patch.object(ec, "embed_image", return_value=(np.array([1., 0., 0.]), 0.01)),
                        patch.object(ec, "embed_query", return_value=np.array([1., 0., 0.]))]
        for p in self.patches:
            p.start()
        server.state.update(docs={}, vecs={}, model=None, info={"model": "test"}, revision=0, map_cache=None, pair_cache={})
        server.jobs = server.Jobs()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def test_formats_decode_and_keep_original(self):
        for fmt in ("PNG", "JPEG", "WEBP", "GIF", "BMP", "TIFF", "AVIF", "HEIF", "ICO", "PDF"):
            with self.subTest(fmt=fmt):
                data = encoded(fmt)
                key, meta, created = server.index_file("자료." + fmt.lower(), data)
                self.assertTrue(created)
                self.assertEqual(meta["kind"], "pdf" if fmt == "PDF" else "image")
                self.assertEqual((server.DOCS / (key + meta["extension"])).read_bytes(), data)
                self.assertTrue((server.DOCS / f"{key}-1.png").exists())
                self.assertEqual(server.index_file("duplicate", data)[2], False)
                self.assertEqual(server.query("query")[0]["page"], 1)

    def test_transparency_and_exif(self):
        target = self.root / "transparent.png"
        Image.new("RGBA", (10, 20), (0, 0, 0, 0)).save(target)
        image = next(media.pages(target, media.describe(target.read_bytes())))[1]
        self.assertEqual(image.getpixel((0, 0)), (255, 255, 255))
        exif = Image.Exif()
        exif[274] = 6
        target = self.root / "rotated.jpg"
        Image.new("RGB", (10, 20), "red").save(target, exif=exif)
        image = next(media.pages(target, media.describe(target.read_bytes())))[1]
        self.assertEqual(image.size, (20, 10))

    def test_tiff_all_pages_and_animation_first_frame(self):
        for fmt, expected in (("TIFF", 2), ("GIF", 1), ("WEBP", 1)):
            data = encoded(fmt, save_all=True, append_images=[Image.new("RGB", (32, 24), "blue")])
            _, meta, _ = server.index_file("multi." + fmt.lower(), data)
            self.assertEqual(meta["pages"], expected)

    def test_invalid_files_and_failed_embedding_leave_no_index(self):
        for data in (b"<svg></svg>", b"not an image", b"%PDF-broken"):
            with self.assertRaises(Exception):
                server.index_file("fake.png", data)
        with patch.object(ec, "embed_image", side_effect=RuntimeError("test inference failure")):
            with self.assertRaises(RuntimeError):
                server.index_file("valid.png", encoded())
        self.assertEqual(server.state["docs"], {})
        self.assertFalse(list(server.DOCS.glob("*")))
        self.assertFalse(list(self.root.glob("upload-*")))

    def test_map_has_source_pages_and_excludes_unrelated_documents(self):
        server.state["docs"] = {"a": {"name": "a.pdf", "pages": 2}, "b": {"name": "b.png", "pages": 1},
                                "c": {"name": "unrelated.png", "pages": 1}}
        server.state["vecs"] = {"a": np.array([[0., 1., 0.], [1., 0., 0.]]), "b": np.array([[1., 0., 0.]]),
                                "c": np.array([[0., 0., 1.]])}
        result = server.map_data()
        self.assertEqual(len(result["docs"]), 3)
        self.assertEqual(result["links"], [{"from": "a", "to": "b", "from_page": 2, "to_page": 1,
                                            "similarity": 1.0, "kind": "similarity"}])
        self.assertEqual(result["method"], "max_page_cosine")

    def test_legacy_pdf_index_loads(self):
        server.META.write_text(json.dumps({"old": {"name": "legacy.pdf", "pages": 1}}))
        np.save(self.root / "old.npy", np.array([[1., 0., 0.]]))
        server.load_index()
        self.assertEqual(server.map_data()["docs"][0]["name"], "legacy.pdf")
        self.assertEqual(server.query("old")[0]["kind"], "pdf")

    def test_http_auth_unicode_filename_delete_and_map_refresh(self):
        server.H.key = "test-only"
        http = server.Server(("127.0.0.1", 0), server.H)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        address = f"http://127.0.0.1:{http.server_port}"
        def request(path, body=None, headers=None):
            with urlopen(Request(address + path, data=body, headers={"X-RAG-Key": "test-only", **(headers or {})}), timeout=5) as response:
                value = json.load(response)
            deadline = time.monotonic() + 10
            while "job" in value:
                if value["state"] == "done":
                    return value["result"]
                if value["state"] == "error":
                    raise AssertionError(value["error"])
                self.assertLess(time.monotonic(), deadline)
                time.sleep(.01)
                with urlopen(Request(address + "/jobs?id=" + value["job"], headers={"X-RAG-Key": "test-only"}), timeout=5) as response:
                    value = json.load(response)
            return value
        try:
            with self.assertRaises(HTTPError) as rejected:
                urlopen(address + "/map", timeout=5)
            self.assertEqual(rejected.exception.code, 403)
            self.assertEqual(request("/map")["docs"], [])
            first = request("/index", encoded(), {"X-File-Name": quote("테스트 100%.png"), "X-File-Name-Encoding": "percent-utf8"})
            second = request("/index", encoded(color="blue"), {"X-File-Name": "blue.png"})
            self.assertEqual(first["name"], "테스트 100%.png")
            self.assertEqual(len(request("/map")["links"]), 1)
            request("/delete", json.dumps({"doc": first["id"]}).encode())
            result = request("/map")
            self.assertEqual([d["id"] for d in result["docs"]], [second["id"]])
            self.assertEqual(result["links"], [])
            self.assertFalse(list(server.DOCS.glob(first["id"] + "*")))
        finally:
            http.shutdown()
            http.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
