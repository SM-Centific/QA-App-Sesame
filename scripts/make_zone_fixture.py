#!/usr/bin/env python3
"""Build a small synthetic room capture with known Blue/Orange Zone answers.

Episode 1: one target straight ahead (10 deg) at about 3.1 m -> Blue Zone.
Between episodes the target walks round to the side.
Episode 2: the target off to the side (75 deg) at about 1.9 m -> a brief
exit within 3 m (Orange), which is allowed.
Episode 3: the target off to the side beyond 3 m (75 deg, about 3.8 m) ->
"outside view beyond 3 m", which the runbook says not to linger in.

Also writes a C0 capture (c001): the rig rests, is moved for 10 s, and rests
again, inside one episode, so the rig-motion reading can be checked.

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
N_FRAMES = 420
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
    (290, 49, 75.0),  # walks out to ~3.8 m, still to the side -> outside_far
    (410, 49, 75.0),
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
    ("ep-3", 3, 30.0, 40.0),
]

C0_STEM = "P02_scenarioRunner_c001"
C0_FRAMES = 280
C0_EPISODE = (6.0, 26.0)   # seconds
C0_MOTION = (11.0, 15.0)   # rig moved inside this window, at rest otherwise (the radar needs ~2-3 s to settle after)


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


def build_c0_bin(path):
    """A room full of static reflectors, seen from a rig that is moved in
    the middle of the episode: every reflector's range and phase shift with
    the rig, so the clutter map cannot cancel them while it moves."""
    rng = np.random.default_rng(11)
    n = np.arange(NUM_SAMPLES)
    c = np.arange(NUM_CHIRPS)
    lam = 299792458 / 58368640000
    refl = [(rng.uniform(1.0, 4.6), rng.uniform(-80, 80), rng.uniform(40, 120)) for _ in range(60)]
    with open(path, "wb") as fh:
        for f in tqdm(range(C0_FRAMES), desc="C0 frames", unit="frame"):
            t = f / FRAME_RATE
            moving = C0_MOTION[0] <= t < C0_MOTION[1]
            d = 0.25 * math.sin(2 * math.pi * 0.6 * (t - C0_MOTION[0])) if moving else 0.0
            v = 0.25 * 2 * math.pi * 0.6 * math.cos(2 * math.pi * 0.6 * (t - C0_MOTION[0])) if moving else 0.0
            frame = rng.normal(0, 25, size=(NUM_CHIRPS, NUM_RX, NUM_SAMPLES))
            for r0, az, amp in refl:
                cos_az = math.cos(math.radians(az))
                r = r0 - d * cos_az
                k = (-v * cos_az) / 0.1819795409571315
                base = (2 * np.pi * (r / 0.07786331709192154) * n[None, :] / NUM_SAMPLES
                        + 2 * np.pi * k * c[:, None] / NUM_CHIRPS + 4 * math.pi * r / lam)
                for ant in range(NUM_RX):
                    frame[:, ant, :] += amp * np.cos(base + ant * math.pi * math.sin(math.radians(az)))
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

    build_c0_bin(out / f"{C0_STEM}.mmwave.bin")
    (out / f"{C0_STEM}.mmwave_sync.json").write_text(json.dumps({"firstFrameReady": {"hostintrReadyUtc": stamp(0)}}))
    c0_markers = [
        {"type": "capture.episode.started", "episodeId": "c0-ep", "episodeNumber": 1, "captureId": "c001",
         "ts": stamp(C0_EPISODE[0]), "captureElapsedMs": int(C0_EPISODE[0] * 1000)},
        {"type": "capture.episode.ended", "episodeId": "c0-ep", "episodeNumber": 1, "captureId": "c001",
         "ts": stamp(C0_EPISODE[1]), "durationMs": int((C0_EPISODE[1] - C0_EPISODE[0]) * 1000),
         "disposition": "retained", "invalidReasons": []},
    ]
    (out / f"{C0_STEM}.episode_markers.jsonl").write_text("\n".join(json.dumps(m) for m in c0_markers) + "\n")
    (out / f"{C0_STEM}.capture.json").write_text(json.dumps({
        "sessionId": SESSION, "scenarioId": "C0", "roomLabel": "Calibration",
        "artifacts": [{"file": f"{C0_STEM}.mp4"}], "episodeEligibility": {"retainedViewCount": 1},
    }))

    base = args.base_url.rstrip("/")
    lines = ["session_id,scenario_id,filename,blob_path,sas_token,video_preview_url"]
    for scen, stem in (("T1-R2", STEM), ("C0", C0_STEM)):
        for ext in (".mmwave.bin", ".episode_markers.jsonl", ".mmwave_sync.json", ".capture.json"):
            name = stem + ext
            lines.append(f"{SESSION},{scen},{name},{base}/{name},sv=test&sig=fixture,")
    (out / "inspection_report.csv").write_text("\n".join(lines) + "\n")
    print(f"Wrote fixture to {out}")


if __name__ == "__main__":
    main()
