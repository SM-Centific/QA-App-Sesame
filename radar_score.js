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
      zones: {blue: 0, orange: 0, outside_far: 0, neither: 0},
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
        outside_far: round(100 * acc.zones.outside_far / tracked, 1),
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

    const backgroundSeries = []; // one value per frame, for rigMotionByEpisode()
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
      backgroundSeries.push(background);

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
        else if (!inFront) zone = 'outside_far';
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
    const rig = rigMotionByEpisode(backgroundSeries, windows, opt.frameRateHz, opt.warmup);
    const episodeSummaries = windows.map(w => Object.assign({
      episode_id: w.episode_id,
      episode_number: w.episode_number,
    }, summarize(episodeAcc[w.episode_id]), {rig_motion: rig[w.episode_id] || null}));
    return {
      frames: nFrames,
      bytes: file.size,
      summary: Object.assign(summarize(summary), {device_placements: placements}),
      episodes: episodeSummaries,
    };
  }

  // Same as rig_motion_by_episode() in extract_mmwave_diagnostics.py: how
  // much the rig itself moved in each episode, from the rise in
  // clutter-subtracted background energy over its at-rest baseline.
  function percentile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q / 100;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function rigMotionByEpisode(series, windows, frameRate, warmupFrames, ratio, smoothFrames, edgeS) {
    ratio = ratio || 1.2; smoothFrames = smoothFrames || 10; edgeS = edgeS || 5;
    const out = {};
    if (!windows.length || !series.length) return out;
    const bg = series.map((v, i) => (i < warmupFrames ? NaN : v));
    const half = smoothFrames >> 1;
    const smooth = bg.map((_, i) => {
      const win = bg.slice(Math.max(0, i - half), i + half).filter(v => !Number.isNaN(v));
      return win.length ? median(win) : NaN;
    });
    const time = i => i / frameRate;
    const firstStart = Math.min.apply(null, windows.map(w => w.start_time_s));
    const pre = [];
    bg.forEach((v, i) => {
      const t = time(i);
      if (!Number.isNaN(v) && t >= warmupFrames / frameRate + 1 && t < firstStart - 0.5) pre.push(v);
    });
    windows.forEach(w => {
      const inside = [];
      smooth.forEach((v, i) => { const t = time(i); if (t >= w.start_time_s && t <= w.end_time_s && !Number.isNaN(v)) inside.push(i); });
      if (!inside.length) return;
      let baseline;
      let source;
      if (pre.length >= 10) { baseline = median(pre); source = 'before_first_episode'; }
      else { baseline = percentile(inside.map(i => smooth[i]).sort((a, b) => a - b), 20); source = 'episode_low_20pct'; }
      if (!(baseline > 0)) return;
      const pct = test => {
        const idx = inside.filter(i => test(time(i)));
        if (!idx.length) return null;
        return round(100 * idx.filter(i => smooth[i] > ratio * baseline).length / idx.length, 1);
      };
      out[w.episode_id] = {
        baseline_energy: round(baseline, 1), baseline_source: source, ratio: ratio, edge_s: edgeS,
        moving_pct: pct(() => true),
        moving_pct_first_edge: pct(t => t < w.start_time_s + edgeS),
        moving_pct_last_edge: pct(t => t > w.end_time_s - edgeS),
        moving_pct_middle: pct(t => t >= w.start_time_s + edgeS && t <= w.end_time_s - edgeS),
      };
    });
    return out;
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
      outside_far: scoreEntry(zones.outside_far, note, summary.pct_tracked),
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

  // files: File objects, or file-like objects with name, size, text() and
  // slice(). An object may also carry captureId / scenarioId (from an
  // inspection-report row); otherwise both come from the filename.
  // options.requireBin (default true): throw when no .bin is present.
  // options.videos: [{name, url}] passed through for the player.
  // options.log: lines to show before the per-room lines.
  async function reviewFromFiles(files, onProgress, options) {
    const opts = Object.assign({requireBin: true, videos: [], log: []}, options || {});
    const list = Array.from(files);
    const textFiles = [];
    const bins = [];
    for (const file of list) {
      if (/\.bin$/i.test(file.name)) bins.push(file);
      else if (!/\.(mp4|mov|webm)$/i.test(file.name)) {
        textFiles.push({name: file.name, text: await file.text(), file: file});
      }
    }
    if (!bins.length && opts.requireBin) throw new Error('Drop a .mmwave.bin to score the room.');
    const parsed = textFiles.map(item => ({
      name: item.name,
      text: item.text,
      captureId: item.file.captureId || captureIdFromName(item.name),
      scenarioId: item.file.scenarioId || scenarioIdFromName(item.name),
    }));
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
    const log = opts.log.slice();
    for (const bin of bins) {
      const captureId = bin.captureId || captureIdFromName(bin.name);
      const companions = parsed.filter(item => captureId && item.captureId === captureId);
      const markers = companions.find(item => /episode_markers/i.test(item.name));
      const sync = companions.find(item => /mmwave_sync|mmwave\.json|mmwave_segments/i.test(item.name));
      const capture = companions.find(item => item.kind === 'capture') || parsed.find(item => item.kind === 'capture' && item.captureId === captureId);
      let scenarioId = (capture && capture.scenarioId) || bin.scenarioId || scenarioIdFromName(bin.name) || captureId || 'UNKNOWN';
      if (!markers || !sync) {
        log.push(`${bin.name}: ${!markers ? 'episode markers' : 'mmwave sync JSON'} not found for ${captureId || scenarioId}, so per-episode Blue/Orange Zone cannot be filled for this room.`);
      }
      let result;
      try {
        if (bin.open) await bin.open();
        if (onProgress) await onProgress(`Reading ${bin.name} (${bin.size.toLocaleString()} bytes) in this browser…`);
        result = await scoreBinFile(bin, {
          markersText: markers && markers.text,
          syncText: sync && sync.text,
          onProgress: async (done, total) => {
            if (onProgress) await onProgress(`Reading ${bin.name}: frame ${done.toLocaleString()} of ${total.toLocaleString()} (${Math.floor(100 * done / total)}%).`);
          },
        });
      } catch (err) {
        radar.push({scenarioId: scenarioId, status: 'error', error: `${bin.name}: ${err && err.message ? err.message : err}`});
        continue;
      } finally {
        if (bin.close) bin.close();
      }
      log.push(`Read ${bin.name} (${bin.size.toLocaleString()} bytes) in the browser. Radar scores come from this .bin.`);
      binsRead.push({name: bin.name, bytes: bin.size, scenarioId: scenarioId});
      radar.push({
        scenarioId: scenarioId,
        status: 'ok',
        bin: {name: bin.name, bytes: bin.size},
        technical: technicalFromSummary(result.summary),
        episodes: result.episodes.map(ep => ({
          episodeId: ep.episode_id,
          rigMotion: ep.rig_motion || null,
          scores: scoresFromSummary(ep, `episode ${ep.episode_number}`),
        })),
      });
    }
    const session = (parsed.find(item => item.sessionId) || {}).sessionId || null;
    return {
      sessionId: session,
      files: textFiles.filter(item => !/video_zone/i.test(item.name)).map(item => ({name: item.name, text: item.text})),
      videos: opts.videos,
      radar: radar,
      binsRead: binsRead,
      log: log,
    };
  }

  /* ---------------------------------------------------------------
     Inspection report, read in the browser (no review server).
     Same row rules as scripts/review_server.py: a file's URL is
     blob_path + sas_token (or any full http URL column), and videos use
     video_preview_url. Only the files the app uses are downloaded; each
     .mmwave.bin is streamed once, front to back, straight into
     scoreBinFile, so a multi-gigabyte room never sits in memory.
     The blob storage account must allow this site's origin (CORS).
  --------------------------------------------------------------- */
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') quoted = false;
        else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some(v => v.trim() !== '')) rows.push(row);
        row = [];
      } else field += ch;
    }
    row.push(field);
    if (row.some(v => v.trim() !== '')) rows.push(row);
    return rows;
  }

  function normalizeKey(key) {
    return String(key || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  function reportRows(text, reportName) {
    const clean = text.replace(/^﻿/, '');
    const trimmed = clean.trim();
    let records;
    if (/\.json$/i.test(reportName || '') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
      let data = JSON.parse(clean);
      if (data && !Array.isArray(data)) data = data.files || data.rows || data.value;
      if (!Array.isArray(data) || !data.length) throw new Error('JSON inspection report must be a list of rows.');
      records = data;
    } else {
      const table = parseCsv(clean);
      if (table.length < 2) throw new Error('Inspection report has no data rows.');
      const header = table[0];
      records = table.slice(1).map(cells => {
        const obj = {};
        header.forEach((h, i) => { obj[h] = cells[i]; });
        return obj;
      });
    }
    return records.map(rec => {
      const out = {};
      Object.keys(rec).forEach(k => {
        const nk = normalizeKey(k);
        if (nk) out[nk] = rec[k] == null ? '' : String(rec[k]).trim();
      });
      return out;
    });
  }

  function firstValue(row, keys) {
    for (const k of keys) if (row[k]) return row[k];
    return '';
  }

  function joinBlobUrl(blob, token) {
    if (!blob || !/^https?:/i.test(blob)) return '';
    if (!token || /[?&]sig=/.test(blob)) return blob;
    const t = token.replace(/^\?/, '');
    return blob + (blob.includes('?') ? '&' : '?') + t;
  }

  function nameFromUrl(url) {
    try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch (e) { return ''; }
  }

  function rowUrl(row) {
    const hint = firstValue(row, ['filename', 'file_name', 'file', 'name', 'blob_name']);
    const preview = row.video_preview_url || '';
    if (/\.(mp4|mov|webm)$/i.test(hint) && /^https?:/i.test(preview)) return preview;
    for (const k of ['url', 'file_url', 'sas_url', 'download_url', 'blob_url']) {
      if (/^https?:/i.test(row[k] || '')) return row[k];
    }
    const built = joinBlobUrl(row.blob_path || '', row.sas_token || '');
    if (built) return built;
    if (/^https?:/i.test(preview)) return preview;
    for (const v of Object.values(row)) if (/^https?:/i.test(v)) return v;
    return '';
  }

  function rowName(row, url) {
    let name = firstValue(row, ['filename', 'file_name', 'file', 'name', 'blob_name']);
    if (!name && row.blob_path) name = /^https?:/i.test(row.blob_path) ? nameFromUrl(row.blob_path) : row.blob_path.split('/').pop();
    if (!name && url) name = nameFromUrl(url);
    return name;
  }

  // Text files the app reads. Anything else in the report is left alone.
  const WANTED_TEXT = /(episode_markers.*\.jsonl|mmwave_sync.*\.json|mmwave\.json|mmwave_segments.*\.json|capture\.json|audit\.json|session_evidence.*\.json|session_validation.*\.json)$/i;

  function fetchFailure(name, err) {
    const msg = err && err.message ? err.message : String(err);
    if (err && err.name === 'TypeError') {
      return `Could not download ${name}. The browser blocked or could not reach it (${msg}). ` +
        'If the link works when opened directly, the blob storage account needs CORS enabled for this site.';
    }
    return `Could not download ${name}: ${msg}`;
  }

  // A .bin read by streaming one GET. scoreBinFile reads frames in order,
  // so slice() only ever moves forward; chunks are dropped once consumed.
  function remoteBinFile(url, name, ids) {
    const file = Object.assign({name: name, size: 0}, ids || {});
    let reader = null;
    let chunks = [];
    let buffered = 0;
    let position = 0;
    let done = false;
    file.open = async function () {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
      const length = Number(res.headers.get('Content-Length'));
      if (!length) throw new Error('the storage server did not report the file size');
      file.size = length;
      reader = res.body.getReader();
    };
    async function take(byteCount) {
      while (buffered < byteCount && !done) {
        const step = await reader.read();
        if (step.done) { done = true; break; }
        chunks.push(step.value);
        buffered += step.value.length;
      }
      if (buffered < byteCount) throw new Error('download ended before the whole file arrived');
      const out = new Uint8Array(byteCount);
      let filled = 0;
      while (filled < byteCount) {
        const head = chunks[0];
        const need = byteCount - filled;
        if (head.length <= need) {
          out.set(head, filled);
          filled += head.length;
          chunks.shift();
        } else {
          out.set(head.subarray(0, need), filled);
          chunks[0] = head.subarray(need);
          filled += need;
        }
      }
      buffered -= byteCount;
      position += byteCount;
      return out.buffer;
    }
    file.slice = function (start, end) {
      return {
        arrayBuffer: async function () {
          if (!reader) throw new Error('file not opened');
          if (start !== position) throw new Error('radar frames must be read in order');
          return take(end - start);
        },
      };
    };
    file.close = function () {
      if (reader && !done) { try { reader.cancel(); } catch (e) {} }
      chunks = [];
      buffered = 0;
    };
    return file;
  }

  async function reviewFromReport(text, reportName, onProgress) {
    const rows = reportRows(text, reportName);
    const log = [];
    const videos = [];
    const textJobs = [];
    const bins = [];
    rows.forEach(row => {
      const url = rowUrl(row);
      const name = rowName(row, url);
      if (!url || !name) {
        log.push(`Skipped a report row with no file URL (${name || 'unnamed'}).`);
        return;
      }
      const ids = {
        captureId: firstValue(row, ['capture_id', 'capture']) || captureIdFromName(name),
        scenarioId: (firstValue(row, ['scenario_id', 'scenario', 'room', 'room_id', 'step_id']) || scenarioIdFromName(name)).toUpperCase(),
      };
      if (/\.(mp4|mov|webm)$/i.test(name)) {
        videos.push({name: name, url: url});
      } else if (/\.bin$/i.test(name)) {
        bins.push(remoteBinFile(url, name, ids));
      } else if (WANTED_TEXT.test(name)) {
        textJobs.push({name: name, url: url, ids: ids});
      }
    });
    if (onProgress) await onProgress(`Downloading ${textJobs.length} session file(s) listed in the report…`);
    const texts = [];
    await Promise.all(textJobs.map(async job => {
      try {
        const res = await fetch(job.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.text();
        texts.push(Object.assign({name: job.name, size: body.length, text: async () => body}, job.ids));
      } catch (err) {
        log.push(fetchFailure(job.name, err));
      }
    }));
    if (!bins.length) log.push('The report lists no .mmwave.bin, so no radar scores were filled.');
    const result = await reviewFromFiles(texts.concat(bins), onProgress, {requireBin: false, videos: videos, log: log});
    result.radar.forEach(room => {
      if (room.status === 'error' && /TypeError|Failed to fetch|NetworkError/i.test(room.error || '')) {
        room.error += ' — if the link works when opened directly, the blob storage account needs CORS enabled for this site.';
      }
    });
    return result;
  }

  // A daily inspection report lists every session collected that day.
  // A row's session is its session_id column, or else the session UUID in
  // its blob path / URL (…/<session-uuid>/phases/P02_scenarioRunner/raw/…).
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  function rowSession(row) {
    const direct = firstValue(row, ['session_id', 'sessionid', 'session']);
    if (direct) return direct;
    for (const key of ['blob_path', 'url', 'file_url', 'sas_url', 'blob_url', 'video_preview_url', 'filename', 'file_name', 'blob_name']) {
      const m = UUID_RE.exec(row[key] || '');
      if (m) return m[0].toLowerCase();
    }
    return '';
  }

  // Groups a report's rows by session. Returns [{sessionId, rows, rooms,
  // bins}] in report order; rows with no session go to sessionId ''.
  function reportSessions(text, reportName) {
    const rows = reportRows(text, reportName);
    const groups = new Map();
    rows.forEach(row => {
      const id = rowSession(row);
      if (!groups.has(id)) groups.set(id, {sessionId: id, rows: [], rooms: new Set(), bins: 0});
      const g = groups.get(id);
      g.rows.push(row);
      const url = rowUrl(row);
      const name = rowName(row, url);
      const scen = (firstValue(row, ['scenario_id', 'scenario', 'room', 'room_id', 'step_id']) || scenarioIdFromName(name)).toUpperCase();
      if (/^T1-R\d+$/.test(scen)) g.rooms.add(scen);
      if (/\.bin$/i.test(name)) g.bins += 1;
    });
    // Rows without a session id (e.g. a shared file) belong to every session.
    const shared = groups.get('');
    const list = Array.from(groups.values()).filter(g => g.sessionId);
    if (shared && list.length) list.forEach(g => { g.rows = g.rows.concat(shared.rows); });
    else if (shared) list.push(shared);
    return list.map(g => ({sessionId: g.sessionId, rows: g.rows, rooms: Array.from(g.rooms).sort(), bins: g.bins}));
  }

  return {scoreBinFile, reviewFromFiles, reviewFromReport, reportSessions, parseCsv, fft};
});
