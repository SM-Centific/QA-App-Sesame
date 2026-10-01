# Project Sesame — Moderator Feedback Email Flow

Reference doc for the Power Automate flow that generates and emails a QA
scorecard to moderators after a session is reviewed. Covers the working
configuration as of the last successful end-to-end test, plus the bugs
hit along the way and why each fix works — so future changes don't
accidentally re-break something already solved.

## What it does

When a row in `tbl_qa_session_feedback` is marked ready (`feedback_sent = 1`)
and hasn't been emailed yet (`emailed_at` empty), the flow:

1. Pulls that session's raw score rows from `tbl_qa_scores`.
2. Makes a fresh copy of the scorecard template.
3. Runs an Office Script that populates the copy with this session's actual
   scores, episode detail, and flagged moments — computed with the same
   scoring logic as the QA app itself.
4. Emails the populated scorecard to the session's two moderators.
5. Marks the row as emailed so it isn't sent again.

## Flow: `QA Moderator Feedback Email` (scheduled cloud flow)

Step sequence:

```
List rows present in a table (tbl_qa_session_feedback)
  → Filter array
  → Apply to each
      → List rows present in a table 1 (tbl_qa_scores, unfiltered)
      → Filter array 1 (this session's rows only)
      → Get file content (template)
      → Create file (copy of template, named for this session)
      → Run script (PopulateScorecard — fills in the copy)
      → Get file content 1 (the now-populated file)
      → Send an email (V2) (scorecard attached)
      → Update a row (emailed_at = now)
```

### Filter array (outer)

Selects which feedback rows are due to be emailed:

```
@and(equals(item()?['feedback_sent'], '1'), empty(item()?['emailed_at']))
```

**Note the `'1'` is quoted** — `feedback_sent` is stored as text, not a
number. Using an unquoted `1` silently fails to match (type mismatch in
`equals()`), and the whole "Apply to each" skips with 0 iterations —
no error, just nothing happens. This was the first hard-to-spot bug hit.

### Create file

- Site: `Oslo_Sesame_Delivery`, folder `/Shared Documents/05_Data & Deliverables/Quality/Scorecards`
- File Name (Function tab, not Dynamic content — Power Automate can't expose
  individual Excel-table columns as separate tokens, only "Current item"):
  ```
  concat('Scorecard_', items('Apply_to_each')?['session_id'], '.xlsx')
  ```
  **The `.xlsx` extension is required.** Without it, Excel Online's
  connector can't recognize the new file as a workbook at all and Run
  Script fails with "Workbook not found" — this looked like an ID-format
  problem at first but wasn't.
- File Content: Dynamic content → the output of the **"Get file content"**
  step specifically (template). Power Automate labels multiple steps'
  outputs generically as "Body" in the picker — easy to grab the wrong
  one (e.g. the unfiltered scores list), which silently wraps everything
  downstream in an unwanted extra loop. Use Code view to confirm the
  `body` field actually reads `@body('Get_file_content')` before moving on.

### Run script

- Connector: Excel Online (Business), script `PopulateScorecard`
- **File field:** `@outputs('Create_file')?['body/Id']`
  **Use `Id`, not `ItemId`.** `ItemId` is the plain SharePoint library item
  number; it looks like the right field but the Excel Online connector's
  Run Script action needs the encoded identifier under `Id` instead.
  Using `ItemId` produces `NotFound` once the script actually tries to
  open the file (distinct from the `.xlsx`-extension "Workbook not
  found" error above — this one surfaces only after that's already fixed).
- 9 parameter fields total (File + 8 `ScriptParameters`):

  | Parameter | Value |
  |---|---|
  | `sessionId` | `@items('Apply_to_each')?['session_id']` |
  | `primaryModName` | `@items('Apply_to_each')?['primary_moderator_name']` |
  | `primaryModEmail` | `@items('Apply_to_each')?['primary_moderator_email']` |
  | `qaModName` | `@items('Apply_to_each')?['qa_moderator_name']` |
  | `qaModEmail` | `@items('Apply_to_each')?['qa_moderator_email']` |
  | `scoreRowsJson` | `@string(body('Filter_array_1'))` |
  | `reviewDate` | `@utcNow('yyyy-MM-dd')` |
  | `roomsLabel` | `See Scenario Breakdown for room details` (literal text, not an expression — no real "rooms" field exists in the data model) |

  The first 5 need the **Function tab**, typed without a leading `@`
  (same reason as Create file's filename — Dynamic content only offers
  "Current item" for table rows, not individual columns).

### Get file content 1

Reads the now-populated file back, for the email attachment.

- File Identifier: `outputs('Create_file')?['body/Id']` — **same `Id`
  field as Run script**, not `ItemId`. This step got missed when Run
  script's field was fixed, and failed separately with the same
  `NotFound` pattern until updated to match.

### Send an email (V2)

- **To:** `concat(items('Apply_to_each')?['primary_moderator_email'], ';', items('Apply_to_each')?['qa_moderator_email'])`
- **Subject:** `Project Sesame - Your Session QA Scorecard`
- **Attachment Name:** `concat('Scorecard_', items('Apply_to_each')?['session_id'], '.xlsx')`
- **Attachment Content:** output of **"Get file content 1"** specifically
  (not the first "Get file content", which reads the template)
- **Body:** see "Email body" section below
- **Update a row** (last step): Key Column `session_id`, `emailed_at` → `utcNow()`

## Known runtime quirks hit during testing

- **File-lock errors at Create file ("lock arguments are not valid"):**
  happens when a file from a previous test run is still sitting at that
  path (the filename is deterministic from `session_id`, so repeat test
  runs on the same test row collide with their own prior output). Fix:
  delete the leftover file in SharePoint before re-testing. Real
  production runs won't hit this since every session has a unique ID.
- **File-lock errors at Get file content (right after Run script):**
  Excel Online can hold a brief lock on a file after a script finishes
  while it commits changes. A short **Delay** action (10–30s) between
  Run script and the next step that touches the file is the standard
  workaround.

## `PopulateScorecard.ts` — Office Script

Ports the same scoring math as the QA app's `app.js` (`toPct`,
`computeScores`, room gating, session rollup) so the numbers in the
scorecard always match what the app itself shows. Writes to:

- **Scorecard** sheet — fixed cell addresses (session header fields,
  final result, and the 4 scenario-breakdown rows). This section never
  grows/shrinks, so fixed addressing is safe.
- **Episode Detail** table (`tbl_episode_detail`) — rebuilt per session.
- **Flagged Moments** table (`tbl_flagged_moments`) — rebuilt per session.

### Real Office Scripts API gotchas fixed along the way

A few methods that seem like they should exist, don't, in the actual
Office Scripts (not full Excel JS API) surface:

- `table.getRows()` — doesn't exist. Use a row-count variable and a
  plain loop instead.
- `workbook.save()` — doesn't exist. Office Scripts auto-commits all
  changes when the script finishes; no explicit save call needed.
- **Clearing a table's sample rows** — this took three attempts:
  1. `table.deleteRowsAt(0)` looped once per row → threw `InvalidArgument`
     (the method's real signature is `deleteRowsAt(index, count)` —
     the count argument isn't actually optional in practice).
  2. Single-call `table.deleteRowsAt(0, rowCount)` → still threw
     `InvalidArgument` once `rowCount` equaled the table's *entire*
     row count — because **an Excel Table can never be emptied to zero
     rows** (long-documented Excel behavior, consistent across VBA,
     Excel JS API, and third-party libraries — not something specific
     to Office Scripts).
  3. **Working fix:** add all the real rows *first*, then delete only
     the original sample row(s) *last* — at that point the table has
     more rows than you're deleting, so it's never emptied to zero at
     any point. Implemented for both Episode Detail and Flagged Moments.
     If a session genuinely has zero real episodes/moments, the sample
     row is deliberately left in place rather than attempting (and
     failing) to delete the table's only row.

### Known simplification (not yet fixed)

`episodeNumber` isn't stored in the saved participant payload today —
only `episode_id` is — so Episode Detail's "Episode #" column shows the
raw episode ID instead of a clean number. Fixing this needs a one-line
change in the QA app's `app.js` (`wireSaveButton`) to also save
`episodeNumber`, which hasn't been done yet.

## Email body — formatting notes

The body is edited directly in the Power Automate rich-text Body field's
toolbar (bold/underline/highlight/bullets), **not** by pasting raw HTML
or JSON into it. Two distinct things got confused during setup, worth
keeping straight:

- **Action-level Code view** (top tab: Parameters / Settings / Code view
  / Testing / About) shows the *entire* action as JSON — every
  parameter, with the Body's HTML nested as a JSON string (quotes
  escaped as `\"`). This is for verifying/replacing the whole action
  definition, never for pasting into just the Body field.
- **The `</>` icon inside the Body toolbar itself** toggles *only* that
  field into raw HTML source — real quotes, no JSON wrapper. This is
  the right place to type/paste actual `<img>` or `<a>` tags directly.
  Typing `<` and `>` in the *normal* (non-source) rendered view instead
  gets auto-escaped to `&lt;`/`&gt;` and shows as literal visible text
  rather than being interpreted as a tag — bitten by this once with the
  logo `<img>` tag and the `www.centific.com` link.
- Markdown-style `[text](url)` link syntax is **not** auto-converted to
  a real hyperlink by this editor — it just displays literally. Use a
  real `<a href="...">text</a>` tag in source view instead.

### Logo

Embedded as `<img src="..." width="200" alt="Centific">`, pointing at a
**publicly hosted URL** (no login required — email clients fetch images
via plain external request):

```
https://sm-centific.github.io/QA-App-Sesame/centific_logo.png
```

(Added directly to the existing public `QA-App-Sesame` GitHub Pages
repo, alongside `index.html`/`style.css`/`app.js`.) An inline base64
data-URI version was tried first but abandoned — it works in some
preview contexts but is fragile to paste/escaping issues at this size,
and a hosted URL is simpler to reason about and edit later.

### Current body content (reference)

```html
<p class="editor-paragraph">Hello @{items('Apply_to_each')?['primary_moderator_name']}, @{items('Apply_to_each')?['qa_moderator_name']}<br><br>Thank you for your hard work on <b><strong class="editor-text-bold">Project Sesame</strong></b>. We'd like to take a moment to share feedback on your session.<br><br>Please review the attached Session QA Scorecard, which has four tabs:<br><br><b><strong class="editor-text-bold">Scorecard </strong></b>– your session's final result, scenario-by-scenario breakdown, and any key issues flagged<br><b><strong class="editor-text-bold">Episode Detail</strong></b> – per-episode scores, with reviewer notes where relevant<br><b><strong class="editor-text-bold">Flagged Moments</strong></b> – specific timestamped comments from the reviewer while watching your footage<br><b><strong class="editor-text-bold">Rubric Guide</strong></b> – what each scoring item measures and the required thresholds</p><p class="editor-paragraph"><br><b><strong class="editor-text-bold">ACTION REQUIRED: Both moderators on this session must confirm receipt of this email within 48 hours by replying all, letting us know what you'll change going forward based on the feedback in your scorecard.</strong></b><br><br>Please don't hesitate to reach out if there are any questions.<br><br>Regards,<br>Project Sesame QA Team<br><br><img src="https://sm-centific.github.io/QA-App-Sesame/centific_logo.png" width="200" alt="Centific"><br><a href="https://www.centific.com">www.centific.com</a></p>
```

## Status

End-to-end confirmed working on a real test run: trigger → file creation
→ script population → email with full formatting and logo → row marked
emailed. Remaining open item is the `episodeNumber` display
simplification noted above — cosmetic, not blocking.
