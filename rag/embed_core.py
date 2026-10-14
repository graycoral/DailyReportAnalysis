"""Shared pieces for the optional multimodal RAG feature.

Runs ONLY on a PC where the operator deliberately started it (analyst / publisher PC).
Loads google/embeddinggemma-2 through sentence-transformers with the audio encoder disabled
(text + vision, ~440M parameters) and turns PDF pages into images for embedding.
Nothing here is part of the shipped AVReportHub.exe.
"""
import io, json, os, re, sys, time
from pathlib import Path

MODEL_ID = os.environ.get("RAG_MODEL", "google/embeddinggemma-2")
HERE = Path(__file__).resolve().parent
INDEX_DIR = Path(os.environ.get("RAG_INDEX", HERE / "index"))
DOCS_DIR = Path(os.environ.get("RAG_DOCS", HERE.parent / "docs"))
RENDER_SCALE = float(os.environ.get("RAG_RENDER_SCALE", "1.5"))  # 72dpi * 1.5 = 108dpi


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def load_model():
    """Text + vision only: audio_config=None means the audio encoder is never loaded."""
    import torch
    from sentence_transformers import SentenceTransformer
    torch.set_num_threads(max(1, os.cpu_count() or 1))
    t = time.perf_counter()
    model = SentenceTransformer(MODEL_ID, config_kwargs={"audio_config": None}, device="cpu")
    seconds = time.perf_counter() - t
    params = sum(p.numel() for p in model.parameters())
    dims = model.get_embedding_dimension()
    return model, {"model": MODEL_ID, "load_seconds": round(seconds, 2), "parameters": params,
                   "dimensions": dims, "device": str(model.device), "audio_encoder": False,
                   "sentence_transformers": __import__("sentence_transformers").__version__}


def pdf_pages(pdf_path, first_only=False):
    """Yield (page_number, PIL.Image) for a PDF."""
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(str(pdf_path))
    try:
        n = 1 if first_only else len(doc)
        for i in range(n):
            page = doc[i]
            try:
                yield i + 1, page.render(scale=RENDER_SCALE).to_pil().convert("RGB")
            finally:
                page.close()
    finally:
        doc.close()


def png_bytes(img, max_side=None):
    if max_side:
        img = img.copy(); img.thumbnail((max_side, max_side))
    b = io.BytesIO(); img.save(b, format="PNG"); return b.getvalue()


def embed_image(model, img):
    t = time.perf_counter()
    v = model.encode({"image": img}, normalize_embeddings=True)
    return v, time.perf_counter() - t


def embed_query(model, text):
    return model.encode(text, prompt_name="SearchQuery", normalize_embeddings=True)


def embed_document_text(model, text):
    return model.encode(text, prompt_name="Document", normalize_embeddings=True)


def pdf_text(pdf_path, page_number=1, limit=1200):
    """Plain text of one page (used only to help craft demo sentences). May be empty for scanned PDFs."""
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(str(pdf_path))
    try:
        page = doc[page_number - 1]
        try:
            tp = page.get_textpage()
            try:
                return re.sub(r"\s+", " ", tp.get_text_range() or "").strip()[:limit]
            finally:
                tp.close()
        finally:
            page.close()
    finally:
        doc.close()


def list_pdfs(folder=DOCS_DIR):
    folder = Path(folder)
    return sorted(p for p in folder.glob("*.pdf") if p.is_file()) if folder.is_dir() else []


def ensure_sample_pdf(folder):
    """If the docs folder holds no PDF, render the latest report MD into a one-page PDF with Pillow
    so the pipeline can still be exercised. Clearly named so nobody mistakes it for a source document."""
    folder = Path(folder); folder.mkdir(parents=True, exist_ok=True)
    reports = sorted((HERE.parent / "data" / "reports").glob("*/*.md"))
    if not reports:
        return None
    src = reports[-1]
    out = folder / f"sample-from-{src.stem}.pdf"
    if out.exists():
        return out
    from PIL import Image, ImageDraw, ImageFont
    text = src.read_text(encoding="utf-8")
    text = re.sub(r"^---.*?---\s*", "", text, count=1, flags=re.S)
    lines = []
    for raw in text.splitlines():
        raw = raw.replace("**", "").strip()
        if raw in ("", "---"):
            continue
        while len(raw) > 60:
            lines.append(raw[:60]); raw = raw[60:]
        lines.append(raw)
        if len(lines) > 60:
            break
    font = None
    for cand in (r"C:\Windows\Fonts\malgun.ttf", r"C:\Windows\Fonts\NotoSansKR-Regular.ttf"):
        if Path(cand).exists():
            font = ImageFont.truetype(cand, 18); break
    font = font or ImageFont.load_default()
    img = Image.new("RGB", (1240, 1754), "white")
    d = ImageDraw.Draw(img)
    y = 60
    for ln in lines:
        d.text((70, y), ln, fill="black", font=font); y += 27
    img.save(out, "PDF", resolution=150)
    return out


def save_json(path, obj):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
