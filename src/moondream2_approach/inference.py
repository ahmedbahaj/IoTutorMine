#!/usr/bin/env python3
"""
Runs Moondream2 (loaded locally via transformers) on deduplicated frames
to extract IoT hardware components.

Pipeline per video:
  1. Load all 1fps frames from data/frames/{video_id}/
  2. pHash deduplication — skip frames too similar to the previous kept frame
  3. Run Moondream2 on each unique frame
  4. Aggregate: per component, which frames it appeared in

Resumable: already-processed frames are skipped on re-run.

Usage:
    python src/moondream2_approach/inference.py
"""

import ctypes
import csv
import re
import sys
from pathlib import Path

# Pre-load libvips so pyvips/cffi can find it (Homebrew on macOS + SIP)
if sys.platform == "darwin":
    try:
        ctypes.CDLL("/opt/homebrew/lib/libvips.42.dylib", mode=ctypes.RTLD_GLOBAL)
    except OSError:
        pass

import imagehash
import torch
from PIL import Image
from transformers import AutoModelForCausalLM, AutoTokenizer

# ── Paths ──────────────────────────────────────────────────────────────────────
ROOT = Path(__file__).parents[2]
FRAMES_DIR = ROOT / "data" / "frames"
MODEL_DIR = ROOT / "models" / "moondream2"
OUT_DIR = Path(__file__).parent
VLM_RESPONSES_CSV = OUT_DIR / "vlm_responses.csv"
RESULTS_CSV = OUT_DIR / "results.csv"

# ── Config ─────────────────────────────────────────────────────────────────────
PHASH_THRESHOLD = 25    # higher = fewer frames processed (0–64)

PROMPT = (
    "List the embedded hardware, electronic and IoT prototyping components visible in this image. "
    "Component names only, one per line, no descriptions. "
    "Reply with 'none' if no such components are visible."
)


def load_model():
    if not MODEL_DIR.exists() or not any(MODEL_DIR.iterdir()):
        print(f"Model not found at {MODEL_DIR}. Run: python models/download_moondream.py")
        sys.exit(1)

    device = "cpu"
    dtype = torch.bfloat16

    print(f"Loading Moondream2 on {device}...")
    print("Step 1: loading tokenizer...")
    tokenizer = AutoTokenizer.from_pretrained(str(MODEL_DIR), trust_remote_code=True)
    print("Step 2: loading model weights...")
    model = AutoModelForCausalLM.from_pretrained(
        str(MODEL_DIR),
        trust_remote_code=True,
        torch_dtype=dtype,
        low_cpu_mem_usage=True,
    )
    print("Step 3: moving to device...")
    model = model.to(device)
    print("Step 4: eval mode...")
    model.eval()
    print("Model ready.\n")
    return model, tokenizer


def select_unique_frames(frame_paths: list[Path]) -> list[Path]:
    """Return frames whose pHash differs enough from the previously kept frame."""
    selected = []
    last_hash = None
    for path in frame_paths:
        try:
            h = imagehash.phash(Image.open(path))
        except Exception:
            continue
        if last_hash is None or (h - last_hash) >= PHASH_THRESHOLD:
            selected.append(path)
            last_hash = h
    return selected


def parse_components(response: str) -> list[str]:
    """Extract individual component names from a VLM response."""
    components = []
    for line in response.splitlines():
        line = line.strip()
        line = re.sub(r"^[\d]+[.)]\s*|^[-*•]\s*", "", line).strip()
        if line and line.lower() != "none":
            components.append(line)
    return components


def load_processed_frames() -> set:
    processed = set()
    if not VLM_RESPONSES_CSV.exists():
        return processed
    with open(VLM_RESPONSES_CSV, newline="") as f:
        for row in csv.DictReader(f):
            processed.add((row["video_id"], row["frame"]))
    return processed


def query_frame(model, tokenizer, image_path: Path) -> str:
    image = Image.open(image_path).convert("RGB")
    answer = model.query(image, PROMPT, tokenizer)["answer"]
    return answer.strip()


def process_video(
    video_id: str,
    model,
    tokenizer,
    processed: set,
    writer,
) -> None:
    frames_dir = FRAMES_DIR / video_id
    all_frames = sorted(frames_dir.glob("*.jpg"))

    if not all_frames:
        print(f"[{video_id}] No frames found, skipping.")
        return

    unique_frames = select_unique_frames(all_frames)
    remaining = [f for f in unique_frames if (video_id, f.name) not in processed]

    if not remaining:
        print(f"[{video_id}] Already processed ({len(unique_frames)} unique frames), skipping.")
        return

    print(
        f"[{video_id}] {len(unique_frames)} unique / {len(all_frames)} total frames "
        f"— {len(remaining)} to process"
    )

    for i, path in enumerate(remaining, 1):
        try:
            response = query_frame(model, tokenizer, path)
        except Exception as e:
            print(f"  [{video_id}] {path.name} error: {e}", file=sys.stderr)
            response = "error"

        writer.writerow({
            "video_id": video_id,
            "frame": path.name,
            "response": response,
        })
        processed.add((video_id, path.name))

        if i % 10 == 0 or i == len(remaining):
            print(f"  [{video_id}] {i}/{len(remaining)}")

    print(f"[{video_id}] Done.")


def aggregate_results() -> None:
    """Build a per-video, per-component frame index and write to results.csv."""
    index: dict[str, dict[str, list[str]]] = {}

    with open(VLM_RESPONSES_CSV, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            vid = row["video_id"]
            frame = row["frame"]
            resp = row["response"].strip()
            if not resp or resp.lower() in ("none", "error"):
                continue
            for comp in parse_components(resp):
                index.setdefault(vid, {}).setdefault(comp, []).append(frame)

    with open(RESULTS_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["video_id", "component", "frame_count", "frames"])
        writer.writeheader()
        for vid in sorted(index):
            for comp, frames in sorted(index[vid].items(), key=lambda x: -len(x[1])):
                writer.writerow({
                    "video_id": vid,
                    "component": comp,
                    "frame_count": len(frames),
                    "frames": " | ".join(frames),
                })

    print(f"Results saved → {RESULTS_CSV.relative_to(ROOT)}")


def main() -> None:
    model, tokenizer = load_model()

    video_ids = sorted(d.name for d in FRAMES_DIR.iterdir() if d.is_dir())
    if not video_ids:
        print(f"No frame directories found in {FRAMES_DIR}")
        sys.exit(1)

    processed = load_processed_frames()

    is_new = not VLM_RESPONSES_CSV.exists()
    with open(VLM_RESPONSES_CSV, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["video_id", "frame", "response"])
        if is_new:
            writer.writeheader()

        for video_id in video_ids:
            try:
                process_video(video_id, model, tokenizer, processed, writer)
                f.flush()
            except Exception as e:
                print(f"[{video_id}] ERROR: {e}", file=sys.stderr)

    aggregate_results()


if __name__ == "__main__":
    main()
