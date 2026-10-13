"""Rebuild SCRIPTS.md (the human-readable review copy) from shotlists/*.json.

Usage: python make_scripts.py
"""
import glob
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
TITLES = {"mb": "Manitoba", "wpg": "Winnipeg"}
EVAL_LABELS = [
    ("advanced-filters", "open Additional Searches"), ("more-filters", "open Additional filters"),
    ("sales-db", "open MAO Sales Database"), ("sales-manual", "open Upload/Paste"),
    ("historical", "pick latest as-of date"), ("removeAllRanges", "clear text selection"),
    ("excl-panel", "open Excluded records"), ("comps-panel", "open Comparable sales"),
    ("page-charts", "scroll to charts"), ("page-maps", "scroll to maps"), ("hint-page", "scroll to hint"),
]


def describe(a):
    (k, v), = a.items()
    simple = {"click": f"click {v}", "hover": f"hover {v}", "type": f'type "{v}"', "press": f"press {v}",
              "key": f"press {v}", "waitfor": "wait for it", "popup": f"click {v} (opens new window)",
              "clickxy": "click on map", "dblclickxy": "double-click on map", "drag": "drag on map",
              "scroll": "scroll the table sideways", "upload": "upload a file"}
    if k in simple:
        return simple[k]
    if k == "fill":
        return f'type "{v[1]}" in {v[0]}' if v[1] else f"clear {v[0]}"
    if k == "fillfile":
        return f"paste {v[1]} into {v[0]}"
    if k == "select":
        return f'pick "{v[1]}" in {v[0]}'
    if k == "clickdot":
        return "shift-click a chart dot" if len(v) > 2 else "click a chart dot"
    if k == "eval":
        return next((label for key, label in EVAL_LABELS if key in v), "page script")
    return None  # wait, move: not worth listing


def main():
    out = ["# Video scripts", "",
           "Rebuilt from `shotlists/*.json` by `python make_scripts.py`. Narration is read exactly as written;"
           " the italic line under each step is what happens on screen.", ""]
    for f in sorted(glob.glob(str(HERE / "shotlists" / "*.json"))):
        d = json.loads(Path(f).read_text(encoding="utf-8"))
        name = d["name"]
        recorded = (HERE / "out" / f"{name}.mp4").exists()
        out += [f"## {name} ({TITLES[name.split('-')[0]]}, {'recorded' if recorded else 'NOT YET RECORDED'})", ""]
        if d.get("setup"):
            s = [x for x in (describe(a) for a in d["setup"]) if x]
            out += [f"_Before recording: {'; '.join(s) or 'load page'}_", ""]
        for i, step in enumerate(d["steps"]):
            acts = [x for x in (describe(a) for a in step.get("do", [])) if x]
            out += [f"**{i}.** {step['say']}", f"<br>_[{'; '.join(acts) if acts else 'cursor rests'}]_", ""]
    (HERE / "SCRIPTS.md").write_text("\n".join(out), encoding="utf-8")
    print(f"wrote SCRIPTS.md ({len(out)} lines)")


if __name__ == "__main__":
    main()
