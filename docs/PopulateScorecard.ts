/*
 * Office Script — run via Power Automate's "Run script" action, against a
 * fresh COPY of QA_Scorecard_Template.xlsx (not the template itself).
 *
 * Ports the same scoring rules as the QA app's app.js (toPct,
 * computeScores, scoresOf, blendedRoomQuality, computeRoomGate,
 * computeSessionSummary) so the numbers here match what the app shows —
 * this file is the one place that logic needs to stay in sync if the
 * rubric ever changes.
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
 *
 * Template cells written: B5:B11 (details), B14 (reviewer's session
 * decision), F14 (app recommendation + reason), F15 (rooms kept/rejected),
 * B15 / D15 (session P0 / P1 averages), plus the three tables.
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
  // gate:    pass/fail; "fail" fails the form outright, never averaged
  // flag:    yes/no;    the failOn value fails the form outright, never averaged (PII)
  // yesno:   yes = 100%, no = 0%
  // scale:   1/2/3 -> 33/67/100%
  // percent: a measurement, see toPct
  type Kind = "gate" | "flag" | "yesno" | "scale" | "percent";
  type Direction = "higher_is_better" | "lower_is_better";
  interface ItemDef {
    id: string; priority: "P0" | "P1"; kind: Kind; label: string;
    direction?: Direction; referenceValue?: number; failOn?: string;
  }

  const ITEMS_C0: ItemDef[] = [
    { id: "sync_chirp", priority: "P0", kind: "gate", label: "Sync Chirp" },
    { id: "static_5s", priority: "P0", kind: "scale", label: "Static (start)" },
    { id: "figure_8", priority: "P0", kind: "scale", label: "Figure-8 Motion" },
    { id: "translation", priority: "P0", kind: "scale", label: "Translation Movements" },
    { id: "static_end", priority: "P0", kind: "scale", label: "Static (end)" },
  ];
  const ITEMS_TECHNICAL: ItemDef[] = [
    { id: "device_placements", priority: "P0", kind: "percent", label: "Device Placements", direction: "higher_is_better", referenceValue: 6 },
    { id: "audio_quality", priority: "P1", kind: "scale", label: "Audio Quality" },
    { id: "video_quality", priority: "P1", kind: "scale", label: "Video Quality" },
  ];
  const ITEMS_PARTICIPANT: ItemDef[] = [
    { id: "pii", priority: "P0", kind: "flag", failOn: "yes", label: "PII visible" },
    { id: "continuous_movement", priority: "P0", kind: "percent", label: "Continuous Movement", direction: "higher_is_better", referenceValue: 75 },
    { id: "blue_zone_pct", priority: "P1", kind: "percent", label: "Blue Zone %", direction: "higher_is_better" },
    { id: "outside_far", priority: "P1", kind: "percent", label: "Outside view beyond 3 m %", direction: "lower_is_better", referenceValue: 10 },
    { id: "speed_variance", priority: "P1", kind: "scale", label: "Speed Variance" },
    { id: "distance_variance", priority: "P1", kind: "scale", label: "Distance Variance" },
    { id: "moderator_visible", priority: "P1", kind: "yesno", label: "Moderator visible and moving" },
  ];
  const MIN_GOOD_EPISODES = 10;

  // Rows saved before the 1/2/3 change (no scoreVersion 2) hold the raw
  // speed / distance spread; bucket them the same way app.js does.
  const SCORE_VERSION = 2;
  const VARIANCE_BUCKETS: { [id: string]: { some: number; great: number } } = {
    speed_variance: { some: 0.25, great: 0.5 },
    distance_variance: { some: 0.5, great: 1.0 },
  };

  type ScoreValue = string | number | null;
  type Scores = { [k: string]: ScoreValue };

  // Must match app.js's toPct exactly.
  function toPct(it: ItemDef, raw: ScoreValue | undefined): number | null {
    if (raw == null || raw === "") return null;
    if (it.kind === "yesno") return raw === "yes" ? 100 : raw === "no" ? 0 : null;
    if (it.kind === "flag" || it.kind === "gate") return null; // pass/fail only, never averaged
    const v = Number(raw);
    if (isNaN(v)) return null;
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
  function round(v: number | null): string | number { return v == null ? "" : Math.round(v); }

  interface ScoreResult { p0Pct: number | null; p1Pct: number | null; gateFailed: boolean; overall: string; }
  function computeScores(items: ItemDef[], values: Scores): ScoreResult {
    let gateFailed = false;
    const p0: number[] = [], p1: number[] = [];
    for (const it of items) {
      const v = values[it.id];
      if (it.kind === "gate") { if (v === "fail") gateFailed = true; }
      else if (it.kind === "flag") { if (v === it.failOn) gateFailed = true; }
      else {
        const pct = toPct(it, v);
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
  interface Payload {
    scores?: Scores; scoreVersion?: number; notes?: string; overall?: string; roomLabel?: string;
    episodeNumber?: number | null; disposition?: string | null;
    annotations?: { type: string; timeSec: number; text: string }[];
    decision?: string; decidedBy?: string | null;
  }

  const rawRows: RawRow[] = JSON.parse(scoreRowsJson);
  const sessionRows = rawRows.filter(r => r.session_id === sessionId);

  function parsePayload(r: RawRow): Payload {
    try { return JSON.parse(r.payload_json); } catch (e) { return {}; }
  }
  // Same as app.js scoresOf(): bucket pre-version-2 raw variance values.
  function scoresOf(p: Payload): Scores {
    const scores: Scores = { ...(p.scores || {}) };
    if (!(p.scoreVersion != null && p.scoreVersion >= SCORE_VERSION)) {
      Object.keys(VARIANCE_BUCKETS).forEach(id => {
        const raw = scores[id];
        if (raw == null || raw === "") return;
        const v = Number(raw), b = VARIANCE_BUCKETS[id];
        scores[id] = v >= b.great ? 3 : (v >= b.some ? 2 : 1);
      });
    }
    return scores;
  }

  const c0Row = sessionRows.find(r => r.kind === "c0");
  const sessionRow = sessionRows.find(r => r.kind === "session");
  // However many T1 rooms this session actually has, sorted by room number.
  const roomIds = Array.from(new Set(
    sessionRows.map(r => r.scenario_id).filter(id => /^T1-R\d+$/.test(id))
  )).sort((a, b) => parseInt(a.slice(4), 10) - parseInt(b.slice(4), 10));

  function techRowFor(scenarioId: string) { return sessionRows.find(r => r.kind === "technical" && r.scenario_id === scenarioId); }
  // Episodes the operator excluded in Hydra never count (the app saves the
  // disposition; rows saved before that have none and are counted).
  function participantRowsFor(scenarioId: string) {
    return sessionRows.filter(r => r.kind === "participant" && r.scenario_id === scenarioId
      && parsePayload(r).disposition !== "excluded");
  }
  function annotationsFor(scenarioId: string) {
    const row = sessionRows.find(r => r.kind === "annotations" && r.scenario_id === scenarioId);
    return row ? (parsePayload(row).annotations || []) : [];
  }

  // ---- C0 (must pass for the session to pass) ----
  const c0Values = c0Row ? scoresOf(parsePayload(c0Row)) : {};
  const c0Scores = computeScores(ITEMS_C0, c0Values);
  const c0GatePass: boolean | null = c0Row ? (!c0Scores.gateFailed && (c0Scores.p0Pct == null ? null : c0Scores.p0Pct >= 85)) : null;

  // ---- Per T1 room ----
  interface EpisodeResult { episodeId: string; episodeNumber: number | null; result: string; p0Pct: number | null; p1Pct: number | null; belowItems: string[]; notes: string; }
  interface RoomResult {
    scenarioId: string; roomLabel: string; techScores: ScoreResult;
    countedEpisodes: number; passedCount: number; meetsMinimum: boolean; technicalOk: boolean;
    gatePass: boolean | null; blendedP0: number | null; blendedP1: number | null;
    episodes: EpisodeResult[];
  }

  function belowThreshold(items: ItemDef[], values: Scores): string[] {
    const out: string[] = [];
    for (const it of items) {
      const v = values[it.id];
      if (v == null || v === "") continue;
      if (it.kind === "flag") { if (v === it.failOn) out.push(it.label); continue; }
      if (it.kind === "gate") { if (v === "fail") out.push(it.label); continue; }
      const pct = toPct(it, v);
      const threshold = it.priority === "P0" ? 85 : 75;
      if (pct != null && pct < threshold) out.push(it.label);
    }
    return out;
  }

  function computeRoom(scenarioId: string): RoomResult {
    const techRow = techRowFor(scenarioId);
    const techValues = techRow ? scoresOf(parsePayload(techRow)) : {};
    const techScores = computeScores(ITEMS_TECHNICAL, techValues);
    const partRows = participantRowsFor(scenarioId);
    const partScores = partRows.map(r => scoresOf(parsePayload(r)));

    const episodes: EpisodeResult[] = partRows.map((r, i) => {
      const payload = parsePayload(r);
      const values = partScores[i];
      const scores = computeScores(ITEMS_PARTICIPANT, values);
      return {
        episodeId: r.episode_id,
        // Rows saved before episodeNumber was added fall back to episode_id.
        episodeNumber: payload.episodeNumber != null ? payload.episodeNumber : null,
        result: scores.overall === "pass" ? "PASS" : (scores.overall === "fail" ? "FAIL" : "INCOMPLETE"),
        p0Pct: scores.p0Pct, p1Pct: scores.p1Pct,
        belowItems: belowThreshold(ITEMS_PARTICIPANT, values), notes: payload.notes || "",
      };
    }).sort((a, b) => (a.episodeNumber || 0) - (b.episodeNumber || 0));

    // Blended room quality (same as app.js blendedRoomQuality): each
    // technical item, plus each participant item averaged across episodes.
    const p0vals: number[] = [], p1vals: number[] = [];
    for (const it of ITEMS_TECHNICAL) {
      const pct = toPct(it, techValues[it.id]);
      if (pct != null) (it.priority === "P0" ? p0vals : p1vals).push(pct);
    }
    for (const it of ITEMS_PARTICIPANT) {
      const pcts = partScores.map(s => toPct(it, s[it.id])).filter((v): v is number => v != null);
      if (pcts.length) (it.priority === "P0" ? p0vals : p1vals).push(avg(pcts) as number);
    }

    const passedCount = episodes.filter(e => e.result === "PASS").length;
    const meetsMinimum = passedCount >= MIN_GOOD_EPISODES;
    const technicalOk = !techScores.gateFailed
      && (techScores.p0Pct == null || techScores.p0Pct >= 85)
      && (techScores.p1Pct == null || techScores.p1Pct >= 75);
    const hasAnyData = !!techRow || partRows.length > 0;

    return {
      scenarioId, roomLabel: techRow ? (parsePayload(techRow).roomLabel || scenarioId) : scenarioId,
      techScores, countedEpisodes: partRows.length, passedCount, meetsMinimum, technicalOk,
      gatePass: hasAnyData ? (technicalOk && meetsMinimum) : null,
      blendedP0: avg(p0vals), blendedP1: avg(p1vals),
      episodes,
    };
  }

  const rooms: { [k: string]: RoomResult } = {};
  for (const id of roomIds) rooms[id] = computeRoom(id);

  // ---- Session recommendation (same as app.js computeSessionSummary) ----
  // C0 must pass. Each room is kept if it qualifies, else rejected; the
  // session passes when C0 passes and at least one room is kept.
  const kept = roomIds.filter(id => rooms[id].gatePass === true);
  const rejected = roomIds.filter(id => rooms[id].gatePass === false);
  const pending = roomIds.filter(id => rooms[id].gatePass == null);
  let recommended = "INCOMPLETE";
  let reason = "";
  if (c0GatePass === false) { recommended = "FAIL"; reason = "C0 failed"; }
  else if (roomIds.length && rejected.length === roomIds.length) {
    recommended = "FAIL";
    reason = roomIds.length === 1 ? `${roomIds[0]} rejected (needs ${MIN_GOOD_EPISODES} passing episodes)` : `every T1 room rejected (each needs ${MIN_GOOD_EPISODES} passing episodes)`;
  }
  else if (c0GatePass === true && kept.length) {
    recommended = "PASS";
    reason = `C0 passed · kept ${kept.join(", ")}` + (rejected.length ? ` · rejected ${rejected.join(", ")}` : "") + (pending.length ? ` · not scored yet ${pending.join(", ")}` : "");
  }
  else {
    const waiting = (c0GatePass == null ? ["C0"] : []).concat(pending);
    reason = waiting.length ? `waiting on ${waiting.join(", ")}` : "no T1 room scored";
  }
  const sessionP0 = avg([c0Scores.p0Pct, ...roomIds.map(id => rooms[id].blendedP0)].filter((v): v is number => v != null));
  const sessionP1 = avg(roomIds.map(id => rooms[id].blendedP1).filter((v): v is number => v != null));

  // The reviewer's decision (saved by the app as a 'session' row) is the
  // session's result. Older sessions without one show the recommendation.
  const sessionPayload = sessionRow ? parsePayload(sessionRow) : null;
  const decision = sessionPayload && (sessionPayload.decision === "pass" || sessionPayload.decision === "fail")
    ? sessionPayload.decision.toUpperCase() : null;

  // =====================================================================
  // Scorecard sheet
  // =====================================================================
  const scorecard = workbook.getWorksheet("Scorecard");
  scorecard.getRange("B5").setValue(sessionId);
  scorecard.getRange("B6").setValue(reviewDate);
  scorecard.getRange("B7").setValue(roomsLabel);
  scorecard.getRange("B8").setValue(primaryModName);
  scorecard.getRange("B9").setValue(primaryModEmail);
  scorecard.getRange("B10").setValue(qaModName);
  scorecard.getRange("B11").setValue(qaModEmail);

  scorecard.getRange("B14").setValue(decision != null ? decision : `NOT DECIDED (recommended ${recommended})`);
  scorecard.getRange("F14").setValue(`${recommended}${reason ? " — " + reason : ""}`);
  scorecard.getRange("F15").setValue(
    roomIds.length
      ? `Kept: ${kept.length ? kept.join(", ") : "none"} · Rejected: ${rejected.length ? rejected.join(", ") : "none"}${pending.length ? " · Not scored: " + pending.join(", ") : ""}`
      : "No T1 rooms scored");
  scorecard.getRange("B15").setValue(round(sessionP0));
  scorecard.getRange("D15").setValue(round(sessionP1));

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
  const c0Issues: string[] = [];
  if (c0Scores.gateFailed) c0Issues.push("Sync chirp failed");
  if (c0Scores.p0Pct != null && c0Scores.p0Pct < 85) c0Issues.push(`P0 below 85%: ${belowThreshold(ITEMS_C0, c0Values).filter(l => l !== "Sync Chirp").join(", ")}`);
  if (c0GatePass === false) c0Issues.push("C0 must pass, so the session fails");
  writeScenarioRow([
    "C0",
    c0GatePass == null ? "INCOMPLETE" : (c0GatePass ? "PASS" : "FAIL"),
    round(c0Scores.p0Pct),
    "N/A", "N/A",
    c0Issues.join("; "),
  ]);

  // One row per room: KEPT / REJECTED
  for (const scenarioId of roomIds) {
    const room = rooms[scenarioId];
    const issues: string[] = [];
    if (room.techScores.p0Pct != null && room.techScores.p0Pct < 85) issues.push("Technical P0 below threshold");
    if (room.techScores.p1Pct != null && room.techScores.p1Pct < 75) issues.push("Technical P1 below threshold");
    if (!room.meetsMinimum) issues.push(`Only ${room.passedCount}/${MIN_GOOD_EPISODES} required passing episodes`);
    const failedEps = room.episodes.filter(e => e.result === "FAIL");
    if (failedEps.length) issues.push(`${failedEps.length} episode(s) failed: ${failedEps.map(e => e.episodeNumber != null ? `#${e.episodeNumber}` : e.episodeId).join(", ")}`);
    const piiEps = room.episodes.filter(e => e.belowItems.indexOf("PII visible") >= 0);
    if (piiEps.length) issues.push(`PII in episode(s) ${piiEps.map(e => e.episodeNumber != null ? `#${e.episodeNumber}` : e.episodeId).join(", ")}`);

    writeScenarioRow([
      scenarioId,
      room.gatePass == null ? "INCOMPLETE" : (room.gatePass ? "KEPT" : "REJECTED"),
      round(room.blendedP0),
      round(room.blendedP1),
      room.passedCount,
      issues.join("; "),
    ]);
  }

  // =====================================================================
  // Episode Detail — overwrite the sample row, then addRow for the rest
  // (this pattern avoids a delete-after-add issue seen in Office Scripts).
  // =====================================================================
  const epSheet = workbook.getWorksheet("Episode Detail");
  const epTable = epSheet.getTables()[0]; // tbl_episode_detail
  const epBodyRange = epTable.getRangeBetweenHeaderAndTotal();
  const epFirstRowRange = epBodyRange.getRowCount() > 0 ? epBodyRange.getRow(0) : null;
  let epFirstRowUsed = false;

  for (const scenarioId of roomIds) {
    const room = rooms[scenarioId];
    for (const ep of room.episodes) {
      const rowValues = [
        scenarioId, ep.episodeNumber != null ? ep.episodeNumber : ep.episodeId, ep.result,
        round(ep.p0Pct), round(ep.p1Pct),
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
  // Flagged Moments — same pattern.
  // =====================================================================
  const fmSheet = workbook.getWorksheet("Flagged Moments");
  const fmTable = fmSheet.getTables()[0]; // tbl_flagged_moments
  const fmBodyRange = fmTable.getRangeBetweenHeaderAndTotal();
  const fmFirstRowRange = fmBodyRange.getRowCount() > 0 ? fmBodyRange.getRow(0) : null;
  let fmFirstRowUsed = false;

  function fmtClock(sec: number): string {
    const s = Math.max(0, Math.round(sec));
    const m = Math.floor(s / 60), r = s % 60;
    return `${m}:${r < 10 ? "0" : ""}${r}`;
  }
  for (const scenarioId of ["C0", ...roomIds]) {
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
  // Office Scripts commits all changes when the script finishes.
}
