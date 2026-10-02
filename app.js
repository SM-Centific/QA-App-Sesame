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
   Backend (Power Automate + SharePoint Excel). See docs/power-automate-spec.md.
--------------------------------------------------------------- */
const QAACCESS_READ_URL = "https://default9b415834803a4da0afdcfe6b1d52d6.49.environment.api.powerplatform.com:443/powerautomate/automations/direct/cu/05/workflows/152a06201a4642339d1e07e930f329d4/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=WorDH8s8grB_3ocp4OmNI5BuSHcx5yA98pjAufZddjU";
const QASCORES_READ_URL = "https://default9b415834803a4da0afdcfe6b1d52d6.49.environment.api.powerplatform.com:443/powerautomate/automations/direct/cu/20/workflows/5e00c2485f8a44129e2aeff73933d0d3/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=RzjbtxXXZMLc7k5Z55NPPqrqwGmIddDQw8rpKr2dsRI";
const QASCORES_WRITE_URL = "https://default9b415834803a4da0afdcfe6b1d52d6.49.environment.api.powerplatform.com:443/powerautomate/automations/direct/cu/04/workflows/99955cada8a441b6a27b171c0f617686/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=XhQwo6f1r_avdZJbufnezrS-szlvNFQQLoBifdIegxU";

let currentUserEmail = null;
let currentUserRole = null;

/* ---------------------------------------------------------------
   Ingested session state
--------------------------------------------------------------- */
let ingested = {
  sessionId: null, scenarios: {}, evidenceByCapture: {}, validationByCapture: {},
  episodesByCapture: {}, auditByScenario: {}, videosByCapture: {},
  videoZoneByCapture: {},
};
let currentScenarioId = null;
let currentEpisodeId = null;
let currentScope = 'technical'; // 'technical' | 'participant' — only meaningful for T1 scenarios
let formCache = {};
let annotationsCache = {}; // scenarioId -> array of {id, type, timeSec, text, createdAt}
let autoSaveTimers = {}; // docId -> pending setTimeout handle, for debounced autosave
let activeForm = null;   // {docId, items, kind, scenarioId, episodeId} for whichever form is currently on screen — lets episode/scope/scenario switches flush a pending autosave before tearing the form down
let localScores = {};
let dbNS = null, downloadsNS = null;
let videoEl = null; // live reference to the <video> element, persists across episode/scope changes
let activeVideoObj = null; // whichever videosByCapture entry currently holds a live blob URL, if any

function escapeHtml(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function logLine(html){ const el = document.getElementById('loadLog'); const d = document.createElement('div'); d.innerHTML = html; el.appendChild(d); el.scrollTop = el.scrollHeight; }
function deriveCaptureIdFromName(name){ const m = /_c(\d{3,})[._]/.exec(name || ''); return m ? 'c' + m[1] : null; }
function fmtSec(ms){ return ms == null ? '—' : (ms/1000).toFixed(1) + 's'; }
function fmtPct(v){ return v == null ? '—' : v.toFixed(0) + '%'; }
function fmtClock(sec){ sec = Math.max(0, Math.round(sec)); const m = Math.floor(sec/60), s = sec%60; return `${m}:${String(s).padStart(2,'0')}`; }

/* ---------------------------------------------------------------
   Video annotations — flags and timestamped comments on a capture's
   video, stored per scenario (one video per room, spans all its
   episodes) and exported alongside scores as their own sheet/table.
--------------------------------------------------------------- */
function annotationDocId(scenarioId){ return `${ingested.sessionId}__${scenarioId}__annotations`; }

async function ensureAnnotationsLoaded(scenarioId){
  if (annotationsCache[scenarioId]) return annotationsCache[scenarioId];
  const saved = await loadDoc(annotationDocId(scenarioId));
  annotationsCache[scenarioId] = (saved && saved.annotations) || [];
  return annotationsCache[scenarioId];
}

async function persistAnnotations(scenarioId){
  const scenario = ingested.scenarios[scenarioId];
  await saveDoc(annotationDocId(scenarioId), {
    sessionId: ingested.sessionId, scenarioId, kind: 'annotations',
    roomLabel: (scenario || {}).roomLabel || null,
    annotations: annotationsCache[scenarioId] || [],
    savedAt: new Date().toISOString(),
  });
}

async function addAnnotation(scenarioId, {type, timeSec, text}){
  await ensureAnnotationsLoaded(scenarioId);
  annotationsCache[scenarioId].push({
    id: `${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
    type, timeSec, text, createdAt: new Date().toISOString(),
  });
  await persistAnnotations(scenarioId);
}

async function deleteAnnotation(scenarioId, id){
  await ensureAnnotationsLoaded(scenarioId);
  annotationsCache[scenarioId] = annotationsCache[scenarioId].filter(a => a.id !== id);
  await persistAnnotations(scenarioId);
}

function findEpisodeNumberForTime(episodes, timeSec){
  for (const ep of episodes){
    if (ep.startElapsedMs == null || ep.durationMs == null) continue;
    const start = ep.startElapsedMs / 1000, end = (ep.startElapsedMs + ep.durationMs) / 1000;
    if (timeSec >= start && timeSec <= end) return ep.episodeNumber;
  }
  return null;
}

async function renderAnnotationsList(scenarioId, episodes){
  const listEl = document.getElementById('annotationList');
  const countEl = document.getElementById('annotationCount');
  if (!listEl) return;
  const anns = (await ensureAnnotationsLoaded(scenarioId)).slice().sort((a,b) => a.timeSec - b.timeSec);
  if (countEl) countEl.textContent = anns.length ? `(${anns.length})` : '';
  if (!anns.length){ listEl.innerHTML = `<div class="empty-state" style="padding:10px 4px;">No flags or comments yet.</div>`; return; }
  listEl.innerHTML = anns.map(a => {
    const epNum = findEpisodeNumberForTime(episodes, a.timeSec);
    return `<div class="annotation-row ${a.type}">
      <span class="a-time" data-seek="${a.timeSec}">${fmtClock(a.timeSec)}</span>
      <span class="a-type">${a.type === 'flag' ? '⚑' : '💬'}</span>
      <div class="a-body">${escapeHtml(a.text)}${epNum != null ? `<div class="a-ep">episode ${epNum}</div>` : ''}</div>
      <button class="a-del" data-del="${a.id}" title="Delete">×</button>
    </div>`;
  }).join('');
  listEl.querySelectorAll('[data-seek]').forEach(el => {
    el.addEventListener('click', () => { if (videoEl) videoEl.currentTime = parseFloat(el.dataset.seek); });
  });
  listEl.querySelectorAll('[data-del]').forEach(el => {
    el.addEventListener('click', async () => { await deleteAnnotation(scenarioId, el.dataset.del); renderAnnotationsList(scenarioId, episodes); });
  });
}

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
    if (lines[0].schemaVersion === 'hydra.mmwave-tracks/1' || (lines[0].frameIndex != null && 'tracks' in lines[0])){
      logLine(`<span class="tag warn">skipped</span> ${escapeHtml(filename)} — mmWave tracks are no longer used (unreliable, and heavy on memory); drop a *.video_zone.jsonl instead`);
      return;
    }
    if ('azimuth_deg' in lines[0] && 'in_blue_zone' in lines[0]){ ingestVideoZone(lines, filename); return; }
    logLine(`<span class="tag warn">unrecognized</span> ${escapeHtml(filename)} (JSONL, unknown shape)`);
  }
}

function ingestVideo(file){
  const captureId = deriveCaptureIdFromName(file.name);
  if (!captureId){ logLine(`<span class="tag warn">skip</span> ${escapeHtml(file.name)} — couldn't detect capture id from filename`); return; }
  // Keep just the raw File reference for now — cheap, no blob URL created yet.
  // The URL is only created lazily when this capture's video is actually opened
  // (see renderScenarioShell), so loading several videos at once doesn't hold
  // several live blobs in memory simultaneously.
  ingested.videosByCapture[captureId] = { name: file.name, file, url: null };
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
   Three layers, tried in order: Claude's db capability (only present
   when this runs inside a Claude artifact preview — never true on
   GitHub Pages, kept only so the same code still works there too),
   then localStorage (the real persistence on GitHub Pages — survives
   reloads, scoped to this one browser/device), then an in-memory
   object as a last-resort safety net if localStorage is unavailable
   (private browsing, quota exceeded, etc).
   This is a deliberate stand-in for the eventual SharePoint/Power
   Automate backend — loadDoc/saveDoc/queryAll are the only three
   functions that need to change when that's wired up; nothing else
   in the app talks to storage directly.
--------------------------------------------------------------- */
const LS_PREFIX = 'qa_app_sesame::';
let localStorageOk = false;

function lsSet(docId, payload){
  try { localStorage.setItem(LS_PREFIX + docId, JSON.stringify(payload)); return true; } catch(e){ return false; }
}
function lsGet(docId){
  try { const raw = localStorage.getItem(LS_PREFIX + docId); return raw ? JSON.parse(raw) : null; } catch(e){ return null; }
}
function lsAll(){
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++){
      const key = localStorage.key(i);
      if (key && key.startsWith(LS_PREFIX)){
        try { out.push(JSON.parse(localStorage.getItem(key))); } catch(e){}
      }
    }
  } catch(e){}
  return out;
}

let remoteCache = null; // array of parsed score payloads, once a QASCORES_READ_URL fetch succeeds

async function initCapabilities(){
  try {
    if (window.claude && window.claude.use){ dbNS = await window.claude.use('db'); downloadsNS = await window.claude.use('downloads'); }
  } catch(e){ dbNS = null; downloadsNS = null; }
  try { localStorage.setItem('__qa_test__','1'); localStorage.removeItem('__qa_test__'); localStorageOk = true; } catch(e){ localStorageOk = false; }
  const statusEl = document.getElementById('persistStatus');
  if (dbNS) { statusEl.textContent = 'Connected — scores persist across reloads'; return; }
  // Try the real backend once at startup; fall back to a local-only message if it's unreachable.
  const fetched = await fetchAllFromRemote();
  if (fetched != null) statusEl.textContent = 'Connected to SharePoint — scores shared across reviewers';
  else if (localStorageOk) statusEl.textContent = 'Backend unreachable — saved in this browser only, this device';
  else statusEl.textContent = 'Local only — scores clear on reload (backend and browser storage both unavailable)';
}

async function checkAccess(email){
  try {
    const res = await fetch(QAACCESS_READ_URL, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email}),
    });
    if (!res.ok) return {authorized: false, networkError: true};
    return await res.json();
  } catch(e){ return {authorized: false, networkError: true}; }
}

async function fetchAllFromRemote(){
  try {
    const res = await fetch(QASCORES_READ_URL, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}',
    });
    if (!res.ok) throw new Error('bad status ' + res.status);
    const data = await res.json();
    const rows = (data && (data.value || (data.body && data.body.value))) || [];
    remoteCache = rows.map(r => {
      try { return JSON.parse(r.payload_json); } catch(e){ return null; }
    }).filter(Boolean);
    return remoteCache;
  } catch(e){
    return null; // caller falls back to localStorage/in-memory
  }
}

function rowForDoc(docId, payload){
  return {
    doc_id: docId,
    session_id: payload.sessionId || '',
    scenario_id: payload.scenarioId || '',
    episode_id: payload.episodeId || '',
    kind: payload.kind || '',
    payload_json: JSON.stringify(payload),
    saved_at: payload.savedAt || new Date().toISOString(),
  };
}

async function loadDoc(docId){
  if (dbNS){ try { const snap = await dbNS.collection('qa_scores').doc(docId).get(); if (snap.exists) return snap.data(); } catch(e){} }
  const all = await queryAll();
  const found = all.find(d => docIdFor(d) === docId);
  if (found) return found;
  return lsGet(docId) || localScores[docId] || null;
}

async function saveDoc(docId, payload){
  localScores[docId] = payload; // in-memory safety net
  lsSet(docId, payload);        // local mirror — keeps the app usable even if the network write below fails
  if (dbNS){ try { await dbNS.collection('qa_scores').doc(docId).set(payload); return true; } catch(e){} }
  try {
    const res = await fetch(QASCORES_WRITE_URL, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(rowForDoc(docId, payload)),
    });
    if (!res.ok) throw new Error('bad status ' + res.status);
    if (remoteCache){
      const idx = remoteCache.findIndex(d => docIdFor(d) === docId);
      if (idx >= 0) remoteCache[idx] = payload; else remoteCache.push(payload);
    }
    return true;
  } catch(e){
    return false; // still saved locally above — not a total loss, just not shared yet
  }
}

async function queryAll(){
  if (dbNS){ try { const qs = await dbNS.collection('qa_scores').limit(500).get(); return qs.docs.map(d => d.data()); } catch(e){} }
  if (remoteCache != null) return remoteCache;
  const fetched = await fetchAllFromRemote();
  if (fetched != null) return fetched;
  const ls = lsAll();
  if (ls.length) return ls;
  return Object.values(localScores);
}

/* Reconstruct the docId a saved record originally used — needed to
   restore imported records to the exact same storage key so re-saving
   the same episode later overwrites rather than duplicates. */
function docIdFor(d){
  if (d.kind === 'c0') return `${d.sessionId}__C0__form`;
  if (d.kind === 'technical') return `${d.sessionId}__${d.scenarioId}__technical`;
  if (d.kind === 'participant') return `${d.sessionId}__${d.scenarioId}__ep__${d.episodeId}`;
  if (d.kind === 'annotations') return `${d.sessionId}__${d.scenarioId}__annotations`;
  return null;
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
      const hasVideoZone = !!ingested.videoZoneByCapture[s.captureId];
      const zoneFlag = id !== 'C0' ? (hasVideoZone ? ' · video-zone ✓' : ' · no zone data') : '';
      flags = `<span class="flags">${hasVideo ? 'video ✓' : 'no video'}${zoneFlag}</span>`;
    }
    return `<button class="${active}" data-scenario="${id}" ${disabled}>${id}${s ? `<span class="room">${escapeHtml(s.roomLabel)}</span>${flags}` : ''}</button>`;
  }).join('');
  el.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      flushActiveAutoSave();
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
   Video blob lifecycle — only one capture's video blob is ever kept
   alive at a time, created the moment its scenario is opened and
   released the moment another one takes its place. Keeps memory use
   flat regardless of how many videos were dropped into the session.
--------------------------------------------------------------- */
function releaseActiveVideo(){
  if (activeVideoObj && activeVideoObj.url){
    URL.revokeObjectURL(activeVideoObj.url);
    activeVideoObj.url = null;
  }
  activeVideoObj = null;
}
function activateVideo(video){
  if (activeVideoObj === video) return; // same one already active — don't recreate/reset playback
  releaseActiveVideo();
  if (video && video.file){
    video.url = URL.createObjectURL(video.file);
    activeVideoObj = video;
  }
}

/* ---------------------------------------------------------------
   Rendering: scenario shell (video + zone overlay + episode selector
   + scope sub-tabs). Rebuilt only on scenario change, so the <video>
   element is never recreated on episode/scope switches or saves.
--------------------------------------------------------------- */
async function renderScenarioShell(){
  flushActiveAutoSave();
  const shell = document.getElementById('scenarioShell');
  videoEl = null;
  if (!currentScenarioId || !ingested.scenarios[currentScenarioId]){
    releaseActiveVideo(); // nothing will be shown, so don't keep any blob alive
    shell.innerHTML = `<div class="empty-state">Choose a scenario on the left to begin scoring.</div>`;
    return;
  }
  const scenario = ingested.scenarios[currentScenarioId];
  const episodes = ingested.episodesByCapture[scenario.captureId] || [];
  if (!currentEpisodeId && episodes.length) currentEpisodeId = episodes[0].episodeId;
  const video = ingested.videosByCapture[scenario.captureId];
  activateVideo(video); // lazily create this one's blob URL, releasing whichever other one was active
  const audit = ingested.auditByScenario[currentScenarioId];
  const videoZone = ingested.videoZoneByCapture[scenario.captureId];
  const zoneSource = videoZone ? 'video' : null;
  const isC0 = currentScenarioId === 'C0';

  const auditLine = audit ? `<div class="audit-line">Devices required: ${escapeHtml(audit.expectedDevices.join(', '))}</div>` : '';
  const videoHtml = video
    ? `<video id="capVideo" controls preload="metadata" src="${video.url}"></video>`
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
         <div class="zone-readout" style="opacity:.7">source: video detection</div>
       </div>`
    : '';

  const episodeSelectHtml = episodes.length ? `
    <div class="episode-select-row">
      <button class="btn" id="prevEpBtn" title="Previous episode">‹ Prev</button>
      <select id="episodeSelect">
        ${episodes.map(e => `<option value="${e.episodeId}" ${e.episodeId===currentEpisodeId?'selected':''}>Episode ${e.episodeNumber ?? '?'}${(e.invalidReasons&&e.invalidReasons.length)?' ⚠':''}</option>`).join('')}
      </select>
      <button class="btn" id="nextEpBtn" title="Next episode">Next ›</button>
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
        <div class="annotation-panel" id="annotationPanel">
          <div class="panel-title">Video annotations <span id="annotationCount"></span></div>
          <div class="annotation-add-row">
            <button class="btn" id="addFlagBtn">⚑ Flag moment</button>
            <button class="btn" id="addCommentBtn">💬 Add comment</button>
          </div>
          <div id="annotationFormHost"></div>
          <div class="annotation-list" id="annotationList"></div>
        </div>
      </div>
      <div class="score-col" id="scoringSection"></div>
    </div>`;

  videoEl = document.getElementById('capVideo');
  const epSelect = document.getElementById('episodeSelect');
  const seekBtn = document.getElementById('seekBtn');
  const prevEpBtn = document.getElementById('prevEpBtn');
  const nextEpBtn = document.getElementById('nextEpBtn');
  const episodeInfo = document.getElementById('episodeInfo');

  shell.querySelectorAll('.scope-tabs button[data-scope]').forEach(btn => {
    btn.addEventListener('click', () => {
      flushActiveAutoSave();
      currentScope = btn.dataset.scope; shell.querySelectorAll('.scope-tabs button[data-scope]').forEach(b=>b.classList.toggle('active', b===btn)); renderScoringSection();
    });
  });

  function updateEpisodeInfo(){
    const ep = episodes.find(e => e.episodeId === currentEpisodeId);
    if (!ep || !episodeInfo) return;
    const flag = (ep.invalidReasons && ep.invalidReasons.length) ? `<span class="flag-pill">${escapeHtml(ep.invalidReasons.join(', '))}</span>` : '';
    episodeInfo.innerHTML = `duration ${fmtSec(ep.durationMs)} · target ${ep.targetDurationSec ?? '—'}s ±${ep.toleranceSec ?? '—'}s ${flag}`;
  }
  updateEpisodeInfo();

  function updateNavButtonStates(){
    const idx = episodes.findIndex(e => e.episodeId === currentEpisodeId);
    if (prevEpBtn) prevEpBtn.disabled = idx <= 0;
    if (nextEpBtn) nextEpBtn.disabled = idx < 0 || idx >= episodes.length - 1;
  }
  updateNavButtonStates();

  // Shared by the dropdown, the explicit seek button, and prev/next — jumping
  // to an episode always moves the video to its start, with no separate click
  // required to also seek (previously picking an episode from the dropdown
  // only switched the scoring form; seeking needed its own button press).
  function seekToEpisodeStart(ep){
    if (ep && ep.startElapsedMs != null && videoEl) videoEl.currentTime = ep.startElapsedMs / 1000;
  }
  function switchToEpisode(episodeId){
    flushActiveAutoSave();
    currentEpisodeId = episodeId;
    if (epSelect) epSelect.value = episodeId;
    updateEpisodeInfo();
    updateNavButtonStates();
    seekToEpisodeStart(episodes.find(e => e.episodeId === episodeId));
    renderScoringSection();
  }

  if (epSelect) epSelect.addEventListener('change', () => switchToEpisode(epSelect.value));
  if (seekBtn) seekBtn.addEventListener('click', () => seekToEpisodeStart(episodes.find(e => e.episodeId === currentEpisodeId)));
  if (prevEpBtn) prevEpBtn.addEventListener('click', () => {
    const idx = episodes.findIndex(e => e.episodeId === currentEpisodeId);
    if (idx > 0) switchToEpisode(episodes[idx - 1].episodeId);
  });
  if (nextEpBtn) nextEpBtn.addEventListener('click', () => {
    const idx = episodes.findIndex(e => e.episodeId === currentEpisodeId);
    if (idx >= 0 && idx < episodes.length - 1) switchToEpisode(episodes[idx + 1].episodeId);
  });

  // Video annotations (flags + timestamped comments) — tied to the scenario's
  // video as a whole, not to the currently-selected episode.
  if (video && videoEl){
    renderAnnotationsList(currentScenarioId, episodes);
    function openAnnotationForm(type){
      videoEl.pause();
      const t = videoEl.currentTime;
      const host = document.getElementById('annotationFormHost');
      host.innerHTML = `
        <div class="annotation-form">
          <div class="time-label">${type === 'flag' ? '⚑ Flag' : '💬 Comment'} at ${fmtClock(t)}</div>
          <textarea id="annotationText" placeholder="What did you notice?"></textarea>
          <div class="form-row">
            <button class="btn" id="annotationCancel">Cancel</button>
            <button class="btn primary" id="annotationSave">Save</button>
          </div>
        </div>`;
      document.getElementById('annotationCancel').addEventListener('click', () => { host.innerHTML = ''; });
      document.getElementById('annotationSave').addEventListener('click', async () => {
        const text = document.getElementById('annotationText').value.trim();
        if (!text) return;
        await addAnnotation(currentScenarioId, {type, timeSec: t, text});
        host.innerHTML = '';
        renderAnnotationsList(currentScenarioId, episodes);
      });
    }
    const flagBtn = document.getElementById('addFlagBtn');
    const commentBtn = document.getElementById('addCommentBtn');
    if (flagBtn) flagBtn.addEventListener('click', () => openAnnotationForm('flag'));
    if (commentBtn) commentBtn.addEventListener('click', () => openAnnotationForm('comment'));
  }

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
    wireItemInputs('c0Items', docId, ITEMS_C0, 'c0', 'C0', null);
    wireNotesField('notesField', docId, ITEMS_C0, 'c0', 'C0', null);
    wireSaveButton(docId, ITEMS_C0, 'c0', 'C0', null, 'saveBtn');
    activeForm = {docId, items: ITEMS_C0, kind: 'c0', scenarioId: 'C0', episodeId: null};
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
    wireItemInputs('techItems', techDocId, ITEMS_TECHNICAL, 'technical', currentScenarioId, null);
    wireSaveButton(techDocId, ITEMS_TECHNICAL, 'technical', currentScenarioId, null, 'saveTechBtn');
    activeForm = {docId: techDocId, items: ITEMS_TECHNICAL, kind: 'technical', scenarioId: currentScenarioId, episodeId: null};
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
  wireItemInputs('participantItems', epDocId, ITEMS_PARTICIPANT, 'participant', currentScenarioId, currentEpisodeId);
  wireNotesField('epNotesField', epDocId, ITEMS_PARTICIPANT, 'participant', currentScenarioId, currentEpisodeId);
  wireSaveButton(epDocId, ITEMS_PARTICIPANT, 'participant', currentScenarioId, currentEpisodeId, 'saveEpBtn');
  activeForm = {docId: epDocId, items: ITEMS_PARTICIPANT, kind: 'participant', scenarioId: currentScenarioId, episodeId: currentEpisodeId};
}

function wireItemInputs(containerId, docId, items, kind, scenarioId, episodeId){
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
      queueAutoSave(docId, items, kind, scenarioId, episodeId, {delay: 300});
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
      queueAutoSave(docId, items, kind, scenarioId, episodeId, {delay: 300});
    });
  });
}

// Wires the notes textarea to autosave on a debounce, WITHOUT re-rendering
// the scoring section on every keystroke (that would steal focus/reset the
// cursor mid-word). This is also the direct fix for notes silently not
// making it into the scorecard: previously notes only got read out of the
// textarea at the moment the Save button was clicked, so typing notes and
// then switching episode/scope without clicking Save first lost them
// entirely. Now every keystroke is captured into formCache immediately.
function wireNotesField(fieldId, docId, items, kind, scenarioId, episodeId){
  const el = document.getElementById(fieldId);
  if (!el) return;
  el.addEventListener('input', () => {
    if (!formCache[docId]) return;
    formCache[docId].notes = el.value;
    queueAutoSave(docId, items, kind, scenarioId, episodeId, {delay: 800, skipScoringRerender: true});
  });
}

/* ---------------------------------------------------------------
   Autosave. Every score button and every notes keystroke persists on
   its own — no save button has to be clicked for data to survive a
   switch to a different episode/scope/scenario, or a page reload.
   Discrete inputs (scale/gate buttons) save almost immediately;
   notes are debounced so typing doesn't fire a save per keystroke.
   `activeForm` tracks whichever form is currently on screen so a
   switch can flush any not-yet-fired debounced save first.
--------------------------------------------------------------- */
function saveStatusLabelEl(){
  return document.getElementById('savedAtLabel') || document.getElementById('techSavedAtLabel') || document.getElementById('epSavedAtLabel');
}
function setSaveStatus(state, savedAt){
  const el = saveStatusLabelEl();
  if (!el) return;
  if (state === 'saving') el.textContent = 'Saving…';
  else if (state === 'saved') el.textContent = 'Saved ' + new Date(savedAt).toLocaleTimeString();
}

async function doAutoSave(docId, items, kind, scenarioId, episodeId, opts){
  opts = opts || {};
  const form = formCache[docId];
  if (!form) return;
  const scores = computeScores(items, form.values);
  const payload = {
    sessionId: ingested.sessionId, scenarioId, episodeId, kind,
    roomLabel: (ingested.scenarios[scenarioId] || {}).roomLabel || null,
    scores: form.values, notes: form.notes,
    p0Pct: scores.p0Pct, p1Pct: scores.p1Pct, overall: scores.overall,
    savedAt: new Date().toISOString(),
  };
  setSaveStatus('saving');
  await saveDoc(docId, payload);
  form.savedAt = payload.savedAt;
  setSaveStatus('saved', payload.savedAt);
  renderSavedList();
  renderSessionBanner();
  // Notes autosave skips this to avoid tearing down the textarea the
  // reviewer is actively typing in (full re-render would steal focus
  // and reset the cursor position mid-word).
  if (!opts.skipScoringRerender) renderScoringSection();
}

function queueAutoSave(docId, items, kind, scenarioId, episodeId, opts){
  opts = opts || {};
  clearTimeout(autoSaveTimers[docId]);
  autoSaveTimers[docId] = setTimeout(() => {
    delete autoSaveTimers[docId];
    doAutoSave(docId, items, kind, scenarioId, episodeId, opts);
  }, opts.delay || 400);
}

// Called right before switching episode/scope/scenario (or leaving the
// page), so a debounced save still pending doesn't just get dropped.
function flushActiveAutoSave(){
  if (!activeForm) return;
  const {docId, items, kind, scenarioId, episodeId} = activeForm;
  if (autoSaveTimers[docId]){
    clearTimeout(autoSaveTimers[docId]);
    delete autoSaveTimers[docId];
    doAutoSave(docId, items, kind, scenarioId, episodeId, {skipScoringRerender: true});
  }
}
window.addEventListener('beforeunload', flushActiveAutoSave);

// The Save button still exists as a manual "save right now" fallback —
// useful as reassurance, or to force a save through immediately rather
// than waiting out the debounce — but it is no longer the only thing
// that persists data; every input already autosaves on its own.
function wireSaveButton(docId, items, kind, scenarioId, episodeId, btnId){
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    clearTimeout(autoSaveTimers[docId]);
    delete autoSaveTimers[docId];
    const notesEl = document.getElementById(kind === 'participant' ? 'epNotesField' : 'notesField');
    if (notesEl) formCache[docId].notes = notesEl.value;
    await doAutoSave(docId, items, kind, scenarioId, episodeId, {});
  });
}

async function renderSavedList(){
  const el = document.getElementById('savedList');
  const docs = (await queryAll()).filter(d => d.kind !== 'annotations');
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

document.getElementById('refreshSavedBtn').addEventListener('click', async () => {
  remoteCache = null; // force a fresh fetch instead of reusing whatever was cached
  await queryAll();
  renderSavedList(); renderSessionBanner();
  if (currentScenarioId) { formCache = {}; renderScoringSection(); }
});
document.getElementById('exportBtn').addEventListener('click', async () => {
  const docs = await queryAll();
  const json = JSON.stringify(docs, null, 2);
  const area = document.getElementById('exportArea');
  area.style.display = 'block'; area.value = json; area.select();
  if (downloadsNS){ try { await downloadsNS.save({filename: `qa-scores-${(ingested.sessionId||'session')}.json`, data: json}); } catch(e){} }
  // Plain download link works here (unlike inside a Claude artifact) since this is a normal static page.
  try {
    const blob = new Blob([json], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `qa-scores-${(ingested.sessionId||'session')}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch(e){}
});

const importInput = document.getElementById('importInput');
document.getElementById('importBtn').addEventListener('click', () => importInput.click());
importInput.addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const docs = JSON.parse(await file.text());
    let count = 0;
    for (const d of docs){
      const docId = docIdFor(d);
      if (!docId) continue;
      await saveDoc(docId, d);
      count++;
    }
    formCache = {}; annotationsCache = {}; // drop caches so re-renders pick up the imported values
    renderSavedList(); renderSessionBanner();
    if (currentScenarioId) { renderScenarioShell(); }
    logLine(`<span class="tag ok">import</span> loaded ${count} saved record(s) from ${escapeHtml(file.name)}`);
  } catch(err){
    logLine(`<span class="tag warn">import failed</span> ${escapeHtml(err.message)}`);
  }
  importInput.value = '';
});

/* ---------------------------------------------------------------
   Access gate — checked against tbl_qa_access via QAACCESS_READ_URL.
   Nothing else in the app renders until this passes. The email is
   remembered in localStorage purely for convenience (skip retyping
   it every visit); the real check still runs every time, server-side.
--------------------------------------------------------------- */
function showApp(){
  document.getElementById('accessGate').style.display = 'none';
  document.getElementById('appRoot').style.display = '';
}

async function attemptAccess(email){
  const msgEl = document.getElementById('accessMsg');
  const submitBtn = document.getElementById('accessSubmit');
  if (msgEl) msgEl.textContent = '';
  if (submitBtn){ submitBtn.disabled = true; submitBtn.textContent = 'Checking…'; }
  const result = await checkAccess(email);
  if (submitBtn){ submitBtn.disabled = false; submitBtn.textContent = 'Continue'; }
  if (result.authorized){
    currentUserEmail = email; currentUserRole = result.role || null;
    try { localStorage.setItem('qa_app_user_email', email); } catch(e){}
    const who = document.getElementById('signedInAs');
    if (who) who.textContent = `${email}${currentUserRole ? ' · ' + currentUserRole : ''}`;
    showApp();
    await initCapabilities();
    renderScenarioTabs();
    renderSavedList();
    renderSessionBanner();
    return true;
  }
  if (msgEl){
    msgEl.textContent = result.networkError
      ? "Couldn't reach the access check right now — check your connection and try again."
      : "This email doesn't have access to the QA review tool.";
  }
  return false;
}

document.getElementById('accessSubmit').addEventListener('click', () => {
  const email = document.getElementById('accessEmail').value.trim();
  if (email) attemptAccess(email);
});
document.getElementById('accessEmail').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('accessSubmit').click();
});
document.getElementById('signOutBtn').addEventListener('click', () => {
  try { localStorage.removeItem('qa_app_user_email'); } catch(e){}
  currentUserEmail = null; currentUserRole = null;
  document.getElementById('appRoot').style.display = 'none';
  document.getElementById('accessGate').style.display = '';
  document.getElementById('accessEmail').value = '';
});

(function initGate(){
  let remembered = null;
  try { remembered = localStorage.getItem('qa_app_user_email'); } catch(e){}
  if (remembered){
    document.getElementById('accessEmail').value = remembered;
    attemptAccess(remembered);
  }
})();
