#!/usr/bin/env python3
"""
Reads videos.csv, downloads each video via yt-dlp, and extracts frames at 1fps using ffmpeg.

Setup:
    uv venv
    uv pip install yt-dlp
    # ffmpeg must be installed separately: brew install ffmpeg

Usage:
    python data/download.py
"""

import csv
import subprocess
import sys
from pathlib import Path

DATA_DIR = Path(__file__).parent
RAW_DIR = DATA_DIR / "raw"
FRAMES_DIR = DATA_DIR / "frames"
CSV_PATH = DATA_DIR / "videos.csv"
FPS = 1


def download_video(video_id: str, url: str) -> Path:
    output_path = RAW_DIR / f"{video_id}.mp4"
    if output_path.exists():
        print(f"[{video_id}] Already downloaded, skipping.")
        return output_path

    print(f"[{video_id}] Downloading...")
    subprocess.run(
        [
            "yt-dlp",
            "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            "--merge-output-format", "mp4",
            "-o", str(output_path),
            url,
        ],
        check=True,
    )
    return output_path


def extract_frames(video_id: str, video_path: Path) -> Path:
    frames_dir = FRAMES_DIR / video_id
    frames_dir.mkdir(parents=True, exist_ok=True)

    existing = list(frames_dir.glob("*.jpg"))
    if existing:
        print(f"[{video_id}] Frames already extracted ({len(existing)} frames), skipping.")
        return frames_dir

    print(f"[{video_id}] Extracting frames at {FPS}fps...")
    subprocess.run(
        [
            "ffmpeg", "-i", str(video_path),
            "-vf", f"fps={FPS}",
            "-q:v", "2",
            str(frames_dir / "%04d.jpg"),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    count = len(list(frames_dir.glob("*.jpg")))
    print(f"[{video_id}] Done — {count} frames saved to {frames_dir.relative_to(DATA_DIR.parent)}")
    return frames_dir


def main():
    RAW_DIR.mkdir(exist_ok=True)
    FRAMES_DIR.mkdir(exist_ok=True)

    with open(CSV_PATH, newline="", encoding="cp1252") as f:
        reader = csv.DictReader(f)
        videos = [
            (row["ID"].strip(), row["Direct YouTube URL"].strip())
            for row in reader
            if row["ID"].strip()
        ]

    print(f"Found {len(videos)} videos.\n")

    failed = []
    for video_id, url in videos:
        try:
            video_path = download_video(video_id, url)
            extract_frames(video_id, video_path)
        except subprocess.CalledProcessError as e:
            print(f"[{video_id}] ERROR: {e}", file=sys.stderr)
            failed.append(video_id)
        print()

    if failed:
        print(f"Failed: {', '.join(failed)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
