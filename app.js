/* ---------------------------------------------------------------
   Item definitions
   kind: 'gate' (pass/fail, gates the whole scenario), 'scale' (manual
   1-3 judgment), 'percent' (a real measured 0-100 value, either
   computed automatically or entered directly — no lossy 1-3 bucket)
--------------------------------------------------------------- */
const ITEMS_C0 = [
  {id:'sync_chirp', label:'Sync Chirp', priority:'P0', kind:'gate', help:'Audible chirp detected and aligned across camera + ambient mic.'},
  {id:'static_5s', label:'5-Second Static (start)', priority:'P0', kind:'scale', help:'Performer/rig held still for ~5s at capture start.'},
  {id:'figure_8', label:'Figure-8 Motion', priority:'P0', kind:'scale', help:'Figure-8 movement pattern in the ~5–10s window.'},
  {id:'translation', label:'Translation Movements', priority:'P0', kind:'scale', help:'Near/far translation movements in the ~25–30s window.'},
  {id:'static_end', label:'Static Before End', priority:'P0', kind:'scale', help:'Held still again before the capture ends.'},
];
// Useful Views is no longer a scored/averaged item here — it's the room-level
// "at least MIN_GOOD_EPISODES passed episodes" gate instead (see computeRoomGate).
const ITEMS_TECHNICAL = [
  {id:'device_placements', label:'Device Placements', priority:'P0', kind:'scale', help:'At least 6 distinct camera positions covered in this room.'},
  {id:'audio_quality', label:'Audio Quality', priority:'P1', kind:'scale', help:'Clipping, noise floor, intelligibility.'},
  {id:'video_quality', label:'Video Quality', priority:'P1', kind:'scale', help:'Exposure, focus, framing, dropped frames.'},
];
const ITEMS_PARTICIPANT = [
  {id:'continuous_movement', label:'Continuous Movement', priority:'P0', kind:'scale', help:'Performer in continuous motion for >75% of the episode.'},
  {id:'blue_zone_pct', label:'Blue Zone %', priority:'P1', kind:'percent', help:'Time spent inside the 120°×5m forward FOV — measured directly from the video detector when available.'},
  {id:'orange_zone', label:'Orange Zone %', priority:'P1', kind:'scale', help:'Brief exits/re-entries outside FOV, staying near 2m, turning back before 3m.'},
  {id:'speed_variance', label:'Speed Variance', priority:'P1', kind:'scale', help:'Natural variation in movement speed.'},
  {id:'distance_variance', label:'Distance Variance', priority:'P1', kind:'scale', help:'Natural variation in near/far distance.'},
];
const SCENARIO_ORDER = ['C0','T1-R1','T1-R2','T1-R3'];
const MIN_GOOD_EPISODES = 10; // client threshold: a room needs at least this many PASSED episodes

/* ---------------------------------------------------------------
   Ingested session state
--------------------------------------------------------------- */
let ingested = {
  sessionId: null, scenarios: {}, evidenceByCapture: {}, validationByCapture: {},
  episodesByCapture: {}, auditByScenario: {}, tracksByCapture: {}, videosByCapture: {},
  videoZoneByCapture: {},
};
let currentScenarioId = null;
let currentEpisodeId = null;
let currentScope = 'technical'; // 'technical' | 'participant' — only meaningful for T1 scenarios
let formCache = {};
let localScores = {};
let dbNS = null, downloadsNS = null;
let videoEl = null; // live reference to the <video> element, persists across episode/scope changes

function escapeHtml(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function logLine(html){ const el = document.getElementById('loadLog'); const d = document.createElement('div'); d.innerHTML = html; el.appendChild(d); el.scrollTop = el.scrollHeight; }
function deriveCaptureIdFromName(name){ const m = /_c(\d{3,})[._]/.exec(name || ''); return m ? 'c' + m[1] : null; }
function fmtSec(ms){ return ms == null ? '—' : (ms/1000).toFixed(1) + 's'; }
function fmtPct(v){ return v == null ? '—' : v.toFixed(0) + '%'; }

/* ---------------------------------------------------------------
   File classification + ingestion
--------------------------------------------------------------- */
function deriveCaptureIdFromArtifacts(artifacts){
  if (!Array.isArray(artifacts)) return null;
  for (const a of artifacts){ const m = /_c(\d{3,})[._]/.exec(a.file || ''); if (m) return 'c' + m[1]; }
  return null;
}

function ingestCaptureManifest(obj){
  if (ingested.sessionId && obj.sessionId && obj.sessionId !== ingested.sessionId){ logLine(`<span class="tag warn">skip</span> capture manifest — different session`); return; }
  ingested.sessionId = ingested.sessionId || obj.sessionId;
  const captureId = deriveCaptureIdFromArtifacts(obj.artifacts) || ('unknown-' + obj.scenarioId);
  ingested.scenarios[obj.scenarioId] = {
    scenarioId: obj.scenarioId,
    roomLabel: obj.roomLabel || obj.assignedRoom || obj.scenarioId,
    captureId,
    startedAt: obj.startedAt || null,
    retainedViewCount: (obj.episodeEligibility && obj.episodeEligibility.retainedViewCount != null) ? obj.episodeEligibility.retainedViewCount : null,
  };
  logLine(`<span class="tag ok">capture.json</span> ${escapeHtml(obj.scenarioId)} — ${escapeHtml(obj.roomLabel||'')} <span style="color:var(--muted)">(${escapeHtml(captureId)})</span>`);
}

function ingestSessionEvidence(obj){
  if (ingested.sessionId && obj.sessionId && obj.sessionId !== ingested.sessionId){ logLine(`<span class="tag warn">skip</span> session_evidence — different session`); return; }
  ingested.sessionId = ingested.sessionId || obj.sessionId;
  (obj.captures || []).forEach(cap => {
    const sync = {};
    (cap.syncEvidence || []).forEach(se => { if (se.timing && se.timing.role) sync[se.timing.role] = se.timing.verdict; });
    ingested.evidenceByCapture[cap.captureId] = { status: cap.status, sync };
  });
  logLine(`<span class="tag ok">session_evidence</span> sync verdicts for ${(obj.captures||[]).length} captures`);
}

function ingestSessionValidation(obj){
  if (ingested.sessionId && obj.sessionId && obj.sessionId !== ingested.sessionId){ logLine(`<span class="tag warn">skip</span> session_validation — different session`); return; }
  ingested.sessionId = ingested.sessionId || obj.sessionId;
  const caps = obj.phases && obj.phases.P02_scenarioRunner && obj.phases.P02_scenarioRunner.captures;
  (caps || []).forEach(cap => { ingested.validationByCapture[cap.id] = { issues: cap.issues || [] }; });
  logLine(`<span class="tag ok">session_validation</span> integrity issues for ${(caps||[]).length} captures`);
}

function ingestAudit(obj){
  ingested.auditByScenario[obj.stepId] = { expectedDevices: obj.expectedDevices || [], requiredMask: obj.requiredMask || [] };
  logLine(`<span class="tag ok">audit.json</span> ${escapeHtml(obj.stepId)} — devices: ${escapeHtml((obj.expectedDevices||[]).join(', '))}`);
}

function ingestEpisodeMarkers(lines, filename){
  const byEpisode = {};
  let captureId = null;
  lines.forEach(m => {
    if (!m || !m.episodeId) return;
    captureId = captureId || m.captureId;
    byEpisode[m.episodeId] = byEpisode[m.episodeId] || {};
    if (m.type === 'capture.episode.started') byEpisode[m.episodeId].start = m;
    if (m.type === 'capture.episode.ended') byEpisode[m.episodeId].end = m;
  });
  captureId = captureId || deriveCaptureIdFromName(filename);
  if (!captureId){ logLine(`<span class="tag warn">skip</span> ${escapeHtml(filename)} — no episode markers recognized`); return; }
  const episodes = Object.entries(byEpisode).map(([episodeId, pair]) => {
    const s = pair.start, e = pair.end;
    return {
      episodeId,
      episodeNumber: (s && s.episodeNumber) || (e && e.episodeNumber) || null,
      durationMs: e ? e.durationMs : null,
      startElapsedMs: (s && s.captureElapsedMs) != null ? s.captureElapsedMs : null,
      targetDurationSec: (s && s.targetDurationSec) || (e && e.targetDurationSec) || null,
      toleranceSec: (s && s.durationToleranceSec) || (e && e.durationToleranceSec) || null,
      invalidReasons: (e && e.invalidReasons) || [],
      disposition: (e && e.disposition) || null,
      dispositionReason: (e && e.dispositionReason) || null,
      complete: !!e,
    };
  }).sort((a,b) => (a.episodeNumber||0) - (b.episodeNumber||0));
  ingested.episodesByCapture[captureId] = episodes;
  logLine(`<span class="tag ok">episode_markers</span> ${episodes.length} episodes for ${escapeHtml(captureId)}`);
}

function ingestVideoZone(lines, filename){
  const captureId = deriveCaptureIdFromName(filename);
  if (!captureId){ logLine(`<span class="tag warn">skip</span> ${escapeHtml(filename)} — couldn't detect capture id from filename for video-zone log`); return; }
  ingested.videoZoneByCapture[captureId] = lines;
  const detected = lines.filter(l => l.azimuth_deg != null).length;
  logLine(`<span class="tag ok">video zone log</span> ${lines.length} samples (${detected} with a detection) for ${escapeHtml(captureId)}`);
}

function ingestTracks(lines, filename){
  const captureId = deriveCaptureIdFromName(filename);
  if (!captureId){ logLine(`<span class="tag warn">skip</span> ${escapeHtml(filename)} — couldn't detect capture id from filename for tracks file`); return; }
  ingested.tracksByCapture[captureId] = lines;
  logLine(`<span class="tag ok">mmwave tracks</span> ${lines.length} frames for ${escapeHtml(captureId)}`);
}

function classifyAndIngest(filename, text){
  try {
    const obj = JSON.parse(text);
    if (obj && obj.scenarioId && obj.artifacts && obj.episodeEligibility){ ingestCaptureManifest(obj); return; }
    if (obj && Array.isArray(obj.captures) && obj.captures[0] && obj.captures[0].syncEvidence){ ingestSessionEvidence(obj); return; }
    if (obj && obj.phases && obj.phases.P02_scenarioRunner && obj.phases.P02_scenarioRunner.captures){ ingestSessionValidation(obj); return; }
    if (obj && obj.expectedDevices && obj.requiredMask && obj.stepId){ ingestAudit(obj); return; }
    logLine(`<span class="tag warn">unrecognized</span> ${escapeHtml(filename)} (valid JSON, unknown shape)`);
  } catch (err){
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch(e){ return null; } }).filter(Boolean);
    if (!lines.length){ logLine(`<span class="tag warn">unrecognized</span> ${escapeHtml(filename)} (could not parse)`); return; }
    if (lines[0].type && String(lines[0].type).startsWith('capture.episode')){ ingestEpisodeMarkers(lines, filename); return; }
    if (lines[0].schemaVersion === 'hydra.mmwave-tracks/1' || (lines[0].frameIndex != null && 'tracks' in lines[0])){ ingestTracks(lines, filename); return; }
    if ('azimuth_deg' in lines[0] && 'in_blue_zone' in lines[0]){ ingestVideoZone(lines, filename); return; }
    logLine(`<span class="tag warn">unrecognized</span> ${escapeHtml(filename)} (JSONL, unknown shape)`);
  }
}

function ingestVideo(file){
  const captureId = deriveCaptureIdFromName(file.name);
  if (!captureId){ logLine(`<span class="tag warn">skip</span> ${escapeHtml(file.name)} — couldn't detect capture id from filename`); return; }
  const url = URL.createObjectURL(file);
  ingested.videosByCapture[captureId] = { name: file.name, url };
  logLine(`<span class="tag ok">video</span> ${escapeHtml(file.name)} → ${escapeHtml(captureId)}`);
}

async function handleFiles(fileList){
  const files = Array.from(fileList);
  for (const f of files){
    const isVideo = f.type.startsWith('video/') || /\.(mp4|mov|webm)$/i.test(f.name);
    if (isVideo) ingestVideo(f);
    else classifyAndIngest(f.name, await f.text());
  }
  refreshSessionStatus();
  if (!currentScenarioId){
    currentScenarioId = SCENARIO_ORDER.find(id => ingested.scenarios[id]) || null;
  }
  renderScenarioTabs();
  renderScenarioShell();
  renderSessionBanner();
}

function refreshSessionStatus(){
  const el = document.getElementById('sessionStatus');
  if (!ingested.sessionId){ el.textContent = 'No files loaded yet.'; return; }
  const loadedScenarios = SCENARIO_ORDER.filter(id => ingested.scenarios[id]).length;
  const videoCount = Object.keys(ingested.videosByCapture).length;
  el.innerHTML = `Session <span style="font-family:var(--font-mono)">${escapeHtml(ingested.sessionId)}</span> — ${loadedScenarios}/4 scenarios, ${videoCount} video(s) loaded`;
}

/* ---------------------------------------------------------------
   Automated value suggestions
--------------------------------------------------------------- */
// Scenario-scoped autos: Sync Chirp (C0), Audio/Video Quality (T1 Technical)
function computeScenarioAutos(scenarioId, items){
  const scenario = ingested.scenarios[scenarioId];
  const captureId = scenario && scenario.captureId;
  const ev = captureId ? ingested.evidenceByCapture[captureId] : null;
  const val = captureId ? ingested.validationByCapture[captureId] : null;
  const autos = {};
  items.forEach(it => { autos[it.id] = {value: null, note: null}; });

  if (autos.sync_chirp){
    if (ev && ev.sync){
      const roles = ['camera_detection','ambimik_detection','alignment'];
      const verdicts = roles.map(r => ev.sync[r]).filter(v => v != null);
      const allPass = roles.every(r => ev.sync[r] === 'pass');
      autos.sync_chirp.value = verdicts.length ? (allPass ? 'pass' : 'fail') : null;
      autos.sync_chirp.note = roles.map(r => `${r}: ${ev.sync[r] || 'n/a'}`).join(' · ');
    } else { autos.sync_chirp.note = 'No session_evidence loaded for this capture.'; }
  }
  ['audio_quality','video_quality'].forEach(id => {
    if (!autos[id]) return;
    if (val && val.issues){
      const prefix = id === 'audio_quality' ? 'audio.' : 'video.';
      const related = val.issues.filter(i => i.code && i.code.startsWith(prefix));
      if (related.length === 0){ autos[id].value = 3; autos[id].note = 'No automated issues flagged.'; }
      else {
        const hasError = related.some(i => i.severity === 'error');
        autos[id].value = hasError ? 1 : 2;
        autos[id].note = related.map(i => `${i.severity}: ${i.message}`).join(' | ');
      }
    } else { autos[id].note = 'No session_validation loaded for this capture.'; }
  });
  return autos;
}

// Episode-scoped auto: Blue Zone % computed from the video-zone log, filtered
// to this specific episode's time window. Also returns a coverage figure
// (fraction of sampled frames that actually had a detection) so the reviewer
// can see how much to trust the number, not just the number itself.
function computeBlueZoneAuto(scenarioId, episode){
  const scenario = ingested.scenarios[scenarioId];
  const captureId = scenario && scenario.captureId;
  const videoZone = captureId ? ingested.videoZoneByCapture[captureId] : null;
  if (!videoZone || !episode || episode.startElapsedMs == null || episode.durationMs == null){
    return {value: null, note: 'No video-zone log loaded for this capture.', coveragePct: null};
  }
  const startSec = episode.startElapsedMs / 1000;
  const endSec = (episode.startElapsedMs + episode.durationMs) / 1000;
  const inWindow = videoZone.filter(f => f.time_s >= startSec && f.time_s <= endSec);
  if (!inWindow.length) return {value: null, note: 'No video-zone samples fall inside this episode\'s time window.', coveragePct: null};
  const detected = inWindow.filter(f => f.azimuth_deg != null);
  const inBlue = detected.filter(f => f.in_blue_zone);
  const coveragePct = detected.length / inWindow.length * 100;
  const bluePct = detected.length ? (inBlue.length / detected.length * 100) : null;
  return {
    value: bluePct != null ? Math.round(bluePct * 10) / 10 : null,
    note: bluePct != null
      ? `${inWindow.length} samples in window, detected in ${coveragePct.toFixed(0)}%`
      : 'No detections landed inside this episode\'s window.',
    coveragePct,
  };
}

/* ---------------------------------------------------------------
   Persistence
--------------------------------------------------------------- */
async function initCapabilities(){
  try {
    if (window.claude && window.claude.use){ dbNS = await window.claude.use('db'); downloadsNS = await window.claude.use('downloads'); }
  } catch(e){ dbNS = null; downloadsNS = null; }
  document.getElementById('persistStatus').textContent = dbNS ? 'Connected — scores persist across reloads' : 'Local only — scores clear on reload';
}
async function loadDoc(docId){
  if (dbNS){ try { const snap = await dbNS.collection('qa_scores').doc(docId).get(); if (snap.exists) return snap.data(); } catch(e){} }
  return localScores[docId] || null;
}
async function saveDoc(docId, payload){
  localScores[docId] = payload;
  if (dbNS){ try { await dbNS.collection('qa_scores').doc(docId).set(payload); return true; } catch(e){ return false; } }
  return false;
}
async function queryAll(){
  if (dbNS){ try { const qs = await dbNS.collection('qa_scores').limit(500).get(); return qs.docs.map(d => d.data()); } catch(e){} }
  return Object.values(localScores);
}

/* ---------------------------------------------------------------
   Scoring
   Every item, regardless of kind, is converted to a 0-100 "percent
   of max" figure before pooling — scale items via value/3*100,
   percent items pass through as-is. This lets a measured percentage
   (Blue Zone) sit in the same average as a manual 1-3 judgment
   without forcing the measurement through a lossy bucket first.
--------------------------------------------------------------- */
function toPct(it, v){
  if (v == null) return null;
  return it.kind === 'percent' ? v : (v / 3 * 100);
}

function computeScores(items, values){
  let gateFailed = false; const p0 = [], p1 = [];
  items.forEach(it => {
    const v = values[it.id];
    if (it.kind === 'gate'){ if (v === 'fail') gateFailed = true; }
    else {
      const pct = toPct(it, v);
      if (pct != null) (it.priority === 'P0' ? p0 : p1).push(pct);
    }
  });
  const avg = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : null;
  const p0Pct = avg(p0), p1Pct = avg(p1);
  let overall = 'incomplete';
  if (gateFailed) overall = 'fail';
  else if (p0Pct != null || p1Pct != null){
    const p0ok = p0Pct == null || p0Pct >= 85; const p1ok = p1Pct == null || p1Pct >= 75;
    overall = (p0ok && p1ok) ? 'pass' : 'fail';
  }
  return {p0Pct, p1Pct, gateFailed, overall};
}

// Room-level BLENDED REPORTING numbers only (technical + averaged participant
// items) — a smooth quality figure. This never decides pass/fail on its own;
// see computeRoomGate for the actual gate, which uses hard counts instead of
// an average so one bad episode can't hide inside a good-looking mean.
function blendedRoomQuality(technicalValues, participantDocs){
  const p0vals = []; const p1vals = [];
  ITEMS_TECHNICAL.forEach(it => { const pct = toPct(it, technicalValues[it.id]); if (pct != null) (it.priority==='P0'?p0vals:p1vals).push(pct); });
  const avgOf = key => {
    const nums = participantDocs.map(d => d.scores && d.scores[key]).filter(v => v != null);
    return nums.length ? nums.reduce((a,b)=>a+b,0)/nums.length : null;
  };
  ITEMS_PARTICIPANT.forEach(it => {
    const raw = avgOf(it.id);
    if (raw != null) (it.priority==='P0'?p0vals:p1vals).push(it.kind==='percent' ? raw : raw/3*100);
  });
  const avg = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : null;
  return {p0Pct: avg(p0vals), p1Pct: avg(p1vals)};
}

// The actual room-level GATE: technical thresholds AND at least
// MIN_GOOD_EPISODES individually-passed episodes. gatePass is null
// (not true/false) when there isn't enough data yet to judge.
async function computeRoomGate(scenarioId){
  const scenario = ingested.scenarios[scenarioId];
  if (!scenario) return null;
  const techDocId = `${ingested.sessionId}__${scenarioId}__technical`;
  const techSaved = await loadDoc(techDocId);
  const techValues = (techSaved && techSaved.scores) || {};
  const techScores = computeScores(ITEMS_TECHNICAL, techValues);
  const allDocs = await queryAll();
  const participantDocs = allDocs.filter(d => d.scenarioId === scenarioId && d.kind === 'participant');
  const episodes = ingested.episodesByCapture[scenario.captureId] || [];
  const retainedCount = episodes.filter(e => e.disposition === 'retained').length;
  const passedCount = participantDocs.filter(d => d.overall === 'pass').length;
  const meetsMinimum = passedCount >= MIN_GOOD_EPISODES;
  const technicalOk = !techScores.gateFailed && (techScores.p0Pct == null || techScores.p0Pct >= 85) && (techScores.p1Pct == null || techScores.p1Pct >= 75);
  const hasAnyData = !!techSaved || participantDocs.length > 0;
  const blended = blendedRoomQuality(techValues, participantDocs);
  return {
    scenarioId, roomLabel: scenario.roomLabel,
    retainedCount, episodesTotal: episodes.length, passedCount, meetsMinimum,
    technicalOk, technicalP0Pct: techScores.p0Pct, technicalP1Pct: techScores.p1Pct,
    blendedP0Pct: blended.p0Pct, blendedP1Pct: blended.p1Pct,
    gatePass: hasAnyData ? (technicalOk && meetsMinimum) : null,
  };
}

async function computeC0Gate(){
  if (!ingested.sessionId) return null;
  const saved = await loadDoc(`${ingested.sessionId}__C0__form`);
  if (!saved) return {gatePass: null, p0Pct: null};
  const scores = computeScores(ITEMS_C0, saved.scores || {});
  const gatePass = !scores.gateFailed && (scores.p0Pct == null ? null : scores.p0Pct >= 85);
  return {gatePass, p0Pct: scores.p0Pct, gateFailed: scores.gateFailed};
}

async function computeSessionSummary(){
  if (!ingested.sessionId) return null;
  const c0 = await computeC0Gate();
  const rooms = await Promise.all(['T1-R1','T1-R2','T1-R3'].map(computeRoomGate));
  const all = [c0, ...rooms];
  const anyLoaded = ingested.sessionId && SCENARIO_ORDER.some(id => ingested.scenarios[id]);
  if (!anyLoaded) return null;
  const gates = [c0 ? c0.gatePass : null, ...rooms.map(r => r ? r.gatePass : null)];
  let sessionPass = 'incomplete';
  if (gates.some(g => g === false)) sessionPass = 'fail';
  else if (gates.every(g => g === true)) sessionPass = 'pass';
  const avgOf = arr => { const nums = arr.filter(v => v != null); return nums.length ? nums.reduce((a,b)=>a+b,0)/nums.length : null; };
  const sessionP0 = avgOf([c0 ? c0.p0Pct : null, ...rooms.map(r => r ? r.blendedP0Pct : null)]);
  const sessionP1 = avgOf(rooms.map(r => r ? r.blendedP1Pct : null)); // C0 has no P1 pool
  return {sessionPass, sessionP0, sessionP1, c0, rooms};
}

/* ---------------------------------------------------------------
   Zone classification
--------------------------------------------------------------- */
function classifyZone(track){
  if (!track || track.rangeM == null || track.azimuthDeg == null) return {label: 'No lock', cls: 'muted'};
  const r = track.rangeM, a = track.azimuthDeg, inFov = Math.abs(a) <= 60;
  if (inFov && r <= 5) return {label: 'Blue zone', cls: 'blue'};
  if (!inFov && r <= 2) return {label: 'Orange zone', cls: 'orange'};
  if (!inFov && r > 3) return {label: 'Past 3m warning', cls: 'fail'};
  if (!inFov) return {label: 'Outside FOV (2–3m)', cls: 'warn'};
  return {label: 'Beyond 5m', cls: 'warn'};
}
function classifyZoneVideo(sample){
  if (!sample || sample.azimuth_deg == null) return {label: 'No detection', cls: 'muted'};
  return sample.in_blue_zone ? {label: 'Blue zone', cls: 'blue'} : {label: 'Outside blue zone', cls: 'warn'};
}
function nearestTrackFrame(frames, targetSec){
  let lo = 0, hi = frames.length - 1;
  if (!frames.length) return null;
  while (lo < hi){
    const mid = (lo + hi) >> 1;
    if (frames[mid].__t < targetSec) lo = mid + 1; else hi = mid;
  }
  return frames[lo];
}

/* ---------------------------------------------------------------
   Rendering: rail
--------------------------------------------------------------- */
function renderScenarioTabs(){
  const el = document.getElementById('scenarioTabs');
  el.innerHTML = SCENARIO_ORDER.map(id => {
    const s = ingested.scenarios[id];
    const disabled = !s ? 'disabled' : '';
    const active = id === currentScenarioId ? 'active' : '';
    let flags = '';
    if (s){
      const hasVideo = !!ingested.videosByCapture[s.captureId];
      const hasTracks = !!ingested.tracksByCapture[s.captureId];
      const hasVideoZone = !!ingested.videoZoneByCapture[s.captureId];
      const zoneFlag = id !== 'C0' ? (hasVideoZone ? ' · video-zone ✓' : (hasTracks ? ' · tracks ✓' : ' · no zone data')) : '';
      flags = `<span class="flags">${hasVideo ? 'video ✓' : 'no video'}${zoneFlag}</span>`;
    }
    return `<button class="${active}" data-scenario="${id}" ${disabled}>${id}${s ? `<span class="room">${escapeHtml(s.roomLabel)}</span>${flags}` : ''}</button>`;
  }).join('');
  el.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      currentScenarioId = btn.dataset.scenario; currentEpisodeId = null; currentScope = 'technical';
      renderScenarioTabs(); renderScenarioShell();
    });
  });
}

/* ---------------------------------------------------------------
   Rendering: session banner (always visible, scope = SESSION)
--------------------------------------------------------------- */
async function renderSessionBanner(){
  const el = document.getElementById('sessionBanner');
  const summary = await computeSessionSummary();
  if (!summary){ el.innerHTML = ''; return; }
  const pillsHtml = [['C0', summary.c0], ['T1-R1', summary.rooms[0]], ['T1-R2', summary.rooms[1]], ['T1-R3', summary.rooms[2]]]
    .map(([label, g]) => {
      const state = !g ? 'incomplete' : (g.gatePass === true ? 'pass' : g.gatePass === false ? 'fail' : 'incomplete');
      return `<span class="gate-pill ${state}">${label}</span>`;
    }).join('');
  el.innerHTML = `
    <div class="scope-badge session">SESSION</div>
    <div class="session-banner-row">
      <div class="gate-pills">${pillsHtml}</div>
      <div class="session-nums">P0 avg ${fmtPct(summary.sessionP0)} · P1 avg ${fmtPct(summary.sessionP1)}</div>
      <div class="overall-badge ${summary.sessionPass}">${summary.sessionPass.toUpperCase()}</div>
    </div>`;
}

/* ---------------------------------------------------------------
   Shared rendering helpers
--------------------------------------------------------------- */
function scoreSummaryHtml(p0Pct, p1Pct, overall, label){
  const w = v => v == null ? 0 : Math.max(0, Math.min(100, v));
  return `<div class="score-summary">
    <div class="score-metric"><div class="label">P0 (need ≥85%)</div><div class="value">${fmtPct(p0Pct)}</div><div class="bar"><div style="width:${w(p0Pct)}%"></div></div></div>
    <div class="score-metric"><div class="label">P1 (need ≥75%)</div><div class="value">${fmtPct(p1Pct)}</div><div class="bar"><div style="width:${w(p1Pct)}%"></div></div></div>
    <div class="overall-badge ${overall}">${label || overall.toUpperCase()}</div>
  </div>`;
}

function itemRowHtml(it, value, auto){
  const autoBadge = (auto && auto.value != null) ? `<span class="badge auto">auto-suggested</span>` : '';
  const noteHtml = (auto && auto.note) ? `<div class="item-note">${escapeHtml(auto.note)}</div>` : '';
  const coverageHtml = (auto && auto.coveragePct != null) ? `<div class="item-note">detector confidence: ${auto.coveragePct.toFixed(0)}% of frames had a detection</div>` : '';
  let control;
  if (it.kind === 'gate'){
    control = ['pass','fail'].map(v => `<button type="button" class="seg ${value===v?'active '+v:''}" data-item="${it.id}" data-value="${v}">${v==='pass'?'Pass':'Fail'}</button>`).join('');
  } else if (it.kind === 'percent'){
    control = `<div class="percent-input"><input type="number" min="0" max="100" step="0.1" data-item="${it.id}" value="${value != null ? value : ''}" placeholder="0-100"><span>%</span></div>`;
  } else {
    control = [1,2,3].map(n => `<button type="button" class="seg ${value===n?'active':''}" data-item="${it.id}" data-value="${n}">${n}</button>`).join('');
  }
  return `<div class="item-row">
    <div class="item-label"><span class="pri ${it.priority}">${it.priority}</span> ${escapeHtml(it.label)} ${autoBadge}</div>
    <div class="item-desc">${escapeHtml(it.help)}</div>
    <div class="seg-group">${control}</div>
    ${noteHtml}${coverageHtml}
  </div>`;
}

async function ensureFormLoaded(docId, items, kind, scenarioId, episodeId, autos){
  if (formCache[docId]) return formCache[docId];
  const saved = await loadDoc(docId);
  const values = {};
  items.forEach(it => {
    if (saved && saved.scores && saved.scores[it.id] != null) values[it.id] = saved.scores[it.id];
    else if (autos[it.id] && autos[it.id].value != null) values[it.id] = autos[it.id].value;
    else values[it.id] = null;
  });
  formCache[docId] = {docId, items, kind, scenarioId, episodeId, values, autos, notes: (saved && saved.notes) || '', savedAt: (saved && saved.savedAt) || null};
  return formCache[docId];
}

/* ---------------------------------------------------------------
   Rendering: scenario shell (video + zone overlay + episode selector
   + scope sub-tabs). Rebuilt only on scenario change, so the <video>
   element is never recreated on episode/scope switches or saves.
--------------------------------------------------------------- */
async function renderScenarioShell(){
  const shell = document.getElementById('scenarioShell');
  videoEl = null;
  if (!currentScenarioId || !ingested.scenarios[currentScenarioId]){
    shell.innerHTML = `<div class="empty-state">Choose a scenario on the left to begin scoring.</div>`;
    return;
  }
  const scenario = ingested.scenarios[currentScenarioId];
  const episodes = ingested.episodesByCapture[scenario.captureId] || [];
  if (!currentEpisodeId && episodes.length) currentEpisodeId = episodes[0].episodeId;
  const video = ingested.videosByCapture[scenario.captureId];
  const audit = ingested.auditByScenario[currentScenarioId];
  const tracks = ingested.tracksByCapture[scenario.captureId];
  const videoZone = ingested.videoZoneByCapture[scenario.captureId];
  const zoneSource = videoZone ? 'video' : (tracks ? 'mmwave' : null);
  const isC0 = currentScenarioId === 'C0';

  const auditLine = audit ? `<div class="audit-line">Devices required: ${escapeHtml(audit.expectedDevices.join(', '))}</div>` : '';
  const videoHtml = video
    ? `<video id="capVideo" controls src="${video.url}"></video>`
    : `<div class="no-video">No video uploaded for ${escapeHtml(scenario.captureId)} yet.</div>`;
  const zoneHtml = (zoneSource && video)
    ? `<div class="zone-panel">
         <svg viewBox="0 0 160 130" width="100%" style="max-width:160px;">
           <path d="M 80 110 L 20 20 A 90 90 0 0 1 140 20 Z" fill="var(--panel-2)" stroke="var(--border)"/>
           <circle cx="80" cy="110" r="4" fill="var(--muted)"/>
           <circle id="zoneDot" cx="80" cy="110" r="5" fill="var(--accent)"/>
         </svg>
         <div class="zone-badge muted" id="zoneBadge">No lock</div>
         <div class="zone-readout" id="zoneReadout">–</div>
         <div class="zone-readout" style="opacity:.7">source: ${zoneSource === 'video' ? 'video detection' : 'mmWave (unvalidated)'}</div>
       </div>`
    : '';

  const episodeSelectHtml = episodes.length ? `
    <div class="episode-select-row">
      <select id="episodeSelect">
        ${episodes.map(e => `<option value="${e.episodeId}" ${e.episodeId===currentEpisodeId?'selected':''}>Episode ${e.episodeNumber ?? '?'}${(e.invalidReasons&&e.invalidReasons.length)?' ⚠':''}</option>`).join('')}
      </select>
      <button class="btn" id="seekBtn">Jump to episode start</button>
      <span class="episode-info" id="episodeInfo"></span>
    </div>` : `<div class="episode-info">No episode_markers loaded for this room.</div>`;

  const scopeTabsHtml = !isC0 ? `
    <div class="scope-tabs">
      <button class="${currentScope==='technical'?'active':''}" data-scope="technical">Technical <span class="scope-badge room">ROOM-LEVEL</span></button>
      <button class="${currentScope==='participant'?'active':''}" data-scope="participant">Participant <span class="scope-badge episode">EPISODE-LEVEL</span></button>
    </div>` : `<div class="scope-tabs"><span class="scope-badge calibration">CALIBRATION (C0)</span></div>`;

  shell.innerHTML = `
    <div class="scenario-header">
      <div><h2>${escapeHtml(currentScenarioId)} — ${escapeHtml(scenario.roomLabel)}</h2>
      <div class="meta">${escapeHtml(scenario.captureId)}${episodes.length?` · ${episodes.filter(e=>e.disposition==='retained').length}/${episodes.length} retained episodes`:''}</div>
      ${auditLine}</div>
    </div>
    ${scopeTabsHtml}
    <div class="workspace">
      <div class="video-col">
        ${videoHtml}
        ${zoneHtml}
        ${episodeSelectHtml}
      </div>
      <div class="score-col" id="scoringSection"></div>
    </div>`;

  videoEl = document.getElementById('capVideo');
  const epSelect = document.getElementById('episodeSelect');
  const seekBtn = document.getElementById('seekBtn');
  const episodeInfo = document.getElementById('episodeInfo');

  shell.querySelectorAll('.scope-tabs button[data-scope]').forEach(btn => {
    btn.addEventListener('click', () => { currentScope = btn.dataset.scope; shell.querySelectorAll('.scope-tabs button[data-scope]').forEach(b=>b.classList.toggle('active', b===btn)); renderScoringSection(); });
  });

  function updateEpisodeInfo(){
    const ep = episodes.find(e => e.episodeId === currentEpisodeId);
    if (!ep || !episodeInfo) return;
    const flag = (ep.invalidReasons && ep.invalidReasons.length) ? `<span class="flag-pill">${escapeHtml(ep.invalidReasons.join(', '))}</span>` : '';
    episodeInfo.innerHTML = `duration ${fmtSec(ep.durationMs)} · target ${ep.targetDurationSec ?? '—'}s ±${ep.toleranceSec ?? '—'}s ${flag}`;
  }
  updateEpisodeInfo();

  if (epSelect) epSelect.addEventListener('change', () => { currentEpisodeId = epSelect.value; updateEpisodeInfo(); renderScoringSection(); });
  if (seekBtn) seekBtn.addEventListener('click', () => {
    const ep = episodes.find(e => e.episodeId === currentEpisodeId);
    if (ep && ep.startElapsedMs != null && videoEl) videoEl.currentTime = ep.startElapsedMs / 1000;
  });

  if (zoneSource === 'video' && video && videoEl){
    const frames = videoZone.map(f => ({ ...f, __t: f.time_s })).sort((a,b) => a.__t - b.__t);
    let lastUpdate = 0;
    videoEl.addEventListener('timeupdate', () => {
      const now = performance.now();
      if (now - lastUpdate < 200) return;
      lastUpdate = now;
      const sample = nearestTrackFrame(frames, videoEl.currentTime);
      const zone = classifyZoneVideo(sample);
      const badge = document.getElementById('zoneBadge');
      const readout = document.getElementById('zoneReadout');
      const dot = document.getElementById('zoneDot');
      if (badge){ badge.className = 'zone-badge ' + zone.cls; badge.textContent = zone.label; }
      if (readout) readout.textContent = (sample && sample.azimuth_deg != null) ? `${sample.azimuth_deg.toFixed(0)}°${sample.score!=null?` (score ${sample.score.toFixed(2)})`:''}` : '–';
      if (dot && sample && sample.azimuth_deg != null){
        const rad = sample.azimuth_deg * Math.PI / 180;
        const cx = 80 + 55 * Math.sin(rad);
        const cy = 110 - 55 * Math.cos(rad);
        dot.setAttribute('cx', Math.max(5, Math.min(155, cx)));
        dot.setAttribute('cy', Math.max(10, Math.min(125, cy)));
      }
    });
  } else if (zoneSource === 'mmwave' && video && videoEl){
    const t0 = scenario.startedAt ? Date.parse(scenario.startedAt) : null;
    const frames = tracks.map(f => ({ ...f, __t: t0 != null ? (Date.parse(f.hostintrReadyUtc) - t0) / 1000 : null })).filter(f => f.__t != null);
    frames.sort((a,b) => a.__t - b.__t);
    let lastUpdate = 0;
    videoEl.addEventListener('timeupdate', () => {
      const now = performance.now();
      if (now - lastUpdate < 200) return;
      lastUpdate = now;
      const frame = nearestTrackFrame(frames, videoEl.currentTime);
      const track = frame ? frame.activeTrack : null;
      const zone = classifyZone(track);
      const badge = document.getElementById('zoneBadge');
      const readout = document.getElementById('zoneReadout');
      const dot = document.getElementById('zoneDot');
      if (badge){ badge.className = 'zone-badge ' + zone.cls; badge.textContent = zone.label; }
      if (readout) readout.textContent = track ? `${track.rangeM.toFixed(2)}m @ ${track.azimuthDeg.toFixed(0)}°` : '–';
      if (dot && track && track.xM != null && track.yM != null){
        const cx = 80 + Math.max(-60, Math.min(60, track.xM * 16));
        const cy = 110 - Math.max(0, Math.min(95, track.yM * 16));
        dot.setAttribute('cx', cx); dot.setAttribute('cy', cy);
      }
    });
    if (!t0) logLine(`<span class="tag warn">note</span> ${escapeHtml(currentScenarioId)}: capture.json has no startedAt — zone overlay timing may drift`);
  }

  renderScoringSection();
}

/* ---------------------------------------------------------------
   Rendering: scoring section (right column). Rebuilt on scenario,
   scope, and episode change, and after each save — never touches
   the video element.
--------------------------------------------------------------- */
async function renderScoringSection(){
  const el = document.getElementById('scoringSection');
  if (!el || !currentScenarioId || !ingested.scenarios[currentScenarioId]) return;
  const scenario = ingested.scenarios[currentScenarioId];

  if (currentScenarioId === 'C0'){
    const docId = `${ingested.sessionId}__C0__form`;
    const autos = computeScenarioAutos('C0', ITEMS_C0);
    const form = await ensureFormLoaded(docId, ITEMS_C0, 'c0', 'C0', null, autos);
    const scores = computeScores(ITEMS_C0, form.values);
    el.innerHTML = `
      ${scoreSummaryHtml(scores.p0Pct, null, scores.overall, scores.gateFailed ? 'FAIL — sync chirp' : undefined)}
      <div class="panel">
        <div class="section-title">Calibration checklist <span class="count">P0 only</span></div>
        <div id="c0Items">${ITEMS_C0.map(it => itemRowHtml(it, form.values[it.id], form.autos[it.id])).join('')}</div>
        <div class="notes-block"><label>Reviewer notes</label><textarea id="notesField">${escapeHtml(form.notes)}</textarea></div>
        <div class="save-row">
          <button class="btn primary" id="saveBtn">Save score</button>
          <span class="saved-at" id="savedAtLabel">${form.savedAt ? 'Saved ' + new Date(form.savedAt).toLocaleString() : 'Not saved yet'}</span>
        </div>
      </div>`;
    wireItemInputs('c0Items', docId);
    wireSaveButton(docId, ITEMS_C0, 'c0', 'C0', null, 'saveBtn');
    return;
  }

  const episodes = ingested.episodesByCapture[scenario.captureId] || [];

  if (currentScope === 'technical'){
    const techDocId = `${ingested.sessionId}__${currentScenarioId}__technical`;
    const autos = computeScenarioAutos(currentScenarioId, ITEMS_TECHNICAL);
    const techForm = await ensureFormLoaded(techDocId, ITEMS_TECHNICAL, 'technical', currentScenarioId, null, autos);
    const gate = await computeRoomGate(currentScenarioId);
    el.innerHTML = `
      ${scoreSummaryHtml(gate.technicalP0Pct, gate.technicalP1Pct, gate.gatePass===true?'pass':gate.gatePass===false?'fail':'incomplete', gate.gatePass===true?'ROOM PASS':gate.gatePass===false?'ROOM FAIL':'INCOMPLETE')}
      <div class="panel">
        <div class="gate-stat ${gate.meetsMinimum?'ok':'bad'}">
          <b>${gate.passedCount}</b> of <b>${MIN_GOOD_EPISODES}</b> required good episodes passed
          <span class="gate-stat-sub">(${gate.retainedCount}/${gate.episodesTotal} episodes retained)</span>
        </div>
        <div class="section-title">Technical checklist <span class="count">room-level · P0 &amp; P1</span></div>
        <div id="techItems">${ITEMS_TECHNICAL.map(it => itemRowHtml(it, techForm.values[it.id], techForm.autos[it.id])).join('')}</div>
        <div class="save-row">
          <button class="btn primary" id="saveTechBtn">Save technical score</button>
          <span class="saved-at" id="techSavedAtLabel">${techForm.savedAt ? 'Saved ' + new Date(techForm.savedAt).toLocaleString() : 'Not saved yet'}</span>
        </div>
      </div>`;
    wireItemInputs('techItems', techDocId);
    wireSaveButton(techDocId, ITEMS_TECHNICAL, 'technical', currentScenarioId, null, 'saveTechBtn');
    return;
  }

  // Participant scope
  if (!episodes.length || !currentEpisodeId){
    el.innerHTML = `<div class="empty-state">No episode_markers loaded for this room yet.</div>`;
    return;
  }
  const ep = episodes.find(e => e.episodeId === currentEpisodeId);
  const epDocId = `${ingested.sessionId}__${currentScenarioId}__ep__${currentEpisodeId}`;
  const blueAuto = computeBlueZoneAuto(currentScenarioId, ep);
  const autos = { blue_zone_pct: blueAuto };
  const participantForm = await ensureFormLoaded(epDocId, ITEMS_PARTICIPANT, 'participant', currentScenarioId, currentEpisodeId, autos);
  const epScores = computeScores(ITEMS_PARTICIPANT, participantForm.values);
  el.innerHTML = `
    ${scoreSummaryHtml(epScores.p0Pct, epScores.p1Pct, epScores.overall)}
    <div class="panel">
      <div class="section-title">Participant checklist <span class="count">this episode</span></div>
      <div id="participantItems">${ITEMS_PARTICIPANT.map(it => itemRowHtml(it, participantForm.values[it.id], participantForm.autos[it.id])).join('')}</div>
      <div class="notes-block"><label>Reviewer notes (this episode)</label><textarea id="epNotesField">${escapeHtml(participantForm.notes)}</textarea></div>
      <div class="save-row">
        <button class="btn primary" id="saveEpBtn">Save episode score</button>
        <span class="saved-at" id="epSavedAtLabel">${participantForm.savedAt ? 'Saved ' + new Date(participantForm.savedAt).toLocaleString() : 'Not saved yet'}</span>
      </div>
    </div>`;
  wireItemInputs('participantItems', epDocId);
  wireSaveButton(epDocId, ITEMS_PARTICIPANT, 'participant', currentScenarioId, currentEpisodeId, 'saveEpBtn');
}

function wireItemInputs(containerId, docId){
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll('.seg').forEach(btn => {
    btn.addEventListener('click', () => {
      const itemId = btn.dataset.item;
      const raw = btn.dataset.value;
      const val = (raw === 'pass' || raw === 'fail') ? raw : parseInt(raw, 10);
      if (!formCache[docId]) return;
      formCache[docId].values[itemId] = val;
      renderScoringSection();
    });
  });
  container.querySelectorAll('input[type="number"][data-item]').forEach(inp => {
    inp.addEventListener('change', () => {
      const itemId = inp.dataset.item;
      if (!formCache[docId]) return;
      let v = inp.value === '' ? null : parseFloat(inp.value);
      if (v != null) v = Math.max(0, Math.min(100, v));
      formCache[docId].values[itemId] = v;
      renderScoringSection();
    });
  });
}

function wireSaveButton(docId, items, kind, scenarioId, episodeId, btnId){
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const form = formCache[docId];
    const notesEl = document.getElementById(kind === 'participant' ? 'epNotesField' : 'notesField');
    if (notesEl) form.notes = notesEl.value;
    const scores = computeScores(items, form.values);
    const payload = {
      sessionId: ingested.sessionId, scenarioId, episodeId, kind,
      roomLabel: (ingested.scenarios[scenarioId] || {}).roomLabel || null,
      scores: form.values, notes: form.notes,
      p0Pct: scores.p0Pct, p1Pct: scores.p1Pct, overall: scores.overall,
      savedAt: new Date().toISOString(),
    };
    btn.disabled = true; btn.textContent = 'Saving…';
    await saveDoc(docId, payload);
    form.savedAt = payload.savedAt;
    renderSavedList();
    renderScoringSection();
    renderSessionBanner();
  });
}

async function renderSavedList(){
  const el = document.getElementById('savedList');
  const docs = await queryAll();
  if (!docs.length){ el.innerHTML = `<div class="empty-state" style="padding:14px 4px;">Nothing saved yet.</div>`; return; }
  docs.sort((a,b) => (b.savedAt||'').localeCompare(a.savedAt||''));
  el.innerHTML = docs.map(d => {
    const label = d.kind === 'c0' ? 'C0' : d.kind === 'technical' ? `${d.scenarioId} · Technical` : `${d.scenarioId} · Episode`;
    return `<div class="saved-row">
      <div class="meta"><b>${escapeHtml(label)}</b><span>${d.roomLabel ? escapeHtml(d.roomLabel)+' · ' : ''}${new Date(d.savedAt).toLocaleTimeString()}</span></div>
      <span class="badge-result ${d.overall}">${d.overall}</span>
    </div>`;
  }).join('');
}

/* ---------------------------------------------------------------
   Wiring
--------------------------------------------------------------- */
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => { if (e.target.files.length) handleFiles(e.target.files); fileInput.value=''; });
['dragenter','dragover'].forEach(evt => dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave','drop'].forEach(evt => dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.remove('drag'); }));
dropzone.addEventListener('drop', e => { if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });

document.getElementById('refreshSavedBtn').addEventListener('click', () => { renderSavedList(); renderSessionBanner(); });
document.getElementById('exportBtn').addEventListener('click', async () => {
  const docs = await queryAll();
  const json = JSON.stringify(docs, null, 2);
  const area = document.getElementById('exportArea');
  area.style.display = 'block'; area.value = json; area.select();
  if (downloadsNS){ try { await downloadsNS.save({filename: `qa-scores-${(ingested.sessionId||'session')}.json`, data: json}); } catch(e){} }
});

(async function init(){
  await initCapabilities();
  renderScenarioTabs();
  renderSavedList();
  renderSessionBanner();
})();
