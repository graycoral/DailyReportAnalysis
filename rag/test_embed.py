"""Readiness check and demo for the multimodal RAG feature.

  python test_embed.py            # load model, embed first page of the first PDF in docs/, print report
  python test_embed.py --json     # same, machine-readable (what the app's "보여 줘" button shows)
  python test_embed.py --docs D:\\pdfs

Prints: model load time, parameter count, embedding dimensions, time to render+embed the first PDF
page, and cosine similarity between that page image and three sentences (2 related, 1 unrelated).
"""
import argparse, json, sys, time
from pathlib import Path
import embed_core as ec


def pick_sentences(page_text):
    """Two sentences that should match the page and one that should not.
    The related ones are drawn from the page's own text when it has any; otherwise generic AV-report lines."""
    related = []
    for frag in [s.strip() for s in page_text.replace("\n", " ").split(".") if len(s.strip()) > 20]:
        related.append(frag[:120])
        if len(related) == 2:
            break
    while len(related) < 2:
        related.append(["자율주행 로보택시 운영 지역 확대와 안전요원 없는 무인 운행 허가 현황",
                        "Uber, Waymo, May Mobility 등 자율주행 기업의 데일리 동향 보고"][len(related)])
    unrelated = "오늘 저녁 식사로 김치찌개와 계란말이를 만들 재료를 마트에서 샀다."
    return related, unrelated


def run(docs, as_json=False):
    out = {"docs_dir": str(docs)}
    pdfs = ec.list_pdfs(docs)
    sample = None
    if not pdfs:
        sample = ec.ensure_sample_pdf(docs)
        pdfs = ec.list_pdfs(docs)
        out["note"] = f"docs 폴더에 PDF가 없어 최신 리포트로 샘플 PDF를 만들었습니다: {sample.name}" if sample else "docs 폴더에 PDF가 없습니다."
    model, info = ec.load_model()
    out["model"] = info
    if not pdfs:
        print(json.dumps(out, ensure_ascii=False, indent=2) if as_json else report(out))
        return 0
    pdf = pdfs[0]
    out["pdf"] = pdf.name
    t = time.perf_counter()
    page_no, img = next(ec.pdf_pages(pdf, first_only=True))
    render_s = time.perf_counter() - t
    vec, embed_s = ec.embed_image(model, img)
    out["first_page"] = {"page": page_no, "width": img.width, "height": img.height,
                         "render_seconds": round(render_s, 2), "embed_seconds": round(embed_s, 2),
                         "total_seconds": round(render_s + embed_s, 2)}
    text = ec.pdf_text(pdf, page_no)
    related, unrelated = pick_sentences(text)
    sims = []
    for label, s in [("관련 1", related[0]), ("관련 2", related[1]), ("무관", unrelated)]:
        q = ec.embed_query(model, s)
        sims.append({"label": label, "sentence": s, "similarity": round(float(model.similarity(q, vec)[0][0]), 4)})
    out["similarities"] = sims
    out["page_text_preview"] = text[:200]
    ec.save_json(ec.INDEX_DIR / "last-demo.json", out)
    print(json.dumps(out, ensure_ascii=False, indent=2) if as_json else report(out))
    return 0


def report(o):
    m = o["model"]
    lines = ["== 모델", f"  {m['model']}  (오디오 인코더 미적재)",
             f"  불러오는 시간: {m['load_seconds']}초   파라미터: {m['parameters']:,}   임베딩 차원: {m['dimensions']}   장치: {m['device']}"]
    if o.get("note"):
        lines.append("  " + o["note"])
    if "first_page" in o:
        p = o["first_page"]
        lines += ["== 첫 페이지", f"  {o['pdf']}  p.{p['page']}  {p['width']}x{p['height']}px",
                  f"  이미지 변환 {p['render_seconds']}초 + 임베딩 {p['embed_seconds']}초 = {p['total_seconds']}초", "== 유사도 (페이지 이미지 vs 문장)"]
        for s in o["similarities"]:
            lines.append(f"  {s['similarity']:.4f}  [{s['label']}] {s['sentence']}")
    return "\n".join(lines)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--docs", type=Path, default=ec.DOCS_DIR)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    sys.exit(run(a.docs, a.json))
