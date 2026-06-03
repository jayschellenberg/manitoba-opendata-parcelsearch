// Data Refresh Control Panel - local-only Node server.
//
// Serves a small dashboard at http://127.0.0.1:5180 that shows freshness
// for the Winnipeg and Manitoba data artifacts and runs controlled refresh
// chains. No npm dependencies; all process execution is limited to the
// job definitions in this file.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MB_ROOT = path.resolve(HERE, '..');
const CLAUDE_ROOT = path.resolve(MB_ROOT, '..', '..');
const WPG_ROOT = process.env.WPG_ROOT
  ? path.resolve(process.env.WPG_ROOT)
  : path.join(CLAUDE_ROOT, 'WpgOpenData', 'ParcelSearch');
const SCRAPE_ROOT = process.env.MAO_SCRAPE_ROOT
  ? path.resolve(process.env.MAO_SCRAPE_ROOT)
  : path.resolve(MB_ROOT, '..', 'mao-scrape');

const PUBLIC_DIR = path.join(HERE, 'public');
const LOG_DIR = path.join(HERE, 'logs');
const PORT = Number(process.env.DASHBOARD_PORT || 5180);

const R_DEFAULT = 'C:\\Program Files\\R\\R-4.5.3\\bin\\Rscript.exe';
const RSCRIPT = process.env.RSCRIPT || (fs.existsSync(R_DEFAULT) ? R_DEFAULT : 'Rscript');

const sseClients = new Set();
let currentRun = null;

function quote(value) {
  return /[\s"&]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function r(script) {
  return `${quote(RSCRIPT)} ${script}`;
}

function cmdStep(label, cwd, cmd) {
  return { label, cwd, cmd };
}

function npmStep(label, cwd, args) {
  return cmdStep(label, cwd, `npm ${args}`);
}

function gitFn(root, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        code: err ? (err.code ?? 1) : 0,
        stdout: stdout?.toString() || '',
        stderr: stderr?.toString() || '',
      });
    });
  });
}

async function gitStatus(root) {
  if (!fs.existsSync(path.join(root, '.git'))) return { available: false };
  const branch = await gitFn(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = await gitFn(root, ['status', '--porcelain']);
  let ahead = 0;
  let behind = 0;
  const branchName = branch.stdout.trim() || 'unknown';
  const cmp = await gitFn(root, ['rev-list', '--left-right', '--count', `origin/main...${branchName}`]);
  if (cmp.code === 0 && cmp.stdout.trim()) {
    const [b, a] = cmp.stdout.trim().split(/\s+/).map((n) => Number(n) || 0);
    behind = b;
    ahead = a;
  }
  const dirty = status.stdout.split(/\r?\n/).filter(Boolean);
  return { available: true, branch: branchName, dirty: dirty.length, ahead, behind };
}

function statFile(root, rel) {
  const full = path.join(root, rel);
  try {
    const st = fs.statSync(full);
    return {
      path: rel.replace(/\\/g, '/'),
      exists: true,
      mtime: st.mtime.toISOString(),
      sizeBytes: st.size,
    };
  } catch {
    return { path: rel.replace(/\\/g, '/'), exists: false, mtime: null, sizeBytes: null };
  }
}

function newestFile(root, regex) {
  let best = null;
  try {
    for (const name of fs.readdirSync(root)) {
      if (!regex.test(name)) continue;
      const info = statFile(root, name);
      if (info.exists && (!best || new Date(info.mtime) > new Date(best.mtime))) best = info;
    }
  } catch {
    return null;
  }
  return best;
}

function safeJson(root, rel) {
  try { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); }
  catch { return null; }
}

function minIso(values) {
  const dates = values.filter(Boolean).map((v) => new Date(v)).filter((d) => !Number.isNaN(d.getTime()));
  if (!dates.length) return null;
  return new Date(Math.min(...dates.map((d) => d.getTime()))).toISOString();
}

function maxIso(values) {
  const dates = values.filter(Boolean).map((v) => new Date(v)).filter((d) => !Number.isNaN(d.getTime()));
  if (!dates.length) return null;
  return new Date(Math.max(...dates.map((d) => d.getTime()))).toISOString();
}

function freshness(lastDone, cadenceDays) {
  if (!lastDone) return { state: 'missing', ageDays: null, label: 'missing' };
  if (!cadenceDays) return { state: 'manual', ageDays: null, label: 'manual' };
  const ageDays = Math.floor((Date.now() - new Date(lastDone).getTime()) / 86400000);
  if (ageDays > cadenceDays * 1.25) return { state: 'stale', ageDays, label: 'stale' };
  if (ageDays > cadenceDays) return { state: 'due', ageDays, label: 'due' };
  return { state: 'fresh', ageDays, label: 'fresh' };
}

function item({ id, project, title, cadenceDays, cadenceLabel, lastDone, outputs, actions, note }) {
  return {
    id,
    project,
    title,
    cadenceDays,
    cadenceLabel,
    lastDone,
    freshness: freshness(lastDone, cadenceDays),
    outputs,
    actions,
    note,
  };
}

function gatherWinnipegItems() {
  const survey = newestFile(WPG_ROOT, /^SurveyParcels_\d{8}\.gpkg$/);
  const assess = newestFile(WPG_ROOT, /^AssessmentParcels_\d{8}\.gpkg$/);
  const xref = newestFile(WPG_ROOT, /^ParcelCrossRef_\d{8}\.csv$/);
  const pmtiles = statFile(WPG_ROOT, 'web/public/parcels.pmtiles');
  const parcelsGeojson = statFile(WPG_ROOT, 'web/public/parcels.geojson');
  const parcelsCentroids = statFile(WPG_ROOT, 'web/public/parcels-centroids.geojson');

  const transitRoutes = statFile(WPG_ROOT, 'web/public/transit-routes.geojson');
  const transitStops = statFile(WPG_ROOT, 'web/public/transit-stops.geojson');
  const hoods = statFile(WPG_ROOT, 'web/public/wpg-neighbourhoods.geojson');
  const hoodClusters = statFile(WPG_ROOT, 'web/public/wpg-neighbourhood-clusters.geojson');

  return [
    item({
      id: 'wpg-quarterly',
      project: 'Winnipeg',
      title: 'Assessment + survey parcels and all-parcels tiles',
      cadenceDays: 90,
      cadenceLabel: 'Quarterly',
      lastDone: minIso([survey?.mtime, assess?.mtime, xref?.mtime, pmtiles.mtime]),
      outputs: [survey, assess, xref, pmtiles, parcelsGeojson, parcelsCentroids].filter(Boolean),
      actions: ['wpg-quarterly'],
      note: 'Downloads dated GPKGs, builds the survey/assessment cross-reference, exports GeoJSON, then builds parcels.pmtiles with Docker/tippecanoe.',
    }),
    item({
      id: 'wpg-transit',
      project: 'Winnipeg',
      title: 'Transit routes and stops',
      cadenceDays: 90,
      cadenceLabel: 'Quarterly',
      lastDone: minIso([transitRoutes.mtime, transitStops.mtime]),
      outputs: [transitRoutes, transitStops],
      actions: ['wpg-transit'],
      note: 'Refreshes the static Winnipeg Transit GTFS overlay files.',
    }),
    item({
      id: 'wpg-neighbourhoods',
      project: 'Winnipeg',
      title: 'Neighbourhood boundaries',
      cadenceDays: null,
      cadenceLabel: 'Manual / rare',
      lastDone: minIso([hoods.mtime, hoodClusters.mtime]),
      outputs: [hoods, hoodClusters],
      actions: ['wpg-neighbourhoods'],
      note: 'Re-run only when the source neighbourhood/cluster boundaries change.',
    }),
  ];
}

function gatherManitobaItems() {
  const roll = newestFile(MB_ROOT, /^RollEntry_\d{8}\.gpkg$/);
  const zoning = newestFile(MB_ROOT, /^ManitobaZoning_\d{8}\.gpkg$/);
  const devPlan = newestFile(MB_ROOT, /^ManitobaDevPlan_\d{8}\.gpkg$/);

  const manifest = safeJson(MB_ROOT, 'web/public/data/manifest.json');
  const legal = manifest?.datasets?.legal_index || null;
  const asmt = manifest?.datasets?.assessment_index || null;
  const asmtShards = manifest?.datasets?.assessment_shards || null;

  const mascIndex = statFile(MB_ROOT, 'web/public/data/masc/_index.json');
  const parcelMascIndex = statFile(MB_ROOT, 'web/public/data/parcel-masc/_index.json');
  const mascRiverlots = statFile(MB_ROOT, 'web/public/data/masc-riverlots.json');
  const mascSource = statFile(MB_ROOT, 'masc_soil_ratings_with_latlon.csv');
  const riverKmz = statFile(MB_ROOT, 'MB-RIVER-LOTS.kmz');

  const sectionGrid = statFile(MB_ROOT, 'web/public/data/section-grid.json');
  const riverLots = statFile(MB_ROOT, 'web/public/data/river-lots.json');

  return [
    item({
      id: 'mb-quarterly',
      project: 'Manitoba',
      title: 'Roll Entry, zoning, and development plan snapshots',
      cadenceDays: 90,
      cadenceLabel: 'Quarterly',
      lastDone: minIso([roll?.mtime, zoning?.mtime, devPlan?.mtime]),
      outputs: [roll, zoning, devPlan].filter(Boolean),
      actions: ['mb-quarterly'],
      note: 'Local archive/offline snapshots. The public web app still queries these layers live.',
    }),
    item({
      id: 'mao-refresh',
      project: 'Manitoba',
      title: 'MAO legal and assessment data',
      cadenceDays: 180,
      cadenceLabel: 'Semiannual',
      lastDone: minIso([legal?.generated_at, asmt?.generated_at, asmtShards?.generated_at]),
      outputs: [
        statFile(MB_ROOT, 'web/public/data/legal-index.json'),
        statFile(MB_ROOT, 'web/public/data/assessment-index.json'),
        statFile(MB_ROOT, 'web/public/data/assessment/_index.json'),
        statFile(MB_ROOT, 'web/public/data/manifest.json'),
      ],
      actions: ['mao-full', 'mao-delta'],
      note: `Manifest rows: legal ${legal?.row_count?.toLocaleString?.() || 'unknown'}, assessment ${asmt?.row_count?.toLocaleString?.() || 'unknown'}.`,
    }),
    item({
      id: 'mb-masc',
      project: 'Manitoba',
      title: 'MASC and soil artifacts',
      cadenceDays: 365,
      cadenceLabel: 'Annual',
      lastDone: minIso([mascIndex.mtime, parcelMascIndex.mtime, mascRiverlots.mtime]),
      outputs: [mascSource, riverKmz, mascIndex, parcelMascIndex, mascRiverlots],
      actions: ['mb-masc'],
      note: 'Run after a new MASC CSV, river-lot source, or Roll Entry snapshot.',
    }),
    item({
      id: 'mb-reference',
      project: 'Manitoba',
      title: 'Section grid and river-lot reference files',
      cadenceDays: null,
      cadenceLabel: 'Manual / rare',
      lastDone: minIso([sectionGrid.mtime, riverLots.mtime]),
      outputs: [sectionGrid, riverLots],
      actions: ['mb-reference'],
      note: 'Stable reference overlays; refresh only when the source boundaries change.',
    }),
  ];
}

function dockerVolumePath(root) {
  return root.replace(/\\/g, '/');
}

const JOBS = {
  'wpg-quarterly': {
    label: 'Winnipeg quarterly parcel refresh',
    project: 'Winnipeg',
    confirm: 'This downloads Winnipeg parcels and rebuilds parcels.pmtiles. It can take a while and requires Docker for the tile step.',
    steps: [
      cmdStep('Download Winnipeg survey + assessment GPKGs', WPG_ROOT, r('r\\download_parcels.R')),
      cmdStep('Build Winnipeg survey/assessment cross-reference', WPG_ROOT, r('r\\cross_reference_parcels.R')),
      cmdStep('Export all-parcels GeoJSON for PMTiles', WPG_ROOT, r('r\\build_parcel_tiles.R')),
      cmdStep('Build/refresh felt-tippecanoe Docker image', WPG_ROOT, 'docker build -f Dockerfile.tippecanoe -t felt-tippecanoe:latest .'),
      cmdStep('Build Winnipeg parcels.pmtiles', WPG_ROOT, [
        'docker run --rm',
        `-v ${quote(`${dockerVolumePath(WPG_ROOT)}:/data`)}`,
        'felt-tippecanoe',
        '-o /data/web/public/parcels.pmtiles',
        '-L parcels:/data/web/public/parcels.geojson',
        '-L parcels-labels:/data/web/public/parcels-centroids.geojson',
        '--maximum-zoom=18 --minimum-zoom=13',
        '--simplification=2 --full-detail=14',
        '--no-feature-limit --no-tile-size-limit --force',
      ].join(' ')),
      npmStep('Winnipeg tests', path.join(WPG_ROOT, 'web'), 'test'),
      npmStep('Winnipeg production build', path.join(WPG_ROOT, 'web'), 'run build -- --emptyOutDir=false'),
    ],
  },
  'wpg-transit': {
    label: 'Winnipeg transit refresh',
    project: 'Winnipeg',
    confirm: 'Refresh Winnipeg Transit GTFS route and stop overlays?',
    steps: [
      npmStep('Refresh Winnipeg Transit GeoJSON', path.join(WPG_ROOT, 'web'), 'run refresh:transit'),
      npmStep('Winnipeg tests', path.join(WPG_ROOT, 'web'), 'test'),
      npmStep('Winnipeg production build', path.join(WPG_ROOT, 'web'), 'run build -- --emptyOutDir=false'),
    ],
  },
  'wpg-neighbourhoods': {
    label: 'Winnipeg neighbourhood refresh',
    project: 'Winnipeg',
    confirm: 'Refresh Winnipeg neighbourhood files from the configured BaseFiles folder?',
    steps: [
      npmStep('Refresh Winnipeg neighbourhood GeoJSON', path.join(WPG_ROOT, 'web'), 'run refresh:neighbourhoods'),
      npmStep('Winnipeg tests', path.join(WPG_ROOT, 'web'), 'test'),
      npmStep('Winnipeg production build', path.join(WPG_ROOT, 'web'), 'run build -- --emptyOutDir=false'),
    ],
  },
  'mb-quarterly': {
    label: 'Manitoba quarterly Open Data snapshots',
    project: 'Manitoba',
    confirm: 'Download Manitoba Roll Entry, zoning, and development plan GPKG snapshots?',
    steps: [
      cmdStep('Download Manitoba Roll Entry + zoning + dev plan GPKGs', MB_ROOT, r('r\\download_parcels.R')),
    ],
  },
  'mao-full': {
    label: 'MAO full scrape + rebuild',
    project: 'Manitoba',
    confirm: 'Run a full MAO scrape? This can take hours.',
    steps: [
      cmdStep('MAO full scrape', SCRAPE_ROOT, 'run_full.bat'),
      cmdStep('Build legal index', MB_ROOT, r('r\\build_legal_index.R')),
      cmdStep('Build assessment index + shards', MB_ROOT, r('r\\build_assessment_index.R')),
      cmdStep('Build Manitoba data manifest', MB_ROOT, 'node web\\scripts\\build-manifest.js'),
      npmStep('Manitoba tests', path.join(MB_ROOT, 'web'), 'test'),
      npmStep('Manitoba production build', path.join(MB_ROOT, 'web'), 'run build'),
    ],
  },
  'mao-delta': {
    label: 'MAO delta scrape + rebuild',
    project: 'Manitoba',
    confirm: 'Run a MAO delta scrape and rebuild legal/assessment artifacts?',
    steps: [
      cmdStep('MAO delta scrape', SCRAPE_ROOT, 'run_delta.bat'),
      cmdStep('Build legal index', MB_ROOT, r('r\\build_legal_index.R')),
      cmdStep('Build assessment index + shards', MB_ROOT, r('r\\build_assessment_index.R')),
      cmdStep('Build Manitoba data manifest', MB_ROOT, 'node web\\scripts\\build-manifest.js'),
      npmStep('Manitoba tests', path.join(MB_ROOT, 'web'), 'test'),
      npmStep('Manitoba production build', path.join(MB_ROOT, 'web'), 'run build'),
    ],
  },
  'mb-masc': {
    label: 'Manitoba MASC/soil refresh',
    project: 'Manitoba',
    confirm: 'Rebuild MASC/soil shards from the current CSV, river-lot inputs, and latest RollEntry snapshot?',
    steps: [
      cmdStep('Build MASC overlay shards', MB_ROOT, r('r\\build_masc_shards.R')),
      cmdStep('Build parcel-level MASC shards + river-lot overlay', MB_ROOT, r('r\\build_parcel_masc.R')),
      cmdStep('Build Manitoba data manifest', MB_ROOT, 'node web\\scripts\\build-manifest.js'),
      npmStep('Manitoba tests', path.join(MB_ROOT, 'web'), 'test'),
      npmStep('Manitoba production build', path.join(MB_ROOT, 'web'), 'run build'),
    ],
  },
  'mb-reference': {
    label: 'Manitoba reference overlay refresh',
    project: 'Manitoba',
    confirm: 'Rebuild section-grid and river-lot reference files?',
    steps: [
      cmdStep('Build section grid', MB_ROOT, r('r\\build_section_grid.R')),
      cmdStep('Build river lots', MB_ROOT, r('r\\build_river_lots.R')),
      cmdStep('Build Manitoba data manifest', MB_ROOT, 'node web\\scripts\\build-manifest.js'),
      npmStep('Manitoba tests', path.join(MB_ROOT, 'web'), 'test'),
      npmStep('Manitoba production build', path.join(MB_ROOT, 'web'), 'run build'),
    ],
  },
};

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { /* ignore */ }
  }
}

function appendLog(line) {
  if (!currentRun) return;
  currentRun.log.push(line);
  if (currentRun.log.length > 5000) currentRun.log.splice(0, currentRun.log.length - 5000);
  if (currentRun.logFile) {
    try { fs.appendFileSync(currentRun.logFile, `${line}\n`); } catch { /* ignore */ }
  }
  broadcast({ type: 'log', line });
}

function activeRunSnapshot() {
  if (!currentRun) return null;
  return {
    id: currentRun.id,
    label: currentRun.label,
    project: currentRun.project,
    startedAt: currentRun.startedAt,
    exitCode: currentRun.exitCode,
    isFinished: currentRun.exitCode != null,
    logFile: currentRun.logFile,
    logTail: currentRun.log.slice(-200),
  };
}

async function gatherStatus() {
  return {
    now: new Date().toISOString(),
    roots: { winnipeg: WPG_ROOT, manitoba: MB_ROOT, maoScrape: SCRAPE_ROOT },
    jobs: Object.fromEntries(Object.entries(JOBS).map(([id, job]) => [
      id,
      { id, label: job.label, project: job.project, confirm: job.confirm },
    ])),
    items: [...gatherWinnipegItems(), ...gatherManitobaItems()],
    git: {
      winnipeg: await gitStatus(WPG_ROOT),
      manitoba: await gitStatus(MB_ROOT),
    },
    activeRun: activeRunSnapshot(),
  };
}

function spawnStep(step) {
  return new Promise((resolve) => {
    appendLog(`\n--- ${step.label} ---`);
    appendLog(`> ${step.cmd}`);
    appendLog(`  cwd: ${step.cwd}`);
    const child = spawn('cmd.exe', ['/c', step.cmd], {
      cwd: step.cwd,
      windowsHide: true,
    });
    currentRun.child = child;
    const ingest = (chunk) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (line.length || text.includes('\n')) appendLog(line);
      }
    };
    child.stdout.on('data', ingest);
    child.stderr.on('data', ingest);
    child.on('close', (code) => {
      appendLog(`--- ${step.label} exited with code ${code} ---`);
      resolve(code ?? 1);
    });
    child.on('error', (err) => {
      appendLog(`*** ${step.label} failed to launch: ${err.message}`);
      resolve(1);
    });
  });
}

async function runJob(id) {
  if (currentRun && currentRun.exitCode == null) {
    return { ok: false, status: 409, reason: 'A run is already in progress.' };
  }
  const job = JOBS[id];
  if (!job) return { ok: false, status: 404, reason: 'Unknown job.' };

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  currentRun = {
    id,
    label: job.label,
    project: job.project,
    startedAt: new Date().toISOString(),
    child: null,
    log: [],
    exitCode: null,
    logFile: path.join(LOG_DIR, `${id}-${ts}.log`),
  };
  broadcast({ type: 'run-start', run: activeRunSnapshot() });
  appendLog(`=== ${job.label} started at ${currentRun.startedAt}`);
  appendLog(`=== log file: ${currentRun.logFile}`);

  for (const step of job.steps) {
    const code = await spawnStep(step);
    if (code !== 0) {
      currentRun.exitCode = code;
      appendLog(`=== ${job.label} ABORTED at step "${step.label}"`);
      broadcast({ type: 'run-end', run: activeRunSnapshot() });
      return { ok: false, status: 500 };
    }
  }

  currentRun.exitCode = 0;
  appendLog(`=== ${job.label} completed successfully`);
  broadcast({ type: 'run-end', run: activeRunSnapshot() });
  return { ok: true, status: 202 };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const safe = path.normalize(urlPath).replace(/^[/\\]+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

function jsonRes(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/status' && req.method === 'GET') {
    return jsonRes(res, 200, await gatherStatus());
  }
  if (pathname === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    if (currentRun) res.write(`data: ${JSON.stringify({ type: 'run-snapshot', run: activeRunSnapshot() })}\n\n`);
    sseClients.add(res);
    const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* ignore */ } }, 15000);
    req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
    return;
  }
  const runMatch = pathname.match(/^\/api\/run\/([a-z0-9-]+)$/);
  if (runMatch && req.method === 'POST') {
    const result = await runJob(runMatch[1]);
    return jsonRes(res, result.status || 202, result);
  }
  if (pathname === '/api/cancel' && req.method === 'POST') {
    if (!currentRun || currentRun.exitCode != null) return jsonRes(res, 200, { ok: false, reason: 'No active run.' });
    try { currentRun.child?.kill(); appendLog('--- cancel requested by user ---'); } catch { /* ignore */ }
    return jsonRes(res, 200, { ok: true });
  }
  return jsonRes(res, 404, { error: 'Unknown endpoint' });
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = req.url.split('?')[0];
    if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
    return serveStatic(req, res);
  } catch (err) {
    res.writeHead(500);
    res.end(`Internal error: ${err.message}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Data Refresh Control Panel -> http://127.0.0.1:${PORT}`);
  console.log(`  Winnipeg:  ${WPG_ROOT}`);
  console.log(`  Manitoba:  ${MB_ROOT}`);
  console.log(`  MAO scrape: ${SCRAPE_ROOT}`);
  console.log('Ctrl-C to stop.');
});
