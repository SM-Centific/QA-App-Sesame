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
  {id:'device_placements', label:'Device Placements', priority:'P0', kind:'percent', direction:'higher_is_better', referenceValue:6, unit:'positions', help:'Distinct camera positions covered in this room — 6 fully meets the minimum; measured directly (estimated) when available.'},
  {id:'audio_quality', label:'Audio Quality', priority:'P1', kind:'scale', help:'Clipping, noise floor, intelligibility.'},
  {id:'video_quality', label:'Video Quality', priority:'P1', kind:'scale', help:'Exposure, focus, framing, dropped frames.'},
];
const ITEMS_PARTICIPANT = [
  {id:'continuous_movement', label:'Continuous Movement', priority:'P0', kind:'percent', direction:'higher_is_better', unit:'%', help:'% of the episode spent in motion (target >75%) — measured from the room\'s radar .mmwave.bin when the inspection report includes it.'},
  {id:'blue_zone_pct', label:'Blue Zone %', priority:'P1', kind:'percent', direction:'higher_is_better', unit:'%', help:'Time spent inside the 120°×5m forward FOV — measured from the room\'s radar .mmwave.bin.'},
  {id:'outside_far', label:'Outside view beyond 3 m %', priority:'P1', kind:'percent', direction:'lower_is_better', referenceValue:10, unit:'%', help:'Time spent outside the 120° forward view AND past the 3 m warning line — the runbook says turn back before 3 m and do not linger. Brief exits within 3 m are expected and not penalised. Lower is better; ≤10% passes. Measured from the room\'s radar .mmwave.bin.'},
  {id:'speed_variance', label:'Speed Variance', priority:'P1', kind:'scale', help:'Natural variation in movement speed — more is better (not robotic/staged). 1 = little or none · 2 = some · 3 = great, clearly natural. Suggested from the radar\'s speed spread when available.'},
  {id:'distance_variance', label:'Distance Variance', priority:'P1', kind:'scale', help:'Natural variation in near/far distance — more is better (not robotic/staged). 1 = little or none · 2 = some · 3 = great, clearly natural. Suggested from the radar\'s distance spread when available.'},
];

// Radar measurement -> suggested 1/2/3 for the two variance items. The
// radar reports the spread (standard deviation) of speed or distance across
// the episode's tracked frames; a value at or above `great` suggests 3, at
// or above `some` suggests 2, otherwise 1. PROVISIONAL cut points, not yet
// checked against real reviewed episodes; adjust here once they are.
const VARIANCE_BUCKETS = {
  speed_variance:    {unit: 'm/s', some: 0.25, great: 0.5},
  distance_variance: {unit: 'm',   some: 0.5,  great: 1.0},
};
function varianceBucket(itemId, measured){
  const b = VARIANCE_BUCKETS[itemId];
  if (!b || measured == null || Number.isNaN(Number(measured))) return null;
  const v = Number(measured);
  return v >= b.great ? 3 : (v >= b.some ? 2 : 1);
}
// Saved rows from before the 1/2/3 change hold the raw measurement for
// these items. Rows saved from now on carry scoreVersion 2.
const SCORE_VERSION = 2;
// A saved row's scores with any pre-version-2 variance measurement turned
// into its 1/2/3 bucket, so old and new rows can be averaged together.
function scoresOf(doc){
  const scores = Object.assign({}, (doc && doc.scores) || {});
  if (doc && !(doc.scoreVersion >= SCORE_VERSION)){
    Object.keys(VARIANCE_BUCKETS).forEach(id => {
      if (scores[id] != null) scores[id] = varianceBucket(id, scores[id]);
    });
  }
  return scores;
}
const MIN_GOOD_EPISODES = 10; // client threshold: a room needs at least this many PASSED episodes

// A session can have any number of T1 rooms — not fixed at 3. These derive
// the actual room list from whatever's been ingested so far (via capture.json
// files' own scenarioId field), sorted by room number (T1-R1, T1-R2, ...).
function getIngestedRoomIds(){
  return Object.keys(ingested.scenarios)
    .filter(id => /^T1-R\d+$/.test(id))
    .sort((a,b) => parseInt(a.slice(4),10) - parseInt(b.slice(4),10));
}
// Full display order: C0 first (if ingested), then however many rooms exist.
function getIngestedScenarioIds(){
  const ids = [];
  if (ingested.scenarios['C0']) ids.push('C0');
  ids.push(...getIngestedRoomIds());
  return ids;
}

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
};
let currentScenarioId = null;
let currentEpisodeId = null;
let currentScope = 'technical'; // 'technical' | 'participant' — only meaningful for T1 scenarios
let formCache = {};
let annotationsCache = {}; // scenarioId -> array of {id, type, timeSec, text, createdAt}
let activeForm = null;   // {docId, items, kind, scenarioId, episodeId} for whichever form is currently on screen — lets the single global Save button know what to save
let localScores = {};
// Set by "Reset scores to radar": while it names the loaded session, saved
// score values for that session are ignored when forms are built, so the
// radar / automatic suggestions show instead. Saved notes are kept. Cleared
// whenever a session is (re)loaded.
let ignoreSavedScoresFor = null;
let dbNS = null, downloadsNS = null;
let videoEl = null; // live reference to the <video> element, persists across episode/scope changes
let activeVideoObj = null; // whichever videosByCapture entry currently holds a live blob URL, if any
let radarByScenario = {}; // scenarioId -> {technical: {itemId: {value, note}}, episodes: {episodeId: {itemId: {value, note}}}}

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

function classifyAndIngest(filename, text){
  try {
    const obj = JSON.parse(text);
    if (obj && obj.scenarioId && obj.artifacts && obj.episodeEligibility){ ingestCaptureManifest(obj); return; }
    if (obj && Array.isArray(obj.captures) && obj.captures[0] && obj.captures[0].syncEvidence){ ingestSessionEvidence(obj); return; }
    if (obj && obj.phases && obj.phases.P02_scenarioRunner && obj.phases.P02_scenarioRunner.captures){ ingestSessionValidation(obj); return; }
    if (obj && obj.expectedDevices && obj.requiredMask && obj.stepId){ ingestAudit(obj); return; }
    if (obj && (obj.firstFrameReady || (Array.isArray(obj.segments) && obj.segments[0] && obj.segments[0].firstFrameReady))){
      logLine(`<span class="tag ok">mmwave_sync</span> ${escapeHtml(filename)} — radar frame timing`);
      return;
    }
    logLine(`<span class="tag warn">unrecognized</span> ${escapeHtml(filename)} (valid JSON, unknown shape)`);
  } catch (err){
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch(e){ return null; } }).filter(Boolean);
    if (!lines.length){ logLine(`<span class="tag warn">unrecognized</span> ${escapeHtml(filename)} (could not parse)`); return; }
    if (lines[0].type && String(lines[0].type).startsWith('capture.episode')){ ingestEpisodeMarkers(lines, filename); return; }
    if (lines[0].schemaVersion === 'hydra.mmwave-tracks/1' || (lines[0].frameIndex != null && 'tracks' in lines[0])){
      logLine(`<span class="tag warn">skipped</span> ${escapeHtml(filename)} — this is a tracks log, not the raw radar file. Drop the room's .mmwave.bin instead.`);
      return;
    }
    if ('azimuth_deg' in lines[0] && 'in_blue_zone' in lines[0]){
      logLine(`<span class="tag warn">skipped</span> ${escapeHtml(filename)} — video-zone logs are not used. Scores come from each room's .mmwave.bin.`);
      return;
    }
    logLine(`<span class="tag warn">unrecognized</span> ${escapeHtml(filename)} (JSONL, unknown shape)`);
  }
}

function ingestRemoteVideo(name, url){
  const captureId = deriveCaptureIdFromName(name) || deriveCaptureIdFromName(url);
  if (!captureId){ logLine(`<span class="tag warn">skip</span> ${escapeHtml(name)} — couldn't detect capture id from filename`); return; }
  ingested.videosByCapture[captureId] = { name, file: null, url: null, remoteUrl: url };
  logLine(`<span class="tag ok">video</span> ${escapeHtml(name)} → ${escapeHtml(captureId)}`);
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

function isVideoFile(file){
  return file.type.startsWith('video/') || /\.(mp4|mov|webm)$/i.test(file.name);
}
function isRadarBin(file){
  return /\.bin$/i.test(file.name);
}

async function handleFiles(fileList){
  const files = Array.from(fileList);
  if (files.some(isRadarBin)){
    await scoreDroppedFiles(files);
    return;
  }
  for (const f of files){
    if (isVideoFile(f)) ingestVideo(f);
    else classifyAndIngest(f.name, await f.text());
  }
  refreshSessionStatus();
  if (!currentScenarioId){
    currentScenarioId = getIngestedScenarioIds()[0] || null;
  }
  renderScenarioTabs();
  renderScenarioShell();
  renderSessionBanner();
  renderSavedList();
}

function radarServerMessage(filename){
  return `${filename || 'A file'} could not be sent to the local review server. Check that python3 scripts/review_server.py is still running, then drop the files again.`;
}

async function reviewServerReady(){
  try {
    const res = await fetch('/api/review/health', {method: 'GET', cache: 'no-store'});
    if (!res.ok) return false;
    const data = await res.json();
    return !!(data && data.ok);
  } catch (e){
    return false;
  }
}

async function noteReviewServer(){
  const ready = await reviewServerReady();
  const session = document.getElementById('sessionStatus');
  if (session) session.textContent = ready
    ? 'No files loaded yet.'
    : 'No files loaded yet. Reports and dropped .mmwave.bin files are read in this browser.';
}

async function scoreDroppedFiles(files){
  const status = document.getElementById('sessionStatus');
  const drop = document.getElementById('dropzone');
  const videos = files.filter(isVideoFile);
  const uploads = files.filter(file => !isVideoFile(file));
  if (drop) drop.classList.add('busy');
  if (!(await reviewServerReady())){
    await scoreDroppedFilesInBrowser(uploads, videos, status, drop);
    return;
  }
  if (status) status.textContent = 'Streaming the radar .bin to disk. It is not loaded into browser memory.';
  const uploadId = crypto.randomUUID();
  let scored = false;
  try {
    for (const file of uploads){
      if (status) status.textContent = `Streaming ${file.name} (${file.size.toLocaleString()} bytes) to disk…`;
      const res = await fetch('/api/review/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Upload-Id': uploadId,
          'X-File-Name': file.name,
        },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok){
        if (status) status.textContent = data.error || radarServerMessage(file.name);
        return;
      }
    }
    if (status) status.textContent = 'Running the radar script on the .bin files…';
    const res = await fetch('/api/review/score', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({uploadId}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok){
      if (status) status.textContent = data.error || 'The dropped radar files could not be scored.';
      return;
    }
    scored = true;
    const message = await applyReviewResult(data, 'files');
    videos.forEach(ingestVideo);
    refreshSessionStatus();
    renderScenarioTabs();
    renderScenarioShell();
    renderSessionBanner();
    if (status) status.textContent = message;
  } catch (err){
    if (status) status.textContent = 'The review server is not running, so the radar .bin was not read. Start python3 scripts/review_server.py and drop the files again.';
  } finally {
    if (!scored){
      try {
        await fetch('/api/review/discard', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({uploadId}),
        });
      } catch (e){}
    }
    if (drop) drop.classList.remove('busy');
  }
}

async function scoreDroppedFilesInBrowser(uploads, videos, status, drop){
  try {
    const data = await RadarScore.reviewFromFiles(uploads, async message => {
      if (status) status.textContent = message;
    });
    const message = await applyReviewResult(data, 'files');
    videos.forEach(ingestVideo);
    refreshSessionStatus();
    renderScenarioTabs();
    renderScenarioShell();
    renderSessionBanner();
    if (status) status.textContent = message;
  } catch (err){
    if (status) status.textContent = err && err.message ? err.message : 'The radar .bin could not be read in the browser.';
  } finally {
    if (drop) drop.classList.remove('busy');
  }
}

function refreshSessionStatus(){
  const el = document.getElementById('sessionStatus');
  if (!ingested.sessionId){ el.textContent = 'No files loaded yet.'; return; }
  const hasC0 = !!ingested.scenarios['C0'];
  const roomCount = getIngestedRoomIds().length;
  const scenarioLabel = `${hasC0 ? 'C0' : 'no C0'}${roomCount ? ` + ${roomCount} room${roomCount === 1 ? '' : 's'}` : ''}`;
  const videoCount = Object.keys(ingested.videosByCapture).length;
  el.innerHTML = `Session <span style="font-family:var(--font-mono)">${escapeHtml(ingested.sessionId)}</span> — ${scenarioLabel} loaded, ${videoCount} video(s)`;
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
  if (scenarioId === 'C0') applyC0RigMotion(scenario, autos);
  if (autos.device_placements){
    const hit = radarByScenario[scenarioId] && radarByScenario[scenarioId].technical && radarByScenario[scenarioId].technical.device_placements;
    if (hit && hit.value != null){
      autos.device_placements.value = Math.round(hit.value);
      autos.device_placements.note = hit.note;
    }
  }
  return autos;
}

// C0 suggestions from the radar's rig-motion reading (how much the rig
// itself moved; see rig_motion_by_episode in extract_mmwave_diagnostics.py).
// The radar can tell rest from motion, not the shape of the motion, so the
// figure-8 and translation suggestions only say "the rig moved a lot".
// PROVISIONAL cut points, checked on one real C0 capture so far.
const C0_RIG = {
  restFirstLastS: 5,      // seconds at each end of the episode checked for rest
  restGood: 10,           // ≤10% of those seconds moving -> 3
  restOk: 40,             // ≤40% -> 2, otherwise 1
  motionGood: 50,         // ≥50% of the middle moving -> 3
  motionOk: 25,           // ≥25% -> 2, otherwise 1
};
function applyC0RigMotion(scenario, autos){
  const radar = radarByScenario['C0'];
  const rig = radar && radar.rigMotion;
  if (!rig || !Object.keys(rig).length) {
    ['static_5s','figure_8','translation','static_end'].forEach(id => {
      if (autos[id] && !autos[id].note) autos[id].note = 'No radar reading for C0 yet. Load the C0 .mmwave.bin with its episode markers and mmwave sync JSON.';
    });
    return;
  }
  const episodes = (scenario && ingested.episodesByCapture[scenario.captureId]) || [];
  const kept = episodes.filter(e => e.disposition === 'retained' && rig[e.episodeId]);
  const ep = kept[kept.length - 1] || episodes.find(e => rig[e.episodeId]);
  const m = ep ? rig[ep.episodeId] : rig[Object.keys(rig)[0]];
  if (!m) return;
  const rest = pct => pct == null ? null : (pct <= C0_RIG.restGood ? 3 : pct <= C0_RIG.restOk ? 2 : 1);
  const motion = pct => pct == null ? null : (pct >= C0_RIG.motionGood ? 3 : pct >= C0_RIG.motionOk ? 2 : 1);
  const dur = ep && ep.durationMs != null ? ` Episode ${(ep.durationMs / 1000).toFixed(1)} s (target 50–60 s).` : '';
  const set = (id, value, note) => { if (autos[id]) autos[id] = {value, note}; };
  set('static_5s', rest(m.moving_pct_first_edge),
    `Radar: rig moving ${m.moving_pct_first_edge}% of the first ${m.edge_s} s (3 if ≤${C0_RIG.restGood}%, 2 if ≤${C0_RIG.restOk}%).`);
  set('static_end', rest(m.moving_pct_last_edge),
    `Radar: rig moving ${m.moving_pct_last_edge}% of the last ${m.edge_s} s (3 if ≤${C0_RIG.restGood}%, 2 if ≤${C0_RIG.restOk}%).${dur}`);
  const motionNote = `Radar: rig moving ${m.moving_pct_middle}% of the middle of the episode (3 if ≥${C0_RIG.motionGood}%, 2 if ≥${C0_RIG.motionOk}%). The radar sees that the rig moved, not the shape — confirm on the video.`;
  set('figure_8', motion(m.moving_pct_middle), motionNote);
  set('translation', motion(m.moving_pct_middle), motionNote);
}

function computeParticipantAutos(scenarioId, episode){
  const autos = {};
  ITEMS_PARTICIPANT.forEach(it => { autos[it.id] = {value: null, note: null}; });
  const episodeScores = radarByScenario[scenarioId] && radarByScenario[scenarioId].episodes && episode
    ? radarByScenario[scenarioId].episodes[episode.episodeId]
    : null;
  if (episodeScores){
    ITEMS_PARTICIPANT.forEach(it => {
      const hit = episodeScores[it.id];
      if (!hit || hit.value == null) return;
      if (VARIANCE_BUCKETS[it.id]){
        const b = VARIANCE_BUCKETS[it.id];
        const score = varianceBucket(it.id, hit.value);
        autos[it.id] = Object.assign({}, hit, {
          value: score,
          measured: hit.value,
          note: `Radar spread ${Number(hit.value).toFixed(2)} ${b.unit} → ${score} (2 from ${b.some} ${b.unit}, 3 from ${b.great} ${b.unit}). ${hit.note || ''}`.trim(),
        });
      } else {
        autos[it.id] = hit;
      }
    });
    const exits = episodeScores.orange_zone;
    if (autos.outside_far && autos.outside_far.value != null && exits && exits.value != null){
      autos.outside_far = Object.assign({}, autos.outside_far, {
        note: `${autos.outside_far.note || ''} · Brief exits within 3 m: ${Number(exits.value).toFixed(1)}% (expected, not scored).`.replace(/^ · /, ''),
      });
    }
  }
  ['blue_zone_pct','outside_far'].forEach(id => {
    if (autos[id].value == null && !autos[id].note){
      autos[id].note = 'No radar score yet. Load this room\'s .mmwave.bin with its episode markers and mmwave sync JSON.';
    }
  });
  return autos;
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

/* Wipes this browser's local backup copy (localStorage + the in-memory
   fallback) for one session only — every docId for a session starts with
   `${sessionId}__`, so this never touches another session's local data.
   Does NOT touch SharePoint; it's purely for clearing stale local copies
   after deleting trial rows from the backend directly, so a leftover
   local fallback doesn't make a deleted row silently reappear (see the
   loadDoc fallback chain above). Returns how many local records it removed. */
function clearLocalCacheForSession(sessionId){
  if (!sessionId) return 0;
  let count = 0;
  const prefix = LS_PREFIX + sessionId + '__';
  try {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++){
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) keysToRemove.push(key);
    }
    keysToRemove.forEach(k => { localStorage.removeItem(k); count++; });
  } catch(e){}
  Object.keys(localScores).forEach(docId => {
    if (docId.startsWith(sessionId + '__')) delete localScores[docId];
  });
  return count;
}

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
/* direction/referenceValue let a raw measurement (not just a 1-3 scale) map
   correctly onto the shared 0-100 pooling scale, in whichever direction
   actually means "good" for that item:
   - no referenceValue, higher_is_better (default): raw IS the goodness
     value already (e.g. Blue Zone % — more time there is just better).
   - no referenceValue, lower_is_better: goodness = 100 - raw (only valid
     for a naturally 0-100-bounded raw value, e.g. Orange Zone % — this
     also means 100-raw>=75 is exactly raw<=25, so the existing P1
     threshold IS the "≤25%" rule, no separate constant needed).
   - referenceValue set: raw is an unbounded physical measurement (m/s,
     meters, a count), so it's scaled against this item's OWN pass
     threshold (85 for P0, 75 for P1) instead — goodness equals exactly
     that threshold right at referenceValue, scaling up/down around it. */
function toPct(it, v){
  if (v == null) return null;
  if (it.kind !== 'percent') return v / 3 * 100; // unchanged: 1-3 manual scale
  const dir = it.direction || 'higher_is_better';
  if (it.referenceValue == null) return dir === 'lower_is_better' ? (100 - v) : v;
  const threshold = it.priority === 'P0' ? 85 : 75;
  const pct = dir === 'lower_is_better'
    ? 100 - ((100 - threshold) / it.referenceValue) * v
    : threshold * (v / it.referenceValue);
  return Math.max(0, Math.min(100, pct));
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
    const nums = participantDocs.map(d => scoresOf(d)[key]).filter(v => v != null);
    return nums.length ? nums.reduce((a,b)=>a+b,0)/nums.length : null;
  };
  ITEMS_PARTICIPANT.forEach(it => {
    const raw = avgOf(it.id);
    if (raw != null) (it.priority==='P0'?p0vals:p1vals).push(toPct(it, raw));
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
  const episodes = ingested.episodesByCapture[scenario.captureId] || [];
  const retained = episodes.filter(e => e.disposition === 'retained');
  const retainedCount = retained.length;
  // Only this session's rows count, and only for episodes the operator
  // retained: an excluded attempt "does not consume a retained-view slot"
  // (collection runbook), so it can't count toward the room's minimum
  // either. Without episode markers loaded, every row for the room counts.
  const retainedIds = new Set(retained.map(e => e.episodeId));
  const participantDocs = allDocs.filter(d =>
    d.kind === 'participant' && d.scenarioId === scenarioId && d.sessionId === ingested.sessionId
    && (!episodes.length || retainedIds.has(d.episodeId)));
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
  const roomIds = getIngestedRoomIds();
  const rooms = await Promise.all(roomIds.map(computeRoomGate));
  const anyLoaded = getIngestedScenarioIds().length > 0;
  if (!anyLoaded) return null;
  const gates = [c0 ? c0.gatePass : null, ...rooms.map(r => r ? r.gatePass : null)];
  let sessionPass = 'incomplete';
  if (gates.some(g => g === false)) sessionPass = 'fail';
  else if (gates.every(g => g === true)) sessionPass = 'pass';
  const avgOf = arr => { const nums = arr.filter(v => v != null); return nums.length ? nums.reduce((a,b)=>a+b,0)/nums.length : null; };
  const sessionP0 = avgOf([c0 ? c0.p0Pct : null, ...rooms.map(r => r ? r.blendedP0Pct : null)]);
  const sessionP1 = avgOf(rooms.map(r => r ? r.blendedP1Pct : null)); // C0 has no P1 pool
  return {sessionPass, sessionP0, sessionP1, c0, rooms, roomIds};
}

/* ---------------------------------------------------------------
   Zone classification
--------------------------------------------------------------- */
/* ---------------------------------------------------------------
   Rendering: rail
--------------------------------------------------------------- */
function renderScenarioTabs(){
  const el = document.getElementById('scenarioTabs');
  const ids = getIngestedScenarioIds();
  if (!ids.length){
    el.innerHTML = `<div class="empty-state" style="padding:10px 4px;">Drop capture files to see scenarios here.</div>`;
    return;
  }
  el.innerHTML = ids.map(id => {
    const s = ingested.scenarios[id];
    const active = id === currentScenarioId ? 'active' : '';
    const hasVideo = !!ingested.videosByCapture[s.captureId];
    const radar = radarByScenario[id];
    const binFlag = id !== 'C0' ? (radar && radar.bin ? ' · .bin ✓' : ' · no .bin') : '';
    const flags = `<span class="flags">${hasVideo ? 'video ✓' : 'no video'}${binFlag}</span>`;
    return `<button class="${active}" data-scenario="${id}">${id}<span class="room">${escapeHtml(s.roomLabel)}</span>${flags}</button>`;
  }).join('');
  el.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      captureActiveNotes();
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
  const pillPairs = [['C0', summary.c0], ...summary.roomIds.map((id, i) => [id, summary.rooms[i]])];
  const pillsHtml = pillPairs
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

// A 0-100 meter for items whose raw value already is a percentage
// (Continuous Movement, Blue Zone, Outside view beyond 3 m). The pass line sits where
// toPct() crosses this item's threshold: >= 85 (P0) / 75 (P1) for
// higher-is-better, <= 15 / 25 for lower-is-better. A small tick marks the
// radar's suggestion so it stays visible after the reviewer moves the meter.
function percentPassLine(it){
  // A % item may set referenceValue: the raw % that sits exactly on its
  // pass threshold (see toPct). Otherwise the threshold itself is the line.
  if (it.referenceValue != null) return it.referenceValue;
  const threshold = it.priority === 'P0' ? 85 : 75;
  return it.direction === 'lower_is_better' ? 100 - threshold : threshold;
}
function fmtMeter(v){
  if (v == null || v === '') return '—';
  const n = Number(v);
  return (Math.round(n * 10) / 10).toString() + '%';
}
function percentMeterHtml(it, value, auto){
  const set = value != null && value !== '';
  const v = set ? Math.max(0, Math.min(100, Number(value))) : 0;
  const line = percentPassLine(it);
  const lower = it.direction === 'lower_is_better';
  const passing = set ? (lower ? v <= line : v >= line) : null;
  const passStart = lower ? 0 : line;
  const passEnd = lower ? line : 100;
  const autoV = auto && auto.value != null ? Math.max(0, Math.min(100, Number(auto.value))) : null;
  const autoTick = autoV != null
    ? `<span class="meter-auto" style="left:${autoV}%" title="Radar suggested ${fmtMeter(autoV)}"></span>` : '';
  const state = passing == null ? 'unset' : (passing ? 'pass' : 'fail');
  return `<div class="meter ${state}">
    <div class="meter-track">
      <span class="meter-passzone" style="left:${passStart}%;width:${passEnd - passStart}%"></span>
      <span class="meter-line" style="left:${line}%"></span>
      ${autoTick}
      <input type="range" min="0" max="100" step="1" value="${set ? Math.round(v) : 0}" data-item="${it.id}" data-meter="1" aria-label="${escapeHtml(it.label)} percent">
    </div>
    <div class="meter-read">
      <span class="meter-value" data-meter-value="${it.id}">${set ? fmtMeter(value) : 'Not set'}</span>
      <span class="meter-hint">pass ${lower ? '≤' : '≥'} ${line}%${autoV != null ? ` · radar ${fmtMeter(autoV)}` : ''}</span>
      ${set ? `<button type="button" class="meter-clear" data-meter-clear="${it.id}">Clear</button>` : ''}
    </div>
  </div>`;
}

function itemRowHtml(it, value, auto){
  const hasAuto = auto && auto.value != null;
  const adjusted = hasAuto && value != null && value !== '' && Math.abs(Number(value) - Number(auto.value)) > 1e-6
    && typeof value !== 'string';
  const cleared = hasAuto && (value == null || value === '');
  const autoBadge = !hasAuto ? '' : (cleared
    ? `<span class="badge auto">cleared · radar ${escapeHtml(String(auto.value))}</span>`
    : adjusted
      ? `<span class="badge auto">adjusted · radar ${escapeHtml(String(auto.value))}</span>`
      : `<span class="badge auto">auto-suggested</span>`);
  const noteHtml = (auto && auto.note) ? `<div class="item-note">${escapeHtml(auto.note)}</div>` : '';
  const coverageHtml = (auto && auto.coveragePct != null) ? `<div class="item-note">detector confidence: ${auto.coveragePct.toFixed(0)}% of frames had a detection</div>` : '';
  let control;
  if (it.kind === 'gate'){
    control = ['pass','fail'].map(v => `<button type="button" class="seg ${value===v?'active '+v:''}" data-item="${it.id}" data-value="${v}">${v==='pass'?'Pass':'Fail'}</button>`).join('');
  } else if (it.kind === 'percent' && (it.unit || '%') === '%'){
    control = percentMeterHtml(it, value, auto);
  } else if (it.kind === 'percent'){
    // referenceValue items are raw physical measurements (m/s, meters, a
    // position count), not a 0-100-bounded percentage — no upper cap, and
    // label with the item's real unit instead of assuming "%".
    const unit = it.unit || '%';
    const integer = unit === 'positions';
    const maxAttr = it.referenceValue == null ? ' max="100"' : '';
    const placeholder = it.referenceValue == null ? '0-100' : `e.g. ${it.referenceValue}`;
    const step = integer ? '1' : '0.1';
    const shown = value == null || value === '' ? '' : (integer ? String(Math.round(Number(value))) : value);
    control = `<div class="percent-input"><input type="number" min="0"${maxAttr} step="${step}" data-item="${it.id}" value="${shown}" placeholder="${placeholder}"><span>${escapeHtml(unit)}</span></div>`;
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
  const stored = await loadDoc(docId);
  const resetting = ignoreSavedScoresFor && ingested.sessionId === ignoreSavedScoresFor;
  // On a reset, keep the saved notes but drop the saved score values.
  const saved = (resetting && stored) ? {notes: stored.notes, savedAt: stored.savedAt} : stored;
  const values = {};
  const legacy = saved && saved.scores && !(saved.scoreVersion >= SCORE_VERSION);
  items.forEach(it => {
    if (legacy && VARIANCE_BUCKETS[it.id] && saved.scores[it.id] != null) values[it.id] = varianceBucket(it.id, saved.scores[it.id]);
    else if (saved && saved.scores && saved.scores[it.id] != null) values[it.id] = saved.scores[it.id];
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
  if (video && video.remoteUrl){
    video.url = video.remoteUrl;
    return;
  }
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
  const isC0 = currentScenarioId === 'C0';

  const auditLine = audit ? `<div class="audit-line">Devices required: ${escapeHtml(audit.expectedDevices.join(', '))}</div>` : '';
  const videoHtml = video && video.url
    ? `<video id="capVideo" controls preload="metadata" src="${escapeHtml(video.url)}"></video>`
    : `<div class="no-video">No video uploaded for ${escapeHtml(scenario.captureId)} yet.</div>`;

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
      <div class="meta">${escapeHtml(scenario.captureId)}${episodes.length?` · ${episodes.filter(e=>e.disposition==='retained').length}/${episodes.length} episodes kept by operator`:''}</div>
      ${auditLine}</div>
    </div>
    ${scopeTabsHtml}
    <div class="workspace">
      <div class="video-col">
        ${videoHtml}
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
      captureActiveNotes();
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
    captureActiveNotes();
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
          <span class="saved-at" id="savedAtLabel">${form.savedAt ? 'Saved ' + new Date(form.savedAt).toLocaleString() : 'Not saved yet'}</span>
        </div>
      </div>`;
    wireItemInputs('c0Items', docId, ITEMS_C0, 'c0', 'C0', null);
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
          <span class="gate-stat-sub">(${gate.retainedCount}/${gate.episodesTotal} episodes kept by operator)</span>
        </div>
        <div class="section-title">Technical checklist <span class="count">room-level · P0 &amp; P1</span></div>
        <div id="techItems">${ITEMS_TECHNICAL.map(it => itemRowHtml(it, techForm.values[it.id], techForm.autos[it.id])).join('')}</div>
        <div class="save-row">
          <span class="saved-at" id="techSavedAtLabel">${techForm.savedAt ? 'Saved ' + new Date(techForm.savedAt).toLocaleString() : 'Not saved yet'}</span>
        </div>
      </div>`;
    wireItemInputs('techItems', techDocId, ITEMS_TECHNICAL, 'technical', currentScenarioId, null);
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
  const autos = computeParticipantAutos(currentScenarioId, ep);
  const participantForm = await ensureFormLoaded(epDocId, ITEMS_PARTICIPANT, 'participant', currentScenarioId, currentEpisodeId, autos);
  // episodeNumber is already known from episode_markers.jsonl (used for the
  // dropdown label above) — attach it here so saveActiveForm can include it
  // in the saved record. Previously this never made it past the dropdown,
  // which is why the scorecard showed the raw episode_id instead of a
  // clean number.
  participantForm.episodeNumber = (ep && ep.episodeNumber != null) ? ep.episodeNumber : null;
  const epScores = computeScores(ITEMS_PARTICIPANT, participantForm.values);
  el.innerHTML = `
    ${scoreSummaryHtml(epScores.p0Pct, epScores.p1Pct, epScores.overall)}
    <div class="panel">
      <div class="section-title">Participant checklist <span class="count">this episode</span></div>
      <div id="participantItems">${ITEMS_PARTICIPANT.map(it => itemRowHtml(it, participantForm.values[it.id], participantForm.autos[it.id])).join('')}</div>
      <div class="notes-block"><label>Reviewer notes (this episode)</label><textarea id="epNotesField">${escapeHtml(participantForm.notes)}</textarea></div>
      <div class="save-row">
        <span class="saved-at" id="epSavedAtLabel">${participantForm.savedAt ? 'Saved ' + new Date(participantForm.savedAt).toLocaleString() : 'Not saved yet'}</span>
      </div>
    </div>`;
  wireItemInputs('participantItems', epDocId, ITEMS_PARTICIPANT, 'participant', currentScenarioId, currentEpisodeId);
  activeForm = {docId: epDocId, items: ITEMS_PARTICIPANT, kind: 'participant', scenarioId: currentScenarioId, episodeId: currentEpisodeId};
}

// Pulls whatever's currently typed in the visible notes textarea (if any)
// into formCache before a re-render replaces that textarea's DOM node —
// otherwise a re-render driven by an unrelated score-button click would
// silently discard not-yet-saved notes typing.
function captureVisibleNotes(docId, kind){
  const notesEl = document.getElementById(kind === 'participant' ? 'epNotesField' : 'notesField');
  if (notesEl && formCache[docId]) formCache[docId].notes = notesEl.value;
}
// Same capture, but driven by whatever `activeForm` currently is — call
// this before ANY switch (scenario tab, scope tab, episode change) so
// typed-but-not-yet-saved notes survive in memory even if the user never
// touched a score button on that screen before navigating away.
function captureActiveNotes(){
  if (!activeForm) return;
  captureVisibleNotes(activeForm.docId, activeForm.kind);
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
      captureVisibleNotes(docId, kind);
      formCache[docId].values[itemId] = val;
      renderScoringSection();
    });
  });
  container.querySelectorAll('input[type="range"][data-meter]').forEach(inp => {
    const itemId = inp.dataset.item;
    // Live readout while dragging; commit (and re-render) only on release,
    // so the re-render doesn't interrupt the drag.
    inp.addEventListener('input', () => {
      const label = container.querySelector(`[data-meter-value="${itemId}"]`);
      if (label) label.textContent = fmtMeter(inp.value);
      const meter = inp.closest('.meter');
      const item = items.find(it => it.id === itemId);
      if (meter && item){
        const line = percentPassLine(item);
        const v = Number(inp.value);
        const ok = item.direction === 'lower_is_better' ? v <= line : v >= line;
        meter.classList.remove('unset','pass','fail');
        meter.classList.add(ok ? 'pass' : 'fail');
      }
    });
    inp.addEventListener('change', async () => {
      if (!formCache[docId]) return;
      captureVisibleNotes(docId, kind);
      const hadFocus = document.activeElement === inp;
      formCache[docId].values[itemId] = Math.max(0, Math.min(100, Number(inp.value)));
      await renderScoringSection();
      // The form is redrawn on each change; keep keyboard focus on this
      // meter so arrow keys keep stepping it.
      if (hadFocus){
        const again = document.querySelector(`input[type="range"][data-item="${itemId}"]`);
        if (again) again.focus();
      }
    });
  });
  container.querySelectorAll('[data-meter-clear]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!formCache[docId]) return;
      captureVisibleNotes(docId, kind);
      formCache[docId].values[btn.dataset.meterClear] = null;
      renderScoringSection();
    });
  });
  container.querySelectorAll('input[type="number"][data-item]').forEach(inp => {
    inp.addEventListener('change', () => {
      const itemId = inp.dataset.item;
      if (!formCache[docId]) return;
      captureVisibleNotes(docId, kind);
      const item = items.find(it => it.id === itemId);
      const integer = item && item.unit === 'positions';
      let v = inp.value === '' ? null : (integer ? parseInt(inp.value, 10) : parseFloat(inp.value));
      if (v != null && Number.isNaN(v)) v = null;
      if (v != null) v = integer ? Math.max(0, Math.round(v)) : Math.max(0, Math.min(100, v));
      formCache[docId].values[itemId] = v;
      renderScoringSection();
    });
  });
}

/* ---------------------------------------------------------------
   Saving. One global Save button (wired once, in the header — see
   near the bottom of this file) saves whatever form is currently on
   screen. `activeForm` tracks which one that is — set at the end of
   each of the three render branches above (C0 / Technical /
   Participant) — so the single button always knows what to save
   without needing a separate button per section.
--------------------------------------------------------------- */
function saveStatusLabelEl(){
  return document.getElementById('savedAtLabel') || document.getElementById('techSavedAtLabel') || document.getElementById('epSavedAtLabel');
}
function setSaveStatus(state, savedAt){
  const el = saveStatusLabelEl();
  if (!el) return;
  if (state === 'saving') el.textContent = 'Saving…';
  else if (state === 'saved') el.textContent = 'Saved ' + new Date(savedAt).toLocaleTimeString();
  else if (state === 'dirty') el.textContent = 'Reset to radar — not saved yet';
}

// Saves EVERY form currently sitting in formCache — every episode and
// scope touched this session, not just whichever one is on screen right
// now. formCache entries already carry their own items/kind/scenarioId/
// episodeId (set in ensureFormLoaded), so no navigation is needed to
// reach them; this is what makes "click Save once before closing" cover
// everything entered since the page loaded, not just the last screen
// visited. Annotations (flags/comments) are NOT included here — they
// already persist immediately on their own, independent of this button.
async function saveActiveForm(){
  captureActiveNotes(); // grab whatever's live in the currently-visible notes box first
  const entries = Object.values(formCache);
  if (!entries.length){
    logLine(`<span class="tag warn">save</span> nothing scored yet this session`);
    return;
  }
  setSaveStatus('saving');
  let count = 0;
  for (const form of entries){
    const {docId, items, kind, scenarioId, episodeId} = form;
    const scores = computeScores(items, form.values);
    const payload = {
      sessionId: ingested.sessionId, scenarioId, episodeId, kind,
      roomLabel: (ingested.scenarios[scenarioId] || {}).roomLabel || null,
      episodeNumber: form.episodeNumber != null ? form.episodeNumber : null,
      scores: form.values, notes: form.notes,
      p0Pct: scores.p0Pct, p1Pct: scores.p1Pct, overall: scores.overall,
      scoreVersion: SCORE_VERSION,
      savedAt: new Date().toISOString(),
    };
    await saveDoc(docId, payload);
    form.savedAt = payload.savedAt;
    count++;
  }
  setSaveStatus('saved', new Date().toISOString());
  // A reset has now been written over the old rows; from here on the saved
  // copies are the reset values, so stop ignoring them.
  ignoreSavedScoresFor = null;
  renderSavedList();
  renderSessionBanner();
  renderScoringSection();
  logLine(`<span class="tag ok">save</span> saved ${count} form(s) from this session`);
}

async function renderSavedList(){
  const el = document.getElementById('savedList');
  const docs = (await queryAll()).filter(d => d.kind !== 'annotations'
    && (!ingested.sessionId || d.sessionId === ingested.sessionId));
  if (!docs.length){ el.innerHTML = `<div class="empty-state" style="padding:14px 4px;">${ingested.sessionId ? 'Nothing saved yet for this session.' : 'Nothing saved yet.'}</div>`; return; }
  docs.sort((a,b) => (b.savedAt||'').localeCompare(a.savedAt||''));
  el.innerHTML = docs.map(d => {
    const label = d.kind === 'c0' ? 'C0' : d.kind === 'technical' ? `${d.scenarioId} · Technical` : `${d.scenarioId} · Episode${d.episodeNumber != null ? ' ' + d.episodeNumber : ''}`;
    return `<div class="saved-row">
      <div class="meta"><b>${escapeHtml(label)}</b><span>${d.roomLabel ? escapeHtml(d.roomLabel)+' · ' : ''}${new Date(d.savedAt).toLocaleTimeString()}</span></div>
      <span class="badge-result ${d.overall || ''}">${escapeHtml(d.overall || '—')}</span>
    </div>`;
  }).join('');
}

/* ---------------------------------------------------------------
   Wiring
--------------------------------------------------------------- */
function resetIngested(){
  releaseActiveVideo();
  ingested = {
    sessionId: null, scenarios: {}, evidenceByCapture: {}, validationByCapture: {},
    episodesByCapture: {}, auditByScenario: {}, videosByCapture: {},
  };
  currentScenarioId = null;
  currentEpisodeId = null;
  currentScope = 'technical';
  formCache = {};
  annotationsCache = {};
  activeForm = null;
  radarByScenario = {};
  ignoreSavedScoresFor = null;
  const log = document.getElementById('loadLog');
  if (log) log.innerHTML = '';
}

function indexRadar(rooms){
  const out = {};
  (rooms || []).forEach(room => {
    if (!room || !room.scenarioId) return;
    const episodes = {};
    const rigMotion = {};
    (room.episodes || []).forEach(ep => {
      if (!ep || !ep.episodeId) return;
      episodes[ep.episodeId] = ep.scores || {};
      if (ep.rigMotion) rigMotion[ep.episodeId] = ep.rigMotion;
    });
    out[room.scenarioId] = {technical: room.technical || {}, episodes, rigMotion, status: room.status, error: room.error, bin: room.bin || null};
  });
  return out;
}

async function seedAllForms(){
  if (!ingested.sessionId) return;
  if (ingested.scenarios['C0']){
    const docId = `${ingested.sessionId}__C0__form`;
    await ensureFormLoaded(docId, ITEMS_C0, 'c0', 'C0', null, computeScenarioAutos('C0', ITEMS_C0));
  }
  for (const scenarioId of getIngestedRoomIds()){
    const techDocId = `${ingested.sessionId}__${scenarioId}__technical`;
    await ensureFormLoaded(techDocId, ITEMS_TECHNICAL, 'technical', scenarioId, null, computeScenarioAutos(scenarioId, ITEMS_TECHNICAL));
    const scenario = ingested.scenarios[scenarioId];
    const episodes = ingested.episodesByCapture[scenario.captureId] || [];
    for (const ep of episodes){
      const epDocId = `${ingested.sessionId}__${scenarioId}__ep__${ep.episodeId}`;
      const form = await ensureFormLoaded(epDocId, ITEMS_PARTICIPANT, 'participant', scenarioId, ep.episodeId, computeParticipantAutos(scenarioId, ep));
      form.episodeNumber = ep.episodeNumber != null ? ep.episodeNumber : null;
    }
  }
}

function ensureScenariosFromRadar(rooms){
  (rooms || []).forEach(room => {
    if (!room || !room.scenarioId || ingested.scenarios[room.scenarioId]) return;
    if (!/^(C0|T1-R\d+)$/.test(room.scenarioId)) return;
    const captureId = (room.bin && deriveCaptureIdFromName(room.bin.name)) || room.scenarioId;
    ingested.scenarios[room.scenarioId] = {
      scenarioId: room.scenarioId,
      roomLabel: room.scenarioId,
      captureId,
      startedAt: null,
      retainedViewCount: null,
    };
  });
}

async function applyReviewResult(data, sourceTag){
  resetIngested();
  radarByScenario = indexRadar(data.radar);
  (data.files || []).forEach(f => classifyAndIngest(f.name, f.text));
  ensureScenariosFromRadar(data.radar);
  (data.videos || []).forEach(v => ingestRemoteVideo(v.name, v.url));
  (data.log || []).forEach(line => logLine(`<span class="tag ok">${escapeHtml(sourceTag)}</span> ${escapeHtml(line)}`));
  (data.radar || []).filter(room => room.status === 'error').forEach(room => {
    logLine(`<span class="tag warn">radar</span> ${escapeHtml(room.scenarioId)}: ${escapeHtml(room.error || 'extraction failed')}`);
  });
  if (!ingested.sessionId && data.sessionId) ingested.sessionId = data.sessionId;
  currentScenarioId = getIngestedScenarioIds()[0] || null;
  await seedAllForms();
  refreshSessionStatus();
  renderScenarioTabs();
  renderScenarioShell();
  renderSessionBanner();
  renderSavedList();
  const bins = data.binsRead || [];
  const listed = bins.map(bin => `${bin.name} (${Number(bin.bytes).toLocaleString()} bytes)`).join('; ');
  const failed = (data.radar || []).filter(room => room.status === 'error').map(room => room.scenarioId);
  const failNote = failed.length
    ? ` ${failed.join(', ')} could not be scored${(data.radar || []).some(r => /CORS/.test(r.error || '')) ? ' (the blob downloads were blocked; the storage account likely needs CORS for this site)' : ''}. See the load log.`
    : '';
  return listed
    ? `Read ${listed}. Radar scores were filled from those .bin files. Check them, then Save.${failNote}`
    : `No .mmwave.bin was read, so no radar scores were filled.${failNote}`;
}

// A daily inspection report can hold several sessions. The report is read
// once; the reviewer picks which session to load, and only that session's
// files are downloaded. Picking another session re-uses the same report.
let loadedReport = null; // {name, sessions: [{sessionId, rows, rooms, bins}]}
let activeReportSession = null;

async function beginReview(file){
  const status = document.getElementById('reviewStatus');
  let sessions;
  try {
    sessions = RadarScore.reportSessions(await file.text(), file.name);
  } catch (err){
    if (status) status.textContent = `The inspection report could not be read: ${err && err.message ? err.message : err}`;
    return;
  }
  if (!sessions.length){
    if (status) status.textContent = 'The inspection report has no file rows.';
    return;
  }
  loadedReport = {name: file.name, sessions};
  activeReportSession = null;
  if (sessions.length === 1){
    renderSessionPicker();
    await reviewReportSession(sessions[0].sessionId);
    return;
  }
  renderSessionPicker();
  if (status) status.textContent = `This report lists ${sessions.length} sessions. Choose one to load.`;
}

function renderSessionPicker(){
  const el = document.getElementById('reportSessions');
  if (!el) return;
  if (!loadedReport || loadedReport.sessions.length < 2){ el.innerHTML = ''; return; }
  el.innerHTML = loadedReport.sessions.map(sess => {
    const rooms = sess.rooms.length ? `${sess.rooms.length} room${sess.rooms.length === 1 ? '' : 's'}` : 'no T1 rooms';
    const active = sess.sessionId === activeReportSession;
    return `<button type="button" class="session-pick${active ? ' active' : ''}" data-session="${escapeHtml(sess.sessionId)}">
      <span class="session-pick-id">${escapeHtml(sess.sessionId || 'unnamed session')}</span>
      <span class="session-pick-meta">${rooms} · ${sess.bins} radar file${sess.bins === 1 ? '' : 's'}${active ? ' · loaded' : ''}</span>
    </button>`;
  }).join('');
  el.querySelectorAll('[data-session]').forEach(btn => {
    btn.addEventListener('click', () => {
      const drop = document.getElementById('reportDrop');
      if (drop && drop.classList.contains('busy')) return;
      reviewReportSession(btn.dataset.session);
    });
  });
}

async function reviewReportSession(sessionId){
  if (!loadedReport) return;
  const sess = loadedReport.sessions.find(x => x.sessionId === sessionId);
  if (!sess) return;
  const status = document.getElementById('reviewStatus');
  const drop = document.getElementById('reportDrop');
  // Just this session's rows, as a JSON report both readers accept.
  const body = JSON.stringify(sess.rows);
  const name = 'inspection_report_session.json';
  activeReportSession = sessionId;
  renderSessionPicker();
  document.querySelectorAll('#reportSessions .session-pick').forEach(b => b.disabled = true);
  if (status) status.textContent = `Loading session ${sessionId || ''} and running radar scoring…`;
  if (drop) drop.classList.add('busy');
  try {
    let data;
    if (await reviewServerReady()){
      let res;
      try {
        res = await fetch('/api/review/start', {
          method: 'POST',
          headers: {'Content-Type': 'text/plain; charset=utf-8', 'X-Report-Name': name},
          body,
        });
      } catch (err){
        if (status) status.textContent = 'The review server stopped responding. Start python3 scripts/review_server.py again, or open the public site, and pick the session again.';
        return;
      }
      data = await res.json().catch(() => ({}));
      if (!res.ok){
        if (status) status.textContent = data.error || 'The inspection report could not be processed.';
        return;
      }
    } else {
      // No review server (e.g. the public GitHub Pages site): download the
      // listed files from their blob URLs and stream each room's .bin
      // through the in-browser radar reader.
      data = await RadarScore.reviewFromReport(body, name, async message => {
        if (status) status.textContent = message;
      });
    }
    if (!data.sessionId && sessionId) data.sessionId = sessionId;
    const message = await applyReviewResult(data, 'report');
    if (status) status.textContent = message;
  } catch (err){
    if (status) status.textContent = err && err.message ? `The inspection report could not be read: ${err.message}` : 'The inspection report could not be read.';
  } finally {
    if (drop) drop.classList.remove('busy');
    renderSessionPicker();
  }
}

const reportDrop = document.getElementById('reportDrop');
const reportInput = document.getElementById('reportInput');
if (reportDrop && reportInput){
  reportDrop.addEventListener('click', () => { if (!reportDrop.classList.contains('busy')) reportInput.click(); });
  reportInput.addEventListener('change', e => { if (e.target.files.length) beginReview(e.target.files[0]); reportInput.value = ''; });
  ['dragenter','dragover'].forEach(evt => reportDrop.addEventListener(evt, e => { e.preventDefault(); reportDrop.classList.add('drag'); }));
  ['dragleave','drop'].forEach(evt => reportDrop.addEventListener(evt, e => { e.preventDefault(); reportDrop.classList.remove('drag'); }));
  reportDrop.addEventListener('drop', e => { if (e.dataTransfer.files.length && !reportDrop.classList.contains('busy')) beginReview(e.dataTransfer.files[0]); });
}

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
dropzone.addEventListener('click', () => { if (!dropzone.classList.contains('busy')) fileInput.click(); });
fileInput.addEventListener('change', e => { if (e.target.files.length && !dropzone.classList.contains('busy')) handleFiles(e.target.files); fileInput.value=''; });
['dragenter','dragover'].forEach(evt => dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave','drop'].forEach(evt => dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.remove('drag'); }));
dropzone.addEventListener('drop', e => { if (e.dataTransfer.files.length && !dropzone.classList.contains('busy')) handleFiles(e.dataTransfer.files); });

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

document.getElementById('globalSaveBtn').addEventListener('click', async () => {
  await saveActiveForm();
});

document.getElementById('resetToRadarBtn').addEventListener('click', async () => {
  if (!ingested.sessionId){ logLine(`<span class="tag warn">reset</span> no session loaded yet`); return; }
  const ok = confirm(
    `Reset every score for session ${ingested.sessionId} to the radar and automatic suggestions?\n\n` +
    `Saved scores for this session are set aside and the forms are refilled from the loaded files. ` +
    `Reviewer notes and video annotations are kept. Scores the files can't suggest (for example the C0 motion items) will be empty.\n\n` +
    `Nothing changes in SharePoint until you press Save. Press Save to replace the saved scores; reload the page to back out.`
  );
  if (!ok) return;
  captureActiveNotes();
  // Carry over any notes typed but not yet saved, then rebuild every form.
  const typedNotes = {};
  Object.values(formCache).forEach(f => { if (f.notes) typedNotes[f.docId] = f.notes; });
  clearLocalCacheForSession(ingested.sessionId);
  ignoreSavedScoresFor = ingested.sessionId;
  formCache = {};
  await seedAllForms();
  Object.entries(typedNotes).forEach(([docId, notes]) => { if (formCache[docId]) formCache[docId].notes = notes; });
  renderSessionBanner();
  if (currentScenarioId) await renderScoringSection();
  const n = Object.keys(formCache).length;
  logLine(`<span class="tag warn">reset</span> ${n} form(s) refilled from the radar and automatic suggestions. Press Save to replace the saved scores in SharePoint.`);
  setSaveStatus('dirty');
});

document.getElementById('clearLocalBtn').addEventListener('click', async () => {
  if (!ingested.sessionId){ logLine(`<span class="tag warn">clear local</span> no session loaded yet`); return; }
  const ok = confirm(
    `Clear local cache for session ${ingested.sessionId}?\n\n` +
    `This only wipes this browser's local backup copy — it does NOT delete anything from SharePoint. ` +
    `Use this after you've already deleted rows from the SharePoint file directly, so a stale local ` +
    `copy doesn't make a deleted row silently reappear when you reopen that episode's form.`
  );
  if (!ok) return;
  const n = clearLocalCacheForSession(ingested.sessionId);
  formCache = {}; annotationsCache = {}; remoteCache = null;
  await queryAll();
  renderSavedList(); renderSessionBanner();
  if (currentScenarioId) renderScenarioShell();
  logLine(`<span class="tag ok">clear local</span> removed ${n} locally-cached record(s) for this session`);
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
  noteReviewServer();
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
