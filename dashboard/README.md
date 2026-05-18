# MAO Data Control Panel

A small local dashboard for the Manitoba Parcel Search project. Lets you
see when the MAO data was last scraped, kick off a full or delta refresh,
watch live progress, and push the rebuilt shards to GitHub when you're
ready.

## Quick start

From a Windows machine with this repo checked out:

```cmd
start-dashboard.bat
```

That opens `http://localhost:5174` in your default browser and tails
the Node server's console output. Close the window (or hit Ctrl-C) to
stop the server.

You can also start it manually:

```cmd
node dashboard\server.js
```

No `npm install` is needed — the server is implemented on Node built-ins
(`http`, `fs`, `child_process`, etc.).

## What the buttons do

- **Run Delta** — calls `..\mao-scrape\run_delta.bat`, then rebuilds the
  legal + assessment shards and the public-data manifest. Typical run
  time: a few minutes.
- **Run Full** — same chain but invokes `run_full.bat` instead. Pulls
  every MAO record; can take hours. Use this if a delta has been
  failing repeatedly, or after schema changes.
- **Push to Git** — stages `web/public/data/`, makes a `Data refresh —
  YYYY-MM-DD` commit, and pushes to `origin/main`. Vercel deploys
  automatically once the push lands.

The push button is **tight** about what it commits: if there's anything
dirty *outside* `web/public/data/`, it refuses and tells you to commit
or stash that work first. This stops a data refresh from accidentally
bundling unrelated code changes.

## How live progress works

Every run streams stdout + stderr over Server-Sent Events. The browser
EventSource auto-reconnects on flaky networks, and the server keeps a
heartbeat every 15 seconds. If you close + reopen the browser tab
mid-run, the page picks the run back up and replays the last 200 log
lines.

## Files

```
dashboard/
  server.js          — Node HTTP server + SSE feed + run orchestration
  public/
    index.html       — single-page UI
    app.js           — client-side glue (fetch + EventSource)
    styles.css       — visual design
  README.md          — this file
start-dashboard.bat  — Windows launcher (at the repo root)
```

## Configuration

- **Port**: defaults to `5174`. Override with the `DASHBOARD_PORT` env
  var.
- **R location**: hardcoded to `C:\Program Files\R\R-4.5.3\bin\Rscript.exe`
  in `server.js`. Edit the `Rscript` constant near the top if R is
  installed elsewhere.
- **Scrape location**: resolves `..\mao-scrape` relative to the
  WebSearch repo root. Both projects need to be siblings under
  `MBOpenData/`.

## Relationship to the monthly Task Scheduler job

This dashboard runs the same chain as `monthly-refresh.bat` (the
unattended job registered by `schedule_monthly.ps1`). Use the dashboard
for on-demand refreshes; the scheduled job catches you up if you forget.
Both write to the same `logs/` directories, so the dashboard surfaces
results from either.
