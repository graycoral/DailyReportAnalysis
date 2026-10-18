"""Locate literal query text on a PDF page. No inference, OCR or source edits."""
import ctypes
import math

import pypdfium2 as pdfium
import pypdfium2.raw as raw

import embed_core as ec

MAX_RECTS = 300


def query_terms(text):
    # Search literal words, preserving characters such as '+' in product names.
    words = [word.strip('.,!?;:"\'()[]{}<>“”‘’。！？') for word in text[:2000].split()]
    return list(dict.fromkeys(word for word in words if word and len(word) <= 128))[:32]


def page_highlights(path, page_number, text):
    terms = query_terms(text)
    result = {"source": "pdf_text", "rects": [], "matches": 0, "truncated": False}
    if not terms:
        return {**result, "reason": "no_match"}
    # PDFium requires serialized calls, including the index renderer:
    # https://pypdfium2.readthedocs.io/en/stable/python_api.html#incompatibility-with-threading
    with ec.PDF_LOCK, pdfium.PdfDocument(str(path)) as document:
        page = document[page_number - 1]
        try:
            textpage = page.get_textpage()
            try:
                if not textpage.count_chars():
                    return {**result, "reason": "no_text"}
                width = math.ceil(page.get_width() * ec.RENDER_SCALE)
                height = math.ceil(page.get_height() * ec.RENDER_SCALE)

                def point(x, y):
                    dx, dy = ctypes.c_int(), ctypes.c_int()
                    if not raw.FPDF_PageToDevice(page, 0, 0, width, height, 0, x, y,
                                                ctypes.byref(dx), ctypes.byref(dy)):
                        raise ValueError("Cannot map PDF text to page image")
                    return dx.value / width, dy.value / height

                seen, ranges = set(), set()
                textpage.count_rects()
                for term in terms:
                    search = textpage.search(term, match_case=False)
                    try:
                        while True:
                            match = search.get_next()
                            if match is None:
                                break
                            if match in ranges:
                                continue
                            ranges.add(match)
                            result["matches"] += 1
                            for index in range(textpage.count_rects(*match)):
                                left, bottom, right, top = textpage.get_rect(index)
                                points = [point(x, y) for x in (left, right) for y in (bottom, top)]
                                x0, x1 = max(0, min(p[0] for p in points)), min(1, max(p[0] for p in points))
                                y0, y1 = max(0, min(p[1] for p in points)), min(1, max(p[1] for p in points))
                                box = tuple(round(v, 6) for v in (x0, y0, x1 - x0, y1 - y0))
                                if box[2] > 0 and box[3] > 0 and box not in seen:
                                    seen.add(box)
                                    result["rects"].append(dict(zip(("x", "y", "width", "height"), box)))
                                if len(result["rects"]) >= MAX_RECTS:
                                    result["truncated"] = True
                                    return result
                            if result["matches"] >= MAX_RECTS:
                                result["truncated"] = True
                                return result
                    finally:
                        search.close()
                if not result["rects"]:
                    result["reason"] = "no_match"
                return result
            finally:
                textpage.close()
        finally:
            page.close()
