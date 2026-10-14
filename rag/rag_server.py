"""Local multimodal RAG service for the AV Report Hub "멀티모달 검색" tab.

  python rag_server.py                 # loads the model, listens on 127.0.0.1:<random port>
  python rag_server.py --port 8765

Writes %LOCALAPPDATA%\\AVReportHub\\rag-service.json ({address, key}) so the Go app can find it and
proxies requests with the X-RAG-Key header. Loopback only. Deleted on exit.

Endpoints (all JSON unless noted):
  GET  /health                 model info + index summary
  GET  /demo                   the test_embed.py numbers (cached in index/last-demo.json, recomputed with ?fresh=1)
  POST /index  (application/pdf, X-File-Name)   render every page → embed → store under index/
  POST /query  {"text": "...", "top_k": 5}      top pages with similarity + thumbnail
  GET  /page?doc=<id>&page=<n>  PNG of that page
  POST /delete {"doc": "<id>"}
Indexed PDFs are stored unencrypted under %LOCALAPPDATA%\AVReportHub\rag\index\docs\ (never inside a git
work tree; startup refuses that). The UI warns before upload.
"""
import argparse, hashlib, json, os, secrets, signal, sys, threading, time, base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import numpy as np
import embed_core as ec

DATA_DIR = ec.DATA_DIR
SERVICE_FILE = DATA_DIR / "rag-service.json"
DOCS = ec.INDEX_DIR / "docs"
META = ec.INDEX_DIR / "index.json"
MAX_PDF = 50 << 20
state = {"model": None, "info": None, "docs": {}, "vecs": {}, "lock": threading.Lock()}


def load_index():
    if META.exists():
        state["docs"] = json.loads(META.read_text(encoding="utf-8"))
        for d in list(state["docs"]):
            f = ec.INDEX_DIR / f"{d}.npy"
            if f.exists():
                state["vecs"][d] = np.load(f)
            else:
                state["docs"].pop(d)


def save_index():
    ec.save_json(META, state["docs"])


def index_pdf(name, data):
    doc_id = hashlib.sha256(data).hexdigest()[:16]
    if doc_id in state["docs"]:
        return doc_id, state["docs"][doc_id], False
    DOCS.mkdir(parents=True, exist_ok=True)
    path = DOCS / f"{doc_id}.pdf"
    path.write_bytes(data)
    t = time.perf_counter()
    vecs, pages = [], []
    for n, img in ec.pdf_pages(path):
        v, _ = ec.embed_image(state["model"], img)
        vecs.append(v)
        (DOCS / f"{doc_id}-{n}.png").write_bytes(ec.png_bytes(img, max_side=480))
        pages.append(n)
    arr = np.stack(vecs).astype(np.float32)
    np.save(ec.INDEX_DIR / f"{doc_id}.npy", arr)
    meta = {"name": name, "pages": len(pages), "size": len(data), "seconds": round(time.perf_counter() - t, 2),
            "added": time.strftime("%Y-%m-%dT%H:%M:%S")}
    with state["lock"]:
        state["docs"][doc_id] = meta; state["vecs"][doc_id] = arr; save_index()
    return doc_id, meta, True


def query(text, top_k=5):
    q = ec.embed_query(state["model"], text).astype(np.float32)
    hits = []
    with state["lock"]:
        for d, arr in state["vecs"].items():
            sims = arr @ q
            for i in np.argsort(-sims)[:top_k]:
                hits.append({"doc": d, "name": state["docs"][d]["name"], "page": int(i) + 1, "similarity": round(float(sims[i]), 4)})
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
        if n > MAX_PDF:
            return self._err("50MB를 넘습니다.", 413)
        body = self.rfile.read(n) if n else b""
        try:
            if u.path == "/index":
                name = self.headers.get("X-File-Name", "upload.pdf")
                name = Path(name).name or "upload.pdf"
                if not body.startswith(b"%PDF"):
                    return self._err("PDF 파일만 색인할 수 있습니다.")
                doc_id, meta, created = index_pdf(name, body)
                return self._json({"ok": True, "id": doc_id, "created": created, **meta})
            if u.path == "/query":
                j = json.loads(body or b"{}")
                text = (j.get("text") or "").strip()
                if not text:
                    return self._err("검색 문장을 입력하세요.")
                return self._json({"ok": True, "hits": query(text, int(j.get("top_k", 5)))})
            if u.path == "/delete":
                j = json.loads(body or b"{}"); d = j.get("doc", "")
                with state["lock"]:
                    if d in state["docs"]:
                        state["docs"].pop(d); state["vecs"].pop(d, None); save_index()
                        for f in list(DOCS.glob(f"{d}*")) + [ec.INDEX_DIR / f"{d}.npy"]:
                            f.unlink(missing_ok=True)
                return self._json({"ok": True})
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
