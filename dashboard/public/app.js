const $ = (id) => document.getElementById(id);

const els = {
  now: $('now'),
  pill: $('active-pill'),
  roots: $('roots'),
  git: $('git-status'),
  items: $('items'),
  log: $('log'),
  autoscroll: $('autoscroll'),
  cancel: $('btn-cancel'),
  clear: $('btn-clear'),
  refresh: $('btn-refresh'),
};

let statusCache = null;
let running = false;

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatDate(iso) {
  if (!iso) return 'Missing';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Missing';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatAge(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'never';
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(ms / 3600000);
  if (hours >= 1) return `${hours}h ago`;
  const mins = Math.floor(ms / 60000);
  return `${mins}m ago`;
}

function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderRoots(roots) {
  const rows = [
    ['Winnipeg', roots?.winnipeg],
    ['Manitoba', roots?.manitoba],
    ['MAO scrape', roots?.maoScrape],
  ];
  els.roots.innerHTML = rows.map(([label, value]) => `
    <div class="root-row">
      <span>${label}</span>
      <code>${escapeHtml(value || 'not found')}</code>
    </div>
  `).join('');
}

function renderGit(git) {
  const one = (label, g) => {
    if (!g?.available) return `<div class="git-card"><strong>${label}</strong><span class="muted">No git repo detected</span></div>`;
    const state = g.dirty ? `${g.dirty} dirty` : 'clean';
    const extra = [
      g.ahead ? `${g.ahead} ahead` : '',
      g.behind ? `${g.behind} behind` : '',
    ].filter(Boolean).join(' · ');
    return `
      <div class="git-card">
        <strong>${label}</strong>
        <span>branch <code>${escapeHtml(g.branch)}</code></span>
        <span class="pill ${g.dirty ? 'due' : 'fresh'}">${state}</span>
        ${extra ? `<span class="muted">${extra}</span>` : ''}
      </div>
    `;
  };
  els.git.innerHTML = one('Winnipeg Git', git?.winnipeg) + one('Manitoba Git', git?.manitoba);
}

function renderItem(item, jobs) {
  const fresh = item.freshness || {};
  const outputs = (item.outputs || []).map((out) => `
    <li class="${out.exists ? '' : 'missing'}">
      <code>${escapeHtml(out.path)}</code>
      <span>${out.exists ? `${formatDate(out.mtime)} · ${formatSize(out.sizeBytes)}` : 'missing'}</span>
    </li>
  `).join('');
  const actions = (item.actions || []).map((id) => {
    const job = jobs?.[id];
    if (!job) return '';
    return `<button class="primary job-button" type="button" data-job="${id}">${escapeHtml(job.label)}</button>`;
  }).join('');
  const age = item.lastDone ? `${formatAge(item.lastDone)}` : 'never';

  return `
    <article class="item-card">
      <div class="item-top">
        <div>
          <span class="project">${escapeHtml(item.project)}</span>
          <h3>${escapeHtml(item.title)}</h3>
        </div>
        <span class="pill ${fresh.state || 'missing'}">${escapeHtml(fresh.label || 'missing')}</span>
      </div>
      <dl class="meta">
        <div><dt>Cadence</dt><dd>${escapeHtml(item.cadenceLabel || 'Manual')}</dd></div>
        <div><dt>Last done</dt><dd>${formatDate(item.lastDone)} <span>${age}</span></dd></div>
      </dl>
      ${item.note ? `<p class="note">${escapeHtml(item.note)}</p>` : ''}
      <ul class="outputs">${outputs}</ul>
      <div class="actions">${actions}</div>
    </article>
  `;
}

function renderStatus(status) {
  statusCache = status;
  renderRoots(status.roots);
  renderGit(status.git);
  els.items.innerHTML = (status.items || []).map((item) => renderItem(item, status.jobs)).join('');
  els.items.querySelectorAll('[data-job]').forEach((btn) => {
    btn.addEventListener('click', () => runJob(btn.dataset.job));
  });
  setRunning(!!status.activeRun && !status.activeRun.isFinished, status.activeRun);
  if (status.activeRun?.logTail?.length && !els.log.textContent) {
    els.log.textContent = status.activeRun.logTail.join('\n');
    scrollLog();
  }
}

function setRunning(isRunning, run) {
  running = isRunning;
  document.querySelectorAll('.job-button').forEach((btn) => { btn.disabled = isRunning; });
  els.cancel.disabled = !isRunning;
  if (isRunning) {
    els.pill.className = 'active-pill running';
    els.pill.textContent = `${run?.label || 'running'}...`;
  } else if (run?.exitCode === 0) {
    els.pill.className = 'active-pill success';
    els.pill.textContent = 'last run completed';
  } else if (run?.exitCode != null) {
    els.pill.className = 'active-pill failed';
    els.pill.textContent = `last run failed (${run.exitCode})`;
  } else {
    els.pill.className = 'active-pill';
    els.pill.textContent = 'idle';
  }
}

async function fetchStatus() {
  const res = await fetch('/api/status', { cache: 'no-store' });
  if (!res.ok) throw new Error(`status ${res.status}`);
  renderStatus(await res.json());
}

async function runJob(id) {
  if (running) return;
  const job = statusCache?.jobs?.[id];
  const msg = job?.confirm || `Run ${job?.label || id}?`;
  if (!confirm(msg)) return;
  els.log.textContent = '';
  const res = await fetch(`/api/run/${id}`, { method: 'POST' });
  if (!res.ok && res.status !== 202) {
    const body = await res.json().catch(() => ({}));
    alert(body.reason || `Server returned ${res.status}`);
  }
  await fetchStatus();
}

function appendLog(line) {
  els.log.textContent += (els.log.textContent ? '\n' : '') + line;
  scrollLog();
}

function scrollLog() {
  if (els.autoscroll.checked) els.log.scrollTop = els.log.scrollHeight;
}

function openStream() {
  const source = new EventSource('/api/stream');
  source.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'log') appendLog(msg.line);
    if (msg.type === 'run-start') {
      els.log.textContent = '';
      setRunning(true, msg.run);
    }
    if (msg.type === 'run-end') {
      setRunning(false, msg.run);
      fetchStatus().catch(() => {});
    }
    if (msg.type === 'run-snapshot' && msg.run) {
      setRunning(!msg.run.isFinished, msg.run);
      if (msg.run.logTail?.length) {
        els.log.textContent = msg.run.logTail.join('\n');
        scrollLog();
      }
    }
  };
}

els.refresh.addEventListener('click', () => fetchStatus().catch((err) => alert(err.message)));
els.clear.addEventListener('click', () => { els.log.textContent = ''; });
els.cancel.addEventListener('click', () => {
  if (!running || !confirm('Cancel the active run?')) return;
  fetch('/api/cancel', { method: 'POST' }).catch(() => {});
});

function tick() {
  const d = new Date();
  els.now.textContent = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

tick();
setInterval(tick, 1000);
setInterval(() => fetchStatus().catch(() => {}), 60000);
fetchStatus().catch((err) => {
  els.items.innerHTML = `<article class="item-card"><h3>Could not load status</h3><p class="note">${escapeHtml(err.message)}</p></article>`;
});
openStream();
