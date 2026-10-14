/* In-browser radar scoring for a raw .mmwave.bin.
   Same steps as scripts/extract_mmwave_diagnostics.py. Frames are read
   one at a time so a multi-gigabyte capture is not held in memory. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RadarScore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULTS = {
    numRx: 3,
    numChirps: 64,
    numSamples: 128,
    frameRateHz: 10,
    rangeResolutionM: 0.07786331709192154,
    dopplerResolutionMps: 0.1819795409571315,
    centerFrequencyHz: 58368640000,
    minRangeM: 0.8,
    clutterAlpha: 0.98,
    warmup: 30,
    gateRangeBins: 4,
    gateDopplerBins: 5,
    acquireMinSnr: 16,
    lockMinSnr: 12,
    blueMaxRange: 5,
    orangeMaxRange: 3,
    azimuthSmoothFrames: 5,
    frontalHalfAngle: 60,
    movingSpeedThreshold: 0.3,
    positionWindowS: 2,
    positionShiftPct: 5,
    positionClearMargin: 2,
    minPositions: 6,
  };
  const SPEED_OF_LIGHT = 299792458;

  function round(value, digits) {
    if (value == null || Number.isNaN(value)) return null;
    const p = 10 ** digits;
    return Math.round((value + Number.EPSILON) * p) / p;
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function std(values) {
    if (!values.length) return null;
    let mean = 0;
    for (let i = 0; i < values.length; i++) mean += values[i];
    mean /= values.length;
    let acc = 0;
    for (let i = 0; i < values.length; i++) {
      const d = values[i] - mean;
      acc += d * d;
    }
    return Math.sqrt(acc / values.length);
  }

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wlenRe = Math.cos(ang);
      const wlenIm = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let wRe = 1;
        let wIm = 0;
        for (let j = 0; j < half; j++) {
          const i0 = i + j;
          const i1 = i0 + half;
          const vRe = re[i1] * wRe - im[i1] * wIm;
          const vIm = re[i1] * wIm + im[i1] * wRe;
          re[i1] = re[i0] - vRe;
          im[i1] = im[i0] - vIm;
          re[i0] += vRe;
          im[i0] += vIm;
          const nextRe = wRe * wlenRe - wIm * wlenIm;
          wIm = wRe * wlenIm + wIm * wlenRe;
          wRe = nextRe;
        }
      }
    }
  }

  function newAccumulator() {
    return {
      totalFrames: 0,
      framesTracked: 0,
      framesSearching: 0,
      framesMoving: 0,
      zones: {blue: 0, orange: 0, neither: 0},
      ranges: [],
      speeds: [],
    };
  }

  function accumulate(acc, trackState, zone, peakRange, impliedSpeed, movingThreshold) {
    acc.totalFrames += 1;
    if (trackState === 'searching') {
      acc.framesSearching += 1;
      return;
    }
    acc.framesTracked += 1;
    acc.ranges.push(peakRange);
    if (acc.zones[zone] != null) acc.zones[zone] += 1;
    if (impliedSpeed != null) {
      acc.speeds.push(impliedSpeed);
      if (impliedSpeed > movingThreshold) acc.framesMoving += 1;
    }
  }

  function summarize(acc) {
    const total = acc.totalFrames || 1;
    const tracked = acc.framesTracked || 1;
    return {
      total_frames: acc.totalFrames,
      frames_tracked: acc.framesTracked,
      pct_tracked: round(100 * acc.framesTracked / total, 1),
      zone_pct_of_tracked_frames: {
        blue: round(100 * acc.zones.blue / tracked, 1),
        orange: round(100 * acc.zones.orange / tracked, 1),
        neither: round(100 * acc.zones.neither / tracked, 1),
      },
      continuous_movement_pct: acc.framesTracked ? round(100 * acc.framesMoving / tracked, 1) : null,
      distance_variance_m: round(std(acc.ranges), 4),
      speed_variance_mps: round(std(acc.speeds), 4),
    };
  }

  function parseTs(value) {
    return Date.parse(String(value).replace('Z', '+00:00'));
  }

  function episodeWindows(markersText, syncText) {
    const sync = JSON.parse(syncText);
    let ready = sync.firstFrameReady;
    if (!ready && Array.isArray(sync.segments) && sync.segments[0]) ready = sync.segments[0].firstFrameReady;
    if (!ready || !ready.hostintrReadyUtc) throw new Error('The mmwave sync JSON has no firstFrameReady.hostintrReadyUtc.');
    const anchor = parseTs(ready.hostintrReadyUtc);
    const byId = {};
    String(markersText).split('\n').forEach(line => {
      line = line.trim();
      if (!line) return;
      const ev = JSON.parse(line);
      if (!ev.episodeId) return;
      byId[ev.episodeId] = byId[ev.episodeId] || {};
      byId[ev.episodeId][ev.type] = ev;
    });
    const windows = [];
    Object.keys(byId).forEach(id => {
      const started = byId[id]['capture.episode.started'];
      const ended = byId[id]['capture.episode.ended'];
      if (!started || !ended) return;
      windows.push({
        episode_id: id,
        episode_number: started.episodeNumber,
        start_time_s: (parseTs(started.ts) - anchor) / 1000,
        end_time_s: (parseTs(ended.ts) - anchor) / 1000,
      });
    });
    windows.sort((a, b) => a.start_time_s - b.start_time_s);
    return windows;
  }

  function findEpisode(windows, timeS) {
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      if (w.start_time_s <= timeS && timeS < w.end_time_s) return w;
    }
    return null;
  }

  async function readSamples(file, byteOffset, sampleCount) {
    const bytes = sampleCount * 2;
    const buf = await file.slice(byteOffset, byteOffset + bytes).arrayBuffer();
    const view = new DataView(buf);
    const samples = new Float64Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) samples[i] = view.getInt16(i * 2, false);
    return samples;
  }

  async function scoreBinFile(file, options) {
    const opt = Object.assign({}, DEFAULTS, options || {});
    const numRx = opt.numRx;
    const numChirps = opt.numChirps;
    const numSamples = opt.numSamples;
    const frameSamples = numRx * numChirps * numSamples;
    const frameBytes = frameSamples * 2;
    const nFrames = Math.floor(file.size / frameBytes);
    if (!nFrames) throw new Error(`${file.name || 'radar file'} has no complete radar frames.`);
    const windows = (opt.markersText && opt.syncText) ? episodeWindows(opt.markersText, opt.syncText) : [];
    const minRangeBin = Math.max(2, Math.round(opt.minRangeM / opt.rangeResolutionM));
    const wavelength = SPEED_OF_LIGHT / opt.centerFrequencyHz;
    const spacing = wavelength / 2;
    const centerDoppler = numChirps >> 1;
    const rangeCount = numSamples >> 1;
    const cells = numChirps * numRx * numSamples;
    const clutterRe = new Float64Array(cells);
    const clutterIm = new Float64Array(cells);
    let clutterReady = false;
    const rangeCubeRe = new Float64Array(cells);
    const rangeCubeIm = new Float64Array(cells);
    const dopplerRe = new Float64Array(cells);
    const dopplerIm = new Float64Array(cells);
    const rangeRe = new Float64Array(numSamples);
    const rangeIm = new Float64Array(numSamples);
    const dopplerInRe = new Float64Array(numChirps);
    const dopplerInIm = new Float64Array(numChirps);
    const summary = newAccumulator();
    const episodeAcc = {};
    const tail = {};
    const head = {};
    windows.forEach(w => {
      episodeAcc[w.episode_id] = newAccumulator();
      tail[w.episode_id] = [];
      head[w.episode_id] = [];
    });
    let locked = false;
    let lastDoppler = 0;
    let lastRange = 0;
    let prevX = null;
    let prevY = null;
    let prevRange = null;
    let prevAz = null;
    let prevTime = null;
    let prevLocked = false;
    const azimuthBuffer = [];

    function idx(d, ant, r) {
      return (d * numRx + ant) * numSamples + r;
    }

    for (let frameIdx = 0; frameIdx < nFrames; frameIdx++) {
      const raw = await readSamples(file, frameIdx * frameBytes, frameSamples);
      for (let chirp = 0; chirp < numChirps; chirp++) {
        for (let ant = 0; ant < numRx; ant++) {
          const base = (chirp * numRx + ant) * numSamples;
          let mean = 0;
          for (let s = 0; s < numSamples; s++) mean += raw[base + s];
          mean /= numSamples;
          for (let s = 0; s < numSamples; s++) {
            rangeRe[s] = raw[base + s] - mean;
            rangeIm[s] = 0;
          }
          fft(rangeRe, rangeIm);
          for (let s = 0; s < numSamples; s++) {
            const at = idx(chirp, ant, s);
            rangeCubeRe[at] = rangeRe[s];
            rangeCubeIm[at] = rangeIm[s];
          }
        }
      }
      // Doppler FFT along chirps for every antenna and range bin, then fftshift.
      for (let ant = 0; ant < numRx; ant++) {
        for (let r = 0; r < numSamples; r++) {
          for (let chirp = 0; chirp < numChirps; chirp++) {
            const at = idx(chirp, ant, r);
            dopplerInRe[chirp] = rangeCubeRe[at];
            dopplerInIm[chirp] = rangeCubeIm[at];
          }
          fft(dopplerInRe, dopplerInIm);
          const half = numChirps >> 1;
          for (let chirp = 0; chirp < numChirps; chirp++) {
            const src = (chirp + half) % numChirps;
            const at = idx(chirp, ant, r);
            dopplerRe[at] = dopplerInRe[src];
            dopplerIm[at] = dopplerInIm[src];
          }
        }
      }
      for (let i = 0; i < cells; i++) {
        if (!clutterReady) {
          clutterRe[i] = dopplerRe[i];
          clutterIm[i] = dopplerIm[i];
        } else {
          clutterRe[i] = opt.clutterAlpha * clutterRe[i] + (1 - opt.clutterAlpha) * dopplerRe[i];
          clutterIm[i] = opt.clutterAlpha * clutterIm[i] + (1 - opt.clutterAlpha) * dopplerIm[i];
        }
      }
      clutterReady = true;
      const warmed = frameIdx >= opt.warmup;

      const mag = new Float64Array(numChirps * numSamples);
      for (let d = 0; d < numChirps; d++) {
        for (let r = 0; r < numSamples; r++) {
          let sum = 0;
          for (let ant = 0; ant < numRx; ant++) {
            const at = idx(d, ant, r);
            const re = warmed ? dopplerRe[at] - clutterRe[at] : dopplerRe[at];
            const im = warmed ? dopplerIm[at] - clutterIm[at] : dopplerIm[at];
            sum += Math.hypot(re, im);
          }
          mag[d * numSamples + r] = sum / numRx;
        }
      }
      for (let d = centerDoppler - 1; d <= centerDoppler + 1; d++) {
        if (d < 0 || d >= numChirps) continue;
        for (let r = 0; r < numSamples; r++) mag[d * numSamples + r] = 0;
      }
      const usable = [];
      for (let d = 0; d < numChirps; d++) {
        for (let r = minRangeBin; r < rangeCount; r++) {
          const v = mag[d * numSamples + r];
          if (v > 0) usable.push(v);
        }
      }
      const background = usable.length ? median(usable) : 0;

      function bestPeak(d0, d1, r0, r1) {
        let best = -1;
        let bd = 0;
        let br = 0;
        for (let d = d0; d < d1; d++) {
          for (let r = r0; r < r1; r++) {
            const v = mag[d * numSamples + r];
            if (v > best) {
              best = v;
              bd = d;
              br = r;
            }
          }
        }
        return best > 0 ? {d: bd, r: br, energy: best} : null;
      }

      let candidate = null;
      let trackState = 'searching';
      if (locked) {
        const d0 = Math.max(0, lastDoppler - opt.gateDopplerBins);
        const d1 = Math.min(numChirps, lastDoppler + opt.gateDopplerBins + 1);
        const r0 = Math.max(minRangeBin, lastRange - opt.gateRangeBins);
        const r1 = Math.min(rangeCount, lastRange + opt.gateRangeBins + 1);
        const gated = bestPeak(d0, d1, r0, r1);
        if (gated) {
          const snr = background > 0 ? 10 * Math.log10(gated.energy / background) : NaN;
          if (snr >= opt.lockMinSnr) {
            candidate = gated;
            candidate.snr = snr;
            trackState = 'locked';
          }
        }
        if (!candidate) locked = false;
      }
      if (!candidate && warmed) {
        const found = bestPeak(0, numChirps, minRangeBin, rangeCount);
        if (found) {
          const snr = background > 0 ? 10 * Math.log10(found.energy / background) : NaN;
          if (snr >= opt.acquireMinSnr) {
            candidate = found;
            candidate.snr = snr;
            trackState = 'acquired';
          }
        }
      }

      const timeS = frameIdx / opt.frameRateHz;
      const episode = findEpisode(windows, timeS);
      let peakRange = null;
      let impliedSpeed = null;
      let zone = null;
      if (candidate) {
        locked = true;
        lastDoppler = candidate.d;
        lastRange = candidate.r;
        peakRange = candidate.r * opt.rangeResolutionM;
        const phases = [];
        for (let ant = 0; ant < numRx; ant++) {
          const at = idx(candidate.d, ant, candidate.r);
          phases.push(Math.atan2(dopplerIm[at], dopplerRe[at]) * 180 / Math.PI);
        }
        const diff1 = ((phases[1] - phases[0] + 180) % 360 + 360) % 360 - 180;
        const arg1 = (diff1 * Math.PI / 180) * wavelength / (2 * Math.PI * spacing);
        const azimuth = Math.abs(arg1) <= 1 ? Math.asin(arg1) * 180 / Math.PI : null;
        if (trackState === 'acquired') {
          azimuthBuffer.length = 0;
          prevX = prevY = prevRange = prevAz = prevTime = null;
          prevLocked = false;
        }
        if (azimuth != null) azimuthBuffer.push(azimuth);
        while (azimuthBuffer.length > opt.azimuthSmoothFrames) azimuthBuffer.shift();
        const azimuthSmooth = azimuthBuffer.length ? median(azimuthBuffer) : null;
        let x = null;
        let y = null;
        if (azimuthSmooth != null) {
          const rad = azimuthSmooth * Math.PI / 180;
          x = peakRange * Math.sin(rad);
          y = peakRange * Math.cos(rad);
        }
        const inFront = azimuthSmooth != null && Math.abs(azimuthSmooth) <= opt.frontalHalfAngle;
        if (azimuthSmooth == null) zone = '';
        else if (inFront && peakRange <= opt.blueMaxRange) zone = 'blue';
        else if (!inFront && peakRange <= opt.orangeMaxRange) zone = 'orange';
        else zone = 'neither';
        if (trackState === 'locked' && prevLocked && prevX != null && x != null) {
          const dt = timeS - prevTime;
          const deltaPos = Math.hypot(x - prevX, y - prevY);
          if (dt > 0) impliedSpeed = deltaPos / dt;
        }
        prevX = x;
        prevY = y;
        prevRange = peakRange;
        prevAz = azimuthSmooth;
        prevTime = timeS;
        prevLocked = trackState === 'locked';
      } else {
        prevX = prevY = prevRange = prevAz = prevTime = null;
        prevLocked = false;
        azimuthBuffer.length = 0;
      }
      accumulate(summary, trackState, zone, peakRange, impliedSpeed, opt.movingSpeedThreshold);
      if (episode) {
        accumulate(episodeAcc[episode.episode_id], trackState, zone, peakRange, impliedSpeed, opt.movingSpeedThreshold);
        if (timeS >= episode.end_time_s - opt.positionWindowS) tail[episode.episode_id].push(background);
        if (timeS < episode.start_time_s + opt.positionWindowS) head[episode.episode_id].push(background);
      }
      if (opt.onProgress && (frameIdx % 10 === 0 || frameIdx === nFrames - 1)) {
        await opt.onProgress(frameIdx + 1, nFrames);
      }
    }

    let placements = null;
    if (windows.length >= 2) {
      let shifts = 0;
      for (let i = 0; i < windows.length - 1; i++) {
        const a = tail[windows[i].episode_id];
        const b = head[windows[i + 1].episode_id];
        if (!a.length || !b.length) continue;
        const before = median(a);
        const after = median(b);
        const shiftPct = before > 0 ? ((after - before) / before) * 100 : null;
        if (shiftPct != null && Math.abs(shiftPct) >= opt.positionShiftPct) shifts += 1;
      }
      const estimated = shifts + 1;
      placements = {
        estimated_distinct_positions: estimated,
        routing: estimated >= (opt.minPositions + opt.positionClearMargin) ? 'auto_clear' : 'manual_review',
      };
    }
    const episodeSummaries = windows.map(w => Object.assign({
      episode_id: w.episode_id,
      episode_number: w.episode_number,
    }, summarize(episodeAcc[w.episode_id])));
    return {
      frames: nFrames,
      bytes: file.size,
      summary: Object.assign(summarize(summary), {device_placements: placements}),
      episodes: episodeSummaries,
    };
  }

  function scoreEntry(value, note, coverage) {
    const entry = {value: value == null ? null : round(Number(value), 4), note: note};
    if (coverage != null) entry.coveragePct = round(Number(coverage), 1);
    return entry;
  }

  function scoresFromSummary(summary, label) {
    if (!summary || !summary.frames_tracked) return {};
    const zones = summary.zone_pct_of_tracked_frames || {};
    const note = `Radar extraction, ${label}, tracked ${summary.pct_tracked}% of frames`;
    return {
      continuous_movement: scoreEntry(summary.continuous_movement_pct, note, summary.pct_tracked),
      blue_zone_pct: scoreEntry(zones.blue, note, summary.pct_tracked),
      orange_zone: scoreEntry(zones.orange, note, summary.pct_tracked),
      speed_variance: scoreEntry(summary.speed_variance_mps, note + ', speed std m/s'),
      distance_variance: scoreEntry(summary.distance_variance_m, note + ', distance std m'),
    };
  }

  function technicalFromSummary(summary) {
    const placements = summary && summary.device_placements;
    if (!placements || placements.estimated_distinct_positions == null) return {};
    return {
      device_placements: scoreEntry(
        Math.round(placements.estimated_distinct_positions),
        `Radar estimate of distinct positions, routing ${placements.routing}`,
      ),
    };
  }

  function captureIdFromName(name) {
    const m = /_c(\d{3,})[._]/i.exec(name || '');
    return m ? 'c' + m[1] : '';
  }

  function scenarioIdFromName(name) {
    const m = /(?:^|[^A-Z0-9])(C0|T1-R\d+)(?:[^A-Z0-9]|$)/i.exec(name || '');
    if (!m) return '';
    return m[1].toUpperCase() === 'C0' ? 'C0' : m[1].toUpperCase();
  }

  async function reviewFromFiles(files, onProgress) {
    const list = Array.from(files);
    const textFiles = [];
    const bins = [];
    for (const file of list) {
      if (/\.bin$/i.test(file.name)) bins.push(file);
      else if (!/\.(mp4|mov|webm)$/i.test(file.name)) {
        textFiles.push({name: file.name, text: await file.text(), file: file});
      }
    }
    if (!bins.length) throw new Error('Drop a .mmwave.bin to score the room.');
    const parsed = textFiles.map(item => ({name: item.name, text: item.text, captureId: captureIdFromName(item.name), scenarioId: scenarioIdFromName(item.name)}));
    parsed.forEach(item => {
      const trimmed = item.text.trim();
      if (trimmed.startsWith('{')) {
        try {
          const obj = JSON.parse(item.text);
          if (obj && obj.scenarioId && obj.artifacts) {
            item.scenarioId = item.scenarioId || obj.scenarioId;
            item.sessionId = obj.sessionId || '';
            item.kind = 'capture';
          }
        } catch (e) {}
      }
    });
    const radar = [];
    const binsRead = [];
    const log = [];
    for (const bin of bins) {
      const captureId = captureIdFromName(bin.name);
      const companions = parsed.filter(item => captureId && item.captureId === captureId);
      const markers = companions.find(item => /episode_markers/i.test(item.name));
      const sync = companions.find(item => /mmwave_sync|mmwave\.json|mmwave_segments/i.test(item.name));
      const capture = companions.find(item => item.kind === 'capture') || parsed.find(item => item.kind === 'capture' && item.captureId === captureId);
      let scenarioId = (capture && capture.scenarioId) || scenarioIdFromName(bin.name) || captureId || 'UNKNOWN';
      if (onProgress) await onProgress(`Reading ${bin.name} (${bin.size.toLocaleString()} bytes) in this browser…`);
      const result = await scoreBinFile(bin, {
        markersText: markers && markers.text,
        syncText: sync && sync.text,
        onProgress: async (done, total) => {
          if (onProgress) await onProgress(`Reading ${bin.name}: frame ${done.toLocaleString()} of ${total.toLocaleString()}.`);
        },
      });
      log.push(`Read ${bin.name} (${bin.size.toLocaleString()} bytes) in the browser. Radar scores come from this .bin.`);
      binsRead.push({name: bin.name, bytes: bin.size, scenarioId: scenarioId});
      radar.push({
        scenarioId: scenarioId,
        status: 'ok',
        bin: {name: bin.name, bytes: bin.size},
        technical: technicalFromSummary(result.summary),
        episodes: result.episodes.map(ep => ({
          episodeId: ep.episode_id,
          scores: scoresFromSummary(ep, `episode ${ep.episode_number}`),
        })),
      });
    }
    const session = (parsed.find(item => item.sessionId) || {}).sessionId || null;
    return {
      sessionId: session,
      files: textFiles.filter(item => !/video_zone/i.test(item.name)).map(item => ({name: item.name, text: item.text})),
      videos: [],
      radar: radar,
      binsRead: binsRead,
      log: log,
    };
  }

  return {scoreBinFile, reviewFromFiles, fft};
});
