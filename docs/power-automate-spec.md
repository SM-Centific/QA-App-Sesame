# QA Scoring — Power Automate Flow Spec & Access Control (Draft)

**Status:** draft for review. Follows the same pattern as Sesame Tracker's existing eight signed flows (`USERS_LOGIN_URL`, `SESSIONS_READ_URL`, etc.) — HTTP-triggered flow → Excel-on-SharePoint action → JSON response, called directly from static JS with no browser-side OAuth. These new flows would be separately owned/built on your Power Automate account, not the app owner's.

---

## 1. New signed URLs (naming matches existing convention)

| Constant | Purpose |
|---|---|
| `QAACCESS_READ_URL` | Check whether a signed-in user has QA access, and their role |
| `QAEPISODES_READ_URL` | Read episode-level scores for a session/scenario |
| `QAEPISODES_WRITE_URL` | Upsert one episode's score row |
| `QAROOMS_READ_URL` | Read room/scenario summary rows for a session |
| `QAROOMS_WRITE_URL` | Upsert one room/scenario summary row |
| `QASESSIONS_READ_URL` | Read the session summary row |
| `QASESSIONS_WRITE_URL` | Upsert the session summary row |

Seven flows total, one per table plus access-check — same shape as the existing eight, just a separate namespace.

---

## 2. Backend tables (Excel on SharePoint)

Same workbook the rest of the app could use, or a dedicated QA workbook — three tables from the schema we already designed, plus one new access table:

- `tbl_qa_episode_scores`
- `tbl_qa_room_summary`
- `tbl_qa_session_summary`
- `tbl_qa_access` — **new**, columns: `email`, `role` (`qa_reviewer` / `qa_admin`), `active` (bool), `added_date`

`tbl_qa_access` is intentionally separate from the app's existing `tbl_users` — it's a permission list scoped to *this* page only, and it's the actual security boundary. The idea floated earlier (a page in the app owner's existing access-emails workbook) works fine too, as long as every WRITE flow checks it server-side — which table it lives in is a later decision, not a blocker to drafting the flow logic now.

---

## 3. Access-check flow (`QAACCESS_READ_URL`)

**Trigger body:**
```json
{ "email": "reviewer@centific.com" }
```

**Flow steps:**
1. HTTP trigger receives the body above (same email the app already has from its existing login step — no second sign-in).
2. "List rows present in a table" on `tbl_qa_access`, filter `email eq '<email>' and active eq true`.
3. Response:
```json
{ "authorized": true, "role": "qa_reviewer" }
```
or, if no matching row:
```json
{ "authorized": false }
```

**Frontend behavior:** called once right after the existing login step. `authorized: false` → QA nav link never renders. This is the UX layer only — see §5 for why it can't be trusted as the real gate.

---

## 4. Read/write flows (episodes, rooms, sessions — structurally identical)

Using `QAEPISODES_WRITE_URL` as the template; rooms and sessions follow the same shape against their own table.

**Trigger body (write):**
```json
{
  "email": "reviewer@centific.com",
  "session_id": "2fca9f97-7221-4447-b749-87eebba9e774",
  "scenario_id": "T1-R1",
  "episode_id": "ep_...",
  "scores": { "continuous_movement": 3, "blue_zone_pct": 91.2, "...": "..." },
  "p0_pct": 96.7,
  "p1_pct": 88.4,
  "episode_pass": true,
  "notes": "..."
}
```

**Flow steps:**
1. HTTP trigger receives the body.
2. **Role check first, before any write**: "List rows" on `tbl_qa_access` filtered by the trigger's `email`. If no row, or `role` isn't `qa_reviewer`/`qa_admin`, or `active` is false → skip straight to a `{ "success": false, "reason": "not_authorized" }` response and stop. This is the step that actually matters — see §5.
3. If authorized: "Get row" on `tbl_qa_episode_scores` by a composite key (`session_id` + `scenario_id` + `episode_id`); if it exists, "Update a row"; if not, "Add a row." (Upsert, not two separate flows, to keep the write path single.)
4. Stamp `reviewer` (from `email`) and `scored_at` (flow's UTC timestamp) server-side — don't trust client-supplied values for these two fields, so the audit trail can't be spoofed by editing the request body.
5. Response:
```json
{ "success": true, "scored_at": "2026-09-26T18:04:00Z" }
```

**Read flows** (`QAEPISODES_READ_URL`, etc.) take `{ "session_id": ..., "scenario_id": ... }`, run "List rows present in a table" with a filter, and return the matching rows as an array. Read access can reasonably be less strict than write (any `qa_reviewer`+ can read), but should still check `tbl_qa_access` rather than being wide open — same role-check step, just gating a List instead of a Write.

---

## 5. Why the role check has to live in the flow, not just the frontend

This app is a static site — anyone can view its source. If "restricted access" means only hiding the nav link in JS, the signed URLs are still sitting in the shipped code and callable directly by anyone who finds them, login screen or not. The role check in step 2 of every flow above is the actual boundary; hiding the link is a nice-to-have on top of it, not a substitute.

One consequence worth flagging: the signed URL itself grants *some* level of trust already (that's what "signed" means in Power Automate's HTTP trigger) — but that only proves the caller has the URL, not who they are. The `email` in the body is still just a client-supplied claim, no different from the existing app's username-only login. Real protection here is "this is annoying to discover and forge," not cryptographic identity — worth knowing that ceiling exists, in case QA scores ever need a stronger guarantee than that.

---

## 6. Open decisions (not blockers, just need an answer before building)

- Does `tbl_qa_access` live in its own workbook, a new sheet in the QA scores workbook, or a new sheet in the app owner's existing access workbook?
- Should `qa_admin` vs `qa_reviewer` actually differ in capability (e.g. admin can edit others' saved scores, reviewer can't), or is it one flat "has access" role for now?
- Composite key for episode upsert — `session_id + scenario_id + episode_id` assumes episode IDs are stable/unique per session; worth a quick sanity check against real data before building.
