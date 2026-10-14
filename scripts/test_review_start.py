#!/usr/bin/env python3
"""End-to-end check: inspection report -> file reads -> radar scores."""

import json
import os
import sys
import threading
import urllib.error
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from review_server import (  # noqa: E402
    BIN_LIMIT,
    prepare_review,
    ReviewHandler,
    ROOT,
    stream_body_to_file,
)


def build_fixture(directory):
    num_rx, num_chirps, num_samples = 3, 64, 128
    n_frames = 60
    range_bin = 40
    doppler_k = 4
    rng = np.random.default_rng(1)
    frames = rng.normal(0, 25, size=(n_frames, num_chirps, num_rx, num_samples))
    n = np.arange(num_samples)
    c = np.arange(num_chirps)
    phase = (2 * np.pi * range_bin * n[None, :] / num_samples) + (2 * np.pi * doppler_k * c[:, None] / num_chirps)
    tone = 8000.0 * np.cos(phase)
    for frame_idx in range(40, n_frames):
        frames[frame_idx] += tone[:, None, :]
    raw = np.clip(np.rint(frames), -32767, 32767).astype(">i2")
    (directory / "P02_scenarioRunner_c003.mmwave.bin").write_bytes(raw.tobytes())

    anchor = datetime(2026, 10, 13, 17, 0, 0, tzinfo=timezone.utc)
    sync = {"firstFrameReady": {"hostintrReadyUtc": anchor.isoformat().replace("+00:00", "Z")}}
    (directory / "P02_scenarioRunner_c003.mmwave_sync.json").write_text(json.dumps(sync))

    def stamp(seconds):
        return (anchor + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")

    markers = [
        {"type": "capture.episode.started", "episodeId": "ep-1", "episodeNumber": 1, "captureId": "c003", "roomLabel": "Room A", "ts": stamp(0.2), "captureElapsedMs": 200},
        {"type": "capture.episode.ended", "episodeId": "ep-1", "episodeNumber": 1, "captureId": "c003", "ts": stamp(1.5), "durationMs": 1300, "disposition": "retained", "invalidReasons": []},
        {"type": "capture.episode.started", "episodeId": "ep-2", "episodeNumber": 2, "captureId": "c003", "roomLabel": "Room A", "ts": stamp(3.8), "captureElapsedMs": 3800},
        {"type": "capture.episode.ended", "episodeId": "ep-2", "episodeNumber": 2, "captureId": "c003", "ts": stamp(6.0), "durationMs": 2200, "disposition": "retained", "invalidReasons": []},
    ]
    (directory / "P02_scenarioRunner_c003.episode_markers.jsonl").write_text("\n".join(json.dumps(row) for row in markers) + "\n")
    (directory / "P02_scenarioRunner_c003.capture.json").write_text(json.dumps({
        "sessionId": "env-hello-session",
        "scenarioId": "T1-R1",
        "roomLabel": "Room A",
        "artifacts": [{"file": "P02_scenarioRunner_c003.mp4"}],
        "episodeEligibility": {"retainedViewCount": 2},
    }))
    (directory / "P02_scenarioRunner_c001.capture.json").write_text(json.dumps({
        "sessionId": "env-hello-session",
        "scenarioId": "C0",
        "roomLabel": "Calibration",
        "artifacts": [{"file": "P02_scenarioRunner_c001.mp4"}],
        "episodeEligibility": {"retainedViewCount": 1},
    }))
    (directory / "session_evidence.json").write_text(json.dumps({
        "sessionId": "env-hello-session",
        "captures": [{
            "captureId": "c001",
            "status": "ok",
            "syncEvidence": [
                {"timing": {"role": "camera_detection", "verdict": "pass"}},
                {"timing": {"role": "ambimik_detection", "verdict": "pass"}},
                {"timing": {"role": "alignment", "verdict": "pass"}},
            ],
        }],
    }))
    (directory / "session_validation.json").write_text(json.dumps({
        "sessionId": "env-hello-session",
        "phases": {"P02_scenarioRunner": {"captures": [
            {"id": "c001", "issues": []},
            {"id": "c003", "issues": []},
        ]}},
    }))
    (directory / "T1-R1.audit.json").write_text(json.dumps({
        "stepId": "T1-R1",
        "expectedDevices": ["camera", "radar"],
        "requiredMask": ["camera"],
    }))
    (directory / "P02_scenarioRunner_c003.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42")
    (directory / "P02_scenarioRunner_c003.video_zone.jsonl").write_text(
        json.dumps({"time_s": 0.2, "azimuth_deg": 10, "in_blue_zone": True}) + "\n"
    )


def report_csv(base):
    rows = [
        ("T1-R1", "P02_scenarioRunner_c003.mmwave.bin", f"{base}/P02_scenarioRunner_c003.mmwave.bin", "", ""),
        ("T1-R1", "P02_scenarioRunner_c003.episode_markers.jsonl", f"{base}/P02_scenarioRunner_c003.episode_markers.jsonl", "", ""),
        ("T1-R1", "P02_scenarioRunner_c003.mmwave_sync.json", f"{base}/P02_scenarioRunner_c003.mmwave_sync.json", "", ""),
        ("T1-R1", "P02_scenarioRunner_c003.capture.json", f"{base}/P02_scenarioRunner_c003.capture.json", "", ""),
        ("C0", "P02_scenarioRunner_c001.capture.json", f"{base}/P02_scenarioRunner_c001.capture.json", "", ""),
        ("", "session_evidence.json", f"{base}/session_evidence.json", "", ""),
        ("", "session_validation.json", f"{base}/session_validation.json", "", ""),
        ("T1-R1", "T1-R1.audit.json", f"{base}/T1-R1.audit.json", "sv=test&sig=abc", ""),
        ("T1-R1", "P02_scenarioRunner_c003.mp4", "", "", f"{base}/P02_scenarioRunner_c003.mp4"),
        ("T1-R1", "P02_scenarioRunner_c003.video_zone.jsonl", f"{base}/P02_scenarioRunner_c003.video_zone.jsonl", "", ""),
    ]
    lines = ["session_id,scenario_id,filename,blob_path,sas_token,video_preview_url"]
    for scenario, name, blob, token, preview in rows:
        # The audit row uses blob_path + sas_token. Other rows put the full URL in blob_path.
        lines.append(f"env-hello-session,{scenario},{name},{blob},{token},{preview}")
    return "\n".join(lines) + "\n"


def assert_result(result):
    names = {item["name"] for item in result["files"]}
    expected = {
        "P02_scenarioRunner_c003.capture.json",
        "P02_scenarioRunner_c001.capture.json",
        "session_evidence.json",
        "session_validation.json",
        "T1-R1.audit.json",
        "P02_scenarioRunner_c003.episode_markers.jsonl",
    }
    missing = expected - names
    if missing:
        raise SystemExit(f"missing files: {sorted(missing)}")
    if result["sessionId"] != "env-hello-session":
        raise SystemExit(f"session id: {result['sessionId']}")
    if not result["videos"] or "c003" not in result["videos"][0]["name"]:
        raise SystemExit(f"video link missing: {result['videos']}")
    rooms = {room["scenarioId"]: room for room in result["radar"]}
    room = rooms.get("T1-R1")
    if not room or room["status"] != "ok":
        raise SystemExit(f"radar room failed: {result['radar']}")
    by_episode = {ep["episodeId"]: ep["scores"] for ep in room["episodes"]}
    blue = (by_episode.get("ep-2") or {}).get("blue_zone_pct") or {}
    if blue.get("value") != 100:
        raise SystemExit(f"expected ep-2 blue zone 100, got {by_episode}")
    movement = by_episode["ep-2"].get("continuous_movement") or {}
    if movement.get("value") is None:
        raise SystemExit(f"continuous movement missing: {by_episode['ep-2']}")
    placements = (room.get("technical") or {}).get("device_placements") or {}
    if placements.get("value") is None or placements["value"] != int(placements["value"]):
        raise SystemExit(f"device placements should be a whole number, got {room.get('technical')}")
    bins = result.get("binsRead") or []
    if len(bins) != 1 or not bins[0]["name"].endswith(".mmwave.bin") or not bins[0]["bytes"]:
        raise SystemExit(f"bin was not recorded as read: {bins}")
    if any(name.endswith("video_zone.jsonl") for name in names):
        raise SystemExit(f"video zone log was forwarded: {sorted(names)}")
    if not any("Radar scores come from this .bin" in line for line in result.get("log") or []):
        raise SystemExit(f"log does not say the .bin was scored: {result.get('log')}")
    print("prepare_review ok")
    print(f"  blue_zone_pct={blue['value']} continuous_movement={movement['value']} device_placements={placements['value']}")


def main():
    from pathlib import Path
    directory = Path("/tmp/review-fixture")
    directory.mkdir(parents=True, exist_ok=True)
    build_fixture(directory)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            name = os.path.basename(self.path.split("?", 1)[0])
            path = directory / name
            if not path.is_file():
                self.send_error(404)
                return
            data = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, fmt, *args):
            return

    fixture = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=fixture.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{fixture.server_address[1]}"
    csv_text = report_csv(base)
    result = prepare_review("inspection-report.csv", csv_text.encode())
    assert_result(result)

    review = ThreadingHTTPServer(("127.0.0.1", 0), ReviewHandler)
    review_thread = threading.Thread(target=review.serve_forever, daemon=True)
    review_thread.start()
    import urllib.request
    port = review.server_address[1]
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/review/start",
        data=csv_text.encode(),
        headers={"Content-Type": "text/plain", "X-Report-Name": "inspection-report.csv"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        body = json.loads(response.read().decode())
    assert_result(body)
    no_bin = "session_id,scenario_id,filename,blob_path\nenv-hello-session,T1-R1,P02_scenarioRunner_c003.capture.json," + base + "/P02_scenarioRunner_c003.capture.json\n"
    no_bin_request = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/review/start",
        data=no_bin.encode(),
        headers={"Content-Type": "text/plain", "X-Report-Name": "inspection-report.csv"},
        method="POST",
    )
    try:
        urllib.request.urlopen(no_bin_request, timeout=30)
        raise SystemExit("a report with no .bin was accepted")
    except urllib.error.HTTPError as exc:
        payload = json.loads(exc.read().decode())
        if exc.code != 400 or ".mmwave.bin" not in payload.get("error", ""):
            raise SystemExit(f"missing-bin error was not explicit: {exc.code} {payload}")
    index = urllib.request.urlopen(f"http://127.0.0.1:{port}/index.html", timeout=10).read().decode()
    if "Begin review" not in index or "reportInput" not in index or ".mmwave.bin" not in index:
        raise SystemExit("index.html does not require the radar .bin")
    if "video_zone" in index:
        raise SystemExit("index.html still asks for a video-zone log")
    app = urllib.request.urlopen(f"http://127.0.0.1:{port}/app.js", timeout=10).read().decode()
    if "beginReview" not in app or "unit === 'positions'" not in app or "integer ? '1'" not in app:
        raise SystemExit("app.js does not step device placements by 1")
    if "scoreDroppedFiles" not in app or "/api/review/upload" not in app or "/api/review/health" not in app:
        raise SystemExit("app.js does not stream a manually dropped .bin")
    if "Could not read ${file.name}" in app:
        raise SystemExit("app.js still hides a failed .bin read")
    if "streamed to disk" not in index:
        raise SystemExit("index.html does not explain that a dropped .bin is streamed to disk")
    if "ingestVideoZone" in app or "computeBlueZoneAuto" in app:
        raise SystemExit("video analyzer is still in app.js")
    if not ROOT.endswith("QA-App-Sesame") and not os.path.isdir(ROOT):
        raise SystemExit(f"unexpected root {ROOT}")
    health = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/api/review/health", timeout=10).read().decode())
    if health.get("ok") is not True:
        raise SystemExit(f"health check failed: {health}")
    print(f"HTTP review API ok on port {port}")
    if BIN_LIMIT < 5 * 1024 * 1024 * 1024:
        raise SystemExit(f"bin limit is below 5 GB: {BIN_LIMIT}")

    class ChunkReader:
        def __init__(self, payload):
            self.payload = payload
            self.offset = 0
            self.sizes = []

        def read(self, size):
            self.sizes.append(size)
            chunk = self.payload[self.offset:self.offset + size]
            self.offset += len(chunk)
            return chunk

    payload = b"abc123" * 1000
    reader = ChunkReader(payload)
    streamed = "/tmp/review-streamed.bin"
    written = stream_body_to_file(reader, len(payload), streamed, BIN_LIMIT, chunk_size=1000)
    if written != len(payload) or open(streamed, "rb").read() != payload:
        raise SystemExit("streamed upload did not match the source bytes")
    if any(size > 1000 for size in reader.sizes) or len(reader.sizes) < 6:
        raise SystemExit(f"upload was not read in small chunks: {reader.sizes}")
    print(f"streamed {written} bytes in {len(reader.sizes)} chunk(s)")

    import uuid
    upload_id = str(uuid.uuid4())
    manual_files = [
        "P02_scenarioRunner_c003.mmwave.bin",
        "P02_scenarioRunner_c003.episode_markers.jsonl",
        "P02_scenarioRunner_c003.mmwave_sync.json",
        "P02_scenarioRunner_c003.capture.json",
    ]
    for name in manual_files:
        data = (directory / name).read_bytes()
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/review/upload",
            data=data,
            headers={"X-Upload-Id": upload_id, "X-File-Name": name, "Content-Type": "application/octet-stream"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            uploaded = json.loads(response.read().decode())
        if uploaded.get("bytes") != len(data):
            raise SystemExit(f"upload size mismatch for {name}: {uploaded}")
    score_request = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/review/score",
        data=json.dumps({"uploadId": upload_id}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(score_request, timeout=120) as response:
        manual = json.loads(response.read().decode())
    manual_names = {item["name"] for item in manual["files"]}
    if "P02_scenarioRunner_c003.capture.json" not in manual_names:
        raise SystemExit(f"manual upload did not return the capture file: {sorted(manual_names)}")
    if "P02_scenarioRunner_c003.episode_markers.jsonl" not in manual_names:
        raise SystemExit(f"manual upload did not return episode markers: {sorted(manual_names)}")
    bins = manual.get("binsRead") or []
    if len(bins) != 1 or bins[0]["name"] != "P02_scenarioRunner_c003.mmwave.bin" or bins[0]["scenarioId"] != "T1-R1":
        raise SystemExit(f"manual bin was not matched to T1-R1: {bins}")
    room = {item["scenarioId"]: item for item in manual["radar"]}.get("T1-R1")
    blue = ((room or {}).get("episodes") or [{}])[-1].get("scores", {}).get("blue_zone_pct", {})
    if not room or room["status"] != "ok" or blue.get("value") != 100:
        raise SystemExit(f"manual radar score failed: {manual['radar']}")
    print("manual .bin upload scored")

    c004_bin = directory / "P02_scenarioRunner_c004.mmwave.bin"
    c004_bin.write_bytes((directory / "P02_scenarioRunner_c003.mmwave.bin").read_bytes())
    for src, dest in (
        ("P02_scenarioRunner_c003.episode_markers.jsonl", "P02_scenarioRunner_c004.episode_markers.jsonl"),
        ("P02_scenarioRunner_c003.mmwave_sync.json", "P02_scenarioRunner_c004.mmwave_sync.json"),
        ("P02_scenarioRunner_c003.capture.json", "P02_scenarioRunner_c004.capture.json"),
    ):
        text = (directory / src).read_text().replace("c003", "c004").replace("T1-R1", "T1-R2")
        (directory / dest).write_text(text)
    c004_id = str(uuid.uuid4())
    for name in (
        "P02_scenarioRunner_c004.mmwave.bin",
        "P02_scenarioRunner_c004.episode_markers.jsonl",
        "P02_scenarioRunner_c004.mmwave_sync.json",
        "P02_scenarioRunner_c004.capture.json",
    ):
        data = (directory / name).read_bytes()
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/review/upload",
            data=data,
            headers={"X-Upload-Id": c004_id, "X-File-Name": name, "Content-Type": "application/octet-stream"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            uploaded = json.loads(response.read().decode())
        if uploaded.get("name") != name:
            raise SystemExit(f"c004 upload rejected {name}: {uploaded}")
    score_request = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/review/score",
        data=json.dumps({"uploadId": c004_id}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(score_request, timeout=120) as response:
        c004 = json.loads(response.read().decode())
    c004_bins = c004.get("binsRead") or []
    if len(c004_bins) != 1 or c004_bins[0].get("scenarioId") != "T1-R2":
        raise SystemExit(f"c004 bin was not read: {c004_bins} log={c004.get('log')}")
    print("c004 .bin upload scored")
    fixture.shutdown()
    review.shutdown()


if __name__ == "__main__":
    main()
