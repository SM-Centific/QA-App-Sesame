# Project Sesame — QA Automation Handoff

Written for a fresh Claude session with no memory of the conversation that
produced this. Read this whole file before doing anything — several
sections exist specifically to stop you from re-discovering (or
re-breaking) things that took real iteration to get right the first time.

## 1. What this project is

Centific runs capture sessions for a client ("Project Sesame") where a
participant performs scripted scenarios in a room, recorded via a 360°
camera (Insta360 X5) and a TI IWRL6432AOP mmWave radar chip, in a session
folder structure like:

```
TestSession_.../<session_id>/phases/P02_scenarioRunner/raw/
```

Each session has one **C0** scenario (a calibration sequence: sync chirp,
static/figure-8/translation motion) plus a **variable number of T1 rooms**
(T1-R1, T1-R2, T1-R3, ... — NOT fixed at 3; this was a real app/script
change made partway through this project's history, see §4).

### The six-step pipeline
1. Sessions recorded
2. Uploaded to Azure Blob (`oslotestvideo.blob.core.windows.net`)
3. **Inspection reports** created — a CSV listing every file in the
   session, with direct blob URLs. Lands roughly once/day in SharePoint:
   `Oslo_Sesame_Moderators2` site → `Session Reports/Inspection Reports`
   folder. **As of the last check, this folder was still empty** — no
   report with real, populated `blob_path`/`sas_token`/`Video_preview_url`
   values has ever been available for genuine end-to-end testing. Check
   this folder first before assuming it's still empty.
4. **QA spot check** — this project's main focus. Originally designed as
   an automated pass/fail gate; **the client later decided every session
   gets human eyes on the video regardless of score** (see §6 — this
   descoped a meaningful amount of planned work, read that section before
   building anything gate-related).
5. Delivery to client (client agreed to a 24h delay to accommodate step 4)
6. Moderator feedback — random sampling of sessions (including ones that
   would have failed a QA check) for actual feedback to moderators, trying
   to keep sampling roughly even across moderators over time. **Explicitly
   paused/deprioritized** behind step 4 work; not built.

This project's own work is on steps 4 and 6, primarily 4.

## 2. Where everything lives

- **App repo**: `SM-Centific/QA-App-Sesame` on GitHub. Live at
  `https://sm-centific.github.io/QA-App-Sesame/`. Contains `index.html`,
  `app.js`, `style.css`, `docs/` (power-automate-spec.md,
  power-automate-expression-notes.md), and as of this handoff, should also
  contain `.github/workflows/radar-qa.yml` and `scripts/` (see §5).
- **Backend data**: SharePoint Excel workbook `tbl_qa_scores.xlsx`, site
  `Oslo_Sesame_Delivery`, folder `/Shared Documents/05_Data & Deliverables/Quality/`.
  Sheets: `Scores` (table `tbl_qa_scores`), `Session_feedback` (table
  `tbl_qa_session_feedback`), `helper_lists` (hidden — moderator
  name/email pairs for dropdowns).
- **Scorecard template**: `QA_Scorecard_Template.xlsx`, same folder, used
  by the moderator-feedback email flow. Sheets: `Scorecard`, `Episode Detail`
  (table `tbl_episode_detail`), `Flagged Moments` (table
  `tbl_flagged_moments`), `Rubric Guide`, and `tbl_scenario_breakdown`
  (added — see §4).
- **Scorecards folder**: `/Shared Documents/05_Data & Deliverables/Quality/Scorecards/`
  — where generated per-session scorecards land.
- **Production tracker**: `RR-Centific/Sesame-Tracker` on GitHub —
  **private repo, never got access**. A plain `web_fetch` 404s, no GitHub
  connector was available in this session. If you need its real schema,
  either ask the user to share it directly, or check whether a GitHub
  connector can be enabled this session.
- **Existing Power Automate flows** (built before and during this
  project): `QAACCESS_READ_URL`, `QASCORES_READ_URL`, `QASCORES_WRITE_URL`
  (upserts one row by `doc_id`), the scheduled "QA Moderator Feedback
  Email" flow, and a parallel branch added to that same flow that
  auto-syncs new `session_id`s from `tbl_qa_scores` into
  `tbl_qa_session_feedback` (adds a skeleton row with `feedback_sent: 0`
  for any session_id missing one).

## 3. Data model — read this before writing anything to tbl_qa_scores

Every saved score is one row in `tbl_qa_scores`, keyed by `doc_id`:

| kind | doc_id pattern |
|---|---|
| `c0` | `${sessionId}__C0__form` |
| `technical` (room-level) | `${sessionId}__${scenarioId}__technical` |
| `participant` (episode-level) | `${sessionId}__${scenarioId}__ep__${episodeId}` |
| `annotations` (flags/comments) | `${sessionId}__${scenarioId}__annotations` |

`payload_json` for a `participant`/`technical` row holds `scores: {...}`
(raw item values, see §4 for exactly what each item expects), `notes`,
`episodeNumber` (participant only), `p0Pct`/`p1Pct`/`overall` (computed
client-side), `savedAt`.

**`QASCORES_WRITE_URL` already does the correct upsert pattern** (get row
by `doc_id` → update if exists, else add). Any new automation writing
into this table should reuse that exact pattern, not reinvent it.

## 4. The QA app (`app.js` / `PopulateScorecard.ts` / template) — current state

### Rubric items, as they stand now (this is the END state — see the
### warning in §4b before trusting anything that sounds like "lower is
### better" for variance items)

```js
ITEMS_C0 = [sync_chirp(gate,P0), static_5s(scale,P0), figure_8(scale,P0),
            translation(scale,P0), static_end(scale,P0)]

ITEMS_TECHNICAL = [
  device_placements: percent, P0, direction: higher_is_better, referenceValue: 6, unit: 'positions',
  audio_quality: scale, P1,
  video_quality: scale, P1,
]

ITEMS_PARTICIPANT = [
  continuous_movement: percent, P0, direction: higher_is_better, unit: '%',
  blue_zone_pct:       percent, P1, direction: higher_is_better, unit: '%',
  orange_zone:         percent, P1, direction: lower_is_better,  unit: '%',
  speed_variance:      scale (1/2/3), P1,
  distance_variance:   scale (1/2/3), P1,
]
```

**2026-10-14 change:** Speed Variance and Distance Variance moved from raw
measurements (`percent` + `referenceValue` 5.0 m/s / 1.0 m) to a 1/2/3
reviewer scale, where 3 means great, clearly natural variation. The radar's
measured spread (std dev) still drives a suggested score via
`VARIANCE_BUCKETS` in `app.js` — speed: 2 from 0.25 m/s, 3 from 0.5 m/s;
distance: 2 from 0.5 m, 3 from 1.0 m. These cut points are provisional.
Rows saved before this change hold the raw measurement; the app converts
them with the same buckets on load, and new rows carry `scoreVersion: 2`.
`PopulateScorecard.ts` must make the same change (treat these two as
`scale`) or it will read a 1/2/3 as metres.

### `toPct(item, rawValue)` — identical logic in both `app.js` and
`PopulateScorecard.ts`, verified byte-for-byte identical by compiling and
running the TS logic standalone against the same test cases as the JS:

- Not `percent` kind (i.e. `scale`): `v / 3 * 100` (unchanged, original logic).
- `percent`, no `referenceValue`: the raw value already **is** the
  goodness %, if `higher_is_better`; otherwise `100 - v` (works because
  it's naturally 0–100 bounded — this is why Orange Zone's "≤25% is the
  pass point" falls out for free: `100-25=75`, exactly the P1 threshold).
- `percent`, with `referenceValue` (a raw physical measurement: m/s,
  meters, a position count): scaled so the reference value lands at
  *exactly* this item's own pass threshold (85% for P0, 75% for P1).
  `higher_is_better`: `threshold * (v / referenceValue)`, clamped 0-100.
  `lower_is_better`: `100 - ((100-threshold)/referenceValue) * v`, clamped
  0-100.

### 4a. `PopulateScorecard.ts` needed more than a copy-paste

Its old `toPct` only took a bare `kind` string, not the full item — several
call sites hardcoded `"scale"` by hand instead of looking up the real
item (this would have silently broken direction/referenceValue handling
for every converted item). Fixed via an `ITEM_BY_ID` lookup map; every
call site (`computeScores`, the per-episode `belowItems` check,
`device_placements`/`audio_quality`/`video_quality` pooling,
`continuous_movement`, the room-level blended P1 pool loop) now passes
the real item object.

### 4b. ⚠️ Direction mistake that was caught and fixed — don't re-introduce it

Speed Variance and Distance Variance were **initially** built as
`lower_is_better` (treating variance as "inconsistency = bad"). **This was
wrong and was corrected.** The actual intent: these measure *natural*
variation in movement — more is better, since a constant speed/distance
looks robotic/staged, not like real human behavior. The current
`direction: higher_is_better` + `referenceValue` setup is correct. If you
see any documentation, old Rubric Guide text, or old chat scrollback
describing these as "lower is better" or using the word "Variance" to
mean "inconsistency is bad" — that's the superseded, wrong version.

### 4c. App feature history (all shipped, chronological)

- **Autosave was built, then fully reversed.** The app went through a
  phase of per-keystroke/per-click autosave, then the user decided
  against it ("will probably add a lot of noise") — reverted to a single
  manual **Save** button. Don't re-add autosave without being asked.
- **Current save model**: one global Save button in the header (not
  per-section). Clicking it saves **every form touched this session**
  (everything currently sitting in `formCache`), not just the currently
  visible one — this was a deliberate fix after discovering the original
  single-form-only save silently lost data from other episodes scored
  earlier in the same session.
- Notes are captured on any navigation (episode/scope/scenario switch) and
  on any score-button click on the same screen, so typed-but-unsaved notes
  can't be silently destroyed by a re-render — this was a real, confirmed
  bug, not a hypothetical.
- Episode nav: selecting from the dropdown auto-seeks the video (no
  separate "jump to start" click needed); Prev/Next episode buttons exist,
  disabled at the first/last episode.
- **"Clear local cache" button** — wipes only the current session's
  `localStorage`/in-memory fallback (not SharePoint), confirm dialog,
  scoped so it can't nuke other sessions' local data.
- **Branding**: Centific logo (light-mode `centific_logo.png` navy text,
  dark-mode `centific_logo_white.png` white text, swapped via
  `prefers-color-scheme`), title "Project Sesame - QA", subtitle removed.
  Color scheme: `--accent` switched from the old teal to the existing
  blue; a new `--brand-pink` (`#cd128a` light / `#ec4fb0` dark, sampled
  directly from the logo) is used **only** for primary call-to-action
  buttons — semantic colors (pass=green/fail=red/warn=amber) were
  deliberately left untouched.
- **Variable rooms**: `SCENARIO_ORDER` (a fixed 4-element array) was
  replaced with `getIngestedRoomIds()`/`getIngestedScenarioIds()`, derived
  dynamically from whatever's actually been ingested. Session
  rollup/gating/banner/tabs all generalized to "however many rooms this
  session has," not assumed-3.
- `episodeNumber` is now actually saved in the participant payload (was a
  known, documented gap — `PopulateScorecard.ts` used to fall back to
  showing the raw `episode_id` because the number never made it into the
  saved record; fixed on both sides, with a fallback for pre-fix records).

### 4d. `PopulateScorecard.ts` / template history

- `deleteRowsAt`-based table clearing went through **three** failed
  attempts before landing on the real fix: capture a direct reference to
  the table's original sample row *before* adding anything, overwrite its
  cells directly via `Range.setValues()` for the first real row, and only
  use `addRow()` for subsequent rows. (Root cause of the original bug:
  Excel tables can never be emptied to zero rows — add-then-delete
  approaches kept hitting this, with one variant intermittently dropping
  a real row due to what's believed to be an Office Scripts batching/
  timing quirk between many sequential `addRow` calls and an immediate
  `deleteRowsAt`.) Applies to both `tbl_episode_detail` and
  `tbl_flagged_moments`.
- Scenario Breakdown converted from fixed cells (rows 20-23, assumed
  exactly 4 scenarios) to a real table (`tbl_scenario_breakdown`, same
  robust first-row-overwrite pattern), to support variable room counts.
  This also retired a long-standing cosmetic bug: a stray leftover
  formula-based row at row 19 (predating the Office Script automation)
  that caused every scorecard to show C0 twice.
- `Rubric Guide` sheet text needs manual updates to match the new rubric
  (device_placements/continuous_movement/orange_zone/speed_variance/
  distance_variance all changed from "Scale 1-3" to measured percentages,
  with the corrected higher-is-better direction for the two variance
  items). **Exact old→new text was given to the user twice in chat** (once
  with the wrong direction, once corrected) — it is NOT confirmed whether
  either version was actually applied to the live template file. Check
  before assuming this is done.

## 5. Radar extraction script — `extract_mmwave_diagnostics.py`

This went through many real iterations, each one catching something that
would have been wrong in production. Read the whole history before
touching this file — several "obvious" fixes were already tried and found
not to work.

**Current capabilities**: range/velocity/azimuth per frame, gated
tracking, zone classification (Blue/Orange/Neither), speed/distance
variance, Continuous Movement %, Device Placements estimate (with a
routing hint), episode-window slicing. Takes `--episodes` and
`--sync-json` as optional flags to produce per-episode breakdowns, not
just whole-capture.

### Iteration history (don't re-attempt the abandoned fixes)

1. **Original version**: simple peak-picking after nulling only the exact
   zero-Doppler bin ±1. Found via real data: ~99% of ALL frames across 4
   real captures reported the *exact same reading* — a static near-field
   antenna-coupling artifact winning the "strongest peak" search every
   frame, not the person.
2. **Fix**: a coherent clutter-map (complex exponential moving average)
   subtraction, plus a minimum-range cutoff (`--minrange`, default 0.8m).
   Validated: stuck-frame rate dropped from ~99% to single digits, real
   room-scale range distribution (0.8–4.9m) emerged.
3. **Azimuth added** via phase-interferometry on the ant1-ant0 baseline
   only. **Important, tested finding**: the ant2-ant0 baseline (double
   spacing) is ONLY unambiguous up to ±30° — using it for anything beyond
   that silently gives a confidently wrong angle (verified with a
   synthetic 30° test: short baseline correctly said 30.0, long baseline
   said -30.0). It's reported in output for transparency but deliberately
   excluded from the real azimuth estimate.
4. **Found**: even after the clutter fix, raw per-frame peak-picking still
   jumps between unrelated reflections — only ~12% of consecutive frames
   agreed on real data (physically impossible jumps like 2.6m of movement
   in 100ms). **Fix**: gated tracking — once locked, search only near the
   last known position; fall back to a full-scene search only if the
   gated search fails, with a HIGHER confidence bar required to
   (re)acquire (16dB) than to continue an existing lock (12dB) —
   deliberate hysteresis.
5. **Found**: all four real test files showed their very first lock at
   frame 0 — before the clutter map had any chance to learn the
   background. **Fix**: block acquisition entirely until the clutter map
   has warmed up (`--warmup`, default 30 frames).
6. **Found**: azimuth is noisy even while genuinely "locked" (the gate
   only constrains range/Doppler bins, nothing constrains angle) — median
   frame-to-frame azimuth change was reasonable (~5.7°) but with jumps up
   to 172° in a single frame, inflating implied speed to physically
   impossible values (mean ~9 m/s). **Fix**: a trailing median smoothing
   window on azimuth (`--azimuth-smooth-frames`, default 5), used for
   position/zone/speed/delta calculations; raw azimuth kept as its own
   column for transparency. This dropped median implied speed from
   impossible (~9 m/s) to plausible walking pace (0.8–1.5 m/s) on real data.
7. **Found and fixed a related bug**: a "reacquired" frame (gate failed,
   then a fresh global search succeeded in the same frame) was still
   computing a position delta against the stale pre-gap position, even
   though continuity can't be assumed across that kind of transition.
   Fixed: deltas only computed between two **consecutive "locked"**
   frames, never across any gap or any "acquired" event.
8. **Zone classification** added: Blue (within `--frontal-half-angle`,
   default 60°, and `--blue-max-range`, default 5.0m) / Orange (outside
   that cone, within `--orange-max-range`, default 3.0m) / Neither. Uses
   the *smoothed* azimuth (same reasoning as above — raw azimuth was
   initially used here too and caused individual frames to flicker
   between zones on noise).
9. **Episode-window slicing**: `--episodes` + `--sync-json`.
   **Critical, hard-won finding**: `episode_markers.jsonl`'s
   `captureElapsedMs` field does **NOT** share the same zero-point as the
   `.bin`'s own frame 0 — verified directly against real data (off by
   ~700ms-1.1s, not a constant offset, varies per capture based on device
   startup timing). The correct approach: use each marker's own absolute
   `ts` field, minus `firstFrameReady.hostintrReadyUtc` from that
   capture's own `mmwave_sync.json`/`mmwave.json`/`mmwave_segments.json`
   (per this project's own documented alignment contract — `hostintrReadyUtc`
   is explicitly the field it names as correct for this, not the "legacy"
   decode-done `utc`). **Validated**: computed episode durations from this
   method matched the device's own independently-reported `durationMs` to
   within 0.05s across 11 real episodes, zero mismatches.
10. **Device Placements** (radar proxy): compares background_energy in the
    tail of episode N vs the head of episode N+1 (`--position-window-s`,
    default 2.0s each side; `--position-shift-pct`, default 5%, calibrated
    against only ONE real session's 10 gaps — 9 showed +7% to +30% shift,
    one showed -1%/noise). `estimated_distinct_positions = detected_shifts + 1`.
    **Known, important bias, documented in the code's own output**: this
    can only tell "the scene changed since the immediately preceding
    episode" — it cannot distinguish a genuinely new position from a
    revisit to an old one, so it tends to **overcount**, never undercount.
    Because of this, a `routing` field (`auto_clear` / `manual_review`)
    was added with a margin (`--position-clear-margin`, default 2) — only
    an estimate comfortably above the minimum auto-clears; a borderline
    pass (at or just above the minimum) routes the same as an outright
    fail. **This routing distinction is now just a reviewer hint, not a
    gate** — see §6, the client wants human eyes on every video regardless.
11. **Continuous Movement %**: fraction of *tracked* frames (not raw total
    — consistent with not penalizing the radar's own tracking gaps) with
    smoothed implied speed above `--moving-speed-threshold` (default 0.3
    m/s). **Known caveat, confirmed via synthetic test**: even a
    perfectly static synthetic target showed ~16.7%, not 0%, from
    residual azimuth noise. Worth keeping in mind when interpreting real
    scores against the 75% target — there's likely a noise floor of
    roughly 15-20% baked in.

All of the above was validated using **real diagnostic CSVs from real
captures (c002-c005)** sent back by the user after each fix, re-run
through the actual shipped functions (not reimplemented test logic) where
possible — this is a script with a genuine, multi-round empirical
validation history, not just unit-tested logic.

## 6. The big descope — read this before building any gate/routing logic

The client decided: **every session gets human eyes on the video,
regardless of automated score.** This happened partway through building
toward an automated pass/fail gate, and genuinely changes what's left to
build:

- **No auto pass/fail gate needed.** No egregious-flag routing logic
  (zero-locks-for-whole-room check, corrupted-`.bin` check,
  duration-mismatch check) needs to feed an automated decision anymore.
- **`device_placements.routing`** (auto_clear/manual_review) is now just a
  hint for the reviewer to look twice at a borderline session — not a gate.
- **No new sign-off UI needed in the app.** The existing Save button
  already is the sign-off — a reviewer watches the video, edits scores if
  needed, saves. Done.
- The tracker's purpose is now unclear — it was originally meant for a
  "mark ready for delivery" column driven by the auto-gate, which no
  longer exists in that form. **Before building any tracker integration,
  reconsider what signal it would actually want now** (possibly just "has
  this session been scored at all," not "did it pass").

**What this means automation's job actually is now: just pre-populate
scores so the reviewer finds them already there.** Nothing more.

## 7. GitHub Actions automation — built AND validated on real infrastructure

This is further along than the Power Automate side (see §8). Files (in
the app repo, `.github/workflows/radar-qa.yml` and `scripts/`):

- `radar-qa.yml` — triggers on `repository_dispatch`, event type
  `inspection-report-ready`.
- `run_radar_qa.py` — orchestrator. Expects `client_payload` shaped:
  ```json
  {"session_id": "...", "rooms": [{"scenario_id": "T1-R1", "bin_url": "...",
    "episode_markers_url": "...", "sync_json_url": "..."}]}
  ```
  Processes rooms **one at a time** (confirmed structurally, not just by
  intent — explicit cleanup in a `finally` block regardless of success):
  download all 3 files → run `extract_mmwave_diagnostics.py` as a
  subprocess → read back `summary.json`/`episodes.json` → delete local
  files immediately → next room. One room failing doesn't stop the rest
  (`"status": "error"` recorded, next room still runs). POSTs a combined
  per-session result to `RESULTS_WEBHOOK_URL` (a GitHub secret; falls back
  to printing to the Actions log if unset, so this is testable before the
  receiving flow exists).
- `extract_mmwave_diagnostics.py` — the radar script itself, copied in so
  the workflow can call it directly.

**Design note worth knowing**: `client_payload` has a hard 10-top-level-
property cap plus a separate, undocumented total-size limit — this is why
the payload nests all rooms under one `rooms` array (counts as 1 property
regardless of room count) rather than flattening per-room fields. SAS
URLs are used directly (self-authorizing), so this workflow needs **zero**
Microsoft Graph/Azure credentials of its own.

**Validated for real**: the user manually triggered this via a real
GitHub PAT and PowerShell's `Invoke-RestMethod`, confirmed a real run
fired on github.com, and confirmed it failed exactly as expected (a clean
404 on a fake test URL, correct logging, correct cleanup) — this was
tested on actual GitHub infrastructure, not just local sandbox simulation.

**Security note**: during this process, the user accidentally pasted two
real GitHub PATs directly into chat. Both were flagged for immediate
revocation in the moment. **Not independently confirmed that both were
actually revoked** — worth a quick check if security hygiene matters here.

**What's NOT done**: the Power Automate flow that would watch the
SharePoint inspection-reports folder and automatically call
`repository_dispatch` (currently this is triggered manually, by hand).
Also not done: a real end-to-end test with genuine blob URLs, since the
inspection-reports folder has never had a populated report in it.

## 8. Power Automate write-flow — PAUSED, explicit user decision

A flow to receive the GitHub Actions results and write them into
`tbl_qa_scores` was being designed (Apply-to-each over rooms → build a
JSON payload → Add a row), but the user said the design was "way too
complicated," and after simplifying it down to a minimal first version,
explicitly said:

> "let's not automate app to tbl_qa_scores. Let's keep it as is for now."

**This is a deliberate pause, not an oversight or a forgotten task.** Do
not resume building this unless the user asks for it again.

## 9. Video-based analysis — separate track, most recent work

Explored because (a) the client said `mmwave tracks.jsonl` isn't
reliable, and (b) a real sample video eventually became available to test
against. **Blue/Orange Zone and Speed/Distance Variance are explicitly
staying on the radar path** — video does not need to duplicate those.

### What was tested
- A sample clip (`P02_scenarioRunner_c001_flat.mp4`, already ERP-converted,
  1280×640/2:1) turned out to be **pre-session setup footage, not a real
  scored episode** — people mostly idling, not performing a task. Useful
  for feasibility checks, not for validating real scoring.
- Basic HOG person detection: works for a person at moderate distance,
  **fails for anyone close to the camera** — ERP near-field distortion
  warps them too much to match a trained human-silhouette model. This
  matters because Blue Zone is specifically the close-to-camera zone —
  exactly where this detector is weakest.
- Frame-differencing (motion detection): **works well even through the
  near-field distortion that broke shape detection** — confirmed visually,
  correctly highlighted a badly-warped near-camera figure as well as
  people farther back. Validates the *mechanism* for a
  Continuous-Movement-via-video approach; not yet built into a real
  script, and no real episode footage has been tested against it yet.

### Device Placements via video — `extract_video_positions.py`
Built as a genuinely better approach than the radar proxy for this one
metric: per-episode, build a median background image (per-pixel median
across sampled frames through the episode's trimmed middle portion, to
average out whoever's moving in the foreground), hash it
(`cv2.img_hash.PHash`), and cluster episodes by hash distance
(`--distance-threshold`, default 18, **not calibrated against confirmed
ground truth** — just a reasonable starting point). This *can*
distinguish a genuinely new position from a revisit (unlike the radar
version), since a revisit's hash lands back near its original cluster
instead of always registering as "changed."

**Needs `hydra_timing.json`'s `Insta360X5` `device_start_ready` event** as
its own time-zero anchor — this is a **different device, different
startup timing** than the radar's own anchor. Don't reuse the radar
timestamp for this.

**Tested findings**:
- Negative control (synthetic): split a known-single-position clip into
  fake episodes — correctly found real clustering for normal footage, but
  found a genuine, confirmed limitation: if someone's hand/body dominates
  a large *fraction of an episode's time* very close to the lens, the
  median can't average them out, causing a false position-split. Denser
  sampling was tested and does **not** fix this — it's a time-fraction-
  of-occlusion problem, not a sampling-density problem.
- Real footage test (`P02_scenarioRunner_c004.mp4` — **raw fisheye, not
  ERP-converted**, a format mismatch worth fixing): found 6 estimated
  positions from 9 episodes, with plausible-looking revisit clusters.
  Pairwise distances were continuous, not cleanly bimodal — the result
  landed right at the minimum (6), borderline rather than a comfortable
  pass.
- **User feedback: this was "extremely slow"** — a real concern about
  production deployment, not a correctness objection. Performance ideas
  not yet implemented: downsample frames before hashing, reduce samples
  per episode, run server-side (GitHub Actions) rather than expecting
  fast local runs.
- Raw (non-ERP) fisheye video wastes real hash signal on the black
  circular-crop corners — the script doesn't currently mask these out;
  worth adding if ERP-converted versions aren't reliably available for
  every room.

### Explicit next step (user's own words, most recent instruction)
> "let's preserve it to incorporate getting info directly from the
> inspection report"

i.e., wire `extract_video_positions.py` to pull its three inputs (video,
`episode_markers.jsonl`, `hydra_timing.json`) directly via blob URLs from
the inspection report, the same download-run-delete pattern
`run_radar_qa.py` already implements for the radar side. This is
described as fairly mechanical given the radar version already exists as
a working template — not a new design problem, an extension of an
existing one.

## 10. Priority-ordered next steps

1. **Wire `extract_video_positions.py` into the inspection-report-driven
   pipeline** (explicit next step per §9) — likely as a second script
   alongside `run_radar_qa.py` in the same GitHub Actions workflow, or a
   new one, reusing the same download/cleanup pattern.
2. **Address video script performance** before trusting it for production
   — downsampling, fewer samples/episode, and/or moving execution
   server-side are the live ideas; none implemented yet.
3. **Get a real, populated inspection report** — the whole pipeline
   (radar GitHub Actions, and the video script once wired up) has never
   been tested against genuine blob URLs. Check the SharePoint folder
   first; if still empty, this remains the long-standing blocker it's
   always been.
4. **Confirm whether the Rubric Guide sheet text was actually applied**
   to the live template (§4d) — given twice, once wrong, once corrected;
   unconfirmed either way.
5. Given §6's descope, **reconsider what the tracker integration should
   even do now**, before attempting to resolve the repo-access blocker.
6. Lower priority / explicitly paused, don't start unless asked:
   - Power Automate write-flow to `tbl_qa_scores` (§8 — paused on purpose)
   - Moderator-sampling-distribution system for step 6
   - Calibrating the two still-unvalidated thresholds against real
     ground truth: `--position-shift-pct` (radar Device Placements) and
     `--distance-threshold` (video Device Placements)
