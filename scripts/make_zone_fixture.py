#!/usr/bin/env python3
"""Build a small synthetic room capture with known Blue/Orange Zone answers.

Episode 1: one target straight ahead (10 deg) at about 3.1 m -> Blue Zone.
Between episodes the target walks round to the side.
Episode 2: the target off to the side (75 deg) at about 1.9 m -> Orange Zone.

Writes the .mmwave.bin, episode markers, mmwave sync JSON, capture.json, and
an inspection-report CSV whose URLs point at --base-url.

    python3 scripts/make_zone_fixture.py OUT_DIR [--base-url http://127.0.0.1:8765]
"""

import argparse
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from tqdm import tqdm

NUM_RX, NUM_CHIRPS, NUM_SAMPLES = 3, 64, 128
FRAME_RATE = 10.0
N_FRAMES = 280
SESSION = "zone-fixture-session"
CAPTURE = "c004"
STEM = f"P02_scenarioRunner_{CAPTURE}"

# Target path as (frame, range bin, azimuth deg) keypoints; linear in between.
# The target walks, so it never jumps more than a bin or so per frame.
PATH = [
    (40, 40, 10.0),   # ~3.11 m, in front -> blue
    (140, 40, 10.0),
    (160, 25, 75.0),  # walks to ~1.95 m, to the side -> orange
    (260, 25, 75.0),
]


def target_at(frame):
    if frame < PATH[0][0] or frame >= PATH[-1][0]:
        return None
    for (f0, r0, a0), (f1, r1, a1) in zip(PATH, PATH[1:]):
        if f0 <= frame < f1:
            t = (frame - f0) / (f1 - f0)
            return r0 + t * (r1 - r0), a0 + t * (a1 - a0)
    return None
EPISODES = [
    ("ep-1", 1, 4.0, 14.0),
    ("ep-2", 2, 16.0, 26.0),
]


def build_bin(path):
    rng = np.random.default_rng(7)
    n = np.arange(NUM_SAMPLES)
    c = np.arange(NUM_CHIRPS)
    doppler_k = 4
    with open(path, "wb") as fh:
        for f in tqdm(range(N_FRAMES), desc="frames", unit="frame"):
            frame = rng.normal(0, 25, size=(NUM_CHIRPS, NUM_RX, NUM_SAMPLES))
            target = target_at(f)
            if target is not None:
                range_bin, az = target
                # Phase step between neighbouring antennas spaced lambda/2.
                ant_step = math.pi * math.sin(math.radians(az))
                # Phase drift across frames so the clutter map does not learn the target away.
                frame_drift = 2 * math.pi * 0.37 * f
                base = (2 * np.pi * range_bin * n[None, :] / NUM_SAMPLES) + \
                       (2 * np.pi * doppler_k * c[:, None] / NUM_CHIRPS) + frame_drift
                for ant in range(NUM_RX):
                    frame[:, ant, :] += 8000.0 * np.cos(base + ant * ant_step)
            fh.write(np.clip(np.rint(frame), -32767, 32767).astype(">i2").tobytes())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out_dir")
    ap.add_argument("--base-url", default="http://127.0.0.1:8765")
    args = ap.parse_args()
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    build_bin(out / f"{STEM}.mmwave.bin")

    anchor = datetime(2026, 10, 13, 17, 0, 0, tzinfo=timezone.utc)

    def stamp(sec):
        return (anchor + timedelta(seconds=sec)).isoformat().replace("+00:00", "Z")

    (out / f"{STEM}.mmwave_sync.json").write_text(json.dumps(
        {"firstFrameReady": {"hostintrReadyUtc": stamp(0)}}))
    markers = []
    for ep_id, num, t0, t1 in EPISODES:
        markers.append({"type": "capture.episode.started", "episodeId": ep_id, "episodeNumber": num,
                        "captureId": CAPTURE, "roomLabel": "Room B", "ts": stamp(t0),
                        "captureElapsedMs": int(t0 * 1000)})
        markers.append({"type": "capture.episode.ended", "episodeId": ep_id, "episodeNumber": num,
                        "captureId": CAPTURE, "ts": stamp(t1), "durationMs": int((t1 - t0) * 1000),
                        "disposition": "retained", "invalidReasons": []})
    (out / f"{STEM}.episode_markers.jsonl").write_text("\n".join(json.dumps(m) for m in markers) + "\n")
    (out / f"{STEM}.capture.json").write_text(json.dumps({
        "sessionId": SESSION, "scenarioId": "T1-R2", "roomLabel": "Room B",
        "artifacts": [{"file": f"{STEM}.mp4"}],
        "episodeEligibility": {"retainedViewCount": 2},
    }))

    base = args.base_url.rstrip("/")
    names = [f"{STEM}.mmwave.bin", f"{STEM}.episode_markers.jsonl",
             f"{STEM}.mmwave_sync.json", f"{STEM}.capture.json"]
    lines = ["session_id,scenario_id,filename,blob_path,sas_token,video_preview_url"]
    for name in names:
        lines.append(f"{SESSION},T1-R2,{name},{base}/{name},sv=test&sig=fixture,")
    (out / "inspection_report.csv").write_text("\n".join(lines) + "\n")
    print(f"Wrote fixture to {out}")


if __name__ == "__main__":
    main()
