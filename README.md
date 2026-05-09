# IoTutorMine

Extracts hardware components from YouTube IoT tutorial videos using computer vision. Given a video of an Arduino or Raspberry Pi tutorial, the pipeline identifies which components (sensors, displays, modules, etc.) were used throughout the project.

## Approach

Rather than using an expensive vision LLM on every frame, the pipeline uses **MobileCLIP-S2** — a fast, local image-text encoder — against a predefined IoT component taxonomy.

```
YouTube URL
    ↓  yt-dlp
Raw video (.mp4)
    ↓  ffmpeg @ 1fps
Frames (.jpg)
    ↓  MobileCLIP-S2
Per-frame component scores  →  frame_scores.csv
    ↓  aggregate (>5% of frames)
Per-video component list    →  results.csv
```

## Dataset

20 YouTube tutorials across two platforms and two difficulty levels:

| Category | Count |
|---|---|
| Arduino — Beginner | 8 |
| Arduino — Intermediate | 4 |
| Raspberry Pi — Beginner | 4 |
| Raspberry Pi — Intermediate | 4 |

Videos cover components including ultrasonic sensors, DHT11/22, PIR sensors, LCD displays, RFID modules, and more. Full list in `data/videos.csv`.

## Setup

**Prerequisites:** Python ≥ 3.10, [uv](https://github.com/astral-sh/uv), ffmpeg

```bash
brew install ffmpeg      # macOS
uv pip install -e .
```

## Usage

### 1. Download videos and extract frames

```bash
python data/download.py
```

Downloads all 20 videos to `data/raw/` and extracts frames at 1fps to `data/frames/`. Idempotent — already-downloaded videos and extracted frames are skipped.

### 2. Download the model

```bash
python models/download_mobileclip.py
```

Downloads the MobileCLIP-S2 checkpoint (~200MB) to `models/mobileclip_s2.pt`.

### 3. Run inference

```bash
python src/mobileclip2_approach/inference.py
```

Resumable — if interrupted, re-running picks up from the last processed frame.

**Outputs:**
- `src/mobileclip2_approach/frame_scores.csv` — raw per-frame component scores
- `src/mobileclip2_approach/results.csv` — final component list per video

## Project Structure

```
IoTutorMine/
├── data/
│   ├── videos.csv          # video metadata and URLs
│   ├── raw/                # downloaded .mp4 files (gitignored)
│   └── frames/             # extracted frames at 1fps (gitignored)
├── models/
│   ├── download_mobileclip.py
│   └── mobileclip_s2.pt    # model checkpoint (gitignored)
├── src/
│   └── mobileclip2_approach/
│       ├── inference.py
│       ├── frame_scores.csv
│       └── results.csv
└── pyproject.toml
```

## How MobileCLIP Works

MobileCLIP-S2 is an image-text encoder: it maps both images and text into the same vector space. For each frame, the pipeline computes cosine similarity between the frame embedding and each component label embedding, keeping the top-k matches above a confidence threshold. Components that appear in more than 5% of a video's frames are included in the final component list.

The component taxonomy (31 labels) covers common IoT hardware — boards, sensors, displays, communication modules, actuators, and passive components. Defined in `src/mobileclip2_approach/inference.py`.
