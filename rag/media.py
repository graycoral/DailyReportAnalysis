"""Decode uploaded PDF/raster files locally; original bytes are never executed."""
import io
import warnings
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError
import pillow_heif

import embed_core as ec

pillow_heif.register_heif_opener()
FORMATS = {"JPEG", "PNG", "WEBP", "GIF", "BMP", "TIFF", "AVIF", "HEIF", "ICO"}
EXTENSIONS = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp", "GIF": ".gif",
              "BMP": ".bmp", "TIFF": ".tiff", "AVIF": ".avif", "HEIF": ".heic", "ICO": ".ico"}


def describe(data):
    if data.startswith(b"%PDF"):
        return {"kind": "pdf", "format": "PDF", "extension": ".pdf", "frame_policy": "all_pages"}
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                fmt = image.format
                if fmt not in FORMATS:
                    raise ValueError("지원하지 않는 이미지 형식입니다.")
                image.verify()
        return {"kind": "image", "format": fmt, "extension": EXTENSIONS[fmt],
                "frame_policy": "all_pages" if fmt == "TIFF" else "first_frame"}
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError("읽을 수 있는 PDF 또는 이미지 파일을 선택해 주세요.") from exc


def pages(path, info):
    if info["kind"] == "pdf":
        yield from ec.pdf_pages(path)
        return
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(Path(path)) as source:
            count = getattr(source, "n_frames", 1) if info["format"] == "TIFF" else 1
            for index in range(count):
                source.seek(index)
                image = ImageOps.exif_transpose(source).convert("RGBA")
                # Transparent screenshots/icons should embed as shown on a white page.
                background = Image.new("RGBA", image.size, "white")
                background.alpha_composite(image)
                yield index + 1, background.convert("RGB")
