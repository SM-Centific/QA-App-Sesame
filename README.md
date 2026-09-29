# QA-App-Sesame

QA scoring and review tool for Sesame capture sessions — scores C0/T1 episodes against calibration and participant metrics, with automated checks from capture metadata and video-based zone detection.

**Live app:** https://sm-centific.github.io/QA-App-Sesame/

## Status

Working prototype. Persistence is **live and shared** — scores read/write to a SharePoint Excel workbook (`tbl_qa_scores`) via three Power Automate flows (`QAACCESS_READ_URL`, `QASCORES_READ_URL`, `QASCORES_WRITE_URL`); see `docs/power-automate-spec.md` and `docs/power-automate-expression-notes.md` for how those were built. Access is gated by email against `tbl_qa_access` — the app is unusable until an authorized email signs in. `localStorage` still exists as an automatic fallback (every save writes there too) so a network hiccup never loses data, it just doesn't sync until the next successful write.

## What it does

Load a session's capture files (JSON/JSONL metadata + the capture videos) and score each scenario against the QA rubric, side-by-side with the actual footage:

- **C0** — calibration checklist (sync chirp, static/figure-8/translation motion sequence)
- **T1 rooms (×3)** — split into **Technical** (room-level: device placements, audio/video quality) and **Participant** (per-episode: continuous movement, Blue Zone %, orange zone, speed/distance variance)
- **Video annotations** — flag or comment on specific timestamps in a room's video, independent of the episode being scored
- **Session summary** — always-visible banner showing pass/fail across all four scenarios and the overall session gate

### Automated pre-fills (all reviewer-overridable)
- **Sync Chirp** — pass/fail from `session_evidence.json`
- **Audio/Video Quality** — flagged from `session_validation.json`'s integrity issues
- **Blue Zone %** — computed directly from a video-zone detection log (see below), windowed to each episode's actual time range, with a detector-confidence figure shown alongside it

## Files the app reads

Drop these in (any order, any filename — content is auto-classified):

| File | Scope | What it drives |
|---|---|---|
| `capture.json` | per scenario (×4) | room label, capture id, `startedAt` |
| `audit.json` | per scenario (×4) | expected-devices info line |
| `episode_markers.jsonl` | per capture (×4) | episode list, durations, retained/passed status |
| `session_evidence.json` | per session | Sync Chirp auto-verdict |
| `session_validation.json` | per session | Audio/Video Quality auto-flags |
| capture video (`.mp4`) | per capture | the player itself |
| `*.video_zone.jsonl` | per capture (T1 only) | Blue Zone % auto-fill — see `extract_video_zone.py` |


## Scoring model

- Every item converts to a 0–100 percentage before pooling — a real measurement (Blue Zone %) is never squeezed into a 1–3 bucket the way a manual judgment call is.
- **P0 threshold: ≥85%. P1 threshold: ≥75%.** Sync Chirp is a hard gate, not an averaged item — a failed chirp fails the scenario regardless of everything else.
- **Room gate ≠ room average.** A room passes only if its Technical thresholds clear **and** at least **10 individually-passed episodes** exist (not just retained — actually passed their own P0/P1 thresholds). The blended average is shown separately as a quality figure; it never decides pass/fail on its own, so one bad episode can't hide inside a good-looking mean.
- **Session gate is strict** — all four scenarios (C0 + 3 rooms) must individually pass. No blended session average substitutes for this.
- Moderators see the same session rollup as anyone else — they own both Technical and Participant scoring, so there's no separate restricted view.

## Persistence & access

- **Sign-in:** enter your work email on load. Checked against `tbl_qa_access`; not authorized → no access to the app at all.
- **Scores:** shared across every reviewer via SharePoint, not per-browser. If the network or a flow call fails, the save still lands in `localStorage` as a fallback, and a warning-free retry happens automatically on the next successful save.
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

## Companion tools (not part of this repo, run locally)

- `extract_video_zone.py` — runs person detection on a capture's ERP video, outputs the `*.video_zone.jsonl` log this app ingests for Blue Zone %.
- `extract_mmwave_diagnostics.py` — raw mmWave `.bin` → range/velocity/phase diagnostics. Kept for reference from an earlier investigation into radar-based zone detection; the app itself no longer ingests mmWave tracks at all (dropped — unreliable, and heavy on memory for large sessions), superseded entirely by the video-based detector.
