# Moderator Feedback Loop — Status & Next Steps

Written as a handoff point since usage ran low mid-build. Everything below is enough to resume cold, in a new conversation if needed — paste this file in and pick up from "Immediate next steps."

## What's fully done (whole project, for context)

- GitHub repo `SM-Centific/QA-App-Sesame`, live at `https://sm-centific.github.io/QA-App-Sesame/`
- QA scoring app: percentage-based scoring, 10-passed-episode room gate, strict session gate, side-by-side video/scoring layout, video annotations (flags/comments), video-based Blue Zone detection (script built, not yet run on real footage)
- Real backend: SharePoint Excel (`tbl_qa_scores`, sheet tab currently named "Scores") + three working Power Automate flows:
  - `QAACCESS_READ_URL` — email/role access check against `tbl_qa_access`
  - `QASCORES_READ_URL` — reads all rows from `tbl_qa_scores`
  - `QASCORES_WRITE_URL` — upserts one row by `doc_id`
- `docs/power-automate-spec.md` and `docs/power-automate-expression-notes.md` in the repo cover the backend design and the Power Automate syntax gotchas we hit building it.
- **mmWave tracks removed** from the app (unreliable + memory-heavy); video memory leak fixed (lazy blob creation + revoke-on-switch).

## Moderator feedback loop — decisions locked in so far

**Scorecard content & layout** — done, see `QA_Scorecard_Template.xlsx` (already delivered). Two tabs:
- `Scorecard`: Session Details, Final Result, Scenario Breakdown, Episode Detail, Flagged Moments — Result columns are live formulas replicating the app's real gate logic (P0≥85%, P1≥75%, ≥10 good episodes, strict session AND).
- `Rubric Guide`: built from the app's actual `ITEMS_C0`/`ITEMS_TECHNICAL`/`ITEMS_PARTICIPANT` definitions. No "score meaning" column (removed per your request).
- **Key Issues** (room-level) → auto-generated from Technical items below threshold + failed-episode summary. Confirmed: **no manual Technical-notes field** will be added to the app for this.
- **Reviewer Notes** (episode-level) → already exists, pulled directly from the app's existing per-episode notes field. No new work needed.

**Data model for the trigger/moderator info** — new tab in the *same* `tbl_qa_scores.xlsx` workbook (not a separate file), because:
- Moderator role (Primary vs QA) can swap between sessions even for the same two people — so **no lookup table by moderator pair**, entry is per-session, manual.
- Cross-workbook VLOOKUP was considered and rejected (staleness risk — Excel Online doesn't reliably refresh external references, and Power Automate's Excel actions just read whatever's cached).

**New table name:** `tbl_qa_session_feedback` — **not yet created**. One row per session:

| Column | Filled by |
|---|---|
| `session_id` | matches `tbl_qa_scores` |
| `primary_moderator_name` | manual |
| `primary_moderator_email` | manual |
| `qa_moderator_name` | manual |
| `qa_moderator_email` | manual |
| `feedback_sent` | manual, 0/1 — the trigger |
| `emailed_at` | written automatically by the flow once sent — prevents re-sending |

## Immediate next steps, in order

### 1. Create the `tbl_qa_session_feedback` tab (you, in Excel — 2 minutes)
Same workbook as `tbl_qa_scores`. Add the 7 headers above, select the range, `Ctrl+T`, name the Table `tbl_qa_session_feedback` in Table Design. (Confirmed safe: renaming a sheet *tab* doesn't affect existing flows — only renaming the Table object would. This is a brand-new table either way, so no risk to the existing three flows regardless.)

### 2. Build the scheduled Power Automate flow
This is a **new pattern** — the first three flows all trigger on an HTTP request (the app calls them). This one runs on its own schedule instead:

1. Create flow → **"Scheduled cloud flow"** (not Instant) → set Recurrence (e.g. every 15 minutes).
2. `List rows present in a table` on `tbl_qa_session_feedback`.
3. `Filter array`: rows where `feedback_sent` equals `1` **and** `emailed_at` is blank (use `empty(item()?['emailed_at'])`).
4. `Condition`: `length(...)` greater than `0` (same pattern as the other flows).
5. Inside True, for each matching row (an `Apply to each` loop):
   - `List rows present in a table` on `tbl_qa_scores`, filtered by that row's `session_id`, to pull the actual scores.
   - **Decided, built, and confirmed working.** `PopulateScorecard.ts` is the Office Script that does this — **test-run successfully in Excel Online's Automate pane**, populating Scorecard + Episode Detail from sample JSON with no errors. Went through a few rounds of real Office-Script-API corrections along the way (no `any` types allowed; `table.getRows()` and `workbook.save()` don't exist in the real API — fixed to `deleteRowsAt()` in a loop, and no explicit save needed at all, Office Scripts auto-commits when the script ends). See full flow steps below for wiring it into the actual scheduled flow.
   - **Template restructured to support this:** Episode Detail and Flagged Moments moved off the single `Scorecard` sheet onto their own tabs (`Episode Detail` sheet with a real Excel Table `tbl_episode_detail`; `Flagged Moments` sheet with `tbl_flagged_moments`). Reason: those two sections have a variable number of rows per session, and a real Table can grow/shrink cleanly via `table.addRow()` without needing to manually shift other content around — a fixed-position multi-section single sheet can't do that safely. `Scorecard` sheet itself is unchanged (Session Details, Final Result, Scenario Breakdown — all always fixed-length, so plain cell addresses are fine there).
   - **Known simplification, flagged directly in the script's own comments:** Episode Detail's "Episode #" column currently shows the raw `episode_id` (a long string), not a clean number — `episodeNumber` isn't currently saved in the participant payload, only `episode_id` is. Fix is a one-line addition to `app.js`'s `wireSaveButton`; not done yet, not blocking, worth doing before this goes to real moderators.
   - `Send an email` (Outlook connector) to `primary_moderator_email` and `qa_moderator_email`, with the generated file attached, cc as needed.
   - `Update a row` on `tbl_qa_session_feedback`: set `emailed_at` to now, so it never re-sends.

### 3. Still open, not blocking, but worth deciding eventually
- **Email body** — the reference email from the old project is a good starting template; hasn't been adapted to this project's wording/links yet.
- **Recipients/cc logic** — who besides the two moderators, if anyone, should be copied.
- **`role` column in `tbl_qa_access`** — currently purely informational (only `qa_admin` exists, for one user); nothing in the app gates on it. Decide later whether `qa_admin` vs `qa_reviewer` should ever mean something functionally different.

## Quick reference — the three working flow URLs (for testing)
- `QAACCESS_READ_URL`: `https://default9b415834803a4da0afdcfe6b1d52d6.49.environment.api.powerplatform.com:443/powerautomate/automations/direct/cu/05/workflows/152a06201a4642339d1e07e930f329d4/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=WorDH8s8grB_3ocp4OmNI5BuSHcx5yA98pjAufZddjU`
- `QASCORES_READ_URL`: `https://default9b415834803a4da0afdcfe6b1d52d6.49.environment.api.powerplatform.com:443/powerautomate/automations/direct/cu/20/workflows/5e00c2485f8a44129e2aeff73933d0d3/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=RzjbtxXXZMLc7k5Z55NPPqrqwGmIddDQw8rpKr2dsRI`
- `QASCORES_WRITE_URL`: `https://default9b415834803a4da0afdcfe6b1d52d6.49.environment.api.powerplatform.com:443/powerautomate/automations/direct/cu/04/workflows/99955cada8a441b6a27b171c0f617686/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=XhQwo6f1r_avdZJbufnezrS-szlvNFQQLoBifdIegxU`
