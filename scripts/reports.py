#!/usr/bin/env python3
"""Reader reports: the reads someone marked wrong in the app (docs/REPORTS.md). Reports are private.

  python3 scripts/reports.py list            gather this Mac's reports and the site's private reports into .reports/ and list what is waiting
  python3 scripts/reports.py show <readId>   print one report: what was printed, what the model said, what the app showed
  python3 scripts/reports.py case <readId>   start local-reader/cases/<readId>.json from it (then fill in `expected`)

Reports come from two private places: local-reader/reports/ on this Mac, and the site's Dougal-only reports API
(reads made through dougalhanson.com/caniparkhere by Cloudflare or on the phone, plus Mac reports filed while the
Mac was away). The site needs the admin token: CANIPARKHERE_ADMIN_TOKEN, or the gitignored
dougalhanson-com/.admin_token file. It is only ever sent as a header, never printed.

A report is "waiting" until a case file with its id exists on this branch.
"""
import json
import os
import re
import shutil
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".reports"
CASES = ROOT / "local-reader" / "cases"
LOCAL = ROOT / "local-reader"
TOKEN_FILE = Path.home() / "Documents/Claude/Projects/dougalhanson-com/.admin_token"
USER_AGENT = "caniparkhere-reports/1"
MAC_ID = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{6}$")
UUID_V4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)


# ---------------------------------------------------------------- gathering (read at call time, so tests can patch)

def base_url():
    return os.environ.get("CANIPARKHERE_REPORTS_BASE", "https://dougalhanson.com").rstrip("/")


def admin_token():
    t = os.environ.get("CANIPARKHERE_ADMIN_TOKEN")
    if t and t.strip():
        return t.strip()
    try:
        t = TOKEN_FILE.read_text().strip()
    except OSError:
        return None
    return t or None


def api(token, path="", method="GET", raw=False):
    """One call to the site's private reports API. The bearer goes only in the header."""
    req = urllib.request.Request(base_url() + "/api/caniparkhere/reports" + path, method=method,
                                 data=b"{}" if method == "POST" else None,
                                 headers={"User-Agent": USER_AGENT, "Authorization": f"Bearer {token}",
                                          "Accept": "application/json", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        body = r.read()
    return body if raw else json.loads(body or b"{}")


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def merge_notes(*lists):
    out = []
    for notes in lists:
        for n in notes or []:
            if isinstance(n, str) and n.strip() and n not in out:
                out.append(n)
    return out


def copy_local(rid):
    """Copy local-reader/reports/<rid>/ into the cache (dot files like .uploaded stay behind)."""
    src, dst = LOCAL / "reports" / rid, OUT / "reports" / rid
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns(".*"))


def write_text_only(rid, row, app=None):
    """A report the site holds but whose read (photo, Apple Vision lines) is not on this Mac."""
    d = OUT / "reports" / rid
    d.mkdir(parents=True, exist_ok=True)
    if not (d / "read.json").exists():
        (d / "read.json").write_text(json.dumps({"id": rid, "reader": row.get("reader")}, indent=1))
    merge_into(d, row, app)


def merge_into(d, row, app=None):
    """Fold the site's notes into the cached report.json without duplicating any."""
    rp = d / "report.json"
    rep = read_json(rp, {}) or {}
    rep["readId"] = rep.get("readId") or row.get("readId")
    rep["reportedAt"] = rep.get("reportedAt") or row.get("createdAt")
    rep["updatedAt"] = rep.get("updatedAt") or row.get("updatedAt")
    rep["notes"] = merge_notes(rep.get("notes"), row.get("notes"))
    if rep.get("app") is None and app is not None:
        rep["app"] = app
    rep.setdefault("reader", row.get("reader"))
    rp.write_text(json.dumps(rep, indent=1))


def deliver_mac(token, row, detail):
    """A Mac report filed with the site while the Mac was away: write it on this Mac, then mark it delivered."""
    rid = row["readId"]
    app = (detail.get("report") or {}).get("app")
    local = read_json(LOCAL / "reports" / rid / "report.json", None)
    app = app if app is not None else (local or {}).get("app")
    have = set((local or {}).get("notes") or [])
    missing = [n for n in merge_notes(row.get("notes"), (detail.get("report") or {}).get("notes")) if n not in have]
    if local is None and not missing:
        missing = [""]
    sys.path.insert(0, str(LOCAL))
    import server  # the Mac reader's own ReadLog, so the report lands exactly as one filed on the Mac would
    log = server.ReadLog(LOCAL, sync=False)
    try:
        for note in missing:
            log.report(rid, {"note": note, "app": app})
    except KeyError:
        print(f"warning: report {rid} is from the Mac but its read is no longer on this Mac (only the newest "
              f"{server.ReadLog.KEEP} are kept); keeping the site's notes only", file=sys.stderr)
        write_text_only(rid, row, app)
    api(token, f"/{rid}/delivered", method="POST")
    if (LOCAL / "reports" / rid).is_dir():
        copy_local(rid)
        merge_into(OUT / "reports" / rid, row, app)


def site_reports(token):
    rows = (api(token) or {}).get("reports") or []
    for row in rows:
        rid, reader = str(row.get("readId") or ""), row.get("reader")
        ok = MAC_ID.fullmatch(rid) if reader == "mac" else UUID_V4.fullmatch(rid)
        if not ok or reader not in ("mac", "cloudflare", "on-device"):
            print(f"warning: skipping a site report with an unexpected id or reader: {rid[:40]!r} {reader!r}", file=sys.stderr)
            continue
        d = OUT / "reports" / rid
        if reader == "mac":
            if not row.get("forwarded"):
                deliver_mac(token, row, api(token, f"/{rid}"))
            elif d.is_dir():
                merge_into(d, row)
            else:
                write_text_only(rid, row)
            continue
        detail = api(token, f"/{rid}")
        d.mkdir(parents=True, exist_ok=True)
        (d / "read.json").write_text(json.dumps(detail.get("read") or {"id": rid}, indent=1))
        rp = d / "report.json"
        prev = read_json(rp, {}) or {}
        rep = detail.get("report") or {}
        rep = {**rep, "readId": rid, "reader": reader, "notes": merge_notes(prev.get("notes"), rep.get("notes"), row.get("notes"))}
        rep["reportedAt"] = rep.get("reportedAt") or row.get("createdAt")
        rp.write_text(json.dumps(rep, indent=1))
        if row.get("hasPhoto"):
            try:
                (d / "photo.jpg").write_bytes(api(token, f"/{rid}/photo", raw=True))
            except urllib.error.HTTPError as e:
                if e.code != 404:
                    raise


def gather():
    """Fill .reports/reports/ from this Mac's local-reader/reports/ and the site's private reports API."""
    out = OUT / "reports"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    local = LOCAL / "reports"
    for d in sorted(local.iterdir()) if local.is_dir() else []:
        if d.is_dir() and MAC_ID.fullmatch(d.name):
            copy_local(d.name)
    token = admin_token()
    try:
        if not token:
            raise LookupError("no admin token: set CANIPARKHERE_ADMIN_TOKEN")
        site_reports(token)
    except (LookupError, urllib.error.URLError, OSError, ValueError) as e:
        reason = e.reason if isinstance(e, urllib.error.URLError) and not isinstance(e, urllib.error.HTTPError) else e
        print(f"warning: can't reach the site's private reports ({reason}); listing the reports on this Mac only", file=sys.stderr)


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


def reported_at(d):
    """Sort key: (parsed reportedAt, folder name). Missing or unparseable dates sort first."""
    rep = read_json(d / "report.json", {}) or {}
    try:
        t = datetime.fromisoformat(str(rep.get("reportedAt")))
        t = t if t.tzinfo else t.replace(tzinfo=timezone.utc)
        return (1, t, d.name)
    except ValueError:
        return (0, datetime.min.replace(tzinfo=timezone.utc), d.name)


def cmd_list():
    gather()
    dirs = sorted((d for d in (OUT / "reports").iterdir() if d.is_dir()), key=reported_at) if (OUT / "reports").is_dir() else []
    waiting = 0
    for d in dirs:
        done = (CASES / f"{d.name}.json").exists()
        waiting += not done
        report = read_json(d / "report.json", {}) or {}
        read = read_json(d / "read.json", {}) or {}
        note = " | ".join(report.get("notes") or []) or "(no note)"
        print(f"{'done   ' if done else 'WAITING'} {d.name}  {'ERROR: ' + str(read['error']) if read.get('error') else ''}{note}")
    if dirs:
        print(f"\nPhotos: {OUT}/reports/<readId>/photo.jpg")
    print(f"{waiting} waiting, {len(dirs) - waiting} done.")


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
