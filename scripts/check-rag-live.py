"""Optional offline integration check with an already downloaded model.

Run: rag/.venv/Scripts/python scripts/check-rag-live.py
Uses generated images and a temporary index outside the repository.
"""
import io
import json
import os
import secrets
import sys
import tempfile
import threading
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

os.environ["HF_HOME"] = str(Path(os.environ["LOCALAPPDATA"]) / "AVReportHub" / "rag" / "models")
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "rag"))

with tempfile.TemporaryDirectory(prefix="avhub-rag-check-") as folder:
    os.environ["AVHUB_DATA_DIR"] = folder
    from PIL import Image, ImageDraw
    import embed_core as ec
    import rag_server as service

    model, info = ec.load_model(offline=True)
    service.state["model"], service.state["info"] = model, info
    service.H.key = secrets.token_hex(32)
    http = service.Server(("127.0.0.1", 0), service.H)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    address = f"http://127.0.0.1:{http.server_port}"

    def request(path, body=None, name=None, raw=False):
        headers = {"X-RAG-Key": service.H.key}
        if name:
            headers.update({"X-File-Name": quote(name), "X-File-Name-Encoding": "percent-utf8"})
        if isinstance(body, dict):
            body = json.dumps(body).encode()
        with urlopen(Request(address + path, data=body, headers=headers), timeout=120) as response:
            return response.read() if raw else json.load(response)

    try:
        picture = Image.new("RGB", (320, 240), "white")
        draw = ImageDraw.Draw(picture)
        draw.rectangle((0, 160, 320, 240), fill="gray")
        draw.rectangle((35, 85, 285, 175), fill="red")
        draw.rectangle((55, 100, 265, 135), fill="lightblue")
        for x in (80, 230):
            draw.ellipse((x - 18, 160, x + 18, 196), fill="black")
        uploaded = []
        for fmt, name in (("PNG", "검증 버스.png"), ("JPEG", "검증 버스.jpg")):
            output = io.BytesIO()
            picture.save(output, fmt)
            result = request("/index", output.getvalue(), name=name)
            assert result["kind"] == "image" and result["pages"] == 1 and result["name"] == name
            uploaded.append(result["id"])
        graph = request("/map")
        assert len(graph["docs"]) == 2 and len(graph["links"]) == 1, graph
        hits = request("/query", {"text": "a red bus on a road", "top_k": 2})["hits"]
        assert {hit["doc"] for hit in hits} == set(uploaded)
        assert request(f"/page?doc={uploaded[0]}&page=1", raw=True).startswith(b"\x89PNG")
        request("/delete", {"doc": uploaded[0]})
        assert len(request("/map")["docs"]) == 1 and not request("/map")["links"]
        print(json.dumps({"ok": True, "model": info["model"], "device": info["device"],
                          "image_similarity": graph["links"][0]["similarity"],
                          "query_hits": len(hits), "temporary_index_cleaned": True}))
    finally:
        http.shutdown()
        http.server_close()
        thread.join()
