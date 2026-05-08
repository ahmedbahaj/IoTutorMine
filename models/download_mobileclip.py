#!/usr/bin/env python3
"""
Downloads the MobileCLIP-S2 model checkpoint from Apple.
Run once before inference.

Usage:
    uv pip install -e .
    python models/download_mobileclip.py
"""

import urllib.request
from pathlib import Path

MODELS_DIR = Path(__file__).parent
MODEL_URL = "https://docs-assets.developer.apple.com/ml-research/datasets/mobileclip/mobileclip_s2.pt"
MODEL_PATH = MODELS_DIR / "mobileclip_s2.pt"


def _progress(count: int, block_size: int, total_size: int) -> None:
    percent = min(int(count * block_size * 100 / total_size), 100)
    print(f"\r  {percent}%", end="", flush=True)


def main() -> None:
    if MODEL_PATH.exists():
        print(f"Already exists: {MODEL_PATH}")
        return

    print(f"Downloading MobileCLIP-S2...")
    urllib.request.urlretrieve(MODEL_URL, MODEL_PATH, _progress)
    print(f"\nSaved to {MODEL_PATH}")


if __name__ == "__main__":
    main()
