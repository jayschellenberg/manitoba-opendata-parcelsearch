"""Save a MAO sales-search results page as paste text, for demo videos.

Opens MAO's subscriber login in an ordinary browser window, waits for a person
to sign in, runs one sales search, selects the results grid exactly as a user
would before Ctrl+C, and writes the selection text to a file. Nothing is
recorded; the session lives only in this browser and is discarded.

    python capture_mao_paste.py data/paste-springfield-min100.tsv --muni 189 --typ 1 --min 100
"""
from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

from playwright.async_api import async_playwright

LOGIN = "https://www.gov.mb.ca/mao/subscriber/login.aspx"
SEARCH = "https://www.gov.mb.ca/mao/public/search_sales.aspx"
GRID = "#ctl00_PublicContent__ResultDataGrid"


async def main(a):
    async with async_playwright() as pw:
        b = await pw.chromium.launch(headless=False, args=["--start-maximized"])
        ctx = await b.new_context(no_viewport=True)
        p = await ctx.new_page()
        await p.goto(LOGIN, wait_until="domcontentloaded")
        await p.bring_to_front()
        print(">>> Sign in in the browser window (waiting up to 10 min)", flush=True)
        await p.wait_for_url(lambda u: "login.aspx" not in u.lower(), timeout=600000)
        await p.goto(SEARCH, wait_until="domcontentloaded")
        await p.select_option("#ctl00_PublicContent_lstSalesMuni", value=a.muni)
        await p.select_option("#ctl00_PublicContent_lstSaleTypGrp", value=a.typ)
        if a.min:
            await p.fill("#ctl00_PublicContent_txtSaleAmt1", a.min)
        await p.click("#ctl00_PublicContent_btnSearch")
        await p.wait_for_selector(GRID, timeout=60000)
        text = await p.evaluate("""(sel) => { const r = document.createRange();
            r.selectNodeContents(document.querySelector(sel));
            const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString(); }""", GRID)
        await b.close()
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    print(f"saved {len(text.splitlines())} lines to {out}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--muni", default="189")
    ap.add_argument("--typ", default="1")
    ap.add_argument("--min", default="100")
    asyncio.run(main(ap.parse_args()))
