"""Real PDF text/coordinates and local API tests, without loading an AI model."""
import hashlib
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import numpy as np

import embed_core as ec
import pdf_highlights as highlight
import rag_server as server


def pdf_bytes(rotation=0, crop=False, blank=False, korean=False):
    # Two-page, standards-based fixture with a real searchable text layer.
    stream = b'' if blank else b'BT /F1 24 Tf 60 700 Td (Robotaxi permits) Tj 0 -40 Td (robotaxi routes) Tj ET'
    font = b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    if korean:
        stream = ('BT /F1 24 Tf 60 700 Td <'+ '무인 운행 허가'.encode('utf-16-be').hex()+'> Tj ET').encode()
        font = b'<< /Type /Font /Subtype /Type0 /BaseFont /HYSMyeongJo-Medium /Encoding /UniKS-UCS2-H /DescendantFonts [8 0 R] >>'
    cropbox = b' /CropBox [30 50 560 760]' if crop else b''
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>', font]
    for content in (stream, b'BT /F1 24 Tf 60 700 Td (Different page) Tj ET'):
        contents_id = len(objects) + 2
        objects.append(b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]'+cropbox+
                       f' /Rotate {rotation} /Resources << /Font << /F1 3 0 R >> >> /Contents {contents_id} 0 R >>'.encode())
        objects.append(f'<< /Length {len(content)} >>\nstream\n'.encode()+content+b'\nendstream')
    if korean:
        objects.append(b'<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYSMyeongJo-Medium /CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 1 >> /DW 1000 >>')
    output = bytearray(b'%PDF-1.4\n');offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(output));output.extend(f'{index} 0 obj\n'.encode()+obj+b'\nendobj\n')
    xref = len(output)
    output.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]:
        output.extend(f'{offset:010d} 00000 n \n'.encode())
    output.extend(f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF'.encode())
    return bytes(output)


class HighlightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.path = self.root / 'fixture.pdf'

    def tearDown(self):
        self.temp.cleanup()

    def test_text_boxes_align_with_rendered_ink_at_every_rotation_and_crop(self):
        for rotation in (0, 90, 180, 270):
            for crop in (False, True):
                with self.subTest(rotation=rotation, crop=crop):
                    original = pdf_bytes(rotation, crop)
                    self.path.write_bytes(original)
                    result = highlight.page_highlights(self.path, 1, 'ROBOTAXI?')
                    self.assertEqual(result['matches'], 2)
                    self.assertEqual(len(result['rects']), 2)
                    pages = ec.pdf_pages(self.path)
                    try:
                        _, image = next(pages)
                    finally:
                        pages.close()
                    for rect in result['rects']:
                        self.assertTrue(0 <= rect['x'] < rect['x']+rect['width'] <= 1.00001)
                        self.assertTrue(0 <= rect['y'] < rect['y']+rect['height'] <= 1.00001)
                        x, y, w, h = (rect[k] for k in ('x', 'y', 'width', 'height'))
                        pixels = image.crop((round(x*image.width), round(y*image.height), round((x+w)*image.width), round((y+h)*image.height))).convert('L')
                        self.assertLess(pixels.getextrema()[0], 80, 'highlight contains the rendered letters')
                        self.assertLess(w*h, .02, 'highlight covers a word, not an arbitrary page region')
                    self.assertEqual(self.path.read_bytes(), original)

    def test_korean_text_and_multiple_terms(self):
        self.path.write_bytes(pdf_bytes(korean=True))
        result = highlight.page_highlights(self.path, 1, '무인 운행')
        self.assertEqual(result['matches'], 2)
        self.assertEqual(len(result['rects']), 2)

    def test_highlight_can_run_between_indexed_pages(self):
        self.path.write_bytes(pdf_bytes())
        pages = ec.pdf_pages(self.path)
        next(pages)
        results = []
        worker = threading.Thread(target=lambda: results.append(highlight.page_highlights(self.path, 1, 'Robotaxi')))
        try:
            worker.start()
            worker.join(3)
            self.assertFalse(worker.is_alive(), 'index embedding must not keep PDFium locked')
            self.assertEqual(results[0]['matches'], 2)
        finally:
            pages.close()
            worker.join(3)

    def test_no_match_no_text_and_literal_special_characters(self):
        self.path.write_bytes(pdf_bytes())
        self.assertEqual(highlight.page_highlights(self.path, 1, 'notpresent')['reason'], 'no_match')
        self.assertEqual(highlight.page_highlights(self.path, 2, 'robotaxi')['reason'], 'no_match')
        self.assertEqual(highlight.page_highlights(self.path, 1, '.*')['matches'], 0)
        self.path.write_bytes(pdf_bytes(blank=True))
        self.assertEqual(highlight.page_highlights(self.path, 1, 'robotaxi')['reason'], 'no_text')
        self.assertEqual(highlight.query_terms('무인 운행? C++ 무인'), ['무인', '운행', 'C++'])

    def test_local_api_legacy_index_and_missing_source(self):
        key = hashlib.sha256(pdf_bytes()).hexdigest()[:16]
        (self.root / (key+'.pdf')).write_bytes(pdf_bytes())
        with patch.object(server, 'DOCS', self.root), patch.dict(server.state, docs={key:{'name':'fixture.pdf','pages':2}}, vecs={key:np.array([[1.,0.],[0.,1.]])}), patch.object(ec, 'embed_query', return_value=np.array([1.,0.])):
            hits = server.query('robotaxi')
            self.assertEqual(hits[0]['highlight']['matches'], 2)
            self.assertEqual(hits[1]['highlight']['reason'], 'no_match')
            server.H.key = 'local-test-only'
            http = server.Server(('127.0.0.1', 0), server.H)
            thread = threading.Thread(target=http.serve_forever, daemon=True);thread.start()
            address = f'http://127.0.0.1:{http.server_port}/highlights'
            def request(payload, auth=True):
                return urlopen(Request(address, data=json.dumps(payload).encode(), headers={'X-RAG-Key':'local-test-only'} if auth else {}), timeout=5)
            try:
                with request({'doc':key,'page':1,'text':'robotaxi'}) as response:
                    self.assertEqual(json.load(response)['matches'], 2)
                for payload, code in [({'doc':key,'page':1,'text':'robotaxi'},403), ({'doc':'../escape','page':1,'text':'a'},400), ({'doc':key,'page':0,'text':'a'},400), ({'doc':key,'page':3,'text':'a'},400)]:
                    with self.assertRaises(HTTPError) as error:
                        request(payload, auth=code!=403)
                    self.assertEqual(error.exception.code, code)
                (self.root / (key+'.pdf')).unlink()
                self.assertEqual(server.highlights(key, 1, 'robotaxi')['reason'], 'unavailable')
                server.state['docs'][key]['kind'] = 'image'
                self.assertEqual(server.highlights(key, 1, 'robotaxi')['reason'], 'image')
            finally:
                http.shutdown();http.server_close();thread.join()


if __name__ == '__main__':
    unittest.main()
