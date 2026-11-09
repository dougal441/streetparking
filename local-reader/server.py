#!/usr/bin/env python3
"""CanIparkhere local reader: a parking-sign photo in, a structured sign out, on this Mac.

Runs the same vision model the `life` project uses (mlx-vlm, Qwen2.5-VL-7B-Instruct-4bit) with Apple
Vision OCR beside it. Borrowed from `life` on purpose:
  * the model is loaded once and kept while it is being used, then dropped after an idle period, so a
    second 5.3 GB copy is never resident alongside the life jobs for long;
  * while loaded it holds life's machine-wide model lock (`[model_lock] path` in ~/life/config.toml) so
    the launchd extract/clean jobs and this server never load the model at the same time;
  * output that ends inside a long repeat (a model stuck in a loop, cut off by the token cap) is thrown
    away rather than handed to the rules engine.

Speaks the same contract as the Cloudflare Worker, so the app needs no changes:
  GET  /api/read-sign                      -> {"service":"caniparkhere-reader","backend":"local-mlx",...}
  POST /api/read-sign {image,mediaType,...} -> {"sign":{...},"raw":"...","ocrText":"..."}
  POST /api/read-sign {..., "async": true} -> 202 {"jobId":...}; then poll
  GET  /api/read-sign/jobs/<jobId>         -> {"status":"queued|running|done|error","stage":"...","result":{...}}
A first photo can take a minute on a MacBook Air (model load + reading); phones and proxies give up at
~60 s, so the app always uses the async form and shows the stage while it waits.

Usage:  python3 server.py [--port 8765] [--token SECRET] [--idle-minutes 10] [--fake]
        --fake answers with a canned sign and never loads the model (to test the tunnel and the app).
"""
from __future__ import annotations

import argparse
import base64
import fcntl
import gc
import io
import json
import os
import re
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

os.environ["HF_HUB_OFFLINE"] = os.environ.get("HF_HUB_OFFLINE", "1")  # weights come from the local cache

DEFAULT_MODEL = "mlx-community/Qwen2.5-VL-7B-Instruct-4bit"
MAX_DIMENSION = 1600
MAX_TOKENS = 1400
MAX_BODY = 12 * 1024 * 1024

PANEL_KINDS = ["time_limited", "unrestricted", "no_stopping", "no_parking", "clearway", "loading_zone", "bus_zone",
               "taxi_zone", "works_zone", "mail_zone", "truck_zone", "minibus_zone", "permit_zone", "disabled",
               "motorbike", "car_share", "ev_charging", "bicycle", "unknown"]

# Keep byte-identical with SYSTEM in server/read-sign.js (test/reader-core.test.js checks).
SYSTEM = """You transcribe Australian (Victorian) street parking signs into structured data for a rules engine. Signs follow AS 1742.11: red-on-white panels prohibit (a red circle with a struck-through S = NO STOPPING; struck-through P = NO PARKING; CLEARWAY), green-on-white "P" panels permit with limits (2P = 2 hours, 1/2P = 30 minutes, "P 10 MINUTE" = 10 minutes, plain P = no limit), zone panels reserve the space (LOADING ZONE, PERMIT ZONE, BUS ZONE, TAXI ZONE, WORKS ZONE, MAIL ZONE, TRUCK ZONE, wheelchair symbol = disabled, MOTOR BIKES ONLY). TICKET/METER/PAY means a fee. Times like "7-9AM" share the suffix (07:00-09:00); "4-6.30PM" is 16:00-18:30; small AM/PM letters belong to the number before them. Days: MON-FRI = [1,2,3,4,5]; no days shown = null. Arrows: a panel's arrow says which side of the post it governs as you face the sign; a split sign (left half and right half with different content, often with a vertical line between) gives different panels different sides. A horizontal line or a change of colour separates panels. "AREA 7 RESIDENT PERMIT EXCEPTED" is an exception on the panel above it, not a new panel. Transcribe exactly what is printed; do not infer restrictions that are not on the sign. If text is unreadable, use kind "unknown" and say so in rawText."""

JSON_SHAPE = """Reply with ONE JSON object and nothing else, exactly this shape:
{"isParkingSign": true, "rawText": "<every panel, one per line, with <- -> <-> for arrows and LEFT:/RIGHT: for split signs>", "confidence": <number between 0 and 1, e.g. 0.8>,
 "panels": [{"kind": "<one of %s>", "side": "left|right|both", "limitMinutes": <integer or null>, "fee": <true or false>, "area": <true or false>, "towAway": <true or false>,
   "windows": [{"days": <weekday numbers 1=Mon to 7=Sun, e.g. [1,2,3,4,5], or null>, "start": <"HH:MM" or null>, "end": <"HH:MM" or null>, "publicHolidays": "unspecified|include|exclude"}],
   "exceptions": [{"type": "permit_holders|resident_permit|buses|taxis|goods_vehicles|motorbikes|disability_permit|other", "area": "<code or null>", "text": "<as printed>"}],
   "rawText": "<this panel as printed>"}]}
Each panel gets only the times, days and exceptions printed inside that panel. A panel that is just a symbol and an arrow (a red circled S) has "windows": [] and "exceptions": []. Never copy times or exceptions from one panel to another, or from these instructions.""" % "|".join(PANEL_KINDS)

FAKE_SIGN = {"isParkingSign": True, "rawText": "LEFT:\nNO STOPPING <-\nRIGHT:\nWORKS ZONE 7AM-4PM MON-FRI 9AM-1PM SAT ->", "confidence": 0.5,
             "panels": [{"kind": "no_stopping", "side": "left", "limitMinutes": None, "fee": False, "area": False, "towAway": False, "windows": [], "exceptions": [], "rawText": "NO STOPPING"},
                        {"kind": "works_zone", "side": "right", "limitMinutes": None, "fee": False, "area": False, "towAway": False,
                         "windows": [{"days": [1, 2, 3, 4, 5], "start": "07:00", "end": "16:00", "publicHolidays": "unspecified"},
                                     {"days": [6], "start": "09:00", "end": "13:00", "publicHolidays": "unspecified"}], "exceptions": [], "rawText": "WORKS ZONE 7AM-4PM MON-FRI 9AM-1PM SAT"}]}

# ---------------------------------------------------------------- output handling (mirrors server/read-sign.js)

RUNAWAY_MIN_CHARS, RUNAWAY_MIN_REPEATS, RUNAWAY_MAX_PERIOD = 200, 10, 400


def ends_in_runaway_repeat(text: str) -> bool:
    """True when *text* ends inside a long back-to-back repeat of one short unit (life's guard, same thresholds)."""
    text = text.rstrip()
    length = len(text)
    for period in range(1, min(RUNAWAY_MAX_PERIOD, length // 2) + 1):
        index = length - 1 - period
        while index >= 0 and text[index] == text[index + period]:
            index -= 1
        covered = (length - 1 - period - index) + period
        if covered >= RUNAWAY_MIN_CHARS and covered >= RUNAWAY_MIN_REPEATS * period:
            return True
    return False


def _repair_bare(s: str) -> str:
    """Fix the slips a small model makes outside strings: placeholders copied from the prompt, Python literals, stray commas."""
    s = re.sub(r"//[^\n]*", "", s)                                                        # // comments
    s = re.sub(r"<[^<>]*>", "null", s)                                                    # <integer or null>
    s = re.sub(r"(\d+)\s*\.\.\s*(\d+)", lambda m: ",".join(str(n) for n in range(int(m.group(1)), min(int(m.group(2)), 31) + 1)), s)  # 1..5
    s = re.sub(r"(\d+(?:\.\d+)?)\s*-\s*\d+(?:\.\d+)?", r"\1", s)                      # 0.0-1.0 -> 0.0
    s = re.sub(r"\b(?:true|false)(?:\s*\|\s*(?:true|false))+", "false", s)                # true|false
    s = re.sub(r"\bNone\b", "null", s)
    s = re.sub(r"\bTrue\b", "true", s)
    s = re.sub(r"\bFalse\b", "false", s)
    return re.sub(r",(\s*[}\]])", r"\1", s)                                               # trailing commas


def repair_json(body: str) -> str:
    """Apply _repair_bare to everything that is not inside a JSON string."""
    out, i = [], 0
    for m in re.finditer(r'"(?:\\.|[^"\\])*"', body):
        out += [_repair_bare(body[i:m.start()]), m.group(0)]
        i = m.end()
    out.append(_repair_bare(body[i:]))
    return "".join(out)


def extract_json(text: str):
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.I)
    body = m.group(1) if m else text
    start, end = body.find("{"), body.rfind("}")
    if start < 0 or end < start:
        raise ValueError("no JSON object in model reply")
    body = body[start:end + 1]
    try:
        return json.loads(body, strict=False)  # strict=False: raw newlines inside strings are fine
    except json.JSONDecodeError as first:
        try:
            return json.loads(repair_json(body), strict=False)
        except json.JSONDecodeError:
            print("unparseable model reply:\n" + text, file=sys.stderr)
            raise ValueError(f"the vision model's reply was not valid JSON ({first}); take the photo again, closer and straighter") from first


def _hhmm(v):
    if isinstance(v, str) and re.fullmatch(r"\d{1,2}:\d{2}", v):
        return v.zfill(5)
    return None


ARROWS = {"left": "<-", "right": "->", "both": "<->"}


def panels_text(panels: list[dict]) -> str:
    """One line per panel with its arrow, in the form the app's text parser reads."""
    out = []
    for p in panels:
        text = " ".join((p.get("rawText") or "").split())
        if len(re.sub(r"[^A-Za-z]", "", text)) < 3 and p.get("kind") != "unknown":  # a symbol-only panel ("S")
            text = p["kind"].replace("_", " ").upper()
        out.append(f"{text} {ARROWS[p['side']]}".strip())
    return "\n".join(out)


def normalise_sign(parsed, jurisdiction="au-vic", council=None):
    if not isinstance(parsed, dict):
        raise ValueError("reader returned no object")
    if parsed.get("isParkingSign") is False:
        return {"sign": None, "error": "No parking sign found in the photo."}
    panels = []
    for i, p in enumerate(parsed.get("panels") or []):
        p = p if isinstance(p, dict) else {}
        windows = []
        for w in p.get("windows") or []:
            w = w if isinstance(w, dict) else {}
            days = w.get("days")
            days = sorted({int(d) for d in days if isinstance(d, (int, float)) and 1 <= int(d) <= 7}) if isinstance(days, list) and days else None
            win = {"days": days or None, "start": _hhmm(w.get("start")), "end": _hhmm(w.get("end")),
                   "publicHolidays": w.get("publicHolidays") if w.get("publicHolidays") in ("include", "exclude") else "unspecified"}
            if win["days"] or win["start"] or win["end"]:
                windows.append(win)
        lim = p.get("limitMinutes")
        panels.append({
            "id": f"p{i + 1}",
            "kind": p.get("kind") if p.get("kind") in PANEL_KINDS else "unknown",
            "side": p.get("side") if p.get("side") in ("left", "right", "both") else "both",
            "limitMinutes": int(lim) if isinstance(lim, (int, float)) and lim > 0 else None,
            "fee": bool(p.get("fee")), "area": bool(p.get("area")), "towAway": bool(p.get("towAway")),
            "windows": windows,
            "exceptions": [{"type": e.get("type", "other"), "area": e.get("area"), "text": e.get("text")} for e in (p.get("exceptions") or []) if isinstance(e, dict)],
            "rawText": p.get("rawText") if isinstance(p.get("rawText"), str) else "",
        })
    if not panels:
        raise ValueError("reader found no panels")
    raw = parsed.get("rawText") if isinstance(parsed.get("rawText"), str) else ""
    if not raw.strip() or re.search(r"<[A-Za-z][^<>]*>", raw):  # missing, or a placeholder copied from the prompt
        raw = panels_text(panels)
    conf = parsed.get("confidence") if isinstance(parsed.get("confidence"), (int, float)) else None
    return {"sign": {"jurisdiction": jurisdiction, "council": council, "rawText": raw, "confidence": conf, "panels": panels}}


# ---------------------------------------------------------------- layout from Apple Vision positions

def split_columns(lines: list[dict]):
    """Is the printed text in two side-by-side columns (a split sign)? Returns {"split": bool, "gap": x} or None.

    The vision model is the weak link on split signs: it puts both halves on one side, or drops the arrow.
    Apple Vision knows WHERE each word is, so we look for a vertical gap with words on both sides of it.
    """
    xs = sorted((l["x0"], l["x1"]) for l in lines if l["conf"] >= 0.3)
    if len(xs) < 3:
        return None
    left_edge, right_edge = min(a for a, _ in xs), max(b for _, b in xs)
    width = right_edge - left_edge
    if width <= 0:
        return None
    # candidate gaps between the sorted intervals, measured as a fraction of the text's total width
    best = None
    for i in range(1, len(xs)):
        right_of_left = max(b for _, b in xs[:i])
        gap = xs[i][0] - right_of_left
        if gap / width > 0.12 and i >= 1 and len(xs) - i >= 1:
            cand = (gap, (right_of_left + xs[i][0]) / 2)
            if best is None or cand[0] > best[0]:
                best = cand
    if not best:
        return {"split": False}
    gap, x = best
    n_left = sum(1 for l in lines if l["xc"] < x)
    n_right = len(lines) - n_left
    return {"split": n_left >= 1 and n_right >= 1, "gap": round(x, 3)}


def ocr_hint(lines: list[dict], columns) -> str:
    if not lines:
        return ""
    lines = sorted(lines, key=lambda l: -l["y"])  # top of the sign first: panels are stacked top-to-bottom
    if columns and columns.get("split"):
        return "\n".join(f"[{'left column' if l['xc'] < columns['gap'] else 'right column'}] {l['text']}" for l in lines)
    return "\n".join(l["text"] for l in lines)


def _norm_words(t: str) -> set[str]:
    return set(re.findall(r"[A-Z0-9]+", (t or "").upper()))


def fix_sides_from_columns(panels: list[dict], lines: list[dict], columns) -> list[str]:
    """On a two-column sign, put each panel on the side its printed words sit. Symbol-only panels (the red Ⓢ)
    have no words: they take the column nothing else claimed. Returns a list of what was changed."""
    if not columns or not columns.get("split") or len(panels) < 2:
        return []
    gap = columns["gap"]
    changes = []
    unplaced = []
    taken = set()
    for p in panels:
        words = _norm_words(p.get("rawText", "")) - {"LEFT", "RIGHT", "SIDE", "ARROW"}
        votes = {"left": 0, "right": 0}
        for l in lines:
            lw = _norm_words(l["text"])
            overlap = len(words & lw)
            if overlap:
                votes["left" if l["xc"] < gap else "right"] += overlap
        if votes["left"] == votes["right"]:
            unplaced.append(p)
            continue
        side = "left" if votes["left"] > votes["right"] else "right"
        taken.add(side)
        if p["side"] != side:
            changes.append(f'{p.get("kind")}: {p["side"]} -> {side} (its words sit in the {side} column)')
            p["side"] = side
    free = [s for s in ("left", "right") if s not in taken]
    if len(unplaced) == 1 and len(free) == 1:
        p = unplaced[0]
        if p["side"] != free[0]:
            changes.append(f'{p.get("kind")}: {p["side"]} -> {free[0]} (the other column was taken)')
            p["side"] = free[0]
    return changes


TIME_RANGE = re.compile(r"\d{1,2}(?:[.:]\d{2})?\s*(?:AM|PM)?\s*[-\u2013\u2014]\s*\d{1,2}(?:[.:]\d{2})?\s*(?:AM|PM)", re.I)
HAS_TIME = re.compile(r"\d\s*(?:AM|PM)|\d\s*[-\u2013\u2014]\s*\d|\d[.:]\d{2}", re.I)


def drop_unprinted(panels: list[dict], lines: list[dict]) -> list[str]:
    """Remove what the model invented rather than read. Two habits of the small model: it repeats one panel's
    times on its neighbour (a bare red S given the WORKS ZONE hours), and it adds the prompt's example permit
    exception. Both make a prohibition look lifted, so anything unsupported goes: fewer exceptions and fewer
    time windows only ever make the answer stricter. Returns a list of what was removed."""
    notes = []
    ocr_words = set().union(*[_norm_words(l["text"]) for l in lines]) if lines else set()
    if ocr_words:
        for p in panels:
            kept = []
            for e in p.get("exceptions") or []:
                words = {w for w in _norm_words(e.get("text") or "") if len(w) >= 4 and w.isalpha()}
                if words and not words & ocr_words:
                    notes.append(f'{p.get("kind")}: dropped exception "{e.get("text")}" (not printed on the sign)')
                else:
                    kept.append(e)
            p["exceptions"] = kept
    groups = {}
    for p in panels:
        if p.get("windows"):
            groups.setdefault(json.dumps(p["windows"], sort_keys=True), []).append(p)
    printed = len(TIME_RANGE.findall(" ".join(l["text"] for l in lines))) if lines else None
    for same in groups.values():
        if len(same) < 2:
            continue
        timed = sum(1 for w in same[0]["windows"] if w.get("start") or w.get("end"))
        if printed is not None and printed >= timed * len(same):
            continue  # every copy is printed: two panels really do share hours
        bare = [p for p in same if not HAS_TIME.search(p.get("rawText") or "")]
        if not bare and printed is not None:  # the model copied the text too: symbol panels have no printed name
            bare = [p for p in same if p.get("kind") in ("no_stopping", "no_parking") and not _norm_words(p["kind"].replace("_", " ")) <= ocr_words]
        if len(bare) == len(same):
            continue
        for p in bare:
            notes.append(f'{p.get("kind")}: dropped times copied from another panel (none printed on it), so it applies at all times')
            p["windows"] = []
    return notes


# ---------------------------------------------------------------- the model

def life_lock_path() -> Path | None:
    """The life project's model lock file, if its config can be found. One model in memory per machine."""
    cfg = Path(os.environ.get("LIFE_CONFIG", "~/life/config.toml")).expanduser()
    if not cfg.exists():
        return None
    m = re.search(r"^\[model_lock\][^\[]*?^path\s*=\s*\"([^\"]+)\"", cfg.read_text(), re.M | re.S)
    return Path(m.group(1)).expanduser() if m else None


class Reader:
    """Loads the model on first use, holds the lock while loaded, unloads after idle."""

    def __init__(self, model_id: str, idle_minutes: float, fake: bool):
        self.model_id, self.idle, self.fake = model_id, idle_minutes * 60, fake
        self.lock = threading.Lock()
        self._loaded = None
        self._lock_fh = None
        self.last_used = 0.0
        self.ocr_available = False
        if not fake:
            try:
                import ocrmac  # noqa: F401
                self.ocr_available = True
            except Exception:
                print("ocrmac not installed: running without the Apple Vision OCR hint", file=sys.stderr)
        threading.Thread(target=self._idle_loop, daemon=True).start()

    # lock ------------------------------------------------------------------
    def _acquire_life_lock(self):
        path = life_lock_path()
        if not path:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        fh = open(path, "a+")
        deadline = time.time() + 1200
        while True:
            try:
                fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.time() > deadline:
                    fh.close()
                    raise RuntimeError("the life pipeline is using the model (lock held for 20 min); try later")
                time.sleep(2)
        fh.seek(0); fh.truncate(); fh.write(f"pid={os.getpid()} job=caniparkhere-local-reader since={time.strftime('%Y-%m-%dT%H:%M:%S')}\n"); fh.flush()
        self._lock_fh = fh

    def _release_life_lock(self):
        if self._lock_fh:
            try:
                fcntl.flock(self._lock_fh, fcntl.LOCK_UN); self._lock_fh.close()
            except Exception:
                pass
            self._lock_fh = None

    # model -----------------------------------------------------------------
    def _ensure_loaded(self):
        if self._loaded is None:
            from mlx_vlm import load
            from mlx_vlm.utils import load_config
            self._acquire_life_lock()
            t = time.time()
            model, processor = load(self.model_id)
            self._loaded = (model, processor, load_config(self.model_id))
            print(f"model loaded in {time.time() - t:.1f}s", file=sys.stderr)
        return self._loaded

    def unload(self):
        with self.lock:
            if self._loaded is not None:
                self._loaded = None
                gc.collect()
                try:
                    import mlx.core as mx
                    mx.clear_cache()
                except Exception:
                    pass
                self._release_life_lock()
                print("model unloaded (idle)", file=sys.stderr)

    def _idle_loop(self):
        while True:
            time.sleep(30)
            if self._loaded is not None and time.time() - self.last_used > self.idle:
                self.unload()

    # work ------------------------------------------------------------------
    def read(self, image_bytes: bytes, jurisdiction: str, council: str | None, progress=lambda stage: None) -> dict:
        if self.fake:
            progress("reading (fake)")
            time.sleep(0.2)
            return {**normalise_sign(FAKE_SIGN, jurisdiction, council), "raw": json.dumps(FAKE_SIGN), "ocrText": "", "backend": "local-fake", "model": "fake"}
        progress("waiting for the model" if self.lock.locked() else "starting")
        with self.lock:
            self.last_used = time.time()
            with tempfile.TemporaryDirectory() as d:
                path = Path(d) / "sign.jpg"
                self._normalise(image_bytes, path)
                ocr_lines = []
                if self.ocr_available:
                    progress("reading printed text (Apple Vision)")
                    ocr_lines = self._ocr_lines(path)
                columns = split_columns(ocr_lines)
                ocr_text = ocr_hint(ocr_lines, columns)
                if self._loaded is None:
                    progress("loading the model (20-40 s)")
                    self._ensure_loaded()
                progress("reading the sign with the vision model")
                raw = self._generate(path, ocr_text, jurisdiction, council)
            self.last_used = time.time()
        if ends_in_runaway_repeat(raw):
            raise ValueError("the model got stuck repeating itself; try a closer, straighter photo")
        out = normalise_sign(extract_json(raw), jurisdiction, council)
        fixes = []
        if out.get("sign"):
            sign = out["sign"]
            before = panels_text(sign["panels"])
            fixes = drop_unprinted(sign["panels"], ocr_lines) + fix_sides_from_columns(sign["panels"], ocr_lines, columns)
            if sign["rawText"] == before:  # text was rebuilt from the panels: keep it in step with the fixes
                sign["rawText"] = panels_text(sign["panels"])
        return {**out, "raw": raw, "ocrText": ocr_text, "sideFixes": fixes, "columns": columns, "backend": "local-mlx", "model": self.model_id}

    @staticmethod
    def _normalise(image_bytes: bytes, dst: Path):
        from PIL import Image, ImageOps
        try:
            import pillow_heif
            pillow_heif.register_heif_opener()
        except Exception:
            pass
        im = Image.open(io.BytesIO(image_bytes))
        im = ImageOps.exif_transpose(im).convert("RGB")
        im.thumbnail((MAX_DIMENSION, MAX_DIMENSION), Image.LANCZOS)
        im.save(dst, "JPEG", quality=88)

    @staticmethod
    def _ocr_lines(path: Path) -> list[dict]:
        """Apple Vision lines with their horizontal position (0 = left edge, 1 = right edge of the photo)."""
        from ocrmac import ocrmac
        res = ocrmac.OCR(str(path), recognition_level="accurate").recognize()
        out = []
        for text, conf, bbox in res:
            if not text.strip():
                continue
            x, y, w, h = bbox  # normalised, origin bottom-left
            out.append({"text": text.strip(), "conf": float(conf), "x0": float(x), "x1": float(x + w), "xc": float(x + w / 2), "y": float(y)})
        return out

    def _generate(self, path: Path, ocr_text: str, jurisdiction: str, council: str | None) -> str:
        from mlx_vlm import generate
        from mlx_vlm.prompt_utils import apply_chat_template
        model, processor, config = self._ensure_loaded()
        hint = f"\nApple Vision OCR read these printed lines (reliable for words and numbers, blind to symbols and arrows). Where a line is tagged [left column]/[right column] the sign is split down the middle: everything in the left column is one or more panels with side \"left\", everything in the right column has side \"right\". A column with no printed words but a red circled S is a NO STOPPING panel on that side.\n{ocr_text}\n" if ocr_text else ""
        prompt = f"{SYSTEM}\n\nJurisdiction: {jurisdiction}{', council: ' + council if council else ''}. Transcribe this parking sign.{hint}\n{JSON_SHAPE}"
        formatted = apply_chat_template(processor, config, prompt, num_images=1)
        result = generate(model, processor, formatted, image=[str(path)], verbose=False, max_tokens=MAX_TOKENS)
        return (result.text if hasattr(result, "text") else str(result)).strip()


# ---------------------------------------------------------------- HTTP

class Jobs:
    """Background reads the phone polls for. One worker thread; results kept 10 minutes."""

    def __init__(self, reader: Reader):
        self.reader, self.lock, self.jobs = reader, threading.Lock(), {}
        self.queue: list[str] = []
        threading.Thread(target=self._loop, daemon=True).start()

    def submit(self, image: bytes, jurisdiction: str, council: str | None) -> str:
        job_id = uuid.uuid4().hex[:12]
        with self.lock:
            self.jobs[job_id] = {"status": "queued", "stage": "queued", "created": time.time(), "started": None, "result": None, "error": None,
                                 "_args": (image, jurisdiction, council)}
            self.queue.append(job_id)
            for k, v in list(self.jobs.items()):
                if v["status"] in ("done", "error") and time.time() - v["created"] > 600:
                    del self.jobs[k]
        return job_id

    def get(self, job_id: str):
        with self.lock:
            j = self.jobs.get(job_id)
            if not j:
                return None
            out = {k: v for k, v in j.items() if not k.startswith("_")}
            out["elapsed"] = round(time.time() - (j["started"] or j["created"]), 1)
            out["queued_ahead"] = self.queue.index(job_id) if job_id in self.queue else 0
            return out

    def _loop(self):
        while True:
            with self.lock:
                job_id = self.queue.pop(0) if self.queue else None
            if not job_id:
                time.sleep(0.2)
                continue
            j = self.jobs[job_id]
            j["status"], j["started"] = "running", time.time()
            image, jurisdiction, council = j.pop("_args")

            def progress(stage, j=j):
                j["stage"] = stage

            try:
                t = time.time()
                res = self.reader.read(image, jurisdiction, council, progress)
                res["seconds"] = round(time.time() - t, 1)
                j["result"], j["status"], j["stage"] = res, "done", "done"
            except Exception as e:
                print("read-sign job failed:", repr(e), file=sys.stderr)
                j["error"], j["status"], j["stage"] = str(e), "error", "error"


def make_handler(reader: Reader, token: str | None, jobs: Jobs):
    class Handler(BaseHTTPRequestHandler):
        server_version = "caniparkhere-local-reader/1"

        def _cors(self):
            self.send_header("access-control-allow-origin", self.headers.get("origin") or "*")
            self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
            self.send_header("access-control-allow-headers", "content-type, x-reader-token")
            self.send_header("vary", "origin")

        def _json(self, data, status=200):
            body = json.dumps(data).encode()
            try:
                self.send_response(status)
                self._cors()
                self.send_header("content-type", "application/json")
                self.send_header("cache-control", "no-store")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                print("client went away before the reply", file=sys.stderr)

        def _authorised(self) -> bool:
            if not token:
                return True
            q = re.search(r"[?&]token=([^&]+)", self.path)
            return self.headers.get("x-reader-token") == token or (q is not None and q.group(1) == token)

        def _path(self) -> str:
            return re.sub(r"^/streetparking", "", self.path.split("?")[0])

        def _route(self) -> bool:
            return self._path() == "/api/read-sign"

        def _job_id(self):
            m = re.fullmatch(r"/api/read-sign/jobs/([0-9a-f]{12})", self._path())
            return m.group(1) if m else None

        def do_OPTIONS(self):
            self.send_response(204); self._cors(); self.end_headers()

        def do_GET(self):
            job_id = self._job_id()
            if job_id:
                if not self._authorised():
                    return self._json({"error": "unauthorised: send x-reader-token"}, 401)
                j = jobs.get(job_id)
                return self._json(j, 200) if j else self._json({"error": "no such job (it may have expired)"}, 404)
            if not self._route():
                return self._json({"error": "not found"}, 404)
            self._json({"service": "caniparkhere-reader", "backend": "local-fake" if reader.fake else "local-mlx", "model": reader.model_id,
                        "modelLoaded": reader._loaded is not None, "ocr": reader.ocr_available, "auth": bool(token), "async": True})

        def do_POST(self):
            if not self._route():
                return self._json({"error": "not found"}, 404)
            if not self._authorised():
                return self._json({"error": "unauthorised: send x-reader-token"}, 401)
            n = int(self.headers.get("content-length") or 0)
            if n > MAX_BODY:
                return self._json({"error": "image too large"}, 413)
            try:
                body = json.loads(self.rfile.read(n) or b"{}")
            except Exception:
                return self._json({"error": "bad JSON"}, 400)
            if not body.get("image"):
                return self._json({"error": "image (base64) required"}, 400)
            try:
                image = base64.b64decode(body["image"].split(",")[-1])
                jurisdiction, council = body.get("jurisdiction") or "au-vic", body.get("council")
                if body.get("async"):
                    job_id = jobs.submit(image, jurisdiction, council)
                    return self._json({"jobId": job_id, "status": "queued", "poll": f"/api/read-sign/jobs/{job_id}"}, 202)
                t = time.time()
                out = reader.read(image, jurisdiction, council)
                out["seconds"] = round(time.time() - t, 1)
                self._json(out)
            except Exception as e:  # report plainly; this is a single-user tool
                print("read-sign failed:", repr(e), file=sys.stderr)
                self._json({"error": str(e)}, 502)

        def log_message(self, fmt, *args):
            print(f"{self.address_string()} {fmt % args}", file=sys.stderr)

    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8765)))
    ap.add_argument("--host", default="127.0.0.1", help="bind address; keep loopback and expose via cloudflared")
    ap.add_argument("--model", default=os.environ.get("READER_MODEL", DEFAULT_MODEL))
    ap.add_argument("--token", default=os.environ.get("READER_TOKEN"), help="shared secret the caller must send as x-reader-token")
    ap.add_argument("--idle-minutes", type=float, default=10, help="unload the model after this long unused")
    ap.add_argument("--fake", action="store_true", help="never load the model; answer with a canned sign")
    ap.add_argument("--preload", action="store_true", help="load the model at startup instead of on first request")
    a = ap.parse_args()
    reader = Reader(a.model, a.idle_minutes, a.fake)
    if a.preload and not a.fake:
        reader._ensure_loaded()
    srv = ThreadingHTTPServer((a.host, a.port), make_handler(reader, a.token, Jobs(reader)))
    print(f"CanIparkhere local reader on http://{a.host}:{a.port}/api/read-sign  model={a.model if not a.fake else 'FAKE'}  auth={'on' if a.token else 'off'}", file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        reader.unload()


if __name__ == "__main__":
    main()
