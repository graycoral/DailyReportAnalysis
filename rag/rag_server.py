"""Local multimodal RAG service for the AV Report Hub "멀티모달 검색" tab.

  python rag_server.py                 # loads the model, listens on 127.0.0.1:<random port>
  python rag_server.py --port 8765

Writes %LOCALAPPDATA%\\AVReportHub\\rag-service.json ({address, key}) so the Go app can find it and
proxies requests with the X-RAG-Key header. Loopback only. Deleted on exit.

Endpoints (all JSON unless noted):
  GET  /health                 model info + index summary
  GET  /demo                   the test_embed.py numbers (cached in index/last-demo.json, recomputed with ?fresh=1)
  GET  /map                    indexed sources + labelled embedding similarities
  POST /index  (PDF or image, X-File-Name)    decode → embed → store under index/
  POST /query  {"text": "...", "top_k": 5}      top pages with similarity + thumbnail
  GET  /page?doc=<id>&page=<n>  PNG of that page
  POST /delete {"doc": "<id>"}
Indexed PDFs are stored unencrypted under %LOCALAPPDATA%\AVReportHub\rag\index\docs\ (never inside a git
work tree; startup refuses that). The UI warns before upload.
"""
import argparse, hashlib, json, os, secrets, signal, sys, threading, time, base64, tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote
import numpy as np
import embed_core as ec
import media

DATA_DIR = ec.DATA_DIR
SERVICE_FILE = DATA_DIR / "rag-service.json"
DOCS = ec.INDEX_DIR / "docs"
META = ec.INDEX_DIR / "index.json"
MAX_FILE = 50 << 20
state = {"model": None, "info": None, "docs": {}, "vecs": {}, "lock": threading.Lock(),
         "model_lock": threading.Lock(), "revision": 0, "map_cache": None}


def load_index():
    if META.exists():
        state["docs"] = json.loads(META.read_text(encoding="utf-8"))
        for d in list(state["docs"]):
            f = ec.INDEX_DIR / f"{d}.npy"
            if f.exists():
                state["vecs"][d] = np.load(f)
            else:
                state["docs"].pop(d)
    state["revision"] += 1
    state["map_cache"] = None


def save_index():
    ec.save_json(META, state["docs"])


def index_file(name, data):
    doc_id = hashlib.sha256(data).hexdigest()[:16]
    # Serialize model use and duplicate uploads; publish only a fully decoded/embedded file.
    with state["model_lock"]:
        with state["lock"]:
            if doc_id in state["docs"]:
                return doc_id, state["docs"][doc_id], False
        info = media.describe(data)
        ec.INDEX_DIR.mkdir(parents=True, exist_ok=True)
        DOCS.mkdir(parents=True, exist_ok=True)
        t = time.perf_counter()
        with tempfile.TemporaryDirectory(prefix="upload-", dir=ec.INDEX_DIR) as tmp:
            stage = Path(tmp)
            path = stage / (doc_id + info["extension"])
            path.write_bytes(data)
            vecs = []
            for n, img in media.pages(path, info):
                v, _ = ec.embed_image(state["model"], img)
                vecs.append(v)
                (stage / f"{doc_id}-{n}.png").write_bytes(ec.png_bytes(img, max_side=1200))
            if not vecs:
                raise ValueError("색인할 페이지나 이미지가 없습니다.")
            arr = np.stack(vecs).astype(np.float32)
            if not np.isfinite(arr).all():
                raise ValueError("이미지 임베딩 결과를 확인할 수 없습니다.")
            meta = {"name": name, "pages": len(vecs), "size": len(data), **info,
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "seconds": round(time.perf_counter() - t, 2),
                    "added": time.strftime("%Y-%m-%dT%H:%M:%S")}
            moved = []
            with state["lock"]:
                try:
                    for item in stage.iterdir():
                        dest = DOCS / item.name
                        item.replace(dest)
                        moved.append(dest)
                    vector_path = ec.INDEX_DIR / f"{doc_id}.npy"
                    moved.append(vector_path)
                    np.save(vector_path, arr)
                    state["docs"][doc_id] = meta
                    state["vecs"][doc_id] = arr
                    save_index()
                except Exception:
                    state["docs"].pop(doc_id, None)
                    state["vecs"].pop(doc_id, None)
                    for item in moved:
                        item.unlink(missing_ok=True)
                    raise
                state["revision"] += 1
                state["map_cache"] = None
        return doc_id, meta, True


def map_data():
    """Similarity is retrieval evidence, never a verified company/event relationship."""
    with state["lock"]:
        if state["map_cache"] is not None:
            return state["map_cache"]
        revision = state["revision"]
        docs, vecs = dict(state["docs"]), dict(state["vecs"])
    candidates = []
    ids = sorted(docs)
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            best, page_a, page_b = -1.0, 0, 0
            # Bound temporary matrices even for long PDFs. Stored vectors are normalized.
            for x in range(0, len(vecs[a]), 128):
                for y in range(0, len(vecs[b]), 128):
                    scores = vecs[a][x:x + 128] @ vecs[b][y:y + 128].T
                    row, col = np.unravel_index(np.argmax(scores), scores.shape)
                    score = float(scores[row, col])
                    if score > best:
                        best, page_a, page_b = score, x + int(row) + 1, y + int(col) + 1
            if best >= 0.6:
                candidates.append({"from": a, "to": b, "from_page": page_a, "to_page": page_b,
                                   "similarity": round(min(best, 1.0), 4), "kind": "similarity"})
    # At most three nearest sources per node; preserve evidence for both endpoints.
    candidates.sort(key=lambda item: (-item["similarity"], item["from"], item["to"]))
    degrees, links = {}, []
    for item in candidates:
        a, b = item["from"], item["to"]
        if degrees.get(a, 0) >= 3 or degrees.get(b, 0) >= 3:
            continue
        links.append(item)
        degrees[a], degrees[b] = degrees.get(a, 0) + 1, degrees.get(b, 0) + 1
    result = {"ok": True, "docs": [{"id": k, **v} for k, v in docs.items()], "links": links,
              "threshold": 0.6, "method": "max_page_cosine", "model": state["info"]}
    with state["lock"]:
        if revision == state["revision"]:
            state["map_cache"] = result
    return result


def query(text, top_k=5):
    with state["model_lock"]:
        q = ec.embed_query(state["model"], text).astype(np.float32)
    hits = []
    with state["lock"]:
        for d, arr in state["vecs"].items():
            sims = arr @ q
            for i in np.argsort(-sims)[:top_k]:
                hits.append({"doc": d, "name": state["docs"][d]["name"], "kind": state["docs"][d].get("kind", "pdf"),
                             "page": int(i) + 1, "similarity": round(float(sims[i]), 4)})
    hits.sort(key=lambda h: -h["similarity"])
    hits = hits[:top_k]
    for h in hits:
        p = DOCS / f"{h['doc']}-{h['page']}.png"
        h["thumb"] = "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode() if p.exists() else ""
    return hits


def demo(fresh=False):
    cache = ec.INDEX_DIR / "last-demo.json"
    if cache.exists() and not fresh:
        return json.loads(cache.read_text(encoding="utf-8"))
    import test_embed
    import io, contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        test_embed.run(ec.DOCS_DIR, as_json=True)
    return json.loads(buf.getvalue())


class Server(ThreadingHTTPServer):
    # Python's default SO_REUSEADDR lets a second process bind an already-used port on Windows,
    # silently handing our connections to whoever bound it first. Never do that.
    allow_reuse_address = False


class H(BaseHTTPRequestHandler):
    key = ""

    def log_message(self, fmt, *args):  # never log bodies or query text
        ec.log(f"{self.command} {urlparse(self.path).path} {args[1] if len(args) > 1 else ''}")

    def _auth(self):
        return secrets.compare_digest(self.headers.get("X-RAG-Key", ""), self.key)

    def _json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def _err(self, msg, code=400):
        self._json({"error": msg}, code)

    def do_GET(self):
        if not self._auth():
            return self._err("unauthorized", 403)
        u = urlparse(self.path); qs = parse_qs(u.query)
        if u.path == "/health":
            return self._json({"ok": True, "model": state["info"], "docs": [{"id": k, **v} for k, v in state["docs"].items()],
                               "docs_dir": str(ec.DOCS_DIR), "index_dir": str(ec.INDEX_DIR)})
        if u.path == "/map":
            return self._json(map_data())
        if u.path == "/demo":
            try:
                return self._json(demo(fresh=qs.get("fresh", ["0"])[0] == "1"))
            except Exception as e:
                return self._err(f"demo failed: {e}", 500)
        if u.path == "/page":
            d, n = qs.get("doc", [""])[0], qs.get("page", ["1"])[0]
            if not d.isalnum() or not n.isdigit():
                return self._err("bad request")
            p = DOCS / f"{d}-{int(n)}.png"
            if not p.exists():
                return self._err("not found", 404)
            b = p.read_bytes()
            self.send_response(200); self.send_header("Content-Type", "image/png"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
            return
        self._err("not found", 404)

    def do_POST(self):
        if not self._auth():
            return self._err("unauthorized", 403)
        u = urlparse(self.path)
        n = int(self.headers.get("Content-Length", "0") or 0)
        if n < 0 or n > MAX_FILE:
            return self._err("50MB를 넘습니다.", 413)
        body = self.rfile.read(n) if n else b""
        try:
            if u.path == "/index":
                name = self.headers.get("X-File-Name", "upload")
                if self.headers.get("X-File-Name-Encoding") == "percent-utf8":
                    name = unquote(name)
                name = Path(name).name or "upload.pdf"
                doc_id, meta, created = index_file(name, body)
                return self._json({"ok": True, "id": doc_id, "created": created, **meta})
            if u.path == "/query":
                j = json.loads(body or b"{}")
                text = (j.get("text") or "").strip()
                if not text:
                    return self._err("검색 문장을 입력하세요.")
                return self._json({"ok": True, "hits": query(text, max(1, min(30, int(j.get("top_k", 5)))))})
            if u.path == "/delete":
                j = json.loads(body or b"{}"); d = j.get("doc", "")
                with state["lock"]:
                    if d in state["docs"]:
                        state["docs"].pop(d); state["vecs"].pop(d, None); save_index()
                        state["revision"] += 1
                        state["map_cache"] = None
                        for f in list(DOCS.glob(f"{d}*")) + [ec.INDEX_DIR / f"{d}.npy"]:
                            f.unlink(missing_ok=True)
                return self._json({"ok": True})
        except ValueError as e:
            return self._err(str(e), 400)
        except Exception as e:
            ec.log(f"error: {e}")
            return self._err(str(e), 500)
        self._err("not found", 404)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=0)
    a = ap.parse_args()
    ec.check_storage()
    ec.INDEX_DIR.mkdir(parents=True, exist_ok=True)
    load_index()
    ec.log("loading model …")
    state["model"], state["info"] = ec.load_model()
    ec.log(f"model ready in {state['info']['load_seconds']}s, {state['info']['parameters']:,} params, {state['info']['dimensions']} dims")
    H.key = secrets.token_hex(32)
    try:
        srv = Server(("127.0.0.1", a.port), H)
    except OSError as e:
        ec.log(f"cannot listen on port {a.port or '(random)'}: {e}. Pick another --port or omit it.")
        sys.exit(2)
    address = f"http://127.0.0.1:{srv.server_address[1]}"
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SERVICE_FILE.write_text(json.dumps({"address": address, "key": H.key, "pid": os.getpid()}), encoding="utf-8")
    ec.log(f"listening on {address}; service file {SERVICE_FILE}")

    def stop(*_):
        try: SERVICE_FILE.unlink(missing_ok=True)
        finally: os._exit(0)
    signal.signal(signal.SIGINT, stop); signal.signal(signal.SIGTERM, stop)
    try:
        srv.serve_forever()
    finally:
        SERVICE_FILE.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
