# Screencast recorder and training videos

Narrated, clicked-through feature videos for the Manitoba and Winnipeg ParcelSearch apps, recorded
from JSON shot lists so any video can be re-recorded after the app changes. Status as of 2026-10-13.

## Status

**17 videos planned, 15 recorded, 2 waiting.** All recorded against production on 2026-10-10/12, after
the search-race fix, map re-centre, popup change badge and R2 indexes were live.

| # | Video | Length | Audience | State |
|---|---|---|---|---|
| mb-01 | Search basics | 3:20 | external OK | recorded |
| mb-02 | Legal descriptions, titles and lists | 2:24 | external OK | recorded |
| mb-03 | Map layers | 2:38 | external OK | recorded |
| mb-04 | Map tools and history | 2:02 | external OK | recorded |
| mb-05 | Report outputs | 1:39 | external OK | recorded |
| mb-06 | Agricultural features | 4:01 | external OK | recorded |
| mb-07 | Pasting sales from MAO | — | staff only | **waiting on narration** |
| mb-08 | Connecting the MAO Sales Database | — | staff only | **waiting on narration** |
| mb-09 | Sales grid and comparables | 1:29 | staff only | recorded |
| mb-10 | Sales Charts: layout and settings | 1:33 | staff only | recorded |
| mb-11 | Sales Charts: the chart pages | 1:39 | staff only | recorded |
| mb-12 | Sales Charts: comparables and work file | 1:48 | staff only | recorded |
| wpg-01 | Search basics | 1:45 | external OK | recorded |
| wpg-02 | More searches | 1:55 | external OK | recorded |
| wpg-03 | Map layers | 2:08 | external OK | recorded |
| wpg-04 | Report outputs | 1:33 | external OK | recorded |
| wpg-05 | Sales Analysis and Charts | 1:37 | staff only | recorded |

"Staff only" videos show real MAO subscriber sales (the export is marked *PRIVATE, do not
redistribute*) or SABRE data. Do not share them outside the firm, on any platform, without checking the
data agreements. The Property Search videos use open government data only.

## Where things are

| What | Where |
|---|---|
| Recorder, shot lists, scripts | this folder (`tools/screencast/`) |
| Raw recordings, captions, timings | `out/` (gitignored) |
| Narration clip cache | `out/_work/<video>/NN.mp3` |
| Paste demo data (real MAO rows) | `data/paste-springfield.tsv` (gitignored, private) |
| Shared copy for outside viewers | `D:\Dropbox\Parcel Search Training Videos`: the 10 Property Search videos plus `.srt` captions, with readable names |
| Review copy of every script | `SCRIPTS.md` (rebuild with `python make_scripts.py`) |
| Email for outside viewers | `EMAIL-DRAFT-EXTERNAL.md` (10 videos, one `[folder link]`); local only, gitignored |
| Email for staff | `EMAIL-DRAFT-STAFF.md` (all 17, a `[link]` per video); local only, gitignored |
| AI for Appraisers group post | `POST-AI-FOR-APPRAISERS.md` (Jason posted his own edited version); local only, gitignored |
| Feature inventories used to write the scripts | `inventory-manitoba.md`, `inventory-winnipeg.md` |

## Outstanding

1. **mb-07 and mb-08 narration.** Microsoft's free voice service (edge-tts) has refused every request
   with a 403 since 2026-10-12, almost certainly rate-limiting after two days of heavy use (clock and
   client version ruled out). Jason's rule: **try once every 24 hours until it is permitted.** A
   background job does this and records both videos as soon as all 19 clips arrive:
   ```bash
   python pregen_tts.py shotlists/mb-07-sales-paste.json shotlists/mb-08-sales-database.json --initial-wait 86400 --gap 30 --backoff 86400 --hours 2160 && python record.py shotlists/mb-07-sales-paste.json shotlists/mb-08-sales-database.json --out out
   ```
   It needs the PC awake. If the PC slept or restarted, run the same command again; clips already made
   stay cached. Progress is in `out/_pregen.txt`.
2. **After mb-07/08 record:** review them, then fill the links in `EMAIL-DRAFT-STAFF.md` and put the
   staff videos somewhere firm-only (a Dropbox folder by invitation, or SharePoint/Stream).
3. **Not shown in any video:** the connect step cannot show the Windows folder dialog or the browser's
   one-time read-permission prompt, because the recorder bypasses both. Add a sentence to mb-08 step 1
   if wanted.
4. **External version of the sales videos** (optional): re-record mb-07 to mb-12 and wpg-05 from a
   synthetic sales file so they could be shown outside the firm.
5. **App changes since recording** (no re-record needed yet): Measure now shows square feet (#200), and
   the Addenda Pack zooms closer for lots under an acre (#199). mb-04 and mb-05 still match what they show.
6. The recorder code, shot lists and docs are in git (this repo is public). Recordings, the narration
   cache, the paste demo data and the personal drafts are gitignored and live only in Dropbox.

## App changes made alongside the videos (all merged and live)

| Repo | PR | Change |
|---|---|---|
| Manitoba | #193 | Parcel card shows Land SF, roll frontage/area and DU; map re-centres on ticked rows |
| Manitoba | #194 | Hover and click popups show zoning changes as the grid's amber badge |
| Manitoba | #196 | A slower earlier search can no longer overwrite a newer one (the "artifacts after several searches") |
| Manitoba | #197 | Legal and assessment indexes served gzip from R2; first search went from 20–90 s to about 10 s |
| Manitoba | #198 | Each index downloads once per page, not three times |
| Winnipeg | #54 | Map re-centres on ticked rows |
| Winnipeg | #56 | Same superseded-search guard as Manitoba #196 |

## Decisions to keep (from Jason's reviews)

- No parcel card in any video.
- Narration voice `en-US-AndrewMultilingualNeural`; cursor ring and click ripple; no burned-in captions.
- Videos may run up to 5 minutes; the per-page cap is flexible.
- Database sales searches use sale type **Residential bare land**.
- Paste-from-MAO is the first sales video; the database connection is its own video.
- STR, title and lot/block/plan are mentioned in mb-02, not demonstrated.
- mb-03 demonstrates the zoning-changes pill on Steinbach, 30 to 100 First St (two RLD to RMD parcels).
- Land cover always carries the caution that it can be off for recently broken land and differ from MAO.

## How the recorder works

1. `record.py` reads a shot list from `shotlists/`.
2. Each step's `say` text becomes an MP3 via edge-tts, cached in `out/_work/<name>/`. The clip is measured.
3. A real Chromium window (Playwright, 1920×1080) loads the production site, runs the step's `do`
   actions with a visible cursor and click ripple, and holds the step for the audio length.
4. A window opened with `popup` (the Charts page) is recorded too and stitched into the main video.
5. ffmpeg trims the lead-in, lays the narration at each step's offset, and writes `out/<name>.mp4`,
   `out/<name>.srt` and `out/<name>.timing.json`.

```bash
python record.py shotlists/mb-01-search-basics.json --out out
```

Options: `--voice <name>`, `--dry-run` (narration and timing only), `--headless`. Several shot lists can
be passed at once, and they record one after another. Never run two batches in parallel: it slowed the
province's services enough to break searches. Delete `out/_work/<name>/NN.mp3` after editing a step's
text so it is re-narrated. After a run, check the log for "failed" lines and check
`out/<name>.timing.json`: a step that runs far past its audio means an action timed out.

Requirements: Python 3.14 with `playwright` (browsers installed) and `edge-tts`; ffmpeg from
`winget install Gyan.FFmpeg`.

### Shot list format

```json
{ "name": "mb-01-search-basics",
  "url": "https://manitoba-opendata-parcelsearch.vercel.app/",
  "opfs": {"dir": "D:/Dropbox/SharedInfo/AppMarketData/SalesData/Manitoba", "files": ["manifest.json", "muni_189.csv"]},
  "setup": [ {"waitfor": "#municipality option:nth-child(5)"} ],
  "steps": [ {"say": "Narration…", "do": [ {"click": "#search"}, {"wait": 2000} ]} ] }
```

Actions: `click` `dblclick` `hover` `fill [sel,text]` `fillfile [sel,path]` `type` `press` `key`
`select [sel,value-or-label]` `wait ms` `waitfor sel` `scroll [sel,dx,dy]` `drag [[x1,y1],[x2,y2]]`
`clickxy [x,y]` `dblclickxy [x,y]` `move [x,y]` `upload [sel,path]` `eval js` `goto url` `zoom n`
`popup sel` (opens a window; recording follows it) `clickdot [card selector, n, "shift"?]` (clicks the
n-th plotted SVG dot in a chart card). A failed action is logged and the step continues.

`opfs` (sales videos only, Jason-approved 2026-10-10): serves the listed export files from disk into the
recording browser's private file system and overrides the folder picker, so "Choose export folder…"
works unattended. The files never leave the machine.

`pregen_tts.py` generates narration clips slowly (`--gap`, `--backoff`, `--hours`, `--initial-wait`) for
when the voice service is rate-limiting; `record.py` then uses the cached clips.

### Traps learned the hard way

- `#sales-db` and `#sales-manual` are closed `<details>`; open them before clicking inside.
- A date preset must be set before `#sales-db-load`, or nothing loads.
- `#subject-muni` stays hidden; set the subject with `#subject-roll` inside the opened Additional filters.
- Chart dots are SVG circles: use `clickdot`, never fixed coordinates. Clear the text selection after a
  shift-click with `getSelection().removeAllRanges()`.
- Click `#excl-panel input.excl-reason` before typing a reason; focus is lost when the grid republishes.
- Open the Charts window with `popup`, which uses a locator click. A coordinate click missed while the
  panel was still re-laying out.
- Clear All navigates the page and throws away the loaded indexes; use Clear Roll/Addy and change fields.
- Winnipeg's street typeahead takes Borebank for "BOR", so type the full street name.
- `#number-starred` is hidden unless there are legacy un-numbered stars.
- The Winnipeg rectangle tool is click-click, not drag.
- Windows console: run with `PYTHONIOENCODING=utf-8`, or error text containing an emoji crashes the run.
