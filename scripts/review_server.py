#!/usr/bin/env python3
"""Review server for the QA app.

Serves the static app and, when a reviewer uploads an inspection report,
downloads that session's files, runs extract_mmwave_diagnostics.py for each
room that has a radar .bin, and returns the metadata plus suggested scores.

GitHub Pages cannot run these scripts. Start this process instead of a
plain static file server:

    python3 scripts/review_server.py --bind 0.0.0.0 --port 8080
"""

import argparse
import csv
import io
import json
import mimetypes
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.realpath(os.path.join(os.path.dirname(__file__), ".."))
EXTRACT_SCRIPT = os.path.join(os.path.dirname(__file__), "extract_mmwave_diagnostics.py")
TEXT_LIMIT = 30 * 1024 * 1024
BIN_LIMIT = 2 * 1024 * 1024 * 1024
REPORT_LIMIT = 8 * 1024 * 1024
CAPTURE_RE = re.compile(r"_c(\d{3,})[._]", re.IGNORECASE)
SCENARIO_RE = re.compile(r"(?:^|[^A-Z0-9])(C0|T1-R\d+)(?:[^A-Z0-9]|$)", re.IGNORECASE)

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")


def log(msg):
    print(f"[review] {msg}", flush=True)


class ReportError(ValueError):
    pass


def normalize_key(key):
    return re.sub(r"[^a-z0-9]+", "_", (key or "").strip().lower()).strip("_")


def normalize_row(row):
    out = {}
    for key, value in row.items():
        norm = normalize_key(key)
        if not norm:
            continue
        out[norm] = "" if value is None else str(value).strip()
    return out


def rows_from_report(filename, raw):
    text = raw.decode("utf-8-sig")
    stripped = text.lstrip()
    if filename.lower().endswith(".json") or stripped.startswith("{") or stripped.startswith("["):
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ReportError(f"Inspection report is not valid JSON: {exc}") from exc
        if isinstance(data, dict):
            data = data.get("files") or data.get("rows") or data.get("value")
        if not isinstance(data, list) or not data or not isinstance(data[0], dict):
            raise ReportError("JSON inspection report must be a list of rows.")
        return [normalize_row(row) for row in data]
    try:
        rows = [normalize_row(row) for row in csv.DictReader(io.StringIO(text))]
    except csv.Error as exc:
        raise ReportError(f"Inspection report is not a valid CSV: {exc}") from exc
    if not rows:
        raise ReportError("Inspection report has no data rows.")
    return rows


def first_value(row, keys):
    for key in keys:
        value = row.get(key)
        if value:
            return value
    return ""


def filename_from_url(url):
    path = urllib.parse.urlparse(url).path
    name = os.path.basename(path)
    return urllib.parse.unquote(name)


def capture_id_from_name(name):
    match = CAPTURE_RE.search(name or "")
    return f"c{match.group(1)}" if match else ""


def scenario_id_from_name(name):
    match = SCENARIO_RE.search(name or "")
    if not match:
        return ""
    token = match.group(1).upper()
    return "C0" if token == "C0" else token


def row_filename(row, url):
    name = first_value(row, ("filename", "file_name", "file", "name", "blob_name"))
    if not name:
        blob = row.get("blob_path") or ""
        name = filename_from_url(blob) if blob.startswith("http") else os.path.basename(blob)
    if not name and url:
        name = filename_from_url(url)
    return name


def join_blob_url(blob, token):
    if not blob:
        return ""
    if not token or "sig=" in blob:
        return blob if blob.startswith("http") else ""
    token = token[1:] if token.startswith("?") else token
    joiner = "&" if "?" in blob else "?"
    if blob.startswith("http"):
        return blob + joiner + token
    return ""


def row_url(row):
    filename_hint = first_value(row, ("filename", "file_name", "file", "name", "blob_name"))
    preview = row.get("video_preview_url") or ""
    constructed = join_blob_url(row.get("blob_path") or "", row.get("sas_token") or "")
    is_video = filename_hint.lower().endswith((".mp4", ".mov", ".webm"))
    if is_video and preview.startswith("http"):
        return preview
    for key in ("url", "file_url", "sas_url", "download_url", "blob_url"):
        value = row.get(key) or ""
        if value.startswith("http"):
            return value
    if constructed:
        return constructed
    if preview.startswith("http"):
        return preview
    for value in row.values():
        if value.startswith("http"):
            return value
    return ""


def allowed_url(url):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return False
    host = parsed.hostname.lower().rstrip(".")
    if host in {"169.254.169.254", "metadata.google.internal"}:
        return False
    return True


def classify_name(name):
    lower = (name or "").lower()
    if lower.endswith(".mmwave.bin") or lower.endswith(".bin"):
        return "bin"
    if lower.endswith((".mp4", ".mov", ".webm")):
        return "video"
    return "download"


def sniff_text(name, text):
    stripped = text.lstrip()
    if stripped.startswith("{") or (name or "").lower().endswith(".json"):
        try:
            obj = json.loads(text)
        except json.JSONDecodeError:
            obj = None
        if isinstance(obj, dict):
            if obj.get("scenarioId") and obj.get("artifacts") and obj.get("episodeEligibility") is not None:
                return "capture", obj
            captures = obj.get("captures")
            if isinstance(captures, list) and captures and isinstance(captures[0], dict) and "syncEvidence" in captures[0]:
                return "evidence", obj
            phases = obj.get("phases") if isinstance(obj.get("phases"), dict) else {}
            runner = phases.get("P02_scenarioRunner") if isinstance(phases, dict) else None
            if isinstance(runner, dict) and isinstance(runner.get("captures"), list):
                return "validation", obj
            if obj.get("expectedDevices") and obj.get("stepId"):
                return "audit", obj
            if obj.get("firstFrameReady") or (
                isinstance(obj.get("segments"), list) and obj["segments"] and isinstance(obj["segments"][0], dict)
                and obj["segments"][0].get("firstFrameReady")
            ):
                return "sync", obj
    first = next((line for line in text.splitlines() if line.strip()), "")
    try:
        row = json.loads(first) if first else None
    except json.JSONDecodeError:
        row = None
    if isinstance(row, dict):
        if str(row.get("type") or "").startswith("capture.episode"):
            return "markers", None
        if "azimuth_deg" in row and "in_blue_zone" in row:
            return "video_zone", None
    return "other", None


def capture_id_from_manifest(obj, filename):
    for artifact in obj.get("artifacts") or []:
        if isinstance(artifact, dict):
            found = capture_id_from_name(artifact.get("file") or "")
            if found:
                return found
    return capture_id_from_name(filename)


def download(url, dest_path=None, limit=TEXT_LIMIT):
    if not allowed_url(url):
        raise RuntimeError(f"Refusing to fetch {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "qa-app-review"})
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            if dest_path:
                size = 0
                with open(dest_path, "wb") as handle:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > limit:
                            raise RuntimeError(f"File exceeded {limit} bytes")
                        handle.write(chunk)
                return size
            data = response.read(limit + 1)
    except urllib.error.URLError as exc:
        raise RuntimeError(str(exc.reason if hasattr(exc, "reason") else exc)) from exc
    if len(data) > limit:
        raise RuntimeError(f"File exceeded {limit} bytes")
    return data


def score_entry(value, note, coverage=None):
    entry = {"value": None if value is None else round(float(value), 4), "note": note}
    if coverage is not None:
        entry["coveragePct"] = round(float(coverage), 1)
    return entry


def scores_from_summary(summary, label):
    if not summary or not summary.get("frames_tracked"):
        return {}
    zones = summary.get("zone_pct_of_tracked_frames") or {}
    coverage = summary.get("pct_tracked")
    note = f"Radar extraction, {label}, tracked {summary.get('pct_tracked')}% of frames"
    return {
        "continuous_movement": score_entry(summary.get("continuous_movement_pct"), note, coverage),
        "blue_zone_pct": score_entry(zones.get("blue"), note, coverage),
        "orange_zone": score_entry(zones.get("orange"), note, coverage),
        "speed_variance": score_entry(summary.get("speed_variance_mps"), note + ", speed std m/s"),
        "distance_variance": score_entry(summary.get("distance_variance_m"), note + ", distance std m"),
    }


def technical_from_summary(summary):
    placements = (summary or {}).get("device_placements") or None
    if not placements or placements.get("estimated_distinct_positions") is None:
        return {}
    count = int(round(float(placements["estimated_distinct_positions"])))
    return {
        "device_placements": score_entry(
            count,
            f"Radar estimate of distinct positions, routing {placements.get('routing')}",
        )
    }


def run_extract(bin_path, episodes_path, sync_path, work_dir, scenario_id):
    out_csv = os.path.join(work_dir, f"{scenario_id}.diagnostics.csv")
    command = [sys.executable, EXTRACT_SCRIPT, bin_path, "--out", out_csv]
    if episodes_path and sync_path:
        command.extend(["--episodes", episodes_path, "--sync-json", sync_path])
    log(f"Running {' '.join(command)}")
    result = subprocess.run(command, capture_output=True, text=True, timeout=1800)
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "extraction failed")[-2000:]
        raise RuntimeError(tail.strip())
    summary_path = out_csv.rsplit(".csv", 1)[0] + ".summary.json"
    episodes_summary_path = out_csv.rsplit(".csv", 1)[0] + ".episodes.json"
    with open(summary_path) as handle:
        summary = json.load(handle)
    episodes_summary = None
    if os.path.exists(episodes_summary_path):
        with open(episodes_summary_path) as handle:
            episodes_summary = json.load(handle)
    return summary, episodes_summary


def pick_companion(items, bin_item):
    matches = [
        item for item in items
        if (bin_item["capture_id"] and item["capture_id"] == bin_item["capture_id"])
        or (bin_item["scenario_id"] and item["scenario_id"] == bin_item["scenario_id"])
    ]
    if matches:
        return matches[0]
    if len(items) == 1 and not bin_item["capture_id"] and not bin_item["scenario_id"]:
        return items[0]
    return None


def prepare_review(filename, raw):
    rows = rows_from_report(filename, raw)
    files_out = []
    videos_out = []
    radar_out = []
    messages = []
    downloaded = []

    for row in rows:
        url = row_url(row)
        name = row_filename(row, url)
        if not url or not name:
            messages.append(f"Skipped a report row with no file URL ({name or 'unnamed'}).")
            continue
        item = {
            "name": name,
            "url": url,
            "session_id": first_value(row, ("session_id", "sessionid")),
            "scenario_id": first_value(row, ("scenario_id", "scenario", "room", "room_id", "step_id")).upper(),
            "capture_id": first_value(row, ("capture_id", "capture")) or capture_id_from_name(name),
            "kind": classify_name(name),
            "text": None,
            "parsed": None,
        }
        if not item["scenario_id"]:
            item["scenario_id"] = scenario_id_from_name(name)
        downloaded.append(item)

    with tempfile.TemporaryDirectory(prefix="qareview_") as work_dir:
        for item in downloaded:
            if item["kind"] == "video":
                videos_out.append({"name": item["name"], "url": item["url"]})
                messages.append(f"Video {item['name']} left as a link for the player.")
                continue
            try:
                if item["kind"] == "bin":
                    dest = os.path.join(work_dir, os.path.basename(item["name"]))
                    size = download(item["url"], dest_path=dest, limit=BIN_LIMIT)
                    item["path"] = dest
                    item["size"] = size
                    messages.append(f"Read {item['name']} ({size:,} bytes). Radar scores come from this .bin.")
                else:
                    data = download(item["url"], limit=TEXT_LIMIT)
                    item["text"] = data.decode("utf-8-sig")
                    kind, parsed = sniff_text(item["name"], item["text"])
                    if kind == "video_zone":
                        messages.append(f"Ignored {item['name']}. Video-zone logs are not used. Scores come from each room's .mmwave.bin.")
                        item["kind"] = "ignored"
                        continue
                    item["kind"] = kind
                    item["parsed"] = parsed
                    if kind == "capture" and parsed:
                        item["scenario_id"] = item["scenario_id"] or parsed.get("scenarioId") or ""
                        item["capture_id"] = item["capture_id"] or capture_id_from_manifest(parsed, item["name"])
                        item["session_id"] = item["session_id"] or parsed.get("sessionId") or ""
                    messages.append(f"Read {item['name']} ({kind}).")
            except Exception as exc:
                messages.append(f"Could not read {item['name']}: {exc}")
                item["error"] = str(exc)

        captures = [item for item in downloaded if item["kind"] == "capture" and item.get("parsed")]
        for item in downloaded:
            if item["kind"] != "bin" or item.get("error") or not item.get("path"):
                continue
            if not item["scenario_id"]:
                for capture in captures:
                    if item["capture_id"] and capture["capture_id"] == item["capture_id"]:
                        item["scenario_id"] = capture["scenario_id"]
                        break
            scenario_id = item["scenario_id"] or item["capture_id"] or "UNKNOWN"
            markers = pick_companion([entry for entry in downloaded if entry["kind"] == "markers" and entry.get("text")], item)
            sync = pick_companion([entry for entry in downloaded if entry["kind"] == "sync" and entry.get("text")], item)
            markers_path = sync_path = None
            if markers and sync:
                markers_path = os.path.join(work_dir, os.path.basename(markers["name"]))
                sync_path = os.path.join(work_dir, os.path.basename(sync["name"]))
                with open(markers_path, "w") as handle:
                    handle.write(markers["text"])
                with open(sync_path, "w") as handle:
                    handle.write(sync["text"])
            elif markers or sync:
                messages.append(f"{scenario_id}: episode markers and sync JSON are both required, so episode scores were not sliced.")
            try:
                summary, episodes_summary = run_extract(item["path"], markers_path, sync_path, work_dir, scenario_id)
            except Exception as exc:
                radar_out.append({"scenarioId": scenario_id, "status": "error", "error": str(exc)})
                messages.append(f"{scenario_id}: radar extraction failed.")
                continue
            episodes = []
            for episode in (episodes_summary or {}).get("episodes") or []:
                episodes.append({
                    "episodeId": episode.get("episode_id"),
                    "scores": scores_from_summary(episode, f"episode {episode.get('episode_number')}"),
                })
            radar_out.append({
                "scenarioId": scenario_id,
                "status": "ok",
                "bin": {"name": item["name"], "bytes": item.get("size")},
                "technical": technical_from_summary(summary),
                "episodes": episodes,
            })
            messages.append(f"{scenario_id}: scored from {item['name']} ({item.get('size')} bytes), {len(episodes)} episode(s).")
            try:
                os.remove(item["path"])
            except OSError:
                pass

    read_bins = [item for item in downloaded if item["kind"] == "bin" and item.get("path") and not item.get("error")]
    if not read_bins:
        failed = [f"{item['name']}: {item.get('error') or 'not read'}" for item in downloaded if item["kind"] == "bin"]
        detail = (" " + "; ".join(failed)) if failed else ""
        raise ReportError(
            "No radar .mmwave.bin was read, so the script did not score this session. "
            "The inspection report must include each room's .mmwave.bin, episode markers, and mmwave sync JSON."
            + detail
        )

    for item in downloaded:
        if item["kind"] in {"capture", "evidence", "validation", "audit", "markers"} and item.get("text"):
            files_out.append({"name": item["name"], "text": item["text"]})

    session_ids = [item["session_id"] for item in downloaded if item.get("session_id")]
    return {
        "sessionId": session_ids[0] if session_ids else None,
        "files": files_out,
        "videos": videos_out,
        "radar": radar_out,
        "binsRead": [
            {"name": item["name"], "bytes": item.get("size"), "scenarioId": item.get("scenario_id") or None}
            for item in read_bins
        ],
        "log": messages,
    }


class ReviewHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        log(fmt % args)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/":
            path = "/index.html"
        rel = path.lstrip("/")
        full = os.path.realpath(os.path.join(ROOT, rel))
        if os.path.commonpath([ROOT, full]) != ROOT or not os.path.isfile(full):
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as handle:
            data = handle.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path != "/api/review/start":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > REPORT_LIMIT:
            self._json(413, {"error": "Inspection report is missing or too large."})
            return
        raw = self.rfile.read(length)
        name = self.headers.get("X-Report-Name") or "report.csv"
        try:
            result = prepare_review(name, raw)
        except ReportError as exc:
            self._json(400, {"error": str(exc)})
            return
        except Exception as exc:
            log(f"Review failed: {exc}")
            self._json(500, {"error": "Radar review failed. See the server log for details."})
            return
        self._json(200, result)

    def _json(self, status, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    parser = argparse.ArgumentParser(description="Serve the QA app and run radar scoring from an inspection report.")
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.bind, args.port), ReviewHandler)
    log(f"QA review server on http://{args.bind}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("Stopped.")


if __name__ == "__main__":
    main()
