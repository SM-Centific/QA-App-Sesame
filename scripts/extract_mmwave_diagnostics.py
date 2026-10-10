#!/usr/bin/env python3
"""
Extract moving-target diagnostics from a raw TI IWRL6432 mmWave .bin capture.

What this does, per frame:
  1. Reshapes the raw ADC samples into (chirp, antenna, sample) using the
     byte ordering we confirmed empirically on the C0 capture.
  2. Runs a range-FFT (across samples) then a Doppler-FFT (across chirps).
  3. Subtracts a continuously-learned CLUTTER MAP (a coherent, complex
     running average of the Doppler-FFT output per range/Doppler cell)
     before picking a peak, so a persistent static reflector gets properly
     cancelled rather than just having its exact zero-Doppler bin zeroed.
  4. Finds the strongest remaining peak, restricted to range bins past a
     configurable minimum, and reports its range, radial velocity, an SNR
     estimate, and the raw phase at each of the 3 antennas (for a later
     angle-of-arrival attempt -- this script does NOT compute azimuth yet,
     it just captures the raw numbers needed to attempt it).

--- Why this version changed from the original ---
Diagnostics pulled from 4 real captures (c002-c005) with the original
version showed ~99% of ALL frames reporting the exact same reading: range
~0.16m, velocity ~-5.82 m/s, with peak energy stable to within ~5% across
a 15+ minute capture. That's the signature of a fixed structural artifact
(almost certainly direct antenna leakage, since it sits right at the
radar's own near-field blind zone) winning the "strongest peak" search
every frame -- not a moving person several meters away. Two changes fixed
this:
  (a) a coherent clutter-map subtraction (classic radar MTI technique),
      which cancels a persistent static return far more completely than
      zeroing a few Doppler bins does, and
  (b) a minimum-range cutoff, since no real participant should be reading
      at ~0.16-0.5m for an extended period -- that range is the radar's
      own near-field, not the room.
Confirmed against real re-run data: stuck-frame rate dropped from ~99% to
4-11%, and range now spans a believable 0.8-4.9m with real variation.

This version adds AZIMUTH (angle) estimation, computed from the phase
differences already being captured between the 3 RX antennas, using
standard phase-interferometry (the antennas are a uniform linear array
spaced at lambda/2, which for THIS rig's actual 58.369GHz center
frequency -- confirmed from a real capture's radarProfile, not the generic
62GHz figure in TI's reference design doc -- is 2.568mm, about 6% more
than the generic figure). This matters because range alone cannot tell
"in front of the camera" from "behind it" -- Blue Zone vs Orange Zone are
defined by direction, not just distance, so azimuth is required to tell
them apart at all, not just to make the number more precise.

Output: one CSV next to the input file, one row per frame, same column
names as before (drop-in compatible with anything already built against
the old output) plus one new column, `clutter_warmed_up`, which is False
for the first --warmup frames while the clutter map is still learning --
treat those rows as unreliable and skip them downstream.

Usage:
    python3 extract_mmwave_diagnostics.py P02_scenarioRunner_c003.mmwave.bin

Requires: numpy   (pip install numpy)
"""

import sys
import os
import csv
import json
import argparse
import numpy as np
from datetime import datetime
from collections import deque


def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def find_first_frame_ready_utc(sync_json_path):
    """
    Extract the .bin's frame-0 reference timestamp from a capture's own
    sync/metadata JSON (mmwave_sync.json, mmwave.json, or
    mmwave_segments.json all carry this -- checked both the top-level shape
    and the nested segments[0] shape so any of the three works as input).
    Uses hostintrReadyUtc specifically, per this project's own documented
    alignment contract (mmwave_segments.json's alignmentContract.frameTimeField
    names this exact field as the preferred one for frame-level alignment,
    over the legacy decode-done utc).
    """
    with open(sync_json_path) as f:
        data = json.load(f)
    ffr = data.get("firstFrameReady")
    if ffr is None and "segments" in data and data["segments"]:
        ffr = data["segments"][0].get("firstFrameReady")
    if ffr is None:
        raise ValueError(
            f"Could not find 'firstFrameReady' in {sync_json_path} -- expected either a top-level "
            f"'firstFrameReady' key (mmwave_sync.json, mmwave.json) or 'segments'[0]['firstFrameReady'] "
            f"(mmwave_segments.json)."
        )
    return parse_ts(ffr["hostintrReadyUtc"])


def parse_episode_windows(episodes_path, sync_json_path, framerate):
    """
    Returns a list of episode windows, each a dict with: episode_id,
    episode_number, room_label, disposition, duration_ms,
    within_duration_tolerance, invalid_reasons, start_time_s, end_time_s --
    start_time_s/end_time_s are in the SAME time base as the diagnostics
    CSV's time_s column (seconds since the .bin's own frame 0), computed
    from each marker's absolute ts, NOT captureElapsedMs (confirmed against
    real data that captureElapsedMs uses a different, non-constant-offset
    origin -- using it directly would silently misalign every boundary).
    """
    anchor_utc = find_first_frame_ready_utc(sync_json_path)

    by_episode_id = {}
    with open(episodes_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            ev = json.loads(line)
            eid = ev.get("episodeId")
            if eid is None:
                continue
            by_episode_id.setdefault(eid, {})[ev["type"]] = ev

    windows = []
    for eid, pair in by_episode_id.items():
        started = pair.get("capture.episode.started")
        ended = pair.get("capture.episode.ended")
        if started is None or ended is None:
            continue  # incomplete pair -- skip rather than guess a boundary
        start_time_s = (parse_ts(started["ts"]) - anchor_utc).total_seconds()
        end_time_s = (parse_ts(ended["ts"]) - anchor_utc).total_seconds()
        windows.append({
            "episode_id": eid,
            "episode_number": started.get("episodeNumber"),
            "room_label": started.get("roomLabel"),
            "disposition": ended.get("disposition"),
            "duration_ms": ended.get("durationMs"),
            "within_duration_tolerance": ended.get("withinDurationTolerance"),
            "invalid_reasons": ended.get("invalidReasons", []),
            "start_time_s": start_time_s,
            "end_time_s": end_time_s,
        })
    windows.sort(key=lambda w: w["start_time_s"])
    return windows


def buffer_position_energy(episode_window, time_s, background_energy, tail_buf, head_buf, window_s):
    if episode_window is None:
        return
    eid = episode_window["episode_id"]
    if time_s >= episode_window["end_time_s"] - window_s:
        tail_buf[eid].append(background_energy)
    if time_s < episode_window["start_time_s"] + window_s:
        head_buf[eid].append(background_energy)


def find_episode_for_time(windows, time_s):
    """Linear scan is fine -- at most ~15-20 episodes per capture."""
    for w in windows:
        if w["start_time_s"] <= time_s < w["end_time_s"]:
            return w
    return None

# --- Radar profile constants (from radarProfile in this session's mmwave.json) ---
# These matched across every capture (c002-c005) we've seen, so they should be
# safe defaults. If a different capture uses a different radar config, override
# with the --numrx/--numchirps/--numsamples/etc flags below.
DEFAULTS = dict(
    num_rx=3,
    num_chirps=64,
    num_samples=128,
    frame_rate_hz=10.0,
    range_resolution_m=0.07786331709192154,
    doppler_resolution_mps=0.1819795409571315,
    # Confirmed from this rig's own mmwave.json radarProfile (c002/c003) --
    # NOT the 62GHz figure TI's generic reference design doc assumes.
    center_frequency_hz=58368640000.0,
)

SPEED_OF_LIGHT_MPS = 299792458.0


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("bin_path", help="path to the raw .mmwave.bin file")
    p.add_argument("--out", help="output CSV path (default: <bin_path>.diagnostics.csv)")
    p.add_argument("--stride", type=int, default=1, help="process every Nth frame (default 1 = every frame)")
    p.add_argument("--numrx", type=int, default=DEFAULTS["num_rx"])
    p.add_argument("--numchirps", type=int, default=DEFAULTS["num_chirps"])
    p.add_argument("--numsamples", type=int, default=DEFAULTS["num_samples"])
    p.add_argument("--framerate", type=float, default=DEFAULTS["frame_rate_hz"])
    p.add_argument("--rangeres", type=float, default=DEFAULTS["range_resolution_m"])
    p.add_argument("--dopplerres", type=float, default=DEFAULTS["doppler_resolution_mps"])
    p.add_argument("--centerfreq", type=float, default=DEFAULTS["center_frequency_hz"],
                   help="radar center frequency in Hz, used to derive antenna spacing (lambda/2) for "
                        "azimuth estimation. Default is THIS rig's confirmed value from a real capture's "
                        "radarProfile (58.369GHz) -- override if a different capture's radarProfile shows "
                        "a different centerFrequencyHz.")
    p.add_argument("--minrange", type=float, default=0.8,
                   help="ignore any range bin closer than this (meters) -- excludes the radar's own "
                        "near-field/antenna-coupling zone, which showed up as a dominant false 'peak' "
                        "at ~0.16-0.5m in real captures. Default 0.8m; raise it further if the artifact "
                        "still shows up, lower it if real close-range detections are being excluded.")
    p.add_argument("--clutter-alpha", type=float, default=0.98,
                   help="clutter-map learning rate (0-1). Higher = slower-adapting, more stable background "
                        "estimate; lower = adapts faster but may start treating a lingering person as "
                        "'background'. Default 0.98 (roughly a several-second time constant at 10fps).")
    p.add_argument("--warmup", type=int, default=30,
                   help="frames before the clutter map is trusted enough to use for peak-picking (default 30, "
                        "i.e. ~3s at 10fps). Rows before this are still written but flagged clutter_warmed_up=False.")
    p.add_argument("--gate-range-bins", type=int, default=4,
                   help="once locked onto a target, only search this many range bins on either side of its last "
                        "position (default 4, ~0.31m) -- this is what stops the peak-picker from jumping to an "
                        "unrelated loud reflection elsewhere in the room every frame.")
    p.add_argument("--gate-doppler-bins", type=int, default=5,
                   help="same idea, for Doppler/velocity (default 5, ~0.91 m/s either side of the last frame's "
                        "velocity).")
    p.add_argument("--acquire-min-snr", type=float, default=16.0,
                   help="minimum SNR (dB) required to START a new lock from a full-scene search (default 16). "
                        "Higher than --lock-min-snr on purpose: starting a lock has no prior trajectory to lean "
                        "on, so it needs stronger evidence than just continuing one.")
    p.add_argument("--lock-min-snr", type=float, default=12.0,
                   help="minimum SNR (dB) required to KEEP an existing lock within the gated search (default 12). "
                        "Lower than --acquire-min-snr on purpose (hysteresis) -- an already-tracked target doesn't "
                        "need as much re-proving each frame as a brand new one does.")
    p.add_argument("--blue-max-range", type=float, default=5.0,
                   help="Blue Zone: in front of the camera (within --frontal-half-angle) AND within this range in "
                        "meters (default 5.0, matching the rubric's documented Blue Zone boundary).")
    p.add_argument("--orange-max-range", type=float, default=3.0,
                   help="Orange Zone: BEHIND the frontal cone (outside --frontal-half-angle) AND within this range "
                        "in meters (default 3.0).")
    p.add_argument("--azimuth-smooth-frames", type=int, default=5,
                   help="trailing median window (in frames) applied to azimuth before computing position/speed "
                        "(default 5, ~0.5s at 10fps). Found necessary against real data: the range/Doppler gate "
                        "keeps range well-behaved (median frame-to-frame change ~0 while locked), but azimuth has "
                        "NO equivalent gate -- it comes from a separate phase measurement -- and swings wildly "
                        "frame to frame even while genuinely locked (median 5.7deg, but up to 172deg in a single "
                        "frame, in real test data). Smoothing dropped implied speed from an impossible mean of "
                        "~9 m/s down to a median of ~0.8 m/s. Raw azimuth_deg is still reported unsmoothed for "
                        "transparency; only x_m/y_m/delta/speed use the smoothed version. The window resets "
                        "(buffer cleared) on any tracking gap or fresh acquisition, so it never smooths across a "
                        "broken continuity.")
    p.add_argument("--frontal-half-angle", type=float, default=60.0,
                   help="the camera's frontal field of view, as +/- this many degrees from boresight (default 60, "
                        "matching the rig's documented 120 degree total FOV). Inside this angle AND close enough "
                        "= Blue Zone; outside it = Orange Zone territory.")
    p.add_argument("--episodes", type=str, default=None,
                   help="path to this capture's episode_markers.jsonl. When provided (together with "
                        "--sync-json), every frame gets tagged with which episode it falls into, and a "
                        "per-episode breakdown (same metrics as the whole-capture summary, scoped to each "
                        "episode's actual time window) is written to <out>.episodes.json.")
    p.add_argument("--position-window-s", type=float, default=2.0,
                   help="seconds of background_energy sampled at the tail of one episode and the head of the "
                        "next, compared to detect whether the scene's static background genuinely shifted "
                        "between them (a proxy for the device/camera having been repositioned). Default 2.0s.")
    p.add_argument("--position-shift-pct", type=float, default=5.0,
                   help="minimum %% change in median background_energy (tail of episode N vs head of episode "
                        "N+1) to count as a detected reposition. Default 5 -- calibrated against one real "
                        "session's 10 real gaps (9 showed +7%% to +30%% shift, one showed -1%%/noise-level), "
                        "not a large sample. Revisit if real sessions show this miscounting.")
    p.add_argument("--position-clear-margin", type=int, default=2,
                   help="a pass only auto-clears (routing='auto_clear') if the estimate is at least this much "
                        "ABOVE --min-positions (default 2, i.e. need 8+ when min-positions=6). Anything at or "
                        "just above the raw minimum still routes to manual review, same as an outright fail -- "
                        "given the known overcounting bias, a borderline pass isn't trustworthy enough to clear "
                        "automatically on its own.")
    p.add_argument("--min-positions", type=int, default=6,
                   help="minimum distinct positions required to pass Device Placements (default 6, per the "
                        "rubric). NOTE: this count is an ESTIMATE (detected shifts + 1) -- it can't tell a "
                        "genuinely new position apart from a revisit to an old one, so it tends to OVERcount, "
                        "never undercount, when revisits happen. A fail from this is trustworthy; a pass is "
                        "weaker evidence, not a guarantee of 6 truly distinct spots.")
    p.add_argument("--sync-json", type=str, default=None,
                   help="path to this capture's mmwave_sync.json, mmwave.json, or mmwave_segments.json -- "
                        "needed alongside --episodes to get the .bin's frame-0 reference timestamp "
                        "(firstFrameReady.hostintrReadyUtc), since episode markers are timestamped in absolute "
                        "UTC, not in the .bin's own frame-relative time. Required if --episodes is given.")
    return p.parse_args()


def estimate_azimuth_deg(phase_diff_1_deg, phase_diff_2_deg, wavelength_m, antenna_spacing_m):
    """
    Standard phase-interferometry angle-of-arrival. The PRIMARY (and only
    trusted) estimate uses the ant1-ant0 pair, spaced at exactly one antenna
    spacing (d = lambda/2) -- this spacing has a genuinely unambiguous range
    of +/-90 degrees, safely covering the full +/-60 degree FOV the zones
    need.

    theta = arcsin(phase_diff_rad * wavelength / (2*pi*d))

    The ant2-ant0 pair (double the baseline, 2d = one full wavelength) is
    tempting to also use for a sanity check or finer resolution, but DON'T
    average it in naively: that baseline's unambiguous range is only
    +/-30 degrees -- beyond that it wraps around and reports a plausible
    but WRONG angle (verified against a synthetic 30-degree test case: the
    short baseline correctly reported 30.0, the long baseline reported
    -30.0 -- confidently wrong, not just noisy). Using it correctly requires
    resolving which wrap matches the short-baseline estimate first, which
    is real but more involved than this coarse use case needs. It's still
    reported in the output (azimuth_baseline2_deg) for visibility/debugging,
    but intentionally excluded from the azimuth_deg estimate itself.
    """
    phase_diff_1_rad = np.radians(phase_diff_1_deg)
    arg1 = phase_diff_1_rad * wavelength_m / (2 * np.pi * antenna_spacing_m)
    reliable = abs(arg1) <= 1.0
    angle1 = np.degrees(np.arcsin(arg1)) if reliable else None

    # Reported for reference only -- NOT used in the azimuth_deg estimate,
    # see docstring above for why.
    phase_diff_2_rad = np.radians(phase_diff_2_deg)
    arg2 = phase_diff_2_rad * wavelength_m / (2 * np.pi * antenna_spacing_m * 2)
    angle2 = np.degrees(np.arcsin(arg2)) if abs(arg2) <= 1.0 else None

    return angle1, angle1, angle2, reliable


def new_accumulator():
    return {
        "total_frames": 0, "frames_tracked": 0, "frames_searching": 0,
        "zone_counts": {"blue": 0, "orange": 0, "neither": 0},
        "tracked_ranges_m": [], "implied_speeds_mps": [], "first_lock": None,
    }


def accumulate(acc, frame_idx, time_s, track_state, zone, peak_range_m, implied_speed_mps, azimuth=None):
    acc["total_frames"] += 1
    if track_state == "searching":
        acc["frames_searching"] += 1
        return
    acc["frames_tracked"] += 1
    acc["tracked_ranges_m"].append(peak_range_m)
    if zone in acc["zone_counts"]:
        acc["zone_counts"][zone] += 1
    if implied_speed_mps is not None:
        acc["implied_speeds_mps"].append(implied_speed_mps)
    if track_state == "acquired" and acc["first_lock"] is None:
        acc["first_lock"] = {
            "frame_index": frame_idx, "time_s": round(time_s, 3),
            "range_m": round(peak_range_m, 4) if peak_range_m is not None else None,
            "azimuth_deg": round(azimuth, 2) if azimuth is not None else None,
        }


def summarize_accumulator(acc, extra_fields=None):
    ranges, speeds = acc["tracked_ranges_m"], acc["implied_speeds_mps"]
    total = acc["total_frames"] or 1
    tracked_or_1 = acc["frames_tracked"] or 1
    zc = acc["zone_counts"]
    out = {
        "total_frames": acc["total_frames"],
        "frames_tracked": acc["frames_tracked"], "frames_searching": acc["frames_searching"],
        "pct_tracked": round(100 * acc["frames_tracked"] / total, 1),
        "pct_searching": round(100 * acc["frames_searching"] / total, 1),
        "zone_pct_of_tracked_frames": {
            "blue": round(100 * zc["blue"] / tracked_or_1, 1),
            "orange": round(100 * zc["orange"] / tracked_or_1, 1),
            "neither": round(100 * zc["neither"] / tracked_or_1, 1),
        },
        "distance_variance_m": round(float(np.std(ranges)), 4) if ranges else None,
        "mean_range_m": round(float(np.mean(ranges)), 4) if ranges else None,
        "median_range_m": round(float(np.median(ranges)), 4) if ranges else None,
        "speed_variance_mps": round(float(np.std(speeds)), 4) if speeds else None,
        "mean_speed_mps": round(float(np.mean(speeds)), 4) if speeds else None,
        "median_speed_mps": round(float(np.median(speeds)), 4) if speeds else None,
        "speed_iqr_mps": [round(float(np.percentile(speeds, 25)), 4), round(float(np.percentile(speeds, 75)), 4)] if speeds else None,
        "first_lock": acc["first_lock"],
    }
    if extra_fields:
        out.update(extra_fields)
    return out


def classify_zone(range_m, azimuth_deg, blue_max_range, orange_max_range, frontal_half_angle):
    """
    Blue Zone: in front of the camera (within the frontal half-angle) and
    close enough. Orange Zone: behind/to the side of that frontal cone, and
    within its own (closer) range. Deliberately coarse thresholds, not meant
    to be exact -- matches the "around the target thresholds" requirement
    rather than precise boundary detection.
    """
    if range_m is None or azimuth_deg is None:
        return ""
    in_front = abs(azimuth_deg) <= frontal_half_angle
    if in_front and range_m <= blue_max_range:
        return "blue"
    if (not in_front) and range_m <= orange_max_range:
        return "orange"
    return "neither"


def find_best_peak(mag, doppler_slice, range_slice):
    """
    Find the strongest bin within a restricted (doppler, range) search region
    instead of the whole scene. Returns (doppler_idx, range_idx, peak_energy)
    in ABSOLUTE bin coordinates, or None if the region is empty/all-zero.
    This is what makes gated tracking possible: the same function searches
    either a tiny region near a locked target, or the whole valid area when
    nothing is locked yet -- the caller decides which.
    """
    sub = mag[doppler_slice, range_slice]
    if sub.size == 0 or not np.any(sub > 0):
        return None
    d_idx, r_idx = np.unravel_index(np.argmax(sub), sub.shape)
    abs_d = (doppler_slice.start or 0) + d_idx
    abs_r = (range_slice.start or 0) + r_idx
    return abs_d, abs_r, float(mag[abs_d, abs_r])


def main():
    args = parse_args()

    if bool(args.episodes) != bool(args.sync_json):
        print("ERROR: --episodes and --sync-json must be given together (or neither).")
        sys.exit(1)

    episode_windows = []
    if args.episodes:
        episode_windows = parse_episode_windows(args.episodes, args.sync_json, args.framerate)
        print(f"Loaded {len(episode_windows)} episode window(s) from {args.episodes}, "
              f"anchored to frame-0 via {args.sync_json}.")
        for w in episode_windows:
            print(f"  Episode {w['episode_number']} ({w['room_label']}, {w['disposition']}): "
                  f"{w['start_time_s']:.2f}s - {w['end_time_s']:.2f}s")

    num_rx, num_chirps, num_samples = args.numrx, args.numchirps, args.numsamples
    frame_len_samples = num_rx * num_chirps * num_samples
    frame_len_bytes = frame_len_samples * 2  # int16 = 2 bytes

    file_size = os.path.getsize(args.bin_path)
    if file_size % frame_len_bytes != 0:
        print(f"WARNING: file size {file_size} is not an exact multiple of "
              f"frame size {frame_len_bytes} bytes ({file_size / frame_len_bytes:.3f} frames). "
              f"Trailing partial frame will be ignored. If this looks wrong, double-check "
              f"--numrx/--numchirps/--numsamples match this capture's radarProfile.")
    n_frames = file_size // frame_len_bytes
    print(f"File: {args.bin_path}")
    print(f"Size: {file_size:,} bytes -> {n_frames} frames "
          f"({frame_len_bytes} bytes/frame, {frame_len_samples} samples/frame)")

    # Memory-map so we never load the whole (possibly multi-GB) file into RAM at once.
    mm = np.memmap(args.bin_path, dtype=">i2", mode="r", shape=(n_frames, frame_len_samples))

    center_doppler = num_chirps // 2  # index of zero-Doppler after fftshift
    out_path = args.out or (args.bin_path + ".diagnostics.csv")

    min_range_bin = max(2, int(round(args.minrange / args.rangeres)))
    print(f"Minimum usable range bin: {min_range_bin} (={min_range_bin * args.rangeres:.3f}m) "
          f"-- bins below this are excluded from peak-picking entirely.")

    wavelength_m = SPEED_OF_LIGHT_MPS / args.centerfreq
    antenna_spacing_m = wavelength_m / 2
    print(f"Center frequency: {args.centerfreq/1e9:.3f} GHz -> wavelength {wavelength_m*1000:.3f}mm "
          f"-> antenna spacing (lambda/2) {antenna_spacing_m*1000:.3f}mm")

    # Coherent clutter map: complex running average of the Doppler-FFT output,
    # per (doppler_bin, antenna, range_bin) cell. A persistent static reflector
    # (including antenna coupling) converges to a stable complex value here and
    # gets subtracted out before peak-picking -- this is the standard radar MTI
    # (moving-target-indication) technique, and cancels a static return far more
    # completely than just zeroing a few bins near zero-Doppler.
    clutter_map = None

    # Gated tracker state. Once locked, each frame searches only a small
    # region near the last known position instead of the whole scene --
    # this is the fix for the frame-to-frame jumping problem found in real
    # data (only ~12% of consecutive frames agreed when searching the whole
    # scene every frame; the loudest reflection anywhere in the room kept
    # winning over the actual, sometimes-weaker, person). Two different SNR
    # bars are used on purpose (hysteresis): re-acquiring from scratch needs
    # stronger evidence (--acquire-min-snr) than continuing an existing,
    # already-trusted lock does (--lock-min-snr).
    locked = False
    last_doppler_idx = None
    last_range_idx = None

    # For frame-to-frame movement deltas (only computed between two
    # CONSECUTIVE "locked" frames -- see classify/writer section below for
    # why "acquired" always resets this, not just a full tracking gap).
    prev_x_m = prev_y_m = prev_range_m = prev_azimuth_deg = prev_time_s = None
    prev_was_locked = False

    # Trailing median smoothing buffer for azimuth -- cleared on any gap or
    # fresh acquisition so it never smooths across a broken continuity.
    azimuth_buffer = deque(maxlen=args.azimuth_smooth_frames)

    # Summary accumulators: one for the whole capture, plus one per episode
    # window (if --episodes was given) -- updated together, same helper,
    # every frame.
    summary = new_accumulator()
    episode_accumulators = {w["episode_id"]: new_accumulator() for w in episode_windows}
    # For Device Placements: buffer background_energy from the last
    # --position-window-s seconds of each episode (tail) and the first
    # --position-window-s seconds (head), to compare consecutive episodes'
    # steady-state scene level after the run -- a lasting shift is the
    # proxy signal for a genuine reposition (see module docstring section
    # on this for the full reasoning and its known bias).
    position_tail_energies = {w["episode_id"]: [] for w in episode_windows}
    position_head_energies = {w["episode_id"]: [] for w in episode_windows}

    rows_written = 0
    with open(out_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "frame_index", "time_s",
            "peak_range_m", "peak_velocity_mps",
            "peak_energy", "background_energy", "snr_db",
            "phase_ant0_deg", "phase_ant1_deg", "phase_ant2_deg",
            "phase_diff_ant1_minus_ant0_deg", "phase_diff_ant2_minus_ant0_deg",
            "azimuth_deg", "azimuth_smoothed_deg", "azimuth_baseline1_deg", "azimuth_baseline2_deg", "azimuth_reliable",
            "x_m", "y_m", "zone",
            "delta_range_m", "delta_azimuth_deg", "delta_position_m", "implied_speed_mps",
            "clutter_warmed_up", "track_state",
            "episode_number", "episode_id",
        ])

        for frame_idx in range(0, n_frames, args.stride):
            raw = np.asarray(mm[frame_idx], dtype=np.float64)
            cube = raw.reshape(num_chirps, num_rx, num_samples)
            cube = cube - cube.mean(axis=2, keepdims=True)  # remove per-chirp/antenna DC

            range_fft = np.fft.fft(cube, axis=2)                              # (chirp, ant, range_bin)
            doppler_fft = np.fft.fftshift(np.fft.fft(range_fft, axis=0), axes=0)  # (doppler, ant, range_bin)

            if clutter_map is None:
                clutter_map = doppler_fft.copy()
            else:
                clutter_map = args.clutter_alpha * clutter_map + (1 - args.clutter_alpha) * doppler_fft

            warmed_up = frame_idx >= args.warmup
            moving_only = doppler_fft - clutter_map if warmed_up else doppler_fft

            mag = np.abs(moving_only).mean(axis=1)  # average magnitude over antennas -> (doppler, range_bin)

            # still null the immediate zero-Doppler guard band too -- belt and
            # suspenders, cheap, and catches anything the clutter map hasn't
            # fully converged on yet during warm-up
            mag_moving = mag.copy()
            mag_moving[center_doppler - 1:center_doppler + 2, :] = 0

            # Background energy reference always comes from the FULL valid
            # region (not just the gate), so SNR stays comparable whether
            # we're gated or doing a full-scene search.
            full_range_slice = slice(min_range_bin, num_samples // 2)
            full_doppler_slice = slice(0, num_chirps)
            usable_full = mag_moving[:, min_range_bin:num_samples // 2]
            background_energy = float(np.median(usable_full[usable_full > 0])) if np.any(usable_full > 0) else 0.0

            candidate = None  # (doppler_idx, range_idx, peak_energy, snr_db)
            track_state = "searching"

            if locked:
                d_lo = max(0, last_doppler_idx - args.gate_doppler_bins)
                d_hi = min(num_chirps, last_doppler_idx + args.gate_doppler_bins + 1)
                r_lo = max(min_range_bin, last_range_idx - args.gate_range_bins)
                r_hi = min(num_samples // 2, last_range_idx + args.gate_range_bins + 1)
                gated = find_best_peak(mag_moving, slice(d_lo, d_hi), slice(r_lo, r_hi))
                if gated is not None:
                    d_idx, r_idx, peak_energy = gated
                    snr_db = 10 * np.log10(peak_energy / background_energy) if background_energy > 0 else float("nan")
                    if snr_db >= args.lock_min_snr:
                        candidate = (d_idx, r_idx, peak_energy, snr_db)
                        track_state = "locked"
                if candidate is None:
                    locked = False  # lock lost this frame -- fall through to a full re-acquisition search below

            if candidate is None and warmed_up:
                # Only attempt acquisition once the clutter map has had time
                # to converge. Real test data showed every single capture's
                # very first lock landing at frame 0 -- before any clutter
                # learning at all, which is exactly when a near-field
                # artifact is most likely to still win the search.
                glob = find_best_peak(mag_moving, full_doppler_slice, full_range_slice)
                if glob is not None:
                    d_idx, r_idx, peak_energy = glob
                    snr_db = 10 * np.log10(peak_energy / background_energy) if background_energy > 0 else float("nan")
                    if snr_db >= args.acquire_min_snr:
                        candidate = (d_idx, r_idx, peak_energy, snr_db)
                        track_state = "acquired"

            if candidate is not None:
                doppler_idx, range_idx, peak_energy, snr_db = candidate
                locked = True
                last_doppler_idx, last_range_idx = doppler_idx, range_idx

                peak_range_m = range_idx * args.rangeres
                peak_velocity_mps = (doppler_idx - center_doppler) * args.dopplerres

                complex_per_ant = doppler_fft[doppler_idx, :, range_idx]  # shape (num_rx,)
                phases_deg = np.degrees(np.angle(complex_per_ant))
                phase_diff_1 = ((phases_deg[1] - phases_deg[0] + 180) % 360) - 180
                phase_diff_2 = ((phases_deg[2] - phases_deg[0] + 180) % 360) - 180

                azimuth, az_b1, az_b2, az_reliable = estimate_azimuth_deg(
                    phase_diff_1, phase_diff_2, wavelength_m, antenna_spacing_m)

                time_s = frame_idx / args.framerate

                # "acquired" (whether a brand-new lock or a re-acquisition
                # after the gate failed) means spatial continuity with
                # whatever came before CANNOT be assumed -- even if it
                # happened on the very next frame with no "searching" gap
                # in between. Clear the smoothing buffer and break the delta
                # chain here, same as a full tracking gap does below.
                if track_state == "acquired":
                    azimuth_buffer.clear()
                    prev_x_m = prev_y_m = prev_range_m = prev_azimuth_deg = prev_time_s = None
                    prev_was_locked = False

                if azimuth is not None:
                    azimuth_buffer.append(azimuth)
                azimuth_smoothed = float(np.median(azimuth_buffer)) if azimuth_buffer else None

                # Position/delta/speed are computed from the SMOOTHED azimuth.
                # Found necessary against real data: range is well-behaved
                # under the gate (median frame-to-frame change ~0 while
                # locked), but azimuth has no equivalent gate and is noisy
                # enough on its own to imply impossible speeds otherwise.
                if azimuth_smoothed is not None:
                    az_rad = np.radians(azimuth_smoothed)
                    x_m = peak_range_m * np.sin(az_rad)
                    y_m = peak_range_m * np.cos(az_rad)
                else:
                    x_m = y_m = None

                zone = classify_zone(peak_range_m, azimuth_smoothed, args.blue_max_range,
                                      args.orange_max_range, args.frontal_half_angle)

                # Movement delta: only between two CONSECUTIVE "locked"
                # frames (gate-confirmed continuity on both sides) -- never
                # across a gap, and never across an "acquired" transition
                # either, since that's exactly the case where continuity
                # can't be assumed even though the frames are back-to-back.
                delta_range_m = delta_azimuth_deg = delta_position_m = implied_speed_mps = None
                if track_state == "locked" and prev_was_locked and prev_x_m is not None and x_m is not None:
                    dt = time_s - prev_time_s
                    delta_range_m = peak_range_m - prev_range_m
                    delta_azimuth_deg = azimuth_smoothed - prev_azimuth_deg
                    delta_position_m = float(np.hypot(x_m - prev_x_m, y_m - prev_y_m))
                    if dt > 0:
                        implied_speed_mps = delta_position_m / dt

                prev_x_m, prev_y_m = x_m, y_m
                prev_range_m, prev_azimuth_deg, prev_time_s = peak_range_m, azimuth_smoothed, time_s
                prev_was_locked = (track_state == "locked")

                episode_window = find_episode_for_time(episode_windows, time_s) if episode_windows else None
                accumulate(summary, frame_idx, time_s, track_state, zone, peak_range_m, implied_speed_mps, azimuth)
                if episode_window is not None:
                    accumulate(episode_accumulators[episode_window["episode_id"]],
                               frame_idx, time_s, track_state, zone, peak_range_m, implied_speed_mps, azimuth)
                buffer_position_energy(episode_window, time_s, background_energy,
                                        position_tail_energies, position_head_energies, args.position_window_s)

                writer.writerow([
                    frame_idx, round(time_s, 3),
                    round(peak_range_m, 4), round(peak_velocity_mps, 4),
                    round(peak_energy, 2), round(background_energy, 2), round(snr_db, 2),
                    round(phases_deg[0], 2), round(phases_deg[1], 2), round(phases_deg[2], 2),
                    round(phase_diff_1, 2), round(phase_diff_2, 2),
                    round(azimuth, 2) if azimuth is not None else "",
                    round(azimuth_smoothed, 2) if azimuth_smoothed is not None else "",
                    round(az_b1, 2) if az_b1 is not None else "",
                    round(az_b2, 2) if az_b2 is not None else "",
                    az_reliable,
                    round(x_m, 4) if x_m is not None else "",
                    round(y_m, 4) if y_m is not None else "",
                    zone,
                    round(delta_range_m, 4) if delta_range_m is not None else "",
                    round(delta_azimuth_deg, 2) if delta_azimuth_deg is not None else "",
                    round(delta_position_m, 4) if delta_position_m is not None else "",
                    round(implied_speed_mps, 4) if implied_speed_mps is not None else "",
                    warmed_up, track_state,
                    episode_window["episode_number"] if episode_window else "",
                    episode_window["episode_id"] if episode_window else "",
                ])
            else:
                # No confident detection this frame -- write the row with
                # blank measurement fields rather than a guess, so it's
                # honest about the gap instead of hiding it. Don't update
                # last_range_idx/last_doppler_idx; `locked` is already False.
                # A gap also breaks movement-delta continuity on purpose --
                # the next valid frame after this one should NOT compute a
                # delta against whatever was last seen possibly seconds ago.
                prev_x_m = prev_y_m = prev_range_m = prev_azimuth_deg = prev_time_s = None
                prev_was_locked = False
                azimuth_buffer.clear()

                time_s = frame_idx / args.framerate
                episode_window = find_episode_for_time(episode_windows, time_s) if episode_windows else None
                accumulate(summary, frame_idx, time_s, track_state, None, None, None)
                if episode_window is not None:
                    accumulate(episode_accumulators[episode_window["episode_id"]],
                               frame_idx, time_s, track_state, None, None, None)
                buffer_position_energy(episode_window, time_s, background_energy,
                                        position_tail_energies, position_head_energies, args.position_window_s)

                writer.writerow([
                    frame_idx, round(time_s, 3),
                    "", "", "", round(background_energy, 2), "",
                    "", "", "", "", "",
                    "", "", "", "", "",
                    "", "", "",
                    "", "", "", "",
                    warmed_up, track_state,
                    episode_window["episode_number"] if episode_window else "",
                    episode_window["episode_id"] if episode_window else "",
                ])
            rows_written += 1

            if rows_written % 500 == 0:
                print(f"  ...{rows_written} frames processed")

    print(f"Done. Wrote {rows_written} rows to {out_path}")

    # --- Device Placements (room-level, across episodes, not per-episode) ---
    device_placements = None
    if len(episode_windows) >= 2:
        gaps_detail = []
        shifts_detected = 0
        for i in range(len(episode_windows) - 1):
            ep_a, ep_b = episode_windows[i], episode_windows[i + 1]
            tail = position_tail_energies.get(ep_a["episode_id"], [])
            head = position_head_energies.get(ep_b["episode_id"], [])
            if not tail or not head:
                continue  # no data either side (e.g. both episodes were all-searching) -- skip, don't guess
            before, after = float(np.median(tail)), float(np.median(head))
            shift_pct = ((after - before) / before * 100) if before > 0 else None
            detected = shift_pct is not None and abs(shift_pct) >= args.position_shift_pct
            if detected:
                shifts_detected += 1
            gaps_detail.append({
                "from_episode": ep_a["episode_number"], "to_episode": ep_b["episode_number"],
                "background_before": round(before, 1), "background_after": round(after, 1),
                "shift_pct": round(shift_pct, 1) if shift_pct is not None else None,
                "reposition_detected": detected,
            })
        estimated_positions = shifts_detected + 1
        likely_pass = estimated_positions >= args.min_positions
        clearly_passes = estimated_positions >= (args.min_positions + args.position_clear_margin)
        device_placements = {
            "estimated_distinct_positions": estimated_positions,
            "min_required": args.min_positions,
            "likely_pass": likely_pass,
            "clearly_passes": clearly_passes,
            # Routing is the field to actually act on: only a clear pass
            # auto-clears. An outright fail AND a borderline pass (at or
            # just above min_required, within --position-clear-margin of
            # it) both route to manual review -- a borderline pass isn't
            # trustworthy enough to auto-clear on its own, given the known
            # overcounting bias below.
            "routing": "auto_clear" if clearly_passes else "manual_review",
            "caveat": (
                "This is an ESTIMATE (detected background-energy shifts between consecutive episodes, plus 1). "
                "It cannot distinguish a genuinely NEW position from a revisit to an old one -- both look like "
                "'the scene changed' from this signal alone -- so it tends to OVERcount distinct positions "
                "when revisits happen, never undercount for that reason. Treat a FAIL (estimate below "
                "min_required) as trustworthy; treat a PASS as weaker evidence, not a guarantee of truly "
                "distinct spots. Only a pass with real margin above the minimum (see 'routing') auto-clears; "
                "a borderline pass is routed to manual review same as a fail."
            ),
            "gaps": gaps_detail,
        }

    # --- Comprehensive summary ---
    config_fields = {
        "minrange_m": args.minrange, "clutter_alpha": args.clutter_alpha, "warmup_frames": args.warmup,
        "gate_range_bins": args.gate_range_bins, "gate_doppler_bins": args.gate_doppler_bins,
        "azimuth_smooth_frames": args.azimuth_smooth_frames,
        "acquire_min_snr_db": args.acquire_min_snr, "lock_min_snr_db": args.lock_min_snr,
        "blue_max_range_m": args.blue_max_range, "orange_max_range_m": args.orange_max_range,
        "frontal_half_angle_deg": args.frontal_half_angle,
        "center_frequency_hz": args.centerfreq, "antenna_spacing_mm": round(antenna_spacing_m * 1000, 4),
        "position_window_s": args.position_window_s, "position_shift_pct": args.position_shift_pct,
        "min_positions": args.min_positions, "position_clear_margin": args.position_clear_margin,
    }

    summary_out = summarize_accumulator(summary, extra_fields={
        "source_file": args.bin_path,
        "capture_duration_s": round(summary["total_frames"] / args.framerate, 2),
        "device_placements": device_placements,
        "config": config_fields,
    })
    # summarize_accumulator() doesn't know about source_file/capture_duration_s/config
    # ordering, so just re-key for a cleaner top-of-file read:
    summary_out = {
        "source_file": summary_out.pop("source_file"),
        "capture_duration_s": summary_out.pop("capture_duration_s"),
        "device_placements": summary_out.pop("device_placements"),
        **summary_out,
    }

    summary_path = out_path.rsplit(".csv", 1)[0] + ".summary.json"
    with open(summary_path, "w") as sf:
        json.dump(summary_out, sf, indent=2)

    episodes_summary_path = None
    if episode_windows:
        episodes_out = []
        for w in episode_windows:
            acc = episode_accumulators[w["episode_id"]]
            ep_summary = summarize_accumulator(acc, extra_fields={
                "episode_id": w["episode_id"], "episode_number": w["episode_number"],
                "room_label": w["room_label"], "disposition": w["disposition"],
                "duration_ms": w["duration_ms"], "within_duration_tolerance": w["within_duration_tolerance"],
                "invalid_reasons": w["invalid_reasons"],
                "start_time_s": round(w["start_time_s"], 3), "end_time_s": round(w["end_time_s"], 3),
            })
            episodes_out.append(ep_summary)
        episodes_summary_path = out_path.rsplit(".csv", 1)[0] + ".episodes.json"
        with open(episodes_summary_path, "w") as ef:
            json.dump({"source_file": args.bin_path, "episodes": episodes_out}, ef, indent=2)

    print("\n--- Summary ---")
    print(f"Tracked: {summary_out['pct_tracked']}% of frames "
          f"({summary_out['pct_searching']}% had no confident detection)")
    print(f"Zone split (of tracked frames): blue={summary_out['zone_pct_of_tracked_frames']['blue']}%  "
          f"orange={summary_out['zone_pct_of_tracked_frames']['orange']}%  "
          f"neither={summary_out['zone_pct_of_tracked_frames']['neither']}%")
    print(f"Distance variance: {summary_out['distance_variance_m']}m  "
          f"(mean range {summary_out['mean_range_m']}m, median {summary_out['median_range_m']}m)")
    print(f"Speed: mean {summary_out['mean_speed_mps']} m/s, std {summary_out['speed_variance_mps']} m/s  --  "
          f"median {summary_out['median_speed_mps']} m/s, IQR {summary_out['speed_iqr_mps']} m/s "
          f"(median/IQR are the more trustworthy figures here -- a residual noisy tail even after smoothing "
          f"skews the mean/std more than it should)")
    if device_placements:
        dp = device_placements
        print(f"Device Placements: ~{dp['estimated_distinct_positions']} estimated distinct position(s) "
              f"(need {dp['min_required']}, clear pass needs {dp['min_required']+args.position_clear_margin}) "
              f"-- routing: {dp['routing'].upper()}")
    if summary_out["first_lock"]:
        fl = summary_out["first_lock"]
        print(f"First lock: frame {fl['frame_index']} (t={fl['time_s']}s) at "
              f"range={fl['range_m']}m, azimuth={fl['azimuth_deg']}deg "
              f"-- worth a sanity check that this is a plausible spot for a person, not furniture/clutter.")
    else:
        print("First lock: NEVER ACQUIRED -- no frame in this entire capture reached the acquire-SNR threshold. "
              "Either nobody was in range, or --acquire-min-snr is too strict for this capture.")
    print(f"Full summary written to {summary_path}")
    if episodes_summary_path:
        print(f"Per-episode breakdown ({len(episode_windows)} episodes) written to {episodes_summary_path}")
    print("Send back the CSV plus the .summary.json" + (" and .episodes.json" if episodes_summary_path else "")
          + " -- the CSV should be small (a few hundred KB at most), no need to upload the .bin.")


if __name__ == "__main__":
    main()
