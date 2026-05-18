// MAO Data Control Panel — client-side glue.
//
// Polls /api/status on load + after every run-end, holds an EventSource
// open against /api/stream for live progress lines, and wires the four
// action buttons (Run Full, Run Delta, Push to Git, Cancel).

const $ = (id) => document.getElementById(id);

const els = {
  now:           $('now'),
  pill:          $('active-pill'),
  full:          $('status-full'),
  delta:         $('status-delta'),
  legal:         $('status-legal'),
  asmt:          $('status-asmt'),
  git:           $('status-git'),
  btnFull:       $('btn-full'),
  btnDelta:      $('btn-delta'),
  btnPush:       $('btn-push'),
  btnCancel:     $('btn-cancel'),
  btnClear:      $('btn-clear'),
  autoscroll:    $('autoscroll'),
  log:           $('log'),
  planCard:      $('plan-card'),
  planSummary:   $('plan-summary'),
  planTbody:     $('plan-tbody'),
  planTotalCfg:  $('plan-total-configured'),
  planTotalMun:  $('plan-total-munis'),
  planTotalPar:  $('plan-total-parcels'),
  planParallel:  $('plan-parallel'),
  planSecs:      $('plan-secs'),
};

let running = false;

// ----- formatting -----------------------------------------------------

function formatAgo(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'never';
  const sec = Math.floor(ms / 1000);
  if (sec < 60)    return `${sec}s ago`;
  if (sec < 3600)  return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function formatStamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function freshnessClass(iso, warnDays, badDays) {
  if (!iso) return 'error';
  const days = (Date.now() - new Date(iso).getTime()) / 86400000;
  if (days >= badDays)  return 'very-stale';
  if (days >= warnDays) return 'stale';
  return 'fresh';
}

function freshnessLabel(iso, warnDays, badDays) {
  if (!iso) return 'never';
  const cls = freshnessClass(iso, warnDays, badDays);
  if (cls === 'fresh')      return 'fresh';
  if (cls === 'stale')      return 'stale';
  return 'very stale';
}

// ----- status render --------------------------------------------------

function renderStatus(s) {
  if (!s) return;

  const fullIso  = s.lastFullLog?.mtimeISO || null;
  const deltaIso = s.lastDeltaLog?.mtimeISO || null;
  const legalIso = s.lastShardBuild?.legal || null;
  const asmtIso  = s.lastShardBuild?.asmt  || null;

  const cell = (iso, warn, bad) => {
    if (!iso) return `never <span class="pill error">never</span>`;
    return `${formatStamp(iso)} <span class="muted">(${formatAgo(iso)})</span> ` +
           `<span class="pill ${freshnessClass(iso, warn, bad)}">${freshnessLabel(iso, warn, bad)}</span>`;
  };

  els.full.innerHTML  = cell(fullIso, 45, 90);
  els.delta.innerHTML = cell(deltaIso, 35, 60);
  els.legal.innerHTML = cell(legalIso, 35, 60) +
    (s.lastShardBuild?.legalRows ? ` <span class="muted">— ${s.lastShardBuild.legalRows.toLocaleString()} rows</span>` : '');
  els.asmt.innerHTML = cell(asmtIso, 35, 60) +
    (s.lastShardBuild?.asmtRows ? ` <span class="muted">— ${s.lastShardBuild.asmtRows.toLocaleString()} rows</span>` : '');

  const g = s.git || {};
  const gitParts = [];
  gitParts.push(`branch <code>${g.branch || '?'}</code>`);
  if (g.dirty === 0) {
    gitParts.push('<span class="pill clean">clean</span>');
  } else {
    gitParts.push(`<span class="pill dirty">${g.dirty} dirty</span>`);
    if (g.dirtyData) gitParts.push(`<span class="muted">${g.dirtyData} in web/public/data/</span>`);
    if (g.dirtyNonData?.length) gitParts.push(`<span class="muted">${g.dirtyNonData.length} elsewhere</span>`);
  }
  if (g.ahead)  gitParts.push(`<span class="muted">${g.ahead} ahead</span>`);
  if (g.behind) gitParts.push(`<span class="muted">${g.behind} behind</span>`);
  els.git.innerHTML = gitParts.join(' · ');

  setRunning(!!s.activeRun && !s.activeRun.isFinished, s.activeRun);
  if (s.activeRun?.logTail?.length && !els.log.textContent) {
    els.log.textContent = s.activeRun.logTail.join('\n');
    scrollLog();
  }

  renderCadencePlan(s.cadencePlan);
}

function renderCadencePlan(plan) {
  if (!plan) { els.planCard.hidden = true; return; }
  els.planCard.hidden = false;

  const monthNames = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];
  const dur = (hours) => hours < 24
    ? `~${hours.toFixed(1)} h`
    : `~${(hours/24).toFixed(1)} d  (~${hours.toFixed(0)} h)`;

  els.planSummary.innerHTML = [
    `<strong>${monthNames[plan.month-1]}</strong> delta will re-scrape `,
    `<strong>${plan.triggerMunis.toLocaleString()}</strong> munis · `,
    `<strong>${plan.triggerParcels.toLocaleString()}</strong> parcels — `,
    `<span class="muted">est. ${dur(plan.estHours)}</span>`
  ].join('');

  const tiers = [
    { key: 'monthly',  label: 'Monthly',  trigger: plan.breakdown.monthly,  all: plan.breakdown.monthlyAll,  note: '' },
    { key: 'sixMonth', label: '6-month',  trigger: plan.breakdown.sixMonth, all: plan.breakdown.sixMonthAll, note: `cohort ${plan.cohortSixNow + 1} of 6` },
    { key: 'annual',   label: 'Annual',   trigger: plan.breakdown.annual,   all: plan.breakdown.annualAll,   note: `cohort ${plan.cohortAnnualNow + 1} of 12` },
  ];

  els.planTbody.innerHTML = tiers.map((t) => `
    <tr>
      <td>
        <span class="plan-tier-badge ${t.key}">${t.label}</span>
        ${t.note ? `<span class="muted">${t.note}</span>` : ''}
      </td>
      <td class="num">${t.all.munis.toLocaleString()} munis · ${t.all.parcels.toLocaleString()} parcels</td>
      <td class="num">${t.trigger.munis.toLocaleString()}</td>
      <td class="num">${t.trigger.parcels.toLocaleString()}</td>
    </tr>
  `).join('');

  const totalAllMunis    = tiers.reduce((a, t) => a + t.all.munis, 0);
  const totalAllParcels  = tiers.reduce((a, t) => a + t.all.parcels, 0);
  els.planTotalCfg.textContent = `${totalAllMunis.toLocaleString()} munis · ${totalAllParcels.toLocaleString()} parcels`;
  els.planTotalMun.textContent = plan.triggerMunis.toLocaleString();
  els.planTotalPar.textContent = plan.triggerParcels.toLocaleString();
  if (els.planParallel) els.planParallel.textContent = plan.parallelN;
  if (els.planSecs)     els.planSecs.textContent     = plan.avgSecondsReq;
}

function setRunning(isRunning, run) {
  running = isRunning;
  els.btnFull.disabled   = isRunning;
  els.btnDelta.disabled  = isRunning;
  els.btnPush.disabled   = isRunning;
  els.btnCancel.disabled = !isRunning;

  if (isRunning) {
    els.pill.className = 'active-pill running';
    els.pill.textContent = (run?.label || 'running') + '…';
  } else if (run?.exitCode === 0) {
    els.pill.className = 'active-pill success';
    els.pill.textContent = (run?.label || 'done') + ' — done';
  } else if (run?.exitCode != null) {
    els.pill.className = 'active-pill failed';
    els.pill.textContent = (run?.label || 'failed') + ` — exit ${run.exitCode}`;
  } else {
    els.pill.className = 'active-pill';
    els.pill.textContent = 'idle';
  }
  els.pill.classList.remove('hidden');
}

// ----- log handling ---------------------------------------------------

function appendLogLine(line) {
  if (els.log.textContent) els.log.textContent += '\n' + line;
  else                     els.log.textContent  = line;
  scrollLog();
}

function scrollLog() {
  if (els.autoscroll.checked) {
    els.log.scrollTop = els.log.scrollHeight;
  }
}

// ----- API calls ------------------------------------------------------

async function fetchStatus() {
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    if (!r.ok) return;
    renderStatus(await r.json());
  } catch (e) { /* ignore transient fetch errors */ }
}

async function postAction(path) {
  try {
    const r = await fetch(path, { method: 'POST' });
    if (r.status === 409) {
      const body = await r.json();
      alert(body.reason || 'Action refused.');
      return;
    }
    if (!r.ok) {
      alert(`Server returned ${r.status}.`);
      return;
    }
    els.log.textContent = '';
    fetchStatus();
  } catch (e) {
    alert(`Request failed: ${e.message}`);
  }
}

// ----- SSE wiring -----------------------------------------------------

function openStream() {
  const src = new EventSource('/api/stream');
  src.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'log') {
      appendLogLine(msg.line);
    } else if (msg.type === 'run-start') {
      els.log.textContent = '';
      setRunning(true, msg.run);
    } else if (msg.type === 'run-end') {
      setRunning(false, msg.run);
      fetchStatus();
    } else if (msg.type === 'run-snapshot' && msg.run) {
      setRunning(!msg.run.isFinished, msg.run);
      if (msg.run.logTail?.length) {
        els.log.textContent = msg.run.logTail.join('\n');
        scrollLog();
      }
    }
  };
  src.onerror = () => { /* EventSource auto-reconnects */ };
}

// ----- button wiring --------------------------------------------------

els.btnFull.addEventListener('click', () => {
  if (running) return;
  if (!confirm('Run a FULL MAO scrape? This can take hours.')) return;
  postAction('/api/run/full');
});
els.btnDelta.addEventListener('click', () => {
  if (running) return;
  postAction('/api/run/delta');
});
els.btnPush.addEventListener('click', () => {
  if (running) return;
  if (!confirm('Commit web/public/data and push to origin/main?')) return;
  postAction('/api/push');
});
els.btnCancel.addEventListener('click', () => {
  if (!running) return;
  if (!confirm('Cancel the active run?')) return;
  fetch('/api/cancel', { method: 'POST' });
});
els.btnClear.addEventListener('click', () => {
  els.log.textContent = '';
});

// ----- tick -----------------------------------------------------------

function updateNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  els.now.textContent = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
setInterval(updateNow, 1000);
updateNow();

// Refresh ages every 60s so "5m ago" doesn't go stale on screen.
setInterval(fetchStatus, 60_000);

fetchStatus();
openStream();
