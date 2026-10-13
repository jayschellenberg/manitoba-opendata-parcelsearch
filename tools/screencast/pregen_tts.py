"""Generate narration clips slowly, for when the free voice service rate-limits.

Usage: python pregen_tts.py shotlists/a.json [shotlists/b.json ...] [--gap 20] [--backoff 600] [--hours 6]

Writes out/_work/<name>/NN.mp3 for every step that has no clip yet, one request at a
time with a pause between them. On a refusal (403 / handshake error) it waits
--backoff seconds and tries the same clip again, giving up after --hours. record.py
then finds the clips cached and never calls the service.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
from pathlib import Path

import edge_tts

HERE = Path(__file__).resolve().parent
DEFAULT_VOICE = "en-US-AndrewMultilingualNeural"


async def one(text: str, voice: str, dest: Path) -> None:
    tmp = dest.with_suffix(".part")
    await edge_tts.Communicate(text, voice, rate="+0%").save(str(tmp))
    if tmp.stat().st_size == 0:
        tmp.unlink()
        raise RuntimeError("empty clip")
    tmp.replace(dest)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("shotlist", nargs="+")
    ap.add_argument("--gap", type=float, default=20)
    ap.add_argument("--backoff", type=float, default=600)
    ap.add_argument("--hours", type=float, default=6)
    ap.add_argument("--initial-wait", type=float, default=0, help="seconds to wait before the first request")
    a = ap.parse_args()
    deadline = time.time() + a.hours * 3600
    if a.initial_wait > 0:
        print(f"waiting {a.initial_wait:.0f}s before the first request", flush=True)
        time.sleep(a.initial_wait)
    todo = []
    for sl in a.shotlist:
        shot = json.loads(Path(sl).read_text(encoding="utf-8"))
        work = HERE / "out" / "_work" / shot["name"]
        work.mkdir(parents=True, exist_ok=True)
        voice = shot.get("voice", DEFAULT_VOICE)
        for i, step in enumerate(shot["steps"]):
            dest = work / f"{i:02}.mp3"
            if not (dest.exists() and dest.stat().st_size > 0):
                todo.append((shot["name"], i, step["say"], voice, dest))
    print(f"{len(todo)} clips to generate", flush=True)
    for name, i, text, voice, dest in todo:
        while True:
            try:
                asyncio.run(one(text, voice, dest))
                print(f"ok   {name} {i:02}", flush=True)
                break
            except Exception as e:  # noqa: BLE001 - any refusal means back off
                if time.time() > deadline:
                    print(f"GAVE UP at {name} {i:02}: {str(e)[:120]}", flush=True)
                    return 1
                print(f"wait {name} {i:02}: {str(e)[:80]} -> sleeping {a.backoff:.0f}s", flush=True)
                time.sleep(a.backoff)
        time.sleep(a.gap)
    print("all clips ready", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
