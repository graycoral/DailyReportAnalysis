"""Download/validate the optional search environment without reading user PDFs."""
import argparse
import os


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="Validate cached model offline")
    args = parser.parse_args()
    if args.check:
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
    import numpy as np
    import pypdfium2
    from PIL import Image
    import embed_core as ec
    import media  # Verify raster/HEIC decoders as part of environment readiness.

    ec.check_storage()
    model, _ = ec.load_model(offline=args.check)
    image, _ = ec.embed_image(model, Image.new("RGB", (224, 224), "white"))
    query = ec.embed_query(model, "자율주행 보고서")
    if image.shape != query.shape or not np.isfinite(image).all() or not np.isfinite(query).all():
        raise RuntimeError("Image/query embedding validation failed")
    print("ready", flush=True)


if __name__ == "__main__":
    main()
