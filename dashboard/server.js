// MAO Data Control Panel — local-only Node server.
//
// Launches a small HTTP server on http://localhost:5174 that exposes:
//   - a one-page dashboard (dashboard/public/)
//   - status + control endpoints under /api/
//   - a live Server-Sent Events feed for in-progress runs
//
// Zero npm deps — Node built-ins only. Run with:
//   node dashboard/server.js   (or use start-dashboard.bat)
//
// Halts on Ctrl-C; safe to leave running while you work.
//
// Expected layout (rooted at the WebSearch repo):
//   ./dashboard/server.js                  ← this file
//   ./dashboard/public/                    ← static UI
//   ./r/build_legal_index.R                ← shard builders
//   ./r/build_assessment_index.R
//   ./web/scripts/build-manifest.js
//   ./web/public/data/manifest.json        ← read for shard-age info
//   ../mao-scrape/                         ← sibling project (the scrape)
//   ../mao-scrape/run_full.bat
//   ../mao-scrape/run_delta.bat
//   ../mao-scrape/logs/run-*.log
//   ../mao-scrape/logs/delta-*.log

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';

const HERE        = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT    = path.resolve(HERE, '..');                 // WebSearch repo root
const SCRAPE_ROOT = path.resolve(WEB_ROOT, '..', 'mao-scrape');
const PUBLIC_DIR  = path.join(HERE, 'public');
const MANIFEST    = path.join(WEB_ROOT, 'web', 'public', 'data', 'manifest.json');
const PORT        = Number(process.env.DASHBOARD_PORT || 5174);

// --------------------------------------------------------------- run state
//
// Only one run is active at a time. Live progress lines accumulate in
// `currentRun.log` and broadcast over SSE as they arrive.

let currentRun = null;       // { type, label, startedAt, child, log, exitCode }
const sseClients = new Set();

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { /* ignore broken pipes */ }
  }
}

function appendLog(line) {
  if (!currentRun) return;
  currentRun.log.push(line);
  if (currentRun.log.length > 5000) currentRun.log.splice(0, currentRun.log.length - 5000);
  broadcast({ type: 'log', line });
}

// --------------------------------------------------------------- helpers

function gitFn(args, opts = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: WEB_ROOT, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout?.toString() || '', stderr: stderr?.toString() || '' });
    });
  });
}

async function gatherGitStatus() {
  const { stdout: porcelain } = await gitFn(['status', '--porcelain']);
  const dirty = porcelain.split(/\r?\n/).filter(Boolean);
  // Files that aren't under web/public/data/ — "stuff that isn't the data refresh".
  const dirtyNonData = dirty.filter((line) => !/^.\s+web\/public\/data\//.test(line));
  const dirtyData    = dirty.filter((line) =>  /^.\s+web\/public\/data\//.test(line));
  // ahead/behind — uses local refs (no auto-fetch).
  const { stdout: branch } = await gitFn(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branchName = branch.trim();
  let ahead = 0;
  let behind = 0;
  const cmp = await gitFn(['rev-list', '--left-right', '--count', `origin/main...${branchName}`]);
  if (cmp.code === 0 && cmp.stdout.trim()) {
    const [b, a] = cmp.stdout.trim().split(/\s+/).map((n) => Number(n) || 0);
    behind = b; ahead = a;
  }
  return { branch: branchName, dirty: dirty.length, dirtyData: dirtyData.length, dirtyNonData, ahead, behind };
}

function safeReadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

// Walk the scrape's logs directory for the most recent matching file.
// Returns { name, mtimeISO } or null.
function newestLog(prefix) {
  const dir = path.join(SCRAPE_ROOT, 'logs');
  if (!fs.existsSync(dir)) return null;
  let best = null;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (!best || stat.mtimeMs > best.mtimeMs) best = { name, mtimeMs: stat.mtimeMs, full };
  }
  return best ? { name: best.name, mtimeISO: new Date(best.mtimeMs).toISOString() } : null;
}

function activeRunSnapshot() {
  if (!currentRun) return null;
  return {
    type: currentRun.type,
    label: currentRun.label,
    startedAt: currentRun.startedAt,
    pid: currentRun.child?.pid ?? null,
    exitCode: currentRun.exitCode ?? null,
    isFinished: currentRun.exitCode != null,
    logTail: currentRun.log.slice(-200),
  };
}

async function gatherStatus() {
  const manifest = safeReadJSON(MANIFEST);
  const legal = manifest?.datasets?.legal_index || null;
  const asmt  = manifest?.datasets?.assessment_index || null;
  return {
    now: new Date().toISOString(),
    lastFullLog: newestLog('run-'),
    lastDeltaLog: newestLog('delta-'),
    lastShardBuild: {
      legal: legal?.generated_at || null,
      legalSource: legal?.source_modified || null,
      legalRows: legal?.row_count || null,
      asmt: asmt?.generated_at || null,
      asmtSource: asmt?.source_modified || null,
      asmtRows: asmt?.row_count || null,
    },
    git: await gatherGitStatus(),
    activeRun: activeRunSnapshot(),
  };
}

// --------------------------------------------------------------- spawner

function spawnStep(step) {
  // step = { label, command, args, cwd }
  return new Promise((resolve) => {
    appendLog(`\n--- ${step.label} ---`);
    appendLog(`> ${step.command} ${step.args.join(' ')}  (cwd: ${path.relative(WEB_ROOT, step.cwd)})`);
    const child = spawn(step.command, step.args, {
      cwd: step.cwd,
      shell: true,        // lets us spawn .bat files on Windows
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

async function runChain(type, label, steps) {
  if (currentRun && currentRun.exitCode == null) {
    return { ok: false, reason: 'A run is already in progress.' };
  }
  currentRun = { type, label, startedAt: new Date().toISOString(), child: null, log: [], exitCode: null };
  broadcast({ type: 'run-start', run: { type, label, startedAt: currentRun.startedAt } });
  appendLog(`=== ${label} started at ${currentRun.startedAt}`);
  for (const step of steps) {
    const code = await spawnStep(step);
    if (code !== 0) {
      currentRun.exitCode = code;
      appendLog(`=== ${label} ABORTED at step "${step.label}" (exit code ${code})`);
      broadcast({ type: 'run-end', run: { type, label, exitCode: code, finishedAt: new Date().toISOString() } });
      return { ok: false };
    }
  }
  currentRun.exitCode = 0;
  appendLog(`=== ${label} completed successfully`);
  broadcast({ type: 'run-end', run: { type, label, exitCode: 0, finishedAt: new Date().toISOString() } });
  return { ok: true };
}

// --------------------------------------------------------------- run chains

const Rscript = `"C:\\Program Files\\R\\R-4.5.3\\bin\\Rscript.exe"`;

function chainFull() {
  return runChain('full', 'Full scrape + rebuild', [
    { label: '1/4 mao-scrape full', cwd: SCRAPE_ROOT, command: 'cmd.exe', args: ['/c', 'run_full.bat'] },
    { label: '2/4 build_legal_index.R', cwd: WEB_ROOT, command: Rscript, args: ['r\\build_legal_index.R'] },
    { label: '3/4 build_assessment_index.R', cwd: WEB_ROOT, command: Rscript, args: ['r\\build_assessment_index.R'] },
    { label: '4/4 build-manifest.js', cwd: WEB_ROOT, command: 'node', args: ['web\\scripts\\build-manifest.js'] },
  ]);
}

function chainDelta() {
  return runChain('delta', 'Delta scrape + rebuild', [
    { label: '1/4 mao-scrape delta', cwd: SCRAPE_ROOT, command: 'cmd.exe', args: ['/c', 'run_delta.bat'] },
    { label: '2/4 build_legal_index.R', cwd: WEB_ROOT, command: Rscript, args: ['r\\build_legal_index.R'] },
    { label: '3/4 build_assessment_index.R', cwd: WEB_ROOT, command: Rscript, args: ['r\\build_assessment_index.R'] },
    { label: '4/4 build-manifest.js', cwd: WEB_ROOT, command: 'node', args: ['web\\scripts\\build-manifest.js'] },
  ]);
}

async function chainPush() {
  // Tight push: refuse if anything outside web/public/data/ is dirty.
  const status = await gatherGitStatus();
  if (status.dirtyNonData.length > 0) {
    return {
      ok: false,
      reason: `Working tree has ${status.dirtyNonData.length} change(s) outside web/public/data/. Commit or stash those before pushing the data refresh.`,
      dirtyNonData: status.dirtyNonData,
    };
  }
  if (status.dirtyData === 0 && status.ahead === 0) {
    return { ok: false, reason: 'Nothing to push — no data shards changed and you are not ahead of origin/main.' };
  }
  const today = new Date().toISOString().slice(0, 10);
  return runChain('push', 'Push data refresh to GitHub', [
    { label: 'git add web/public/data', cwd: WEB_ROOT, command: 'git', args: ['add', 'web/public/data/'] },
    { label: 'git commit', cwd: WEB_ROOT, command: 'git', args: ['commit', '-m', `Data refresh — ${today}`, '--allow-empty'] },
    { label: 'git push origin main', cwd: WEB_ROOT, command: 'git', args: ['push', 'origin', 'main'] },
  ]);
}

// --------------------------------------------------------------- HTTP server

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const safe = path.normalize(urlPath).replace(/^[/\\]+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  try { return JSON.parse(raw); } catch { return {}; }
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
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    if (currentRun) {
      res.write(`data: ${JSON.stringify({ type: 'run-snapshot', run: activeRunSnapshot() })}\n\n`);
    }
    sseClients.add(res);
    const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 15000);
    req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
    return;
  }
  if (pathname === '/api/run/full' && req.method === 'POST') {
    chainFull().catch((e) => appendLog(`*** chainFull threw: ${e.message}`));
    return jsonRes(res, 202, { ok: true });
  }
  if (pathname === '/api/run/delta' && req.method === 'POST') {
    chainDelta().catch((e) => appendLog(`*** chainDelta threw: ${e.message}`));
    return jsonRes(res, 202, { ok: true });
  }
  if (pathname === '/api/push' && req.method === 'POST') {
    const result = await chainPush();
    if (!result.ok) return jsonRes(res, 409, result);
    return jsonRes(res, 202, { ok: true });
  }
  if (pathname === '/api/cancel' && req.method === 'POST') {
    if (!currentRun || currentRun.exitCode != null) return jsonRes(res, 200, { ok: false, reason: 'No active run' });
    try { currentRun.child?.kill(); appendLog('--- cancel requested by user ---'); } catch {}
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
    res.writeHead(500); res.end(`Internal error: ${err.message}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`MAO Data Control Panel → http://localhost:${PORT}`);
  console.log(`  WebSearch root: ${WEB_ROOT}`);
  console.log(`  mao-scrape:     ${SCRAPE_ROOT}`);
  console.log('Ctrl-C to stop.');
});
