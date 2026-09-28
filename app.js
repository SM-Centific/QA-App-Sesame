/* ---------------------------------------------------------------
   Item definitions
--------------------------------------------------------------- */
const ITEMS_C0 = [
  {id:'sync_chirp', label:'Sync Chirp', priority:'P0', kind:'gate', help:'Audible chirp detected and aligned across camera + ambient mic.'},
  {id:'static_5s', label:'5-Second Static (start)', priority:'P0', kind:'scale', help:'Performer/rig held still for ~5s at capture start.'},
  {id:'figure_8', label:'Figure-8 Motion', priority:'P0', kind:'scale', help:'Figure-8 movement pattern in the ~5–10s window.'},
  {id:'translation', label:'Translation Movements', priority:'P0', kind:'scale', help:'Near/far translation movements in the ~25–30s window.'},
  {id:'static_end', label:'Static Before End', priority:'P0', kind:'scale', help:'Held still again before the capture ends.'},
];
const ITEMS_TECHNICAL = [
  {id:'device_placements', label:'Device Placements', priority:'P0', kind:'scale', help:'At least 6 distinct camera positions covered in this room.'},
  {id:'useful_views', label:'Useful Views', priority:'P0', kind:'scale', help:'Count of retained/usable views for this room.'},
  {id:'audio_quality', label:'Audio Quality', priority:'P1', kind:'scale', help:'Clipping, noise floor, intelligibility.'},
  {id:'video_quality', label:'Video Quality', priority:'P1', kind:'scale', help:'Exposure, focus, framing, dropped frames.'},
];
const ITEMS_PARTICIPANT = [
  {id:'continuous_movement', label:'Continuous Movement', priority:'P0', kind:'scale', help:'Performer in continuous motion for >75% of the episode.'},
  {id:'blue_zone', label:'Blue Zone %', priority:'P1', kind:'scale', help:'Time spent inside the 120°×5m forward FOV. Use the live overlay as a guide.'},
  {id:'orange_zone', label:'Orange Zone %', priority:'P1', kind:'scale', help:'Brief exits/re-entries outside FOV, staying near 2m, turning back before 3m.'},
  {id:'speed_variance', label:'Speed Variance', priority:'P1', kind:'scale', help:'Natural variation in movement speed.'},
  {id:'distance_variance', label:'Distance Variance', priority:'P1', kind:'scale', help:'Natural variation in near/far distance.'},
];
const SCENARIO_ORDER = ['C0','T1-R1','T1-R2','T1-R3'];

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
let formCache = {};
let localScores = {};
let dbNS = null, downloadsNS = null;
let videoEl = null; // live reference to the <video> element, persists across episode changes

function escapeHtml(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function logLine(html){ const el = document.getElementById('loadLog'); const d = document.createElement('div'); d.innerHTML = html; el.appendChild(d); el.scrollTop = el.scrollHeight; }
function deriveCaptureIdFromName(name){ const m = /_c(\d{3,})[._]/.exec(name || ''); return m ? 'c' + m[1] : null; }

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
function computeAutos(scenarioId, items){
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
  if (autos.useful_views){
    const episodes = captureId ? ingested.episodesByCapture[captureId] : null;
    const n = episodes ? episodes.filter(e => e.disposition === 'retained').length : null;
    if (n != null && n > 0){ autos.useful_views.value = n < 10 ? 1 : (n <= 12 ? 2 : 3); autos.useful_views.note = `${n} retained episodes (of ${episodes.length})`; }
    else { autos.useful_views.note = 'No episode_markers loaded for this capture yet.'; }
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
--------------------------------------------------------------- */
function computeScores(items, values){
  let gateFailed = false; const p0 = [], p1 = [];
  items.forEach(it => {
    const v = values[it.id];
    if (it.kind === 'gate'){ if (v === 'fail') gateFailed = true; }
    else if (v != null){ (it.priority === 'P0' ? p0 : p1).push(v); }
  });
  const avg = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : null;
  const p0Avg = avg(p0), p1Avg = avg(p1);
  const p0Pct = p0Avg != null ? p0Avg/3*100 : null;
  const p1Pct = p1Avg != null ? p1Avg/3*100 : null;
  let overall = 'incomplete';
  if (gateFailed) overall = 'fail';
  else if (p0Pct != null || p1Pct != null){
    const p0ok = p0Pct == null || p0Pct >= 85; const p1ok = p1Pct == null || p1Pct >= 75;
    overall = (p0ok && p1ok) ? 'pass' : 'fail';
  }
  return {p0Pct, p1Pct, gateFailed, overall};
}

function combinedT1Score(technicalValues, participantDocs){
  const p0vals = [technicalValues.device_placements, technicalValues.useful_views].filter(v => v != null);
  const p1vals = [technicalValues.audio_quality, technicalValues.video_quality].filter(v => v != null);
  const avgOf = key => { const nums = participantDocs.map(d => d.scores && d.scores[key]).filter(v => v != null); return nums.length ? nums.reduce((a,b)=>a+b,0)/nums.length : null; };
  const cm = avgOf('continuous_movement'); if (cm != null) p0vals.push(cm);
  ['blue_zone','orange_zone','speed_variance','distance_variance'].forEach(k => { const a = avgOf(k); if (a != null) p1vals.push(a); });
  const avg = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : null;
  const p0Avg = avg(p0vals), p1Avg = avg(p1vals);
  const p0Pct = p0Avg != null ? p0Avg/3*100 : null;
  const p1Pct = p1Avg != null ? p1Avg/3*100 : null;
  const p0ok = p0Pct == null || p0Pct >= 85; const p1ok = p1Pct == null || p1Pct >= 75;
  const overall = (p0Pct == null && p1Pct == null) ? 'incomplete' : ((p0ok && p1ok) ? 'pass' : 'fail');
  return {p0Pct, p1Pct, overall, scoredEpisodes: participantDocs.length};
}

/* ---------------------------------------------------------------
   Zone classification (mmWave track -> Blue/Orange/warning)
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
  // frames sorted ascending by videoTimeSec (attached below)
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
    btn.addEventListener('click', () => { currentScenarioId = btn.dataset.scenario; currentEpisodeId = null; renderScenarioTabs(); renderScenarioShell(); });
  });
}

function scoreSummaryHtml(p0Pct, p1Pct, overall, label){
  const pct = v => v == null ? '—' : v.toFixed(0) + '%';
  const w = v => v == null ? 0 : Math.max(0, Math.min(100, v));
  return `<div class="score-summary">
    <div class="score-metric"><div class="label">P0 (need ≥85%)</div><div class="value">${pct(p0Pct)}</div><div class="bar"><div style="width:${w(p0Pct)}%"></div></div></div>
    <div class="score-metric"><div class="label">P1 (need ≥75%)</div><div class="value">${pct(p1Pct)}</div><div class="bar"><div style="width:${w(p1Pct)}%"></div></div></div>
    <div class="overall-badge ${overall}">${label || overall.toUpperCase()}</div>
  </div>`;
}

function itemRowHtml(it, value, auto){
  const autoBadge = (auto && auto.value != null) ? `<span class="badge auto">auto-suggested</span>` : '';
  const noteHtml = (auto && auto.note) ? `<div class="item-note">${escapeHtml(auto.note)}</div>` : '';
  let control;
  if (it.kind === 'gate'){
    control = ['pass','fail'].map(v => `<button type="button" class="seg ${value===v?'active '+v:''}" data-item="${it.id}" data-value="${v}">${v==='pass'?'Pass':'Fail'}</button>`).join('');
  } else {
    control = [1,2,3].map(n => `<button type="button" class="seg ${value===n?'active':''}" data-item="${it.id}" data-value="${n}">${n}</button>`).join('');
  }
  return `<div class="item-row">
    <div class="item-label"><span class="pri ${it.priority}">${it.priority}</span> ${escapeHtml(it.label)} ${autoBadge}</div>
    <div class="item-desc">${escapeHtml(it.help)}</div>
    <div class="seg-group">${control}</div>
    ${noteHtml}
  </div>`;
}

async function ensureFormLoaded(docId, items, kind, scenarioId, episodeId){
  if (formCache[docId]) return formCache[docId];
  const saved = await loadDoc(docId);
  const autos = computeAutos(scenarioId, items);
  const values = {};
  items.forEach(it => {
    if (saved && saved.scores && saved.scores[it.id] != null) values[it.id] = saved.scores[it.id];
    else if (autos[it.id] && autos[it.id].value != null) values[it.id] = autos[it.id].value;
    else values[it.id] = null;
  });
  formCache[docId] = {docId, items, kind, scenarioId, episodeId, values, autos, notes: (saved && saved.notes) || '', savedAt: (saved && saved.savedAt) || null};
  return formCache[docId];
}

function fmtSec(ms){ return ms == null ? '—' : (ms/1000).toFixed(1) + 's'; }

/* ---------------------------------------------------------------
   Rendering: scenario shell (video + episode selector + zone overlay)
   Rebuilt only on scenario change, so the <video> element is not
   recreated on episode switches or score saves.
--------------------------------------------------------------- */
async function renderScenarioShell(){
  const shell = document.getElementById('scenarioShell');
  videoEl = null;
  if (!currentScenarioId || !ingested.scenarios[currentScenarioId]){
    shell.innerHTML = `<div class="empty-state">Choose a scenario on the left to begin scoring.</div>`;
    document.getElementById('scoringSection').innerHTML = '';
    return;
  }
  const scenario = ingested.scenarios[currentScenarioId];
  const episodes = ingested.episodesByCapture[scenario.captureId] || [];
  if (!currentEpisodeId && episodes.length) currentEpisodeId = episodes[0].episodeId;
  const video = ingested.videosByCapture[scenario.captureId];
  const audit = ingested.auditByScenario[currentScenarioId];
  const tracks = ingested.tracksByCapture[scenario.captureId];
  const videoZone = ingested.videoZoneByCapture[scenario.captureId];
  const zoneSource = videoZone ? 'video' : (tracks ? 'mmwave' : null); // video-based zone wins when both are present

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

  shell.innerHTML = `
    <div class="scenario-header">
      <div><h2>${escapeHtml(currentScenarioId)} — ${escapeHtml(scenario.roomLabel)}</h2>
      <div class="meta">${escapeHtml(scenario.captureId)}${episodes.length?` · ${episodes.filter(e=>e.disposition==='retained').length}/${episodes.length} retained episodes`:''}</div>
      ${auditLine}</div>
    </div>
    <div class="video-row">
      <div>${videoHtml}${episodeSelectHtml}</div>
      ${zoneHtml}
    </div>`;

  videoEl = document.getElementById('capVideo');
  const epSelect = document.getElementById('episodeSelect');
  const seekBtn = document.getElementById('seekBtn');
  const episodeInfo = document.getElementById('episodeInfo');

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

  // Wire zone overlay (independent of scoring re-renders — never rebuild videoEl after this)
  if (zoneSource === 'video' && video && videoEl){
    const frames = videoZone.map(f => ({ ...f, __t: f.time_s })).sort((a,b) => a.__t - b.__t);
    let lastUpdate = 0;
    videoEl.addEventListener('timeupdate', () => {
      const now = performance.now();
      if (now - lastUpdate < 200) return; // throttle to ~5/sec
      lastUpdate = now;
      const sample = nearestTrackFrame(frames, videoEl.currentTime);
      const zone = classifyZoneVideo(sample);
      const badge = document.getElementById('zoneBadge');
      const readout = document.getElementById('zoneReadout');
      const dot = document.getElementById('zoneDot');
      if (badge){ badge.className = 'zone-badge ' + zone.cls; badge.textContent = zone.label; }
      if (readout) readout.textContent = (sample && sample.azimuth_deg != null) ? `${sample.azimuth_deg.toFixed(0)}°${sample.score!=null?` (score ${sample.score.toFixed(2)})`:''}` : '–';
      if (dot && sample && sample.azimuth_deg != null){
        // simple angle-only indicator: place the dot on a fixed-radius arc at the detected azimuth (no range available from video)
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
      if (now - lastUpdate < 200) return; // throttle to ~5/sec
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
   Rendering: scoring section (rebuilt on scenario AND episode change,
   and after each save — never touches the video element)
--------------------------------------------------------------- */
async function renderScoringSection(){
  const el = document.getElementById('scoringSection');
  if (!currentScenarioId || !ingested.scenarios[currentScenarioId]){ el.innerHTML = ''; return; }
  const scenario = ingested.scenarios[currentScenarioId];

  if (currentScenarioId === 'C0'){
    const docId = `${ingested.sessionId}__C0__form`;
    const form = await ensureFormLoaded(docId, ITEMS_C0, 'c0', 'C0', null);
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
    wireItemClicks('c0Items', docId);
    wireSaveButton(docId, ITEMS_C0, 'c0', 'C0', null, 'saveBtn', 'savedAtLabel');
    return;
  }

  const techDocId = `${ingested.sessionId}__${currentScenarioId}__technical`;
  const techForm = await ensureFormLoaded(techDocId, ITEMS_TECHNICAL, 'technical', currentScenarioId, null);
  const episodes = ingested.episodesByCapture[scenario.captureId] || [];
  const allDocs = await queryAll();
  const participantDocs = allDocs.filter(d => d.scenarioId === currentScenarioId && d.kind === 'participant');
  const rollup = combinedT1Score(techForm.values, participantDocs);

  let episodeSectionHtml = `<div class="empty-state">No episode_markers loaded for this room yet.</div>`;
  let participantForm = null, epDocId = null;
  if (episodes.length && currentEpisodeId){
    epDocId = `${ingested.sessionId}__${currentScenarioId}__ep__${currentEpisodeId}`;
    participantForm = await ensureFormLoaded(epDocId, ITEMS_PARTICIPANT, 'participant', currentScenarioId, currentEpisodeId);
    const epScores = computeScores(ITEMS_PARTICIPANT, participantForm.values);
    episodeSectionHtml = `
      ${scoreSummaryHtml(epScores.p0Pct, epScores.p1Pct, epScores.overall)}
      <div id="participantItems">${ITEMS_PARTICIPANT.map(it => itemRowHtml(it, participantForm.values[it.id], null)).join('')}</div>
      <div class="notes-block"><label>Reviewer notes (this episode)</label><textarea id="epNotesField">${escapeHtml(participantForm.notes)}</textarea></div>
      <div class="save-row">
        <button class="btn primary" id="saveEpBtn">Save episode score</button>
        <span class="saved-at" id="epSavedAtLabel">${participantForm.savedAt ? 'Saved ' + new Date(participantForm.savedAt).toLocaleString() : 'Not saved yet'}</span>
      </div>`;
  }

  el.innerHTML = `
    ${scoreSummaryHtml(rollup.p0Pct, rollup.p1Pct, rollup.overall, `${rollup.overall.toUpperCase()} · ${rollup.scoredEpisodes}/${episodes.length||'?'} episodes scored`)}
    <div class="panel">
      <div class="section-title">Technical <span class="count">room-level · P0 &amp; P1</span></div>
      <div id="techItems">${ITEMS_TECHNICAL.map(it => itemRowHtml(it, techForm.values[it.id], techForm.autos[it.id])).join('')}</div>
      <div class="save-row">
        <button class="btn primary" id="saveTechBtn">Save technical score</button>
        <span class="saved-at" id="techSavedAtLabel">${techForm.savedAt ? 'Saved ' + new Date(techForm.savedAt).toLocaleString() : 'Not saved yet'}</span>
      </div>
    </div>
    <div class="panel">
      <div class="section-title">Participant <span class="count">per episode</span></div>
      ${episodeSectionHtml}
    </div>`;

  wireItemClicks('techItems', techDocId);
  wireSaveButton(techDocId, ITEMS_TECHNICAL, 'technical', currentScenarioId, null, 'saveTechBtn', 'techSavedAtLabel');
  if (participantForm){
    wireItemClicks('participantItems', epDocId);
    wireSaveButton(epDocId, ITEMS_PARTICIPANT, 'participant', currentScenarioId, currentEpisodeId, 'saveEpBtn', 'epSavedAtLabel');
  }
}

function wireItemClicks(containerId, docId){
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
}

function wireSaveButton(docId, items, kind, scenarioId, episodeId, btnId, labelId){
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

document.getElementById('refreshSavedBtn').addEventListener('click', renderSavedList);
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
})();
