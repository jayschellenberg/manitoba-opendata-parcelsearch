"""Narrated screencast recorder for the ParcelSearch apps.

Usage:
    python record.py shotlists/<name>.json [--out out] [--voice en-US-AndrewMultilingualNeural]
                     [--dry-run] [--headless]

A shot list is JSON:
{
  "name": "mb-search-basics",
  "url": "https://manitoba-opendata-parcelsearch.vercel.app/",
  "viewport": [1920, 1080],
  "voice": "en-US-AndrewMultilingualNeural",      # optional, overrides CLI
  "setup": [ {"wait": 3000} ],                     # actions run before recording starts
  "steps": [
    {"say": "Narration for this step.",
     "do": [ {"click": "#search-input"},
             {"fill": ["#search-input", "123 Main St"]},
             {"press": "Enter"},
             {"wait": 1500},
             {"hover": "text=Sales"},
             {"scroll": ["#panel", 0, 400]},
             {"eval": "window.scrollTo(0,0)"},
             {"key": "Alt+C"} ] }
  ]
}

Per step the narration clip is generated first (edge-tts) and measured; the step then
holds for max(audio + pad, actions) so clicks land inside the words. A cursor overlay
and click ripple are injected into the page so viewers can follow the pointer.

Outputs <out>/<name>.mp4, <out>/<name>.srt and a timing JSON.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
FFBIN = None
for cand in [
    shutil.which("ffmpeg"),
    os.path.expandvars(
        r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
        r"\ffmpeg-9.0.2-full_build\bin\ffmpeg.exe"),
]:
    if cand and Path(cand).exists():
        FFBIN = Path(cand).parent
        break
if FFBIN is None:
    sys.exit("ffmpeg not found; install Gyan.FFmpeg via winget")
FFMPEG = str(FFBIN / "ffmpeg.exe")
FFPROBE = str(FFBIN / "ffprobe.exe")

DEFAULT_VOICE = "en-US-AndrewMultilingualNeural"
STEP_PAD = 0.7          # seconds of silence after each narration clip
MOVE_MS = 450           # cursor travel time per click/hover
CLICK_SETTLE = 350      # ms after a click before the next action

CURSOR_JS = r"""
(() => {
  if (window.__scCursor) return;
  const c = document.createElement('div');
  c.id = '__sc_cursor';
  c.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24">
    <path d="M5 3 L19 12 L12 13.5 L15.5 20.5 L13 21.5 L9.5 14.5 L5 18 Z"
          fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  Object.assign(c.style, {position:'fixed', left:'0px', top:'0px', zIndex: 2147483647,
    pointerEvents:'none', transform:'translate(-4px,-2px)',
    filter:'drop-shadow(0 1px 2px rgba(0,0,0,.5))'});
  const ring = document.createElement('div');
  ring.id = '__sc_ring';
  Object.assign(ring.style, {position:'fixed', width:'44px', height:'44px', borderRadius:'50%',
    border:'3px solid #ffb400', zIndex: 2147483646, pointerEvents:'none',
    transform:'translate(-50%,-50%) scale(.3)', opacity:'0', left:'0px', top:'0px'});
  const add = () => { if (document.body) { document.body.appendChild(c); document.body.appendChild(ring); }
                      else requestAnimationFrame(add); };
  add();
  window.addEventListener('mousemove', e => { c.style.left = e.clientX+'px'; c.style.top = e.clientY+'px'; }, true);
  window.addEventListener('mousedown', e => {
    ring.style.left = e.clientX+'px'; ring.style.top = e.clientY+'px';
    ring.animate([{transform:'translate(-50%,-50%) scale(.3)', opacity:1},
                  {transform:'translate(-50%,-50%) scale(1.4)', opacity:0}],
                 {duration:520, easing:'ease-out'});
  }, true);
  window.__scCursor = true;
})();
"""


OPFS_PICKER_JS = r"""
(() => {
  // Demo recordings: the app's "Choose export folder…" normally opens a native
  // directory picker that cannot be automated. Hand it the origin-private file
  // system instead, pre-filled by the recorder with export files from disk.
  window.showDirectoryPicker = async () => navigator.storage.getDirectory();
})();
"""

OPFS_FILL_JS = r"""
async (names) => {
  const root = await navigator.storage.getDirectory();
  for (const n of names) {
    const res = await fetch('/__demo/' + n);
    if (!res.ok) throw new Error('demo file ' + n + ' ' + res.status);
    const fh = await root.getFileHandle(n, { create: true });
    const w = await fh.createWritable();
    await w.write(await res.blob());
    await w.close();
  }
  return names.length;
}
"""


STILL_JS = r"""
(src) => {
  document.getElementById('__sc_still')?.remove();
  const d = document.createElement('div');
  d.id = '__sc_still';
  d.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.45);' +
    'display:flex;align-items:center;justify-content:center;pointer-events:none';
  const im = new Image();
  im.src = src;
  im.style.cssText = 'max-width:80vw;max-height:80vh;box-shadow:0 12px 40px rgba(0,0,0,.5)';
  d.appendChild(im);
  document.body.appendChild(d);
}
"""


def _data_url(path: Path) -> str:
    import base64, mimetypes
    mt = mimetypes.guess_type(str(path))[0] or "image/png"
    return f"data:{mt};base64," + base64.b64encode(path.read_bytes()).decode()


def ffprobe_duration(path: Path) -> float:
    out = subprocess.check_output([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                                   "-of", "csv=p=0", str(path)], text=True)
    return float(out.strip())


def clip_key(text: str, voice: str) -> str:
    return f"{voice}\n{text}"


def clip_current(text: str, voice: str, dest: Path) -> bool:
    """A cached clip is reused only if its sidecar .txt matches the step's voice
    and text. Clips made before sidecars existed have none and are trusted."""
    if not (dest.exists() and dest.stat().st_size > 0):
        return False
    side = dest.with_suffix(".txt")
    return not side.exists() or side.read_text(encoding="utf-8") == clip_key(text, voice)


KOKORO_DIR = HERE / "out" / "_kokoro"   # kokoro-v1.0.onnx + voices-v1.0.bin (gitignored)
_kokoro = None


def kokoro_say(text: str, voice: str, dest: Path) -> None:
    """Local neural voice, used while edge-tts refuses (voice "kokoro:am_michael")."""
    global _kokoro
    import soundfile as sf
    from kokoro_onnx import Kokoro
    if _kokoro is None:
        _kokoro = Kokoro(str(KOKORO_DIR / "kokoro-v1.0.onnx"), str(KOKORO_DIR / "voices-v1.0.bin"))
    audio, sr = _kokoro.create(text, voice=voice.split(":", 1)[1], speed=1.0, lang="en-us")
    wav = dest.with_suffix(".wav")
    sf.write(str(wav), audio, sr)
    subprocess.run([FFMPEG, "-y", "-i", str(wav), "-b:a", "128k", str(dest)],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    wav.unlink()


def azure_say(text: str, voice: str, dest: Path) -> None:
    """Azure AI Speech (voice "azure:en-US-AndrewMultilingualNeural"): the same
    Andrew as edge-tts, through Jason's own free-tier resource. Key and region
    come from the AZURE_SPEECH_KEY / AZURE_SPEECH_REGION user env vars."""
    import urllib.request
    from xml.sax.saxutils import escape
    name = voice.split(":", 1)[1]
    ssml = (f"<speak version='1.0' xml:lang='en-US'><voice name='{name}'>"
            f"{escape(text)}</voice></speak>").encode("utf-8")
    req = urllib.request.Request(
        f"https://{os.environ['AZURE_SPEECH_REGION']}.tts.speech.microsoft.com/cognitiveservices/v1",
        data=ssml, method="POST",
        headers={"Ocp-Apim-Subscription-Key": os.environ["AZURE_SPEECH_KEY"],
                 "Content-Type": "application/ssml+xml",
                 "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
                 "User-Agent": "parcelsearch-screencast"})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
    if not body:
        raise RuntimeError("Azure returned an empty clip")
    tmp = dest.with_suffix(".part")
    tmp.write_bytes(body)
    tmp.replace(dest)


async def tts(text: str, voice: str, dest: Path) -> float:
    if not clip_current(text, voice, dest):
        if voice.startswith("kokoro:"):
            kokoro_say(text, voice, dest)
        elif voice.startswith("azure:"):
            azure_say(text, voice, dest)
        else:
            import edge_tts
            await edge_tts.Communicate(text, voice, rate="+0%").save(str(dest))
        dest.with_suffix(".txt").write_text(clip_key(text, voice), encoding="utf-8")
    return ffprobe_duration(dest)


def srt_time(t: float) -> str:
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h):02}:{int(m):02}:{int(s):02},{int(round((s % 1) * 1000)):03}"


class Driver:
    def __init__(self, page):
        self.page = page
        self.pos = (960, 540)
        self.t_video0 = time.monotonic()
        self.segments = [(page, self.t_video0)]   # every page recorded, in order
        self.clip = ""                             # text "copied" by select_text, for fillclip

    async def _centre(self, sel: str):
        loc = self.page.locator(sel).first
        await loc.wait_for(state="visible", timeout=15000)
        await loc.scroll_into_view_if_needed()
        box = await loc.bounding_box()
        if not box:
            raise RuntimeError(f"no bounding box for {sel}")
        return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2

    async def move_to(self, x: float, y: float, ms: int = MOVE_MS):
        steps = max(8, ms // 16)
        await self.page.mouse.move(x, y, steps=steps)
        self.pos = (x, y)

    async def run(self, action: dict):
        p = self.page
        (kind, arg), = action.items()
        if kind == "click":
            x, y = await self._centre(arg)
            await self.move_to(x, y)
            await p.mouse.down(); await p.mouse.up()
            await p.wait_for_timeout(CLICK_SETTLE)
        elif kind == "dblclick":
            x, y = await self._centre(arg)
            await self.move_to(x, y)
            await p.mouse.dblclick(x, y)
            await p.wait_for_timeout(CLICK_SETTLE)
        elif kind == "hover":
            x, y = await self._centre(arg)
            await self.move_to(x, y)
        elif kind == "move":
            await self.move_to(*arg)
        elif kind == "clickxy":
            await self.move_to(*arg)
            await p.mouse.down(); await p.mouse.up()
            await p.wait_for_timeout(CLICK_SETTLE)
        elif kind == "clickdot":        # ["card selector", nth circle, "shift"?]: click a plotted SVG dot
            sel, nth = arg[0], int(arg[1])
            mods = arg[2] if len(arg) > 2 else ""
            pt = await p.evaluate("""([sel, nth]) => {
                const card = document.querySelector(sel); if (!card) return null;
                const dots = [...card.querySelectorAll('svg circle')].filter(c => c.getAttribute('pointer-events') !== 'none');
                const c = dots[Math.min(nth, dots.length - 1)]; if (!c) return null;
                c.scrollIntoView({block: 'center'});
                const r = c.getBoundingClientRect();
                return [r.left + r.width / 2, r.top + r.height / 2];
            }""", [sel, nth])
            if not pt:
                raise RuntimeError(f"no dot in {sel}")
            await p.wait_for_timeout(400)
            await self.move_to(*pt)
            if "shift" in mods:
                await p.keyboard.down("Shift")
            await p.mouse.down(); await p.mouse.up()
            if "shift" in mods:
                await p.keyboard.up("Shift")
            await p.wait_for_timeout(CLICK_SETTLE)
        elif kind == "fill":
            sel, text = arg
            x, y = await self._centre(sel)
            await self.move_to(x, y)
            await p.click(sel)
            await p.fill(sel, "")
            await p.type(sel, text, delay=45)
        elif kind == "select":          # ["#sel", "visible label or value"]
            sel, want = arg
            x, y = await self._centre(sel)
            await self.move_to(x, y)
            try:
                await p.select_option(sel, value=want, timeout=3000)
            except Exception:
                await p.select_option(sel, label=want, timeout=5000)
            await p.wait_for_timeout(CLICK_SETTLE)
        elif kind == "upload":          # ["input[type=file]", "path"]
            await p.set_input_files(arg[0], arg[1])
        elif kind == "dblclickxy":
            await self.move_to(*arg)
            await p.mouse.dblclick(*arg)
        elif kind == "fillfile":        # ["#sel", "path relative to the shot list dir or absolute"]: paste a file's text
            sel, path = arg
            fp = Path(path)
            if not fp.is_absolute():
                fp = HERE / fp
            x, y = await self._centre(sel)
            await self.move_to(x, y)
            await p.click(sel)
            await p.fill(sel, fp.read_text(encoding="utf-8"))
        elif kind == "fillclip":        # ["#sel", "fallback file"]: paste what select_text copied
            sel, path = arg
            text = self.clip.strip()
            if text.count("\n") < 2:  # nothing usable was copied: fall back to the saved file
                print("  fillclip: no copied text, using " + path)
                fp = Path(path)
                text = (fp if fp.is_absolute() else HERE / fp).read_text(encoding="utf-8")
            x, y = await self._centre(sel)
            await self.move_to(x, y)
            await p.click(sel)
            await p.fill(sel, text)
        elif kind == "type":
            await p.keyboard.type(arg, delay=45)
        elif kind == "press":
            await p.keyboard.press(arg)
        elif kind == "key":
            await p.keyboard.press(arg)
        elif kind == "wait":
            await p.wait_for_timeout(int(arg))
        elif kind == "waitfor":
            await p.locator(arg).first.wait_for(state="attached", timeout=75000)
        elif kind == "scroll":
            sel, dx, dy = arg
            x, y = await self._centre(sel)
            await self.move_to(x, y)
            await p.mouse.wheel(dx, dy)
        elif kind == "drag":
            (x1, y1), (x2, y2) = arg
            await self.move_to(x1, y1)
            await p.mouse.down()
            await self.move_to(x2, y2, ms=900)
            await p.mouse.up()
        elif kind == "dragmap":         # [lon, lat, radius_px]: draw a circle centred on a map coordinate
            lon, lat, rad = arg
            pt = await p.evaluate("""([lon, lat]) => { const m = window._map; if (!m) return null;
                const r = m.getContainer().getBoundingClientRect(); const q = m.project([lon, lat]);
                return [r.left + q.x, r.top + q.y]; }""", [lon, lat])
            if not pt:
                raise RuntimeError("no window._map")
            # the app's circle tool is click-centre, move (live radius preview), click-edge
            await self.move_to(*pt)
            await p.mouse.down(); await p.mouse.up()
            await p.wait_for_timeout(400)
            await self.move_to(pt[0] + rad, pt[1] + rad * 0.4, ms=1400)
            await p.wait_for_timeout(500)
            await p.mouse.down(); await p.mouse.up()
        elif kind == "eval":
            await p.evaluate(arg)
        elif kind == "goto":
            await p.goto(arg, wait_until="domcontentloaded")
        elif kind == "still":            # overlay a screenshot (e.g. a native dialog the recording can't capture)
            await p.evaluate(STILL_JS, _data_url(HERE / arg))
        elif kind == "unstill":
            await p.evaluate("document.getElementById('__sc_still')?.remove()")
        elif kind == "select_text":      # highlight an element's contents as a user's drag-select would
            self.clip = await p.evaluate("""(sel) => { const el = document.querySelector(sel); if (!el) throw new Error('no ' + sel);
                el.scrollIntoView({block:'start'}); const r = document.createRange(); r.selectNodeContents(el);
                const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString(); }""", arg)
        elif kind == "popup":            # click something that window.open()s; record that page from here on
            x, y = await self._centre(arg)
            await self.move_to(x, y)
            # Locator click, not a coordinate click: the sales panel keeps
            # re-laying out while enrichment finishes, and a click at stale
            # coordinates missed the button (no window, 30 s timeout).
            async with p.context.expect_page(timeout=60000) as pop:
                await p.locator(arg).first.click()
            new = await pop.value
            await new.wait_for_load_state("domcontentloaded")
            await new.bring_to_front()
            self.page = new
            self.segments.append((new, time.monotonic()))
            await new.mouse.move(600, 400)
        elif kind == "zoom":          # map wheel zoom at the current cursor: +n in / -n out
            await p.mouse.wheel(0, -120 * int(arg))
        else:
            raise ValueError(f"unknown action {kind}")


async def record(shot: dict, out_dir: Path, voice: str, headless: bool, dry: bool):
    from playwright.async_api import async_playwright

    name = shot["name"]
    vw, vh = shot.get("viewport", [1920, 1080])
    voice = shot.get("voice", voice)
    work = out_dir / "_work" / name
    work.mkdir(parents=True, exist_ok=True)

    # 1. narration clips
    clips = []
    for i, step in enumerate(shot["steps"]):
        mp3 = work / f"{i:02}.mp3"
        dur = await tts(step["say"], voice, mp3)
        clips.append((mp3, dur))
    total_narr = sum(d for _, d in clips)
    print(f"[{name}] {len(clips)} steps, narration {total_narr:.1f}s "
          f"(+pad {STEP_PAD * len(clips):.1f}s)")
    if dry:
        return

    # 2. drive + record
    async with async_playwright() as pw:
        # Sites behind a login (MAO sales search, Jason 2026-10-13): sign in by
        # hand in an ordinary browser window (the software-GL recording window
        # paints black on screen), then hand its cookies to the recording
        # context in memory. The login page is never recorded and nothing is
        # written to disk.
        state = None
        login = shot.get("login")
        if login:
            lb = await pw.chromium.launch(headless=False, args=["--start-maximized"])
            lctx = await lb.new_context(no_viewport=True)
            lp = await lctx.new_page()
            await lp.goto(login["url"], wait_until="domcontentloaded")
            await lp.bring_to_front()
            mins = login.get("minutes", 10)
            print(f"  >>> Sign in in the browser window. Recording starts once signed in "
                  f"(waiting up to {mins} min)", flush=True)
            # Signed in = the browser has left the login page (a failed login stays on it).
            gate = login["url"].rsplit("/", 1)[-1].lower()
            await lp.wait_for_url(lambda u: gate not in u.lower(), timeout=mins * 60000)
            await lp.wait_for_timeout(1500)
            state = await lctx.storage_state()
            await lb.close()
            print("  signed in; recording", flush=True)

        browser = await pw.chromium.launch(
            headless=headless,
            args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
                  "--ignore-gpu-blocklist", "--hide-scrollbars"],
        )
        ctx = await browser.new_context(
            viewport={"width": vw, "height": vh},
            device_scale_factor=1,
            record_video_dir=str(work),
            record_video_size={"width": vw, "height": vh},
            locale="en-CA",
            storage_state=state,
        )
        await ctx.add_init_script(CURSOR_JS)
        # Sales videos (Jason, 2026-10-10, option 1): serve the firm's export
        # files from disk into the page's private file system and point the
        # app's folder picker at it. Local browser process only; the files
        # go nowhere else and vanish with the context.
        opfs = shot.get("opfs")
        if opfs:
            await ctx.add_init_script(OPFS_PICKER_JS)
            src = Path(opfs["dir"])
            if opfs["files"] == "*":      # the whole export folder, as a real connect would see it
                opfs["files"] = sorted(f.name for f in src.iterdir() if f.is_file())

            async def serve_demo(route, request):
                name = request.url.rsplit("/__demo/", 1)[1].split("?")[0]
                f = src / name
                if f.is_file() and name in opfs["files"]:
                    await route.fulfill(path=str(f), content_type="application/octet-stream")
                else:
                    await route.fulfill(status=404)
            await ctx.route("**/__demo/*", serve_demo)
        page = await ctx.new_page()
        t_video0 = time.monotonic()
        drv = Driver(page)
        await page.goto(shot["url"], wait_until="domcontentloaded")
        if opfs:
            n = await page.evaluate(OPFS_FILL_JS, opfs["files"])
            print(f"  seeded {n} export files into the page's private file system")
        await page.mouse.move(vw * 0.55, vh * 0.55)
        for a in shot.get("setup", []):
            try:
                await drv.run(a)
            except Exception as e:
                print(f"  setup action {a} failed: {str(e).encode('ascii', 'replace').decode()[:300]}")
        page = drv.page
        # A popup opened during setup becomes the only page that matters; one
        # opened mid-recording is stitched onto the main page's video below.
        if len(drv.segments) > 1:
            drv.segments = drv.segments[-1:]
        t_video0 = drv.segments[0][1]

        timings = []
        for i, step in enumerate(shot["steps"]):
            t0 = time.monotonic()
            for a in step.get("do", []):
                try:
                    await drv.run(a)
                except Exception as e:  # keep rolling; report after
                    print(f"  step {i} action {a} failed: {str(e).encode('ascii', 'replace').decode()[:300]}")
            page = drv.page
            elapsed = time.monotonic() - t0
            hold = max(clips[i][1] + STEP_PAD, elapsed)
            if hold > elapsed:
                await page.wait_for_timeout(int((hold - elapsed) * 1000))
            timings.append({"i": i, "start": t0 - t_video0, "dur": time.monotonic() - t0,
                            "audio": clips[i][1], "say": step["say"]})
        await page.wait_for_timeout(800)
        segs = [(await pg.video.path(), t0 - t_video0) for pg, t0 in drv.segments]
        await ctx.close()
        await browser.close()

    # 3a. stitch: a popup opened mid-recording has its own video; cut the main
    # video at the moment it opened and continue with the popup's, so the
    # picture follows what the viewer would have seen.
    if len(segs) > 1:
        parts = []
        for k, (vp, start) in enumerate(segs):
            end = segs[k + 1][1] if k + 1 < len(segs) else None
            part = work / f"seg{k}.mp4"
            cut = ["-ss", f"{start:.3f}"] if k == 0 else []
            if end is not None:
                cut += ["-t", f"{end - start:.3f}"]
            subprocess.run([FFMPEG, "-y", *cut, "-i", str(vp), "-an", "-c:v", "libx264", "-preset", "veryfast",
                            "-crf", "18", "-pix_fmt", "yuv420p", "-r", "30", "-vf", f"scale={vw}:{vh}", str(part)],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            parts.append(part)
        lst = work / "segs.txt"
        lst.write_text(os.linesep.join(f"file '{q.resolve().as_posix()}'" for q in parts) + os.linesep, encoding="utf-8")
        stitched = work / "stitched.mp4"
        subprocess.run([FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(stitched)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        video_path, video_offset = stitched, segs[0][1]
    else:
        video_path, video_offset = segs[0][0], 0.0

    # 3. mux: trim lead-in, overlay narration at step offsets
    lead = timings[0]["start"]
    inputs = ["-ss", f"{lead - video_offset:.3f}", "-i", str(video_path)]
    filters = []
    for i, (mp3, _) in enumerate(clips):
        inputs += ["-i", str(mp3)]
        delay = int(max(0.0, timings[i]["start"] - lead) * 1000)
        filters.append(f"[{i + 1}:a]aresample=48000,adelay={delay}|{delay}[a{i}]")
    mix = "".join(f"[a{i}]" for i in range(len(clips)))
    filters.append(f"{mix}amix=inputs={len(clips)}:normalize=0:dropout_transition=0[aout]")
    final = out_dir / f"{name}.mp4"
    cmd = [FFMPEG, "-y", *inputs, "-filter_complex", ";".join(filters),
           "-map", "0:v", "-map", "[aout]",
           "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
           "-r", "30", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
           str(final)]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # 4. captions + timing
    with open(out_dir / f"{name}.srt", "w", encoding="utf-8") as f:
        for t in timings:
            s = t["start"] - lead
            f.write(f"{t['i'] + 1}\n{srt_time(s)} --> {srt_time(s + t['audio'])}\n{t['say']}\n\n")
    (out_dir / f"{name}.timing.json").write_text(json.dumps(timings, indent=1))
    print(f"[{name}] wrote {final} ({ffprobe_duration(final):.1f}s)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("shotlist", nargs="+")
    ap.add_argument("--out", default=str(HERE / "out"))
    ap.add_argument("--voice", default=DEFAULT_VOICE)
    ap.add_argument("--headless", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="generate narration and report timing only")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for sl in a.shotlist:
        shot = json.loads(Path(sl).read_text(encoding="utf-8"))
        asyncio.run(record(shot, out, a.voice, a.headless, a.dry_run))


if __name__ == "__main__":
    main()
