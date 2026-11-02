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
{"isParkingSign": true, "rawText": "<every panel, one per line, with <- -> <-> for arrows and LEFT:/RIGHT: for split signs>", "confidence": 0.0-1.0,
 "panels": [{"kind": "<one of %s>", "side": "left|right|both", "limitMinutes": <integer or null>, "fee": true|false, "area": true|false, "towAway": true|false,
   "windows": [{"days": [1..7] or null, "start": "HH:MM" or null, "end": "HH:MM" or null, "publicHolidays": "unspecified|include|exclude"}],
   "exceptions": [{"type": "permit_holders|resident_permit|buses|taxis|goods_vehicles|motorbikes|disability_permit|other", "area": "<code or null>", "text": "<as printed>"}],
   "rawText": "<this panel as printed>"}]}""" % "|".join(PANEL_KINDS)

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


def extract_json(text: str):
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.I)
    body = m.group(1) if m else text
    start, end = body.find("{"), body.rfind("}")
    if start < 0 or end < start:
        raise ValueError("no JSON object in model reply")
    return json.loads(body[start:end + 1])


def _hhmm(v):
    if isinstance(v, str) and re.fullmatch(r"\d{1,2}:\d{2}", v):
        return v.zfill(5)
    return None


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
    raw = parsed.get("rawText") if isinstance(parsed.get("rawText"), str) else "\n".join(p["rawText"] for p in panels)
    conf = parsed.get("confidence") if isinstance(parsed.get("confidence"), (int, float)) else None
    return {"sign": {"jurisdiction": jurisdiction, "council": council, "rawText": raw, "confidence": conf, "panels": panels}}


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
    def read(self, image_bytes: bytes, jurisdiction: str, council: str | None) -> dict:
        if self.fake:
            return {**normalise_sign(FAKE_SIGN, jurisdiction, council), "raw": json.dumps(FAKE_SIGN), "ocrText": "", "backend": "local-fake", "model": "fake"}
        with self.lock:
            self.last_used = time.time()
            with tempfile.TemporaryDirectory() as d:
                path = Path(d) / "sign.jpg"
                self._normalise(image_bytes, path)
                ocr_text = self._ocr(path) if self.ocr_available else ""
                raw = self._generate(path, ocr_text, jurisdiction, council)
            self.last_used = time.time()
        if ends_in_runaway_repeat(raw):
            raise ValueError("the model got stuck repeating itself; try a closer, straighter photo")
        out = normalise_sign(extract_json(raw), jurisdiction, council)
        return {**out, "raw": raw, "ocrText": ocr_text, "backend": "local-mlx", "model": self.model_id}

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
    def _ocr(path: Path) -> str:
        from ocrmac import ocrmac
        res = ocrmac.OCR(str(path), recognition_level="accurate").recognize()
        return "\n".join(t for t, _c, _b in res if t.strip()).strip()

    def _generate(self, path: Path, ocr_text: str, jurisdiction: str, council: str | None) -> str:
        from mlx_vlm import generate
        from mlx_vlm.prompt_utils import apply_chat_template
        model, processor, config = self._ensure_loaded()
        hint = f"\nApple Vision OCR read these printed lines (reliable for words and numbers, blind to symbols and arrows):\n{ocr_text}\n" if ocr_text else ""
        prompt = f"{SYSTEM}\n\nJurisdiction: {jurisdiction}{', council: ' + council if council else ''}. Transcribe this parking sign.{hint}\n{JSON_SHAPE}"
        formatted = apply_chat_template(processor, config, prompt, num_images=1)
        result = generate(model, processor, formatted, image=[str(path)], verbose=False, max_tokens=MAX_TOKENS)
        return (result.text if hasattr(result, "text") else str(result)).strip()


# ---------------------------------------------------------------- HTTP

def make_handler(reader: Reader, token: str | None):
    class Handler(BaseHTTPRequestHandler):
        server_version = "caniparkhere-local-reader/1"

        def _cors(self):
            self.send_header("access-control-allow-origin", self.headers.get("origin") or "*")
            self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
            self.send_header("access-control-allow-headers", "content-type, x-reader-token")
            self.send_header("vary", "origin")

        def _json(self, data, status=200):
            body = json.dumps(data).encode()
            self.send_response(status)
            self._cors()
            self.send_header("content-type", "application/json")
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _authorised(self) -> bool:
            if not token:
                return True
            q = re.search(r"[?&]token=([^&]+)", self.path)
            return self.headers.get("x-reader-token") == token or (q is not None and q.group(1) == token)

        def _route(self) -> bool:
            return re.sub(r"^/streetparking", "", self.path.split("?")[0]) == "/api/read-sign"

        def do_OPTIONS(self):
            self.send_response(204); self._cors(); self.end_headers()

        def do_GET(self):
            if not self._route():
                return self._json({"error": "not found"}, 404)
            self._json({"service": "caniparkhere-reader", "backend": "local-fake" if reader.fake else "local-mlx", "model": reader.model_id,
                        "modelLoaded": reader._loaded is not None, "ocr": reader.ocr_available, "auth": bool(token)})

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
                t = time.time()
                out = reader.read(image, body.get("jurisdiction") or "au-vic", body.get("council"))
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
    srv = ThreadingHTTPServer((a.host, a.port), make_handler(reader, a.token))
    print(f"CanIparkhere local reader on http://{a.host}:{a.port}/api/read-sign  model={a.model if not a.fake else 'FAKE'}  auth={'on' if a.token else 'off'}", file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        reader.unload()


if __name__ == "__main__":
    main()
