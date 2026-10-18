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
  POST /highlights {"doc": "<id>", "page": 1, "text": "..."}  literal PDF text locations
  GET  /page?doc=<id>&page=<n>  PNG of that page
  POST /delete {"doc": "<id>"}
Indexed PDFs are stored unencrypted under %LOCALAPPDATA%\AVReportHub\rag\index\docs\ (never inside a git
work tree; startup refuses that). The UI warns before upload.
"""
import argparse, hashlib, json, os, secrets, signal, sys, threading, time, base64, tempfile, re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote
import numpy as np
import embed_core as ec
import media
import pdf_highlights
from tasks import Jobs, ModelGate

DATA_DIR = ec.DATA_DIR
SERVICE_FILE = DATA_DIR / "rag-service.json"
DOCS = ec.INDEX_DIR / "docs"
META = ec.INDEX_DIR / "index.json"
MAX_FILE = 50 << 20
state = {"model": None, "info": None, "docs": {}, "vecs": {}, "lock": threading.Lock(),
         "model_gate": ModelGate(), "index_lock": threading.Lock(), "map_lock": threading.Lock(),
         "revision": 0, "map_cache": None, "pair_cache": {}}
jobs = Jobs()


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
    state["pair_cache"] = {}


def save_index():
    ec.save_json(META, state["docs"])


def index_file(name, data, progress=lambda pages: None):
    doc_id = hashlib.sha256(data).hexdigest()[:16]
    # Serialize file publication, but let queued queries run between page embeddings.
    with state["index_lock"]:
        with state["lock"]:
            if doc_id in state["docs"]:
                if state["docs"][doc_id].get("deleted"):
                    prior = state["docs"][doc_id]
                    state["docs"][doc_id] = {k: v for k, v in prior.items() if k != "deleted"}
                    try:
                        save_index()
                    except Exception:
                        state["docs"][doc_id] = prior
                        raise
                    state["revision"] += 1
                    state["map_cache"] = None
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
                with state["model_gate"].use():
                    v, _ = ec.embed_image(state["model"], img)
                vecs.append(v)
                (stage / f"{doc_id}-{n}.png").write_bytes(ec.png_bytes(img, max_side=1200))
                progress(n)
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


def compare_documents(a, b, va, vb):
    best, page_a, page_b = -1.0, 0, 0
    for x in range(0, len(va), 128):
        for y in range(0, len(vb), 128):
            scores = va[x:x + 128] @ vb[y:y + 128].T
            row, col = np.unravel_index(np.argmax(scores), scores.shape)
            score = float(scores[row, col])
            if score > best:
                best, page_a, page_b = score, x + int(row) + 1, y + int(col) + 1
    if best >= 0.6:
        return {"from": a, "to": b, "from_page": page_a, "to_page": page_b,
                "similarity": round(min(best, 1.0), 4), "kind": "similarity"}
    return None


def map_data():
    # One calculation per revision even when several windows request the map.
    with state["map_lock"]:
        return build_map()


def build_map():
    """Similarity is retrieval evidence, never a verified company/event relationship."""
    with state["lock"]:
        if state["map_cache"] is not None:
            return state["map_cache"]
        revision = state["revision"]
        docs = {k: v for k, v in state["docs"].items() if not v.get("deleted")}
        vecs = {k: state["vecs"][k] for k in docs}
        pairs = dict(state["pair_cache"])
    candidates = []
    ids = sorted(docs)
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            key = (a, b)
            prior = pairs.get(key)
            # Vectors are immutable after publication. Cache non-matches too.
            if prior is None or prior[0] is not vecs[a] or prior[1] is not vecs[b]:
                prior = (vecs[a], vecs[b], compare_documents(a, b, vecs[a], vecs[b]))
                pairs[key] = prior
            if prior[2] is not None:
                candidates.append(prior[2])
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
        state["pair_cache"] = {key: value for key, value in pairs.items()
                               if state["vecs"].get(key[0]) is value[0] and state["vecs"].get(key[1]) is value[1]}
        if revision == state["revision"]:
            state["map_cache"] = result
    return result


def highlights(doc_id, page_number, text):
    if not isinstance(doc_id, str) or not re.fullmatch(r"[A-Za-z0-9]{1,64}", doc_id):
        raise ValueError("잘못된 자료 번호입니다.")
    if type(page_number) is not int or not isinstance(text, str) or len(text) > 2000:
        raise ValueError("페이지 번호와 검색어를 확인해 주세요.")
    with state["lock"]:
        meta = state["docs"].get(doc_id)
        if meta is None or meta.get("deleted") or not 1 <= page_number <= meta["pages"]:
            raise ValueError("자료 또는 페이지를 찾을 수 없습니다.")
        kind = meta.get("kind", "pdf")
    empty = {"rects": [], "matches": 0, "truncated": False}
    if kind != "pdf":
        return {**empty, "reason": "image"}
    try:
        return pdf_highlights.page_highlights(DOCS / (doc_id + ".pdf"), page_number, text)
    except Exception:
        # A missing text layer/source must never turn a successful semantic query into an error.
        return {**empty, "reason": "unavailable"}


def query(text, top_k=5):
    with state["model_gate"].use(interactive=True):
        q = ec.embed_query(state["model"], text).astype(np.float32)
    hits = []
    with state["lock"]:
        for d, arr in state["vecs"].items():
            if state["docs"][d].get("deleted"):
                continue
            sims = arr @ q
            for i in np.argsort(-sims)[:top_k]:
                hits.append({"doc": d, "name": state["docs"][d]["name"], "kind": state["docs"][d].get("kind", "pdf"),
                             "page": int(i) + 1, "similarity": round(float(sims[i]), 4)})
    hits.sort(key=lambda h: -h["similarity"])
    hits = hits[:top_k]
    for h in hits:
        p = DOCS / f"{h['doc']}-{h['page']}.png"
        h["thumb"] = "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode() if p.exists() else ""
        try:
            h["highlight"] = highlights(h["doc"], h["page"], text)
        except ValueError:
            h["highlight"] = {"rects": [], "matches": 0, "reason": "unavailable"}
    return hits


def demo(fresh=False):
    cache = ec.INDEX_DIR / "last-demo.json"
    if cache.exists() and not fresh:
        return json.loads(cache.read_text(encoding="utf-8"))
    import test_embed
    return test_embed.run(ec.DOCS_DIR, model=state["model"], info=state["info"],
                          model_call=state["model_gate"].call, return_result=True)


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
        if u.path == "/jobs":
            job = jobs.get(qs.get("id", [""])[0])
            return self._json(job) if job else self._err("작업을 찾을 수 없습니다. 서비스가 재시작되었는지 확인하세요.", 404)
        if u.path == "/health":
            with state["lock"]:
                docs = list(state["docs"].items())
            return self._json({"ok": True, "model": state["info"], "docs": [{"id": k, **v} for k, v in docs if not v.get("deleted")],
                               "trash": [{"id": k, **v} for k, v in docs if v.get("deleted")],
                               "docs_dir": str(ec.DOCS_DIR), "index_dir": str(ec.INDEX_DIR)})
        if u.path == "/map":
            with state["lock"]:
                cached, revision = state["map_cache"], state["revision"]
            if cached is not None:
                return self._json(cached)
            try:
                return self._json(jobs.start(f"map:{revision}", lambda progress: map_data()), 202)
            except ValueError as e:
                return self._err(str(e), 429)
        if u.path == "/demo":
            try:
                fresh = qs.get("fresh", ["0"])[0] == "1"
                cache = ec.INDEX_DIR / "last-demo.json"
                if cache.exists() and not fresh:
                    return self._json(demo())
                return self._json(jobs.start("demo", lambda progress: demo(fresh=True)), 202)
            except Exception as e:
                return self._err(f"demo failed: {e}", 500)
        if u.path == "/page":
            d, n = qs.get("doc", [""])[0], qs.get("page", ["1"])[0]
            if not d.isalnum() or not n.isdigit():
                return self._err("bad request")
            with state["lock"]:
                meta = state["docs"].get(d)
                if not meta or meta.get("deleted"):
                    return self._err("not found", 404)
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
                def work(progress):
                    doc_id, meta, created = index_file(name, body, progress)
                    return {"ok": True, "id": doc_id, "created": created, **meta}
                return self._json(jobs.start("index:" + hashlib.sha256(body).hexdigest(), work), 202)
            if u.path == "/query":
                j = json.loads(body or b"{}")
                text = (j.get("text") or "").strip()
                if not text:
                    return self._err("검색 문장을 입력하세요.")
                if len(text) > 2000:
                    return self._err("검색어는 2,000자 이내로 입력해 주세요.")
                return self._json({"ok": True, "hits": query(text, max(1, min(30, int(j.get("top_k", 5)))))})
            if u.path == "/highlights":
                j = json.loads(body or b"{}")
                return self._json({"ok": True, **highlights(j.get("doc"), j.get("page", 1), j.get("text", ""))})
            if u.path in ("/delete", "/trash", "/restore"):
                j = json.loads(body or b"{}"); d = j.get("doc", "")
                if not isinstance(d, str) or not re.fullmatch(r"[a-f0-9]{16}", d):
                    return self._err("잘못된 자료 번호입니다.")
                # A Windows PDF handle must be closed before removing its source file.
                with state["index_lock"], ec.PDF_LOCK, state["lock"]:
                    if d in state["docs"]:
                        prior = dict(state["docs"][d])
                        if u.path == "/delete":
                            files = [f for f in DOCS.iterdir() if f.name.startswith(d + ".") or f.name.startswith(d + "-")]
                            for f in files + [ec.INDEX_DIR / f"{d}.npy"]:
                                f.unlink(missing_ok=True)
                            state["docs"].pop(d)
                        elif u.path == "/trash":
                            state["docs"][d] = {**prior, "deleted": time.time()}
                        else:
                            state["docs"][d] = {k: v for k, v in prior.items() if k != "deleted"}
                        try:
                            save_index()
                        except Exception:
                            state["docs"][d] = prior
                            raise
                        if u.path == "/delete":
                            state["vecs"].pop(d, None)
                        state["revision"] += 1
                        state["map_cache"] = None
                        state["pair_cache"] = {k: v for k, v in state["pair_cache"].items() if d not in k}
                    else:
                        return self._err("자료를 찾을 수 없습니다.", 404)
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
