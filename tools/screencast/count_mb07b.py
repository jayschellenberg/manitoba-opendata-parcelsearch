"""Recount the figures mb-07b's narration quotes, before re-recording it.

mb-07b narrates a count after each filter ("27 of the 77 sales"). Those go
stale two ways: the paste file is re-captured, and the date presets count back
from today. This loads the paste file into the live site, runs the same filter
sequence headless and prints the status line after each step, so the shot
list's numbers can be checked against it. Nothing is recorded.

    python count_mb07b.py data/paste-springfield-min100.tsv 6 RT

Arguments: the paste file, the date preset in months, and the zones to tick
(comma-separated). The subject roll and the 5 km radius are mb-07b's.
"""
import asyncio
import sys
from pathlib import Path

from playwright.async_api import async_playwright

URL = "https://manitoba-opendata-parcelsearch.vercel.app/?t=sales"
SUBJECT, RADIUS = "163408.240", "5"


async def main(path: str, months: str, zones: str):
    text = Path(path).read_text(encoding="utf-8")
    async with async_playwright() as pw:
        b = await pw.chromium.launch(headless=True)
        p = await (await b.new_context(viewport={"width": 1920, "height": 1080})).new_page()
        await p.goto(URL)
        await p.wait_for_timeout(3500)
        await p.evaluate("document.querySelector('#sales-source-tab-manual')?.click()")
        await p.click("#sales-import-trigger")
        await p.wait_for_selector("#sales-import-text")
        await p.fill("#sales-import-text", text)
        await p.click("#sales-import-load")
        await p.wait_for_selector("#results tbody tr")
        await p.wait_for_timeout(12000)

        async def say(label):
            await p.wait_for_timeout(2500)
            print(f"{label}: {await p.inner_text('#results-status')}")

        await say("loaded")
        await p.click(f'.date-preset-btn[data-months="{months}"]')
        await say(f"{months} months")
        await p.select_option("#vacant-improved", "vacant")
        await say("vacant land only")
        await p.fill("#size-high", "1")
        await p.keyboard.press("Tab")
        await say("max 1 acre")
        await p.fill("#sales-price-low", "50000")
        await p.keyboard.press("Tab")
        await say("min $50,000")
        await p.click("#zoning-filter summary")
        for z in zones.split(","):
            await p.click(f"#zoning-filter input[value={z}]")
        await p.click("#zoning-filter summary")
        await say(f"zoning {zones}")
        await p.fill("#subject-roll", SUBJECT)
        await p.fill("#distance-max", RADIUS)
        await p.click("#subject-apply")
        await p.wait_for_timeout(4000)
        await say(f"within {RADIUS} km of the subject")
        await b.close()


if __name__ == "__main__":
    asyncio.run(main(*sys.argv[1:4]))
