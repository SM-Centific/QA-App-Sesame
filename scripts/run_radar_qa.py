#!/usr/bin/env python3
"""
Orchestrates radar QA extraction for one session, triggered by a
repository_dispatch event from Power Automate.

Expected client_payload shape (kept deliberately small -- GitHub's
client_payload has a hard 10-top-level-property cap, and a separate,
undocumented total-size limit that can throw "client_payload is too
large" -- nesting per-room data under one "rooms" array keeps this well
under both regardless of how many rooms a session has):

    {
      "session_id": "2fca9f97-7221-4447-b749-87eebba9e774",
      "rooms": [
        {
          "scenario_id": "T1-R1",
          "bin_url": "https://...blob.core.windows.net/.../c002.mmwave.bin?sv=...&sig=...",
          "episode_markers_url": "https://.../c002.episode_markers.jsonl?sv=...",
          "sync_json_url": "https://.../c002.mmwave_sync.json?sv=..."
        },
        ...
      ]
    }

Every URL above is expected to be a ready-to-use SAS link (as the
inspection report's Video_preview_url column already demonstrates) --
this script never authenticates to Azure or SharePoint itself, it just
does plain HTTPS downloads. That's a deliberate design choice: it means
this workflow needs ZERO Microsoft Graph/Azure credentials of its own,
only a webhook URL (and optional auth token) to post results back to.

For each room, in sequence (NOT in parallel -- this is what keeps peak
disk usage to roughly one .bin at a time, important since GitHub-hosted
runners have limited disk and some captures run 400MB+):
    1. Download the .bin, episode_markers.jsonl, and sync json.
    2. Run extract_mmwave_diagnostics.py against them.
    3. Read back its summary.json and episodes.json output.
    4. Delete the .bin (and the small sidecar files) immediately.
    5. Accumulate this room's results.

Once every room is processed, POST one combined result for the whole
session to the results webhook (a Power Automate HTTP-triggered flow --
not yet built as of this script's creation; see the module-level
RESULTS_WEBHOOK_URL / RESULTS_WEBHOOK_AUTH env vars below for what it
needs to accept).

Env vars expected:
    GITHUB_EVENT_PATH        -- set automatically by GitHub Actions;
                                 points at the JSON file containing the
                                 full repository_dispatch event,
                                 including client_payload.
    RESULTS_WEBHOOK_URL       -- where to POST the combined results.
    RESULTS_WEBHOOK_AUTH      -- optional bearer token / shared secret,
                                 sent as an Authorization header if set.
"""

import os
import sys
import json
import shutil
import subprocess
import tempfile
import urllib.request
import urllib.error

EXTRACT_SCRIPT = os.path.join(os.path.dirname(__file__), "extract_mmwave_diagnostics.py")


def log(msg):
    print(f"[run_radar_qa] {msg}", flush=True)


def download(url, dest_path, label):
    log(f"Downloading {label} -> {dest_path}")
    try:
        urllib.request.urlretrieve(url, dest_path)
    except urllib.error.URLError as e:
        raise RuntimeError(f"Failed to download {label} from its URL: {e}") from e
    size = os.path.getsize(dest_path)
    log(f"  {label}: {size:,} bytes")
    return size


def process_room(session_id, room, work_dir):
    """
    Returns a dict: {"scenario_id", "status", "summary"?, "episodes"?, "error"?}
    Never raises -- a failure on one room should not take down the whole
    session's processing; it's recorded and the next room still runs.
    """
    scenario_id = room.get("scenario_id", "UNKNOWN")
    log(f"=== Room {scenario_id} ===")

    bin_path = os.path.join(work_dir, f"{scenario_id}.mmwave.bin")
    episodes_path = os.path.join(work_dir, f"{scenario_id}.episode_markers.jsonl")
    sync_path = os.path.join(work_dir, f"{scenario_id}.mmwave_sync.json")
    out_csv = os.path.join(work_dir, f"{scenario_id}.diagnostics.csv")

    try:
        download(room["bin_url"], bin_path, f"{scenario_id} .bin")
        download(room["episode_markers_url"], episodes_path, f"{scenario_id} episode_markers.jsonl")
        download(room["sync_json_url"], sync_path, f"{scenario_id} sync json")

        cmd = [
            sys.executable, EXTRACT_SCRIPT, bin_path,
            "--out", out_csv,
            "--episodes", episodes_path,
            "--sync-json", sync_path,
        ]
        log(f"Running: {' '.join(cmd)}")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
        log(result.stdout[-4000:])  # extraction script prints a lot; keep the tail (summary) in logs
        if result.returncode != 0:
            log(f"STDERR: {result.stderr[-4000:]}")
            return {"scenario_id": scenario_id, "status": "error",
                    "error": f"extraction script exited {result.returncode}"}

        summary_path = out_csv.rsplit(".csv", 1)[0] + ".summary.json"
        episodes_summary_path = out_csv.rsplit(".csv", 1)[0] + ".episodes.json"
        with open(summary_path) as f:
            summary = json.load(f)
        episodes_summary = None
        if os.path.exists(episodes_summary_path):
            with open(episodes_summary_path) as f:
                episodes_summary = json.load(f)

        return {"scenario_id": scenario_id, "status": "ok", "summary": summary, "episodes": episodes_summary}

    except Exception as e:
        log(f"Room {scenario_id} failed: {e}")
        return {"scenario_id": scenario_id, "status": "error", "error": str(e)}

    finally:
        # Delete everything for this room immediately, success or failure --
        # this is the actual point of processing one room at a time: never
        # hold more than one room's files on disk.
        for p in (bin_path, episodes_path, sync_path, out_csv):
            if os.path.exists(p):
                os.remove(p)
        log(f"Cleaned up local files for {scenario_id}")


def post_results(payload):
    webhook_url = os.environ.get("RESULTS_WEBHOOK_URL")
    if not webhook_url:
        log("WARNING: RESULTS_WEBHOOK_URL not set -- printing results to stdout instead of posting.")
        print(json.dumps(payload, indent=2))
        return

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(webhook_url, data=data, method="POST",
                                  headers={"Content-Type": "application/json"})
    auth = os.environ.get("RESULTS_WEBHOOK_AUTH")
    if auth:
        req.add_header("Authorization", auth)
    log(f"POSTing combined results ({len(data):,} bytes) to results webhook")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            log(f"Webhook responded {resp.status}")
    except urllib.error.HTTPError as e:
        log(f"Webhook returned an error: {e.code} {e.read().decode(errors='replace')[:2000]}")
        raise
    except urllib.error.URLError as e:
        log(f"Could not reach results webhook: {e}")
        raise


def main():
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if not event_path or not os.path.exists(event_path):
        log("ERROR: GITHUB_EVENT_PATH not set or file missing -- this script expects to run inside a "
            "GitHub Actions job triggered by repository_dispatch.")
        sys.exit(1)

    with open(event_path) as f:
        event = json.load(f)
    payload = event.get("client_payload")
    if not payload:
        log("ERROR: no client_payload found on the triggering event.")
        sys.exit(1)

    session_id = payload.get("session_id")
    rooms = payload.get("rooms", [])
    if not session_id or not rooms:
        log(f"ERROR: payload missing session_id or rooms. Got: {json.dumps(payload)[:500]}")
        sys.exit(1)

    log(f"Session {session_id}: {len(rooms)} room(s) to process")

    room_results = []
    with tempfile.TemporaryDirectory(prefix="radarqa_") as work_dir:
        for room in rooms:
            room_results.append(process_room(session_id, room, work_dir))

    failed = [r for r in room_results if r["status"] == "error"]
    if failed:
        log(f"WARNING: {len(failed)}/{len(rooms)} room(s) failed to process -- "
            f"results for those rooms will be missing, not guessed at.")

    combined = {"session_id": session_id, "rooms": room_results}
    post_results(combined)

    # Non-zero exit if EVERY room failed (genuinely nothing to show for this
    # run) -- but a partial success (some rooms ok, some failed) still exits
    # 0, since the results webhook already has what did succeed, and a
    # human can see exactly which room(s) failed in the posted payload
    # rather than the whole session silently vanishing from view.
    if len(failed) == len(rooms):
        log("ERROR: every room failed -- exiting non-zero.")
        sys.exit(1)

    log("Done.")


if __name__ == "__main__":
    main()
