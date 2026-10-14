# QA-App-Sesame

QA scoring and review tool for Sesame capture sessions — scores C0/T1 episodes against calibration and participant metrics. Radar scores come from each room's raw `.mmwave.bin`.

**Live app:** https://sm-centific.github.io/QA-App-Sesame/

## Status

Working prototype. Persistence is **live and shared** — scores read/write to a SharePoint Excel workbook (`tbl_qa_scores`) via three Power Automate flows (`QAACCESS_READ_URL`, `QASCORES_READ_URL`, `QASCORES_WRITE_URL`); see `docs/power-automate-spec.md` and `docs/power-automate-expression-notes.md` for how those were built. Access is gated by email against `tbl_qa_access` — the app is unusable until an authorized email signs in. `localStorage` still exists as an automatic fallback (every save writes there too) so a network hiccup never loses data, it just doesn't sync until the next successful write.

## What it does

Load a session's capture files (JSON/JSONL metadata + the capture videos) and score each scenario against the QA rubric, side-by-side with the actual footage:

- **C0** — calibration checklist (sync chirp, static/figure-8/translation motion sequence)
- **T1 rooms (×3)** — split into **Technical** (room-level: device placements, audio/video quality) and **Participant** (per-episode: continuous movement, Blue Zone %, orange zone, speed/distance variance)
- **Video annotations** — flag or comment on specific timestamps in a room's video, independent of the episode being scored
- **Session summary** — always-visible banner showing pass/fail across all four scenarios and the overall session gate

Continuous Movement, Blue Zone % and Outside view beyond 3 m % are set with a 0–100 meter rather than typed. The meter shows the pass zone (≥85% / ≥75%, or ≤10% for Outside view beyond 3 m), a tick where the radar put it, and an **adjusted · radar N** badge once a reviewer moves it away from the radar value. Drag it, click the track, or focus it and use the arrow keys; **Clear** empties it. Device Placements (a count) keeps its number box.

Speed Variance and Distance Variance are scored 1 / 2 / 3, where 3 is reserved for great, clearly natural variation. The radar's measured spread suggests a score (speed: 2 from 0.25 m/s, 3 from 0.5 m/s; distance: 2 from 0.5 m, 3 from 1.0 m — provisional cut points in `VARIANCE_BUCKETS`, `app.js`), and the note under each shows the measured value.

**Outside view beyond 3 m** replaced Orange Zone. The collection runbook asks people to make brief exits outside the 120° forward view, staying within 2 m, and to turn back before the 3 m line. Brief exits are expected, so they are no longer penalised (their share is shown in the item's note); the scored item is the time spent outside the view *and* past 3 m. Lower is better; ≤10% passes (`referenceValue` on the item in `app.js`). Older saved rows with an `orange_zone` value are ignored.

### Automated pre-fills (all reviewer-overridable)
- **Sync Chirp** — pass/fail from `session_evidence.json` (still a hard gate for C0)
- **C0 items** — from the C0 capture's `.mmwave.bin`. Moving the rig makes every static reflector in the room shift relative to the radar, so the clutter-subtracted background energy rises; at rest it settles back. Each frame is "rig moving" when that energy (1 s rolling median) is over 1.2× the at-rest level measured before the episode starts. **Static start / Static end** suggest 3 when the rig moved ≤10% of the first / last 5 s (2 if ≤40%); **Figure-8 / Translation** suggest 3 when it moved ≥50% of the middle (2 if ≥25%). The radar sees *that* the rig moved, not the shape, so the reviewer confirms those two on the video. Cut points in `C0_RIG`, `app.js`; checked on one real C0 capture so far (session 2fca9f97: 0% moving in the first and last 5 s, 68% in the middle). Needs the C0 `capture.json` so the `.bin` is recognised as C0.
- **Audio/Video Quality** — flagged from `session_validation.json`'s integrity issues
- **Radar scores** — continuous movement, blue zone, orange zone, speed variance, distance variance, and device placements are filled from each room's `.mmwave.bin`, from either an inspection report or files dropped by hand (see Radar scoring). Video-zone logs are not used.

## Files the app reads

Drop these in (any order, any filename — content is auto-classified):

| File | Scope | What it drives |
|---|---|---|
| `capture.json` | per scenario (×4) | room label, capture id, `startedAt` |
| `audit.json` | per scenario (×4) | expected-devices info line |
| `episode_markers.jsonl` | per capture (×4) | episode list, durations, retained/passed status |
| `session_evidence.json` | per session | Sync Chirp auto-verdict |
| `session_validation.json` | per session | Audio/Video Quality auto-flags |
| capture video (`.mp4`) | per capture | the player itself, for watching the capture while reviewing |
| `.mmwave.bin` | per room, required in the inspection report | the file the radar script reads to fill scores |


## Scoring model

- Every item converts to a 0–100 percentage before pooling — a real measurement (Blue Zone %) is never squeezed into a 1–3 bucket the way a manual judgment call is.
- **P0 threshold: ≥85%. P1 threshold: ≥75%.** Sync Chirp is a hard gate, not an averaged item — a failed chirp fails the scenario regardless of everything else.
- **Only the loaded session counts.** The room gate, the blended room figure and the Saved scores list use rows for the loaded session only, and the gate counts only episodes the operator retained — an excluded attempt never counts toward the minimum.
- **Room gate ≠ room average.** A room passes only if its Technical thresholds clear **and** at least **10 individually-passed episodes** exist (not just retained — actually passed their own P0/P1 thresholds). The blended average is shown separately as a quality figure; it never decides pass/fail on its own, so one bad episode can't hide inside a good-looking mean.
- **Session gate is strict** — all four scenarios (C0 + 3 rooms) must individually pass. No blended session average substitutes for this.
- Moderators see the same session rollup as anyone else — they own both Technical and Participant scoring, so there's no separate restricted view.

## Persistence & access

- **Sign-in:** enter your work email on load. Checked against `tbl_qa_access`; not authorized → no access to the app at all.
- **Scores:** shared across every reviewer via SharePoint, not per-browser. If the network or a flow call fails, the save still lands in `localStorage` as a fallback, and a warning-free retry happens automatically on the next successful save.
- **Reset scores to radar** sets aside every saved score for the loaded session and refills the forms from the radar and the other automatic suggestions (notes and video annotations are kept). Use it when old saved values hide the radar's numbers — for example a "3" saved back when Continuous Movement was a 1–3 scale now reads as 3%. Nothing changes in SharePoint until you press Save, which then overwrites the old rows; reload to back out. The app has no delete flow, so this is how a session is cleared.
- **Export all (.json)** / **Import (.json)** still exist — useful for backups, or moving work between devices in a pinch, independent of the live backend.

## Repo structure

```
index.html   — page structure
style.css    — all styling
app.js       — ingestion, scoring, rendering, persistence
docs/
  power-automate-spec.md              — spec for the backend (flows + Excel tables + access control) — implemented, not just a plan
  power-automate-expression-notes.md  — syntax gotchas learned building the flows (worth reading before touching them)
```

## Radar scoring

Blue Zone %, Outside view beyond 3 m %, Continuous Movement, Speed/Distance Variance and Device Placements are filled from each room's raw `.mmwave.bin`, and the C0 motion items from the C0 `.mmwave.bin`. Two ways in, both on the public site with nothing to install:

- **Inspection report** — drop the CSV under **Begin review**. The page downloads the listed `.bin`, episode markers, mmwave sync JSON, `capture.json`, audit, evidence and validation files from their blob links (`blob_path` + `sas_token`, or any full URL column) and streams each `.bin` through `radar_score.js` one frame at a time, so a multi-gigabyte room is never held in memory. Videos play from `video_preview_url`. **Needs CORS on the blob storage account** for `https://sm-centific.github.io` (GET/HEAD, any headers); without it the browser refuses the download and the status line says so.
- **Daily reports** — an inspection report is produced once a day and lists every session collected that day. When it lists more than one, the page shows a session picker; only the chosen session's files are downloaded, and the reviewer can switch session without re-uploading. A row's session comes from a `session_id` column, or else from the session UUID in its blob path (`…/<session-id>/phases/P02_scenarioRunner/raw/…`).
- **Manual files** — drop each room's `.mmwave.bin` together with its episode markers, mmwave sync JSON and `capture.json`. Files are matched to a room by capture id or room id in the filename (`c004`, `T1-R2`).

If `python3 scripts/review_server.py` is running and the app is opened from it, both paths hand the work to that server instead (it runs `scripts/extract_mmwave_diagnostics.py`; no CORS needed). The browser reader and the Python script give identical numbers — `scripts/test_radar_score.js` checks this.

Per-episode zone scores need the episode markers **and** the mmwave sync JSON for that room; without them only the room-wide reading is computed and the episode forms stay empty (the load log says which file was missing). All radar scores are suggestions the reviewer can change before Save; a saved value always wins over a fresh auto-fill.

### Tests

```
python3 scripts/make_zone_fixture.py /tmp/zone   # synthetic room: episode 1 in front, episode 2 to the side
node scripts/test_radar_score.js /tmp/zone       # browser reader == Python script
python3 scripts/test_review_start.py             # local review server end to end
python3 scripts/test_app_zones.py                # real page in headless Chromium, all four input paths
```
