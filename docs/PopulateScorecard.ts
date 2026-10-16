/*
 * Office Script — run via Power Automate's "Run script" action, against a
 * fresh COPY of QA_Scorecard_Template.xlsx (not the template itself).
 *
 * Ports the exact same scoring math as the QA app's app.js (toPct,
 * computeScores, blendedRoomQuality, computeRoomGate, computeSessionSummary)
 * so the numbers here always match what the app itself would show — this
 * file is the one place that logic needs to stay in sync if the rubric
 * ever changes.
 *
 * Parameters (Power Automate maps these to dynamic content automatically
 * once this script is selected in the "Run script" action):
 *   sessionId          - the session_id this scorecard is for
 *   scoreRowsJson       - JSON string: the array of raw tbl_qa_scores rows
 *                         for this session (each row still has payload_json
 *                         as a nested string — this script parses it)
 *   reviewDate          - display string
 *   roomsLabel          - display string, e.g. "Home Office, Kitchen, Living Room"
 *   primaryModName / primaryModEmail / qaModName / qaModEmail - from
 *                         tbl_qa_session_feedback
 */
function main(
  workbook: ExcelScript.Workbook,
  sessionId: string,
  scoreRowsJson: string,
  reviewDate: string,
  roomsLabel: string,
  primaryModName: string,
  primaryModEmail: string,
  qaModName: string,
  qaModEmail: string
) {
  // ---- Item definitions (must match ITEMS_C0 / ITEMS_TECHNICAL / ITEMS_PARTICIPANT in app.js) ----
  type Kind = "gate" | "scale" | "percent";
  type Direction = "higher_is_better" | "lower_is_better";
  interface ItemDef {
    id: string; priority: "P0" | "P1"; kind: Kind; label: string;
    direction?: Direction; referenceValue?: number;
  }

  const ITEMS_C0: ItemDef[] = [
    { id: "sync_chirp", priority: "P0", kind: "gate", label: "Sync Chirp" },
    { id: "static_5s", priority: "P0", kind: "scale", label: "5-Second Static (start)" },
    { id: "figure_8", priority: "P0", kind: "scale", label: "Figure-8 Motion" },
    { id: "translation", priority: "P0", kind: "scale", label: "Translation Movements" },
    { id: "static_end", priority: "P0", kind: "scale", label: "Static Before End" },
  ];
  const ITEMS_TECHNICAL: ItemDef[] = [
    { id: "device_placements", priority: "P0", kind: "percent", label: "Device Placements", direction: "higher_is_better", referenceValue: 6 },
    { id: "audio_quality", priority: "P1", kind: "scale", label: "Audio Quality" },
    { id: "video_quality", priority: "P1", kind: "scale", label: "Video Quality" },
  ];
  const ITEMS_PARTICIPANT: ItemDef[] = [
    { id: "continuous_movement", priority: "P0", kind: "percent", label: "Continuous Movement", direction: "higher_is_better" },
    { id: "blue_zone_pct", priority: "P1", kind: "percent", label: "Blue Zone %", direction: "higher_is_better" },
    { id: "orange_zone", priority: "P1", kind: "percent", label: "Orange Zone %", direction: "lower_is_better" },
    { id: "speed_variance", priority: "P1", kind: "percent", label: "Speed Variance", direction: "higher_is_better", referenceValue: 5.0 },
    { id: "distance_variance", priority: "P1", kind: "percent", label: "Distance Variance", direction: "higher_is_better", referenceValue: 1.0 },
  ];
  const MIN_GOOD_EPISODES = 10;

  // Lookup by id -- several places below need an item's full definition
  // (direction/referenceValue/priority) when all they originally had was
  // its id string, now that toPct needs more than just a bare kind.
  const ALL_ITEMS: ItemDef[] = [...ITEMS_C0, ...ITEMS_TECHNICAL, ...ITEMS_PARTICIPANT];
  const ITEM_BY_ID: { [id: string]: ItemDef } = {};
  ALL_ITEMS.forEach(it => { ITEM_BY_ID[it.id] = it; });

  // Must match app.js's toPct exactly -- see that file's comment for the
  // full reasoning on each branch (naturally-bounded complement for
  // no-referenceValue lower_is_better items like Orange Zone vs. scaled
  // against this item's own pass threshold for raw-unit items like Speed
  // Variance).
  function toPct(it: ItemDef, v: number | null): number | null {
    if (v == null) return null;
    if (it.kind !== "percent") return (v / 3) * 100;
    const dir: Direction = it.direction || "higher_is_better";
    if (it.referenceValue == null) return dir === "lower_is_better" ? (100 - v) : v;
    const threshold = it.priority === "P0" ? 85 : 75;
    const pct = dir === "lower_is_better"
      ? 100 - ((100 - threshold) / it.referenceValue) * v
      : threshold * (v / it.referenceValue);
    return Math.max(0, Math.min(100, pct));
  }
  function avg(arr: number[]): number | null {
    return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  }

  type ScoreValue = string | number;
  interface ScoreResult { p0Pct: number | null; p1Pct: number | null; gateFailed: boolean; overall: string; }
  function computeScores(items: ItemDef[], values: { [k: string]: ScoreValue }): ScoreResult {
    let gateFailed = false;
    const p0: number[] = [], p1: number[] = [];
    for (const it of items) {
      const v = values[it.id];
      if (it.kind === "gate") { if (v === "fail") gateFailed = true; }
      else {
        const pct = toPct(it, v == null ? null : Number(v));
        if (pct != null) (it.priority === "P0" ? p0 : p1).push(pct);
      }
    }
    const p0Pct = avg(p0), p1Pct = avg(p1);
    let overall = "incomplete";
    if (gateFailed) overall = "fail";
    else if (p0Pct != null || p1Pct != null) {
      const p0ok = p0Pct == null || p0Pct >= 85;
      const p1ok = p1Pct == null || p1Pct >= 75;
      overall = p0ok && p1ok ? "pass" : "fail";
    }
    return { p0Pct, p1Pct, gateFailed, overall };
  }

  // ---- Parse the raw rows for this session ----
  interface RawRow { doc_id: string; session_id: string; scenario_id: string; episode_id: string; kind: string; payload_json: string; saved_at: string; }
  interface Payload { scores?: { [k: string]: ScoreValue }; notes?: string; overall?: string; roomLabel?: string; episodeNumber?: number | null; annotations?: { type: string; timeSec: number; text: string }[]; }

  const rawRows: RawRow[] = JSON.parse(scoreRowsJson);
  const sessionRows = rawRows.filter(r => r.session_id === sessionId);

  function parsePayload(r: RawRow): Payload {
    try { return JSON.parse(r.payload_json); } catch (e) { return {}; }
  }

  const c0Row = sessionRows.find(r => r.kind === "c0");
  // However many T1 rooms this session actually has — not assumed to be 3.
  // Derived from whatever scenario_ids show up in the real data, sorted by
  // room number (T1-R1, T1-R2, T1-R3, T1-R4, ...).
  const roomIds = Array.from(new Set(
    sessionRows.map(r => r.scenario_id).filter(id => /^T1-R\d+$/.test(id))
  )).sort((a, b) => parseInt(a.slice(4), 10) - parseInt(b.slice(4), 10));

  function techRowFor(scenarioId: string) { return sessionRows.find(r => r.kind === "technical" && r.scenario_id === scenarioId); }
  function participantRowsFor(scenarioId: string) { return sessionRows.filter(r => r.kind === "participant" && r.scenario_id === scenarioId); }
  function annotationsFor(scenarioId: string) {
    const row = sessionRows.find(r => r.kind === "annotations" && r.scenario_id === scenarioId);
    return row ? (parsePayload(row).annotations || []) : [];
  }

  // ---- C0 ----
  const c0Values = c0Row ? (parsePayload(c0Row).scores || {}) : {};
  const c0Scores = computeScores(ITEMS_C0, c0Values);
  const c0GatePass: boolean | null = c0Row ? (!c0Scores.gateFailed && (c0Scores.p0Pct == null ? null : c0Scores.p0Pct >= 85)) : null;

  // ---- Per T1 room ----
  interface RoomResult {
    scenarioId: string; roomLabel: string; techScores: ScoreResult;
    retainedCount: number; passedCount: number; meetsMinimum: boolean;
    gatePass: boolean | null; blendedP0: number | null; blendedP1: number | null;
    episodes: { episodeId: string; episodeNumber: number | null; result: string; p0Pct: number | null; p1Pct: number | null; belowItems: string[]; notes: string }[];
  }

  function computeRoom(scenarioId: string): RoomResult {
    const techRow = techRowFor(scenarioId);
    const techValues = techRow ? (parsePayload(techRow).scores || {}) : {};
    const techScores = computeScores(ITEMS_TECHNICAL, techValues);
    const partRows = participantRowsFor(scenarioId);

    const p0vals: number[] = [];
    const p1vals: number[] = [];
    const dp = techValues["device_placements"] != null ? toPct(ITEM_BY_ID["device_placements"], Number(techValues["device_placements"])) : null;
    if (dp != null) p0vals.push(dp);
    const aq = techValues["audio_quality"] != null ? toPct(ITEM_BY_ID["audio_quality"], Number(techValues["audio_quality"])) : null;
    if (aq != null) p1vals.push(aq);
    const vq = techValues["video_quality"] != null ? toPct(ITEM_BY_ID["video_quality"], Number(techValues["video_quality"])) : null;
    if (vq != null) p1vals.push(vq);

    const episodes = partRows.map(r => {
      const payload = parsePayload(r);
      const values = payload.scores || {};
      const scores = computeScores(ITEMS_PARTICIPANT, values);
      const belowItems: string[] = [];
      for (const it of ITEMS_PARTICIPANT) {
        const v = values[it.id];
        if (v == null) continue;
        const pct = toPct(it, Number(v));
        const threshold = it.priority === "P0" ? 85 : 75;
        if (pct != null && pct < threshold) belowItems.push(it.label);
      }
      return {
        episodeId: r.episode_id,
        // Present for anything saved after the app.js fix; older rows saved
        // before that fix won't have it, so this still falls back to null
        // (and the sheet falls back to showing episode_id) rather than
        // breaking on older data.
        episodeNumber: payload.episodeNumber != null ? payload.episodeNumber : null,
        result: scores.overall === "pass" ? "PASS" : (scores.overall === "fail" ? "FAIL" : "INCOMPLETE"),
        p0Pct: scores.p0Pct, p1Pct: scores.p1Pct,
        belowItems, notes: payload.notes || "",
      };
    });

    // Continuous Movement specifically (P0 participant item) contributes to the room's P0 pool:
    const cmPctVals = partRows.map(r => {
      const v = (parsePayload(r).scores || {})["continuous_movement"];
      return v == null ? null : toPct(ITEM_BY_ID["continuous_movement"], Number(v));
    }).filter((v): v is number => v != null);
    if (cmPctVals.length) p0vals.push(avg(cmPctVals) as number);

    (["blue_zone_pct", "orange_zone", "speed_variance", "distance_variance"] as const).forEach(id => {
      const vals = partRows.map(r => {
        const v = (parsePayload(r).scores || {})[id];
        return v == null ? null : toPct(ITEM_BY_ID[id], Number(v));
      }).filter((v): v is number => v != null);
      if (vals.length) p1vals.push(avg(vals) as number);
    });

    const passedCount = episodes.filter(e => e.result === "PASS").length;
    const meetsMinimum = passedCount >= MIN_GOOD_EPISODES;
    const technicalOk = !techScores.gateFailed
      && (techScores.p0Pct == null || techScores.p0Pct >= 85)
      && (techScores.p1Pct == null || techScores.p1Pct >= 75);
    const hasAnyData = !!techRow || partRows.length > 0;

    return {
      scenarioId, roomLabel: techRow ? (parsePayload(techRow).roomLabel || scenarioId) : scenarioId,
      techScores, retainedCount: partRows.length, passedCount, meetsMinimum,
      gatePass: hasAnyData ? (technicalOk && meetsMinimum) : null,
      blendedP0: avg(p0vals), blendedP1: avg(p1vals),
      episodes,
    };
  }

  const rooms: { [k: string]: RoomResult } = {};
  for (const id of roomIds) rooms[id] = computeRoom(id);

  // ---- Session rollup — same strict-AND logic as before, just over
  // however many rooms this session actually has instead of a fixed 3 ----
  const gates = [c0GatePass, ...roomIds.map(id => rooms[id].gatePass)];
  let sessionResult = "INCOMPLETE";
  if (gates.some(g => g === false)) sessionResult = "FAIL";
  else if (gates.every(g => g === true)) sessionResult = "PASS";
  const sessionP0 = avg([c0Scores.p0Pct, ...roomIds.map(id => rooms[id].blendedP0)].filter((v): v is number => v != null));
  const sessionP1 = avg(roomIds.map(id => rooms[id].blendedP1).filter((v): v is number => v != null));

  // =====================================================================
  // Write to the "Scorecard" sheet.
  // Session Details + Final Result stay fixed-cell (always exactly one
  // value each, regardless of room count). Scenario Breakdown is now a
  // real Table (tbl_scenario_breakdown) instead of 4 fixed rows, since a
  // session can have any number of T1 rooms — same direct-overwrite-
  // first-row-then-addRow pattern as Episode Detail/Flagged Moments below.
  // =====================================================================
  const scorecard = workbook.getWorksheet("Scorecard");
  scorecard.getRange("B5").setValue(sessionId);
  scorecard.getRange("B6").setValue(reviewDate);
  scorecard.getRange("B7").setValue(roomsLabel);
  scorecard.getRange("B8").setValue(primaryModName);
  scorecard.getRange("B9").setValue(primaryModEmail);
  scorecard.getRange("B10").setValue(qaModName);
  scorecard.getRange("B11").setValue(qaModEmail);

  scorecard.getRange("B14").setValue(sessionResult);
  scorecard.getRange("B15").setValue(sessionP0 == null ? "" : Math.round(sessionP0));
  scorecard.getRange("D15").setValue(sessionP1 == null ? "" : Math.round(sessionP1));

  const sbTable = scorecard.getTables()[0]; // tbl_scenario_breakdown
  const sbBodyRange = sbTable.getRangeBetweenHeaderAndTotal();
  const sbFirstRowRange = sbBodyRange.getRowCount() > 0 ? sbBodyRange.getRow(0) : null;
  let sbFirstRowUsed = false;
  function writeScenarioRow(rowValues: (string | number)[]) {
    if (!sbFirstRowUsed && sbFirstRowRange) {
      sbFirstRowRange.setValues([rowValues]);
      sbFirstRowUsed = true;
    } else {
      sbTable.addRow(-1, rowValues);
    }
  }

  // C0 row
  writeScenarioRow([
    "C0",
    c0GatePass == null ? "INCOMPLETE" : (c0GatePass ? "PASS" : "FAIL"),
    c0Scores.p0Pct == null ? "" : Math.round(c0Scores.p0Pct),
    "N/A", "N/A",
    c0Scores.gateFailed ? "Sync chirp failed" : "",
  ]);

  // One row per room this session actually has — however many that is.
  for (const scenarioId of roomIds) {
    const room = rooms[scenarioId];
    const issues: string[] = [];
    if (room.techScores.p0Pct != null && room.techScores.p0Pct < 85) issues.push("Technical P0 below threshold");
    if (room.techScores.p1Pct != null && room.techScores.p1Pct < 75) issues.push("Technical P1 below threshold");
    if (!room.meetsMinimum) issues.push(`Only ${room.passedCount}/${MIN_GOOD_EPISODES} required good episodes`);
    const failedEps = room.episodes.filter(e => e.result === "FAIL");
    if (failedEps.length) issues.push(`${failedEps.length} episode(s) failed: ${failedEps.map(e => e.episodeId).join(", ")}`);

    writeScenarioRow([
      scenarioId,
      room.gatePass == null ? "INCOMPLETE" : (room.gatePass ? "PASS" : "FAIL"),
      room.blendedP0 == null ? "" : Math.round(room.blendedP0),
      room.blendedP1 == null ? "" : Math.round(room.blendedP1),
      room.passedCount,
      issues.join("; "),
    ]);
  }

  // =====================================================================
  // Episode Detail — real Table, cleared and rebuilt to the exact
  // number of real episodes (unlike the fixed Scenario Breakdown rows).
  // =====================================================================
  const epSheet = workbook.getWorksheet("Episode Detail");
  const epTable = epSheet.getTables()[0]; // tbl_episode_detail
  // Capture a direct reference to the original sample row's Range BEFORE
  // adding anything, rather than adding everything first and deleting the
  // sample row(s) afterward by position/count. The previous approach
  // (add N rows, then deleteRowsAt(0, sampleCount)) intermittently dropped
  // one real row in practice — likely an Office Scripts batching/timing
  // quirk between many sequential addRow calls and an immediate
  // deleteRowsAt right after, though the exact mechanism wasn't fully
  // confirmed. This version sidesteps that whole class of risk: the first
  // real episode overwrites the captured sample row's cells directly via
  // plain Range.setValues (a basic, well-established API, unlike the
  // Table-level row-count/delete methods that caused trouble before);
  // every subsequent episode still uses addRow as normal. If there turn
  // out to be zero real episodes, the sample row is simply left untouched,
  // same as before.
  const epBodyRange = epTable.getRangeBetweenHeaderAndTotal();
  const epFirstRowRange = epBodyRange.getRowCount() > 0 ? epBodyRange.getRow(0) : null;
  let epFirstRowUsed = false;

  for (const scenarioId of roomIds) {
    const room = rooms[scenarioId];
    for (const ep of room.episodes) {
      const rowValues = [
        scenarioId, ep.episodeNumber != null ? ep.episodeNumber : ep.episodeId, ep.result,
        ep.p0Pct == null ? "" : Math.round(ep.p0Pct),
        ep.p1Pct == null ? "" : Math.round(ep.p1Pct),
        ep.belowItems.join(", "), ep.notes,
      ];
      if (!epFirstRowUsed && epFirstRowRange) {
        epFirstRowRange.setValues([rowValues]);
        epFirstRowUsed = true;
      } else {
        epTable.addRow(-1, rowValues);
      }
    }
  }

  // =====================================================================
  // Flagged Moments — same pattern, real Table.
  // =====================================================================
  const fmSheet = workbook.getWorksheet("Flagged Moments");
  const fmTable = fmSheet.getTables()[0]; // tbl_flagged_moments
  // Same direct-overwrite approach as Episode Detail above.
  const fmBodyRange = fmTable.getRangeBetweenHeaderAndTotal();
  const fmFirstRowRange = fmBodyRange.getRowCount() > 0 ? fmBodyRange.getRow(0) : null;
  let fmFirstRowUsed = false;

  function fmtClock(sec: number): string {
    const s = Math.max(0, Math.round(sec));
    const m = Math.floor(s / 60), r = s % 60;
    return `${m}:${r < 10 ? "0" : ""}${r}`;
  }
  for (const scenarioId of roomIds) {
    const anns = annotationsFor(scenarioId);
    for (const a of anns) {
      const rowValues = [scenarioId, fmtClock(a.timeSec), "", a.type === "flag" ? "Flag" : "Comment", a.text];
      if (!fmFirstRowUsed && fmFirstRowRange) {
        fmFirstRowRange.setValues([rowValues]);
        fmFirstRowUsed = true;
      } else {
        fmTable.addRow(-1, rowValues);
      }
    }
  }
  // No explicit save call needed — Office Scripts commits all changes
  // to the workbook automatically when the script finishes running.
}

/*
 * `episodeNumber` is now saved in the participant payload by app.js (fixed
 * — previously only `episode_id` was saved, so Episode Detail's "Episode #"
 * column showed a raw episode_id instead of a clean number). Records saved
 * BEFORE that app.js fix won't have `episodeNumber` in their payload, so
 * this script falls back to showing episode_id for those older rows —
 * nothing breaks, it just reverts to the old display for pre-fix data.
 */