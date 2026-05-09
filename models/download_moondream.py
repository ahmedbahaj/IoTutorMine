#!/usr/bin/env python3
"""
Downloads the Moondream2 model from HuggingFace to models/moondream2/.
Run once before inference.

A free HuggingFace token speeds up the download significantly:
    huggingface.co/settings/tokens → create a read token → export HF_TOKEN=<token>

Usage:
    uv pip install -e .
    python models/download_moondream.py
"""

import os
import sys
from pathlib import Path

MODELS_DIR = Path(__file__).parent
MODEL_DIR = MODELS_DIR / "moondream2"
REPO_ID = "vikhyatk/moondream2"
REVISION = "2025-01-09"


def main() -> None:
    if MODEL_DIR.exists() and any(MODEL_DIR.iterdir()):
        print(f"Already exists: {MODEL_DIR}")
        return

    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print("Run: uv pip install -e . first")
        sys.exit(1)

    token = os.environ.get("HF_TOKEN")
    if not token:
        print("Tip: set HF_TOKEN env var for faster downloads (free at huggingface.co/settings/tokens)")

    print(f"Downloading {REPO_ID} @ {REVISION} → {MODEL_DIR}")
    print("This is ~7.6GB — grab a coffee.\n")

    snapshot_download(
        repo_id=REPO_ID,
        revision=REVISION,
        local_dir=str(MODEL_DIR),
        token=token or None,
    )
    print(f"\nDone. Saved to {MODEL_DIR}")


if __name__ == "__main__":
    main()
