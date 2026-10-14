#!/usr/bin/env node
/* Compare the in-browser radar reader with extract_mmwave_diagnostics.py. */
const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');
const radar = require('../radar_score.js');

function openFile(filePath) {
  const size = fs.statSync(filePath).size;
  const fd = fs.openSync(filePath, 'r');
  return {
    name: path.basename(filePath),
    size,
    slice(start, end) {
      return {
        async arrayBuffer() {
          const len = end - start;
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, start);
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + len);
        },
      };
    },
  };
}

function fftSelfCheck() {
  const re = [1, 0, 0, 0];
  const im = [0, 0, 0, 0];
  radar.fft(re, im);
  const ok = re.every((v, i) => Math.abs(v - 1) < 1e-9) && im.every(v => Math.abs(v) < 1e-9);
  if (!ok) {
    console.error('fft self-check failed', re, im);
    process.exit(1);
  }
}

async function main() {
  fftSelfCheck();
  const dir = process.argv[2] || '/tmp/review-fixture';
  const binPath = path.join(dir, 'P02_scenarioRunner_c004.mmwave.bin');
  const markers = fs.readFileSync(path.join(dir, 'P02_scenarioRunner_c004.episode_markers.jsonl'), 'utf8');
  const sync = fs.readFileSync(path.join(dir, 'P02_scenarioRunner_c004.mmwave_sync.json'), 'utf8');
  const out = path.join(dir, 'c004.browser-check.csv');
  const py = spawnSync('python3', [
    path.join(__dirname, 'extract_mmwave_diagnostics.py'),
    binPath, '--out', out,
    '--episodes', path.join(dir, 'P02_scenarioRunner_c004.episode_markers.jsonl'),
    '--sync-json', path.join(dir, 'P02_scenarioRunner_c004.mmwave_sync.json'),
  ], {encoding: 'utf8'});
  if (py.status !== 0) {
    console.error(py.stdout, py.stderr);
    process.exit(1);
  }
  const pyEpisodes = JSON.parse(fs.readFileSync(out.replace(/\.csv$/, '.episodes.json'), 'utf8')).episodes;
  const js = await radar.scoreBinFile(openFile(binPath), {markersText: markers, syncText: sync});
  const fields = ['blue', 'orange', 'continuous_movement_pct', 'speed_variance_mps', 'distance_variance_m', 'pct_tracked'];
  pyEpisodes.forEach((ep, i) => {
    const got = js.episodes[i];
    const pyBlue = ep.zone_pct_of_tracked_frames.blue;
    const jsBlue = got.zone_pct_of_tracked_frames.blue;
    console.log(`episode ${ep.episode_number} python blue=${pyBlue} tracked=${ep.pct_tracked} move=${ep.continuous_movement_pct} js blue=${jsBlue} tracked=${got.pct_tracked} move=${got.continuous_movement_pct}`);
    fields.forEach(field => {
      const pv = field === 'blue' || field === 'orange' ? ep.zone_pct_of_tracked_frames[field] : ep[field];
      const jv = field === 'blue' || field === 'orange' ? got.zone_pct_of_tracked_frames[field] : got[field];
      if (pv !== jv) {
        console.error(`mismatch ${field}: python ${pv} js ${jv}`);
        process.exit(1);
      }
    });
  });
  const pyPositions = JSON.parse(fs.readFileSync(out.replace(/\.csv$/, '.summary.json'), 'utf8')).device_placements;
  const jsPositions = js.summary.device_placements;
  console.log('positions', pyPositions && pyPositions.estimated_distinct_positions, jsPositions && jsPositions.estimated_distinct_positions);
  if ((pyPositions && pyPositions.estimated_distinct_positions) !== (jsPositions && jsPositions.estimated_distinct_positions)) {
    console.error('device placements mismatch');
    process.exit(1);
  }
  console.log('browser radar reader matches the Python script');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
