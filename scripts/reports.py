#!/usr/bin/env python3
"""Reader reports: the reads someone marked wrong in the app (docs/REPORTS.md).

  python3 scripts/reports.py list            fetch the reader-reports branch into .reports/ and list what is waiting
  python3 scripts/reports.py show <readId>   print one report: what was printed, what the model said, what the app showed
  python3 scripts/reports.py case <readId>   start local-reader/cases/<readId>.json from it (then fill in `expected`)

A report is "waiting" until a case file with its id exists on this branch.
"""
import io
import json
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".reports"
CASES = ROOT / "local-reader" / "cases"
BRANCH = "reader-reports"


def fetch():
    r = subprocess.run(["git", "fetch", "-q", "origin", f"+{BRANCH}:refs/remotes/origin/{BRANCH}"], cwd=ROOT, capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"no {BRANCH} branch yet (nothing has been reported), or fetch failed:\n{r.stderr.strip()}")
    tar = subprocess.run(["git", "archive", f"origin/{BRANCH}"], cwd=ROOT, capture_output=True, check=True).stdout
    OUT.mkdir(exist_ok=True)
    tarfile.open(fileobj=io.BytesIO(tar)).extractall(OUT, filter="data")


def load(rid):
    d = OUT / "reports" / rid
    if not d.is_dir():
        sys.exit(f"no report {rid} in {OUT}/reports (run: list)")
    read = json.loads((d / "read.json").read_text())
    report = json.loads((d / "report.json").read_text()) if (d / "report.json").exists() else {}
    return d, read, report


def panel_line(p):
    wins = "; ".join(f"{w.get('days') or 'all days'} {w.get('start')}-{w.get('end')}" for w in p.get("windows") or []) or "all times"
    exc = (" except " + ", ".join(str(e.get("text") or e.get("type")) for e in p["exceptions"])) if p.get("exceptions") else ""
    lim = f" {p['limitMinutes']}min" if p.get("limitMinutes") else ""
    return f"    {p.get('side', '?'):5} {p.get('kind')}{lim}{' fee' if p.get('fee') else ''}  [{wins}]{exc}"


def cmd_list():
    fetch()
    dirs = sorted((OUT / "reports").iterdir()) if (OUT / "reports").is_dir() else []
    waiting = 0
    for d in dirs:
        done = (CASES / f"{d.name}.json").exists()
        waiting += not done
        report = json.loads((d / "report.json").read_text()) if (d / "report.json").exists() else {}
        read = json.loads((d / "read.json").read_text())
        note = " | ".join(report.get("notes") or []) or "(no note)"
        print(f"{'done   ' if done else 'WAITING'} {d.name}  {'ERROR: ' + read['error'] if read.get('error') else ''}{note}")
    print(f"\n{waiting} waiting, {len(dirs) - waiting} done. Photos: {OUT}/reports/<readId>/photo.jpg")


def cmd_show(rid):
    d, read, report = load(rid)
    print(f"photo: {d / 'photo.jpg'}\nread at {read.get('at')} in {read.get('seconds')}s by {read.get('model')}  council={read.get('council')}")
    print("\nNOTES FROM THE PERSON:", *(report.get("notes") or ["(none)"]), sep="\n  ")
    print("\nAPPLE VISION LINES (text, x centre, y from bottom):")
    for l in sorted(read.get("ocrLines") or [], key=lambda l: -l["y"]):
        print(f"    {l['text']!r:32} x={l['xc']:.2f} y={l['y']:.2f} conf={l['conf']:.2f}")
    print("\nMODEL REPLY:\n" + (read.get("raw") or "(none)"))
    res = read.get("result") or {}
    print("\nERROR:", read["error"]) if read.get("error") else None
    print("\nSIGN SENT TO THE APP:")
    for p in ((res.get("sign") or {}).get("panels") or []):
        print(panel_line(p))
    print("  corrections made:", res.get("sideFixes") or "none")
    app = report.get("app") or {}
    if app:
        print("\nWHAT THE APP SHOWED (after any fixes the person made by hand):")
        print("  sign text:", json.dumps(app.get("signText")))
        for p in ((app.get("sign") or {}).get("panels") or []):
            print(panel_line(p))
        print("  side overrides:", app.get("sideOverrides") or "none", "| when:", app.get("when"), "| vehicle:", app.get("vehicle"))
        for side, v in (app.get("verdicts") or {}).items():
            print(f"  {side}: {v}")


def cmd_case(rid):
    _, read, report = load(rid)
    dst = CASES / f"{rid}.json"
    if dst.exists():
        sys.exit(f"{dst} already exists")
    case = {"id": rid, "status": "TODO fixed|model", "note": " | ".join(report.get("notes") or []),
            "jurisdiction": read.get("jurisdiction") or "au-vic", "council": read.get("council"),
            "ocrLines": read.get("ocrLines") or [], "raw": read.get("raw"),
            "expected": {"panels": ((report.get("app") or {}).get("sign") or (read.get("result") or {}).get("sign") or {}).get("panels") or []}}
    dst.write_text(json.dumps(case, indent=1) + "\n")
    print(f"wrote {dst}\n`expected` starts as what the app showed after the person's fixes: check every panel against the photo, then set status.")


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["list"]:
        cmd_list()
    elif a[:1] == ["show"] and len(a) == 2:
        cmd_show(a[1])
    elif a[:1] == ["case"] and len(a) == 2:
        cmd_case(a[1])
    else:
        sys.exit(__doc__)
