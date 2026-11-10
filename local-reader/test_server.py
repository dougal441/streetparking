"""Unit tests for the local reader's model-free parts. Run: cd local-reader && python3 -m unittest test_server"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import server  # noqa: E402


class JsonHandling(unittest.TestCase):
    def test_extract_json_tolerates_fences_and_chatter(self):
        self.assertEqual(server.extract_json('Sure!\n```json\n{"a": 1}\n```'), {"a": 1})
        self.assertEqual(server.extract_json('{"a": {"b": 2}} trailing'), {"a": {"b": 2}})
        with self.assertRaises(ValueError):
            server.extract_json("no json")

    def test_extract_json_repairs_small_model_slips(self):
        # The reply that broke a real read: the prompt's "0.0-1.0" placeholder copied verbatim.
        reply = '{\n  "isParkingSign": true,\n  "rawText": "2P 9AM-6PM MON-FRI <->",\n  "confidence": 0.9-1.0,\n  "panels": []\n}'
        self.assertEqual(server.extract_json(reply)["confidence"], 0.9)
        out = server.extract_json('{"a": True, "b": None, "fee": true|false, "days": [1..5], "lim": <integer or null>, // note\n "s": "7-9AM, 1..2 <- None",\n "t": "line\nbreak",}')
        self.assertEqual(out, {"a": True, "b": None, "fee": False, "days": [1, 2, 3, 4, 5], "lim": None, "s": "7-9AM, 1..2 <- None", "t": "line\nbreak"})
        with self.assertRaisesRegex(ValueError, "not valid JSON"):
            server.extract_json('{"a": [1, 2}')

    def test_prompt_shape_has_no_copyable_invalid_json(self):
        for trap in ("0.0-1.0", "true|false", "[1..7]"):
            self.assertNotIn(trap, server.JSON_SHAPE)

    def test_normalise_cleans_and_pads(self):
        out = server.normalise_sign(server.FAKE_SIGN, council="melbourne")
        self.assertEqual(len(out["sign"]["panels"]), 2)
        self.assertEqual(out["sign"]["panels"][1]["windows"][0]["start"], "07:00")
        self.assertEqual(out["sign"]["council"], "melbourne")
        bad = server.normalise_sign({"panels": [{"kind": "bogus", "side": "up", "windows": [{"days": [9, 1], "start": "7:30", "end": None}]}]})
        self.assertEqual(bad["sign"]["panels"][0]["kind"], "unknown")
        self.assertEqual(bad["sign"]["panels"][0]["side"], "both")
        self.assertEqual(bad["sign"]["panels"][0]["windows"][0], {"days": [1], "start": "07:30", "end": None, "publicHolidays": "unspecified"})

    def test_normalise_rejects_junk_and_flags_non_signs(self):
        with self.assertRaises(ValueError):
            server.normalise_sign({"panels": []})
        self.assertIsNone(server.normalise_sign({"isParkingSign": False})["sign"])


class RunawayGuard(unittest.TestCase):
    def test_loop_is_caught_and_normal_output_is_not(self):
        self.assertTrue(server.ends_in_runaway_repeat('{"rawText": "x' + "**." * 700))
        self.assertFalse(server.ends_in_runaway_repeat(json.dumps(server.FAKE_SIGN)))
        self.assertFalse(server.ends_in_runaway_repeat("affirmation " * 12 + '\n{"ok": true}'))


class LifeLock(unittest.TestCase):
    def test_lock_path_is_read_from_life_config(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = Path(d) / "config.toml"
            cfg.write_text('[extract]\nvlm_model = "x"\n\n[model_lock]\npath = "~/life/state/local/model.lock"\ntimeout_seconds = 1200\n')
            os.environ["LIFE_CONFIG"] = str(cfg)
            try:
                self.assertEqual(server.life_lock_path(), Path("~/life/state/local/model.lock").expanduser())
            finally:
                os.environ["LIFE_CONFIG"] = str(Path(d) / "missing.toml")
                self.assertIsNone(server.life_lock_path())


if __name__ == "__main__":
    unittest.main()


class AsyncJobs(unittest.TestCase):
    def test_submit_poll_done(self):
        import http.client, threading, base64
        from http.server import ThreadingHTTPServer
        reader = server.Reader("fake", 10, fake=True)
        srv = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(reader, "tok", server.Jobs(reader)))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        port = srv.server_address[1]
        try:
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            c.request("POST", "/streetparking/api/read-sign?token=tok", body=json.dumps({"image": base64.b64encode(b"x").decode(), "async": True, "council": "melbourne"}), headers={"content-type": "application/json"})
            r = c.getresponse(); body = json.loads(r.read())
            self.assertEqual(r.status, 202); self.assertIn("jobId", body)
            c.request("GET", f"/api/read-sign/jobs/{body['jobId']}")  # no token → 401
            self.assertEqual(c.getresponse().status, 401)
            for _ in range(50):
                c.request("GET", f"/api/read-sign/jobs/{body['jobId']}?token=tok"); r = c.getresponse(); j = json.loads(r.read())
                if j["status"] == "done": break
                import time as _t; _t.sleep(0.1)
            self.assertEqual(j["status"], "done"); self.assertEqual(j["result"]["sign"]["council"], "melbourne"); self.assertEqual(j["stage"], "done")
            c.request("GET", "/api/read-sign/jobs/000000000000?token=tok"); self.assertEqual(c.getresponse().status, 404)
            c.request("GET", "/streetparking/api/read-sign"); j = json.loads(c.getresponse().read()); self.assertTrue(j["async"])
        finally:
            srv.shutdown()


class TokenAndLog(unittest.TestCase):
    """WR-05: the token is compared in constant time, and no query string (the old phone link's ?token=) is logged."""

    TOKEN = "Zq7-tok_9fXkL2mPa8Rc4"

    def test_header_and_old_link_work_and_the_log_never_holds_the_query(self):
        import contextlib, http.client, io, threading
        from http.server import ThreadingHTTPServer
        reader = server.Reader("fake", 10, fake=True)
        srv = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(reader, self.TOKEN, server.Jobs(reader)))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        err = io.StringIO()
        try:
            with contextlib.redirect_stderr(err):
                c = http.client.HTTPConnection("127.0.0.1", srv.server_address[1], timeout=5)
                def status(path, headers=None):
                    c.request("GET", path, headers=headers or {}); r = c.getresponse(); r.read(); return r.status
                self.assertEqual(status("/api/read-sign/jobs/000000000000", {"x-reader-token": self.TOKEN}), 404)  # authorised, no job
                self.assertEqual(status(f"/api/read-sign/jobs/000000000000?token={self.TOKEN}"), 404)  # the old phone link still works
                self.assertEqual(status(f"/api/read-sign/jobs/000000000000?a=1&token={self.TOKEN}"), 404)
                self.assertEqual(status("/api/read-sign/jobs/000000000000", {"x-reader-token": self.TOKEN[:-1]}), 401)
                self.assertEqual(status("/api/read-sign/jobs/000000000000", {"x-reader-token": self.TOKEN + "x"}), 401)
                self.assertEqual(status(f"/api/read-sign/jobs/000000000000?token={self.TOKEN[:-1]}"), 401)
                self.assertEqual(status("/api/read-sign/jobs/000000000000?token="), 401)
                self.assertEqual(status("/api/read-sign/jobs/000000000000"), 401)
        finally:
            srv.shutdown(); srv.server_close()
        log = err.getvalue()
        self.assertIn("/api/read-sign/jobs/000000000000?[redacted]", log)  # the request lines are still logged
        self.assertNotIn(self.TOKEN[:-1], log)
        self.assertNotIn("token=", log)

    def test_redact_query(self):
        self.assertEqual(server.redact_query('"GET /streetparking/api/read-sign?token=abc HTTP/1.1" 200 -'),
                         '"GET /streetparking/api/read-sign?[redacted] HTTP/1.1" 200 -')
        self.assertEqual(server.redact_query("code 400, message Bad request syntax ('GET /x?token=abc&b=2')"),
                         "code 400, message Bad request syntax ('GET /x?[redacted]')")
        self.assertEqual(server.redact_query('"GET /api/read-sign HTTP/1.1" 200 -'), '"GET /api/read-sign HTTP/1.1" 200 -')

    def test_compare_is_constant_time(self):
        src = (Path(__file__).parent / "server.py").read_text()
        body = src[src.index("def _authorised"):src.index("def _path")]
        self.assertIn("hmac.compare_digest", body)
        self.assertNotIn("== token", body)


class ColumnFixes(unittest.TestCase):
    LINES = [
        {"text": "WORKS", "conf": 0.9, "x0": 0.58, "x1": 0.72, "xc": 0.65, "y": 0.8},
        {"text": "ZONE", "conf": 0.9, "x0": 0.59, "x1": 0.70, "xc": 0.645, "y": 0.75},
        {"text": "7 AM - 4 PM", "conf": 0.8, "x0": 0.56, "x1": 0.74, "xc": 0.65, "y": 0.6},
        {"text": "MON - FRI", "conf": 0.8, "x0": 0.57, "x1": 0.73, "xc": 0.65, "y": 0.55},
        {"text": "SAT", "conf": 0.8, "x0": 0.62, "x1": 0.68, "xc": 0.65, "y": 0.45},
        {"text": "S", "conf": 0.4, "x0": 0.33, "x1": 0.38, "xc": 0.355, "y": 0.8},
    ]

    def test_two_columns_detected_and_sides_fixed(self):
        cols = server.split_columns(self.LINES)
        self.assertTrue(cols["split"])
        panels = [{"kind": "no_stopping", "side": "both", "rawText": "NO STOPPING"},
                  {"kind": "works_zone", "side": "both", "rawText": "WORKS ZONE 7AM-4PM MON-FRI 9AM-1PM SAT"}]
        changes = server.fix_sides_from_columns(panels, self.LINES, cols)
        self.assertEqual([p["side"] for p in panels], ["left", "right"])
        self.assertEqual(len(changes), 2)
        hint = server.ocr_hint(self.LINES, cols)
        self.assertIn("[right column] WORKS", hint)

    def test_single_column_leaves_sides_alone(self):
        lines = [dict(l, x0=0.4, x1=0.6, xc=0.5) for l in self.LINES]
        cols = server.split_columns(lines)
        self.assertFalse(cols["split"])
        panels = [{"kind": "no_stopping", "side": "both", "rawText": "NO STOPPING"}]
        self.assertEqual(server.fix_sides_from_columns(panels, lines, cols), [])
        self.assertEqual(panels[0]["side"], "both")


class Unprinted(unittest.TestCase):
    """The real read that got it wrong: red S <- | WORKS ZONE 7-4 Mon-Fri, 9-1 Sat ->. The model gave the S the
    works zone's hours and the prompt's example permit exception, so the app said you could stop there."""
    LINES = [{"text": t, "conf": 0.9, "x0": 0.56, "x1": 0.74, "xc": 0.65, "y": 0.8 - i / 10}
             for i, t in enumerate(["WORKS", "ZONE", "7 AM - 4PM", "MON - FRI", "9 AM - 1 PM", "SAT"])]
    WINDOWS = [{"days": [1, 2, 3, 4, 5], "start": "07:00", "end": "16:00"}, {"days": [6], "start": "09:00", "end": "13:00"}]
    EXC = [{"type": "resident_permit", "area": "7", "text": "AREA 7 RESIDENT PERMIT EXCEPTED"}]

    def reply(self, s_text="S"):
        return {"isParkingSign": True, "rawText": "<left column>/<right column>", "confidence": 0.9, "panels": [
            {"kind": "no_stopping", "side": "left", "windows": self.WINDOWS, "exceptions": self.EXC, "rawText": s_text},
            {"kind": "works_zone", "side": "right", "windows": self.WINDOWS, "exceptions": self.EXC, "rawText": "WORKS ZONE 7 AM - 4PM MON - FRI 9 AM - 1 PM SAT"}]}

    def test_copied_times_and_invented_exception_are_removed(self):
        sign = server.normalise_sign(self.reply())["sign"]
        notes = server.drop_unprinted(sign["panels"], self.LINES)
        stop, works = sign["panels"]
        self.assertEqual((stop["windows"], stop["exceptions"]), ([], []))
        self.assertEqual(len(works["windows"]), 2)
        self.assertEqual(works["exceptions"], [])
        self.assertEqual(len(notes), 3)
        self.assertEqual(server.panels_text(sign["panels"]).splitlines()[0], "NO STOPPING <-")

    def test_placeholder_raw_text_is_rebuilt(self):
        raw = server.normalise_sign(self.reply())["sign"]["rawText"]
        self.assertNotIn("column", raw)
        self.assertTrue(raw.startswith("NO STOPPING <-"))

    def test_copied_text_is_caught_from_the_printed_count(self):
        sign = server.normalise_sign(self.reply("NO STOPPING 7 AM - 4PM MON - FRI 9 AM - 1 PM SAT"))["sign"]
        server.drop_unprinted(sign["panels"], self.LINES)
        self.assertEqual(sign["panels"][0]["windows"], [])
        self.assertEqual(len(sign["panels"][1]["windows"]), 2)

    def test_hours_printed_on_both_panels_are_kept(self):
        lines = self.LINES + [{"text": t, "conf": 0.9, "x0": 0.3, "x1": 0.4, "xc": 0.35, "y": 0.5} for t in ["NO STOPPING", "7 AM - 4PM", "9 AM - 1 PM", "PERMIT HOLDERS EXCEPTED"]]
        r = self.reply("NO STOPPING 7 AM - 4PM 9 AM - 1 PM")
        r["panels"][0]["exceptions"] = [{"type": "permit_holders", "area": None, "text": "PERMIT HOLDERS EXCEPTED"}]
        sign = server.normalise_sign(r)["sign"]
        server.drop_unprinted(sign["panels"], lines)
        self.assertEqual(len(sign["panels"][0]["windows"]), 2)
        self.assertEqual(len(sign["panels"][0]["exceptions"]), 1)

    def test_no_ocr_still_clears_the_bare_symbol(self):
        sign = server.normalise_sign(self.reply())["sign"]
        server.drop_unprinted(sign["panels"], [])
        self.assertEqual(sign["panels"][0]["windows"], [])
        self.assertEqual(len(sign["panels"][0]["exceptions"]), 1)  # nothing to check it against


class ReadLogAndReports(unittest.TestCase):
    """Every read is logged; a report copies it to reports/ and stays on this Mac. Only ReadLog(sync=True), set
    in code, pushes to a reader-reports branch (tested here against a local bare remote only)."""

    def setUp(self):
        import subprocess
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name) / "reader"
        self.base.mkdir()
        self.remote = Path(self.tmp.name) / "remote.git"
        subprocess.run(["git", "init", "-q", "--bare", str(self.remote)], check=True)

    def tearDown(self):
        self.tmp.cleanup()

    def remote_files(self):
        import subprocess
        r = subprocess.run(["git", "--git-dir", str(self.remote), "ls-tree", "-r", "--name-only", server.REPORTS_BRANCH], capture_output=True, text=True)
        return r.stdout.split()

    def test_read_is_logged_reported_and_uploaded(self):
        log = server.ReadLog(self.base, remote=str(self.remote), sync=True)
        reader = server.Reader("fake", 10, fake=True, log=log)
        out = reader.read(b"jpegbytes", "au-vic", "melbourne")
        rid = out["readId"]
        self.assertRegex(rid, server.READ_ID)
        rec = json.loads((self.base / "reads" / rid / "read.json").read_text())
        self.assertEqual(rec["result"]["sign"]["panels"][0]["kind"], "no_stopping")
        self.assertEqual((self.base / "reads" / rid / "photo.jpg").read_bytes(), b"jpegbytes")

        res = log.report(rid, {"note": "left side is wrong", "app": {"signText": "NO STOPPING <-"}})
        self.assertTrue(res["uploaded"], res["uploadNote"])
        self.assertEqual(sorted(self.remote_files()), ["README.md", f"reports/{rid}/photo.jpg", f"reports/{rid}/read.json", f"reports/{rid}/report.json"])
        self.assertEqual(log.sync(), (True, "nothing new to upload"))

        # a second note on the same read updates the same report; a second read lands beside the first
        res = log.report(rid, {"note": "should be all times"})
        self.assertTrue(res["uploaded"], res["uploadNote"])
        self.assertEqual(json.loads((self.base / "reports" / rid / "report.json").read_text())["notes"], ["left side is wrong", "should be all times"])
        rid2 = reader.read(b"second", "au-vic", None)["readId"]
        self.assertTrue(log.report(rid2, {})["uploaded"])
        self.assertEqual(len([f for f in self.remote_files() if f.endswith("report.json")]), 2)

    def test_upload_failure_keeps_the_report_for_next_time(self):
        log = server.ReadLog(self.base, remote=str(Path(self.tmp.name) / "missing.git"), sync=True)
        rid = server.Reader("fake", 10, fake=True, log=log).read(b"x", "au-vic", None)["readId"]
        res = log.report(rid, {"note": "n"})
        self.assertTrue(res["saved"]); self.assertFalse(res["uploaded"])
        log.remote = str(self.remote)
        self.assertEqual(log.sync()[0], True)
        self.assertIn(f"reports/{rid}/report.json", self.remote_files())

    def test_upload_is_off_by_default(self):
        log = server.ReadLog(self.base)
        rid = server.Reader("fake", 10, fake=True, log=log).read(b"x", "au-vic", None)["readId"]
        res = log.report(rid, {"note": "wrong"})
        self.assertTrue(res["saved"])
        self.assertIs(res["uploaded"], False)
        self.assertEqual(res["uploadNote"], "kept on this Mac (private)")
        self.assertTrue((self.base / "reports" / rid / "report.json").exists())
        self.assertFalse((self.base / "state" / "reports-git").exists())

    def run_server_cli(self, *args):
        import subprocess
        return subprocess.run([sys.executable, "server.py", *args, "--data-dir", str(self.base)],
                              cwd=str(Path(__file__).parent), capture_output=True, text=True, timeout=60)

    def test_sync_reports_flag_refuses(self):
        r = self.run_server_cli("--sync-reports")
        self.assertEqual(r.returncode, 1)
        self.assertIn("Uploading reports is switched off", r.stdout)
        self.assertFalse((self.base / "state" / "reports-git").exists())

    def test_no_upload_flag_still_parses(self):
        r = self.run_server_cli("--no-upload", "--sync-reports")
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn("Uploading reports is switched off", r.stdout)
        self.assertFalse((self.base / "state" / "reports-git").exists())

    def test_failed_read_is_logged_with_its_id(self):
        log = server.ReadLog(self.base, sync=False)
        reader = server.Reader("fake", 10, fake=True, log=log)
        reader._read = lambda *a, **k: (_ for _ in ()).throw(ValueError("boom"))
        with self.assertRaises(ValueError) as cm:
            reader.read(b"x", "au-vic", None)
        rec = json.loads((self.base / "reads" / cm.exception.read_id / "read.json").read_text())
        self.assertEqual(rec["error"], "ValueError: boom")

    def test_report_endpoint(self):
        import http.client, threading, base64
        from http.server import ThreadingHTTPServer
        reader = server.Reader("fake", 10, fake=True, log=server.ReadLog(self.base, sync=False))
        srv = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(reader, "tok", server.Jobs(reader)))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            c = http.client.HTTPConnection("127.0.0.1", srv.server_address[1], timeout=5)
            post = lambda path, body: (c.request("POST", path, body=json.dumps(body), headers={"content-type": "application/json"}), c.getresponse())[1]
            r = post("/api/read-sign?token=tok", {"image": base64.b64encode(b"x").decode()}); rid = json.loads(r.read())["readId"]
            r = post("/streetparking/api/read-sign/reports", {"readId": rid}); r.read(); self.assertEqual(r.status, 401)
            r = post("/streetparking/api/read-sign/reports?token=tok", {"readId": rid, "note": "wrong"}); body = json.loads(r.read())
            self.assertEqual((r.status, body["saved"], body["uploaded"]), (200, True, False))
            r = post("/api/read-sign/reports?token=tok", {"readId": "../../etc"}); r.read(); self.assertEqual(r.status, 404)
        finally:
            srv.shutdown()


class ReportsCommand(unittest.TestCase):
    """scripts/reports.py list: one command gathers this Mac's reports and the site's private ones (fake API here)."""

    BEARER = "test-bearer-7f3a9c1e5d"

    def setUp(self):
        import importlib.util, threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        self.env = dict(os.environ)
        for k in ("CANIPARKHERE_ADMIN_TOKEN", "CANIPARKHERE_REPORTS_BASE"):
            os.environ.pop(k, None)
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        spec = importlib.util.spec_from_file_location("reports_cmd", Path(__file__).parent.parent / "scripts" / "reports.py")
        self.rp = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.rp)
        self.local = root / "local-reader"
        self.local.mkdir()
        self.rp.ROOT, self.rp.OUT, self.rp.LOCAL = root, root / ".reports", self.local
        self.rp.CASES, self.rp.TOKEN_FILE = self.local / "cases", root / "no-admin-token"
        self.log = server.ReadLog(self.local, sync=False)
        self.reader = server.Reader("fake", 10, fake=True, log=self.log)
        self.rows, self.details, self.photos, self.posts, self.agents = [], {}, {}, [], set()
        t = self
        PREFIX = "/api/caniparkhere/reports"

        class Fake(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def answer(self, code, body, ctype="application/json"):
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(code); self.send_header("content-type", ctype)
                self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)

            def route(self):
                t.agents.add(self.headers.get("User-Agent"))
                if self.headers.get("Authorization") != f"Bearer {t.BEARER}":
                    return self.answer(401, {"error": "unauthorized"})
                rest = self.path[len(PREFIX):] if self.path.startswith(PREFIX) else None
                if rest is None:
                    return self.answer(404, {"error": "not found"})
                parts = [x for x in rest.split("/") if x]
                if self.command == "POST" and len(parts) == 2 and parts[1] == "delivered":
                    self.rfile.read(int(self.headers.get("content-length") or 0))
                    t.posts.append((self.path, self.headers.get("Authorization")))
                    return self.answer(200, {"ok": True})
                if self.command != "GET":
                    return self.answer(405, {"error": "method"})
                if not parts:
                    return self.answer(200, {"reports": t.rows})
                if len(parts) == 1 and parts[0] in t.details:
                    return self.answer(200, t.details[parts[0]])
                if len(parts) == 2 and parts[1] == "photo" and parts[0] in t.photos:
                    return self.answer(200, t.photos[parts[0]], "image/jpeg")
                return self.answer(404, {"error": "not found"})

            do_GET = do_POST = route

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.api_base = f"http://127.0.0.1:{self.srv.server_address[1]}"

    def tearDown(self):
        self.srv.shutdown(); self.srv.server_close()
        os.environ.clear(); os.environ.update(self.env)
        self.tmp.cleanup()

    def use_api(self, base=None):
        os.environ["CANIPARKHERE_REPORTS_BASE"] = base or self.api_base
        os.environ["CANIPARKHERE_ADMIN_TOKEN"] = self.BEARER

    def run_list(self):
        import contextlib, io
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.rp.cmd_list()
        return out.getvalue(), err.getvalue()

    def mac_read(self):
        return self.reader.read(b"macphoto", "au-vic", None)["readId"]

    def site_row(self, rid, reader, notes, at, forwarded=False, photo=False, app=None, read=None):
        self.rows.append({"readId": rid, "reader": reader, "memberEmail": "d@example.com", "notes": notes, "createdAt": at,
                          "updatedAt": at, "hasPhoto": photo, "forwarded": forwarded})
        self.details[rid] = {"row": self.rows[-1], "read": read,
                             "report": {"readId": rid, "reportedAt": at, "updatedAt": at, "notes": notes, "app": app}}

    def closed_port(self):
        import socket
        s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
        return f"http://127.0.0.1:{port}"

    def test_gathers_the_mac_and_the_site_in_date_order(self):
        mac = self.mac_read()
        self.log.report(mac, {"note": "mac note"})
        uid = "3f2b8c1a-9d4e-4f6a-8b2c-1e5d7a9c0b3f"
        self.site_row(uid, "on-device", ["wrong side"], "2026-01-01T00:00:00.000Z", photo=True,
                      app={"signText": "2P"}, read={"id": uid, "backend": "on-device", "ocrText": "2P"})
        self.photos[uid] = b"\xff\xd8phone"
        self.use_api()
        out, err = self.run_list()
        cache = self.rp.OUT / "reports"
        self.assertEqual(sorted(p.name for p in cache.iterdir()), sorted([mac, uid]))
        self.assertEqual((cache / uid / "photo.jpg").read_bytes(), b"\xff\xd8phone")
        self.assertEqual(json.loads((cache / uid / "read.json").read_text())["ocrText"], "2P")
        self.assertEqual(json.loads((cache / uid / "report.json").read_text())["notes"], ["wrong side"])
        self.assertEqual((cache / mac / "photo.jpg").read_bytes(), b"macphoto")
        self.assertLess(out.index(uid), out.index(mac))  # January before today
        self.assertIn("2 waiting, 0 done.", out)
        self.assertEqual(self.agents, {"caniparkhere-reports/1"})
        self.assertNotIn("warning", err)

    def test_waiting_mac_report_is_written_on_the_mac_and_delivered(self):
        mac = self.mac_read()
        self.site_row(mac, "mac", ["away note"], "2026-11-10T01:00:00.000Z", app={"signText": "NO STOPPING"})
        self.use_api()
        out, err = self.run_list()
        local = json.loads((self.local / "reports" / mac / "report.json").read_text())
        self.assertEqual(local["notes"], ["away note"])
        self.assertEqual(local["app"], {"signText": "NO STOPPING"})
        self.assertEqual(self.posts, [(f"/api/caniparkhere/reports/{mac}/delivered", f"Bearer {self.BEARER}")])
        self.assertTrue((self.rp.OUT / "reports" / mac / "photo.jpg").exists())
        self.assertIn(mac, out)

    def test_same_read_in_both_places_is_one_folder_with_each_note_once(self):
        mac = self.mac_read()
        self.log.report(mac, {"note": "a"})
        self.site_row(mac, "mac", ["a", "b"], "2026-11-10T01:00:00.000Z")
        self.use_api()
        out, _ = self.run_list()
        self.assertEqual([p.name for p in (self.rp.OUT / "reports").iterdir()], [mac])
        self.assertEqual(json.loads((self.rp.OUT / "reports" / mac / "report.json").read_text())["notes"], ["a", "b"])
        self.assertEqual(json.loads((self.local / "reports" / mac / "report.json").read_text())["notes"], ["a", "b"])
        self.assertEqual(out.count(mac), 1)
        # already forwarded and also on the Mac: still one folder, notes merged without duplicates
        self.rows[0]["forwarded"], self.rows[0]["notes"] = True, ["b", "c"]
        self.run_list()
        self.assertEqual(json.loads((self.rp.OUT / "reports" / mac / "report.json").read_text())["notes"], ["a", "b", "c"])

    def test_no_token_or_no_site_still_lists_the_mac(self):
        mac = self.mac_read()
        self.log.report(mac, {"note": "n"})
        for setup in (lambda: os.environ.__setitem__("CANIPARKHERE_REPORTS_BASE", self.closed_port()), lambda: self.use_api(self.closed_port())):
            os.environ.pop("CANIPARKHERE_ADMIN_TOKEN", None)
            setup()
            out, err = self.run_list()
            warnings = [l for l in err.splitlines() if l.startswith("warning")]
            self.assertEqual(len(warnings), 1, err)
            self.assertIn("listing the reports on this Mac only", warnings[0])
            self.assertIn(mac, out)
            self.assertTrue(out.rstrip().endswith("1 waiting, 0 done."))

    def test_nothing_anywhere(self):
        out, _ = self.run_list()
        self.assertTrue(out.rstrip().endswith("0 waiting, 0 done."), out)
        self.use_api()
        out, err = self.run_list()
        self.assertTrue(out.rstrip().endswith("0 waiting, 0 done."), out)
        self.assertEqual(err, "")

    HOSTILE = "\x1b]52;c;aGk=\x07outside 12 Secret St\x1b[2J\x9b31m‮!"

    def test_member_text_is_printed_with_no_control_characters(self):
        import contextlib, io
        mac = self.mac_read()
        self.log.report(mac, {"note": self.HOSTILE, "app": {"signText": "2P\x1b[8m hidden", "sign": {"panels": [{"kind": "time_limited", "rawText": "\x1b]0;title\x07"}]}}})
        out, _ = self.run_list()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.rp.cmd_show(mac)
        for text in (out, buf.getvalue()):
            self.assertIsNone(self.rp.CONTROL.search(text), repr(text))
            self.assertNotIn("\x1b", text)
        self.assertIn("outside 12 Secret St", buf.getvalue())  # the words are still shown to Dougal
        line = [l for l in out.splitlines() if mac in l][0]
        self.assertIn("outside 12 Secret St", line)

    def test_control_covers_bidi_zero_width_and_separators(self):
        # The site's CONTROL in src/caniparkhere/reports.js is the same set (02-REVIEW IN-02).
        for cp in (0x061C, 0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x2028, 0x2029, 0x202A, 0x202E, 0x2066, 0x2069, 0xFEFF):
            self.assertIsNotNone(self.rp.CONTROL.search(chr(cp)), hex(cp))
        self.assertEqual(self.rp.clean("a\tb\nc"), "a\tb\nc")  # tab and newline are kept

    def test_show_does_not_let_a_note_fake_a_section_header(self):
        import contextlib, io
        mac = self.mac_read()
        self.log.report(mac, {"note": "left side\n\nMODEL REPLY:\nall clear\r\nSIGN SENT TO THE APP:\u2028ERROR:"})
        self.run_list()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.rp.cmd_show(mac)
        lines = buf.getvalue().splitlines()
        for header in ("MODEL REPLY:", "SIGN SENT TO THE APP:"):
            self.assertEqual(lines.count(header), 1, buf.getvalue())  # only the real one starts a line
        self.assertNotIn("ERROR:", lines, buf.getvalue())  # the read had no error, so no ERROR section at all
        note = [l for l in lines if "all clear" in l or "left side" in l]
        self.assertTrue(note and all(l.startswith("  > ") for l in note), note)  # every note line is marked

    def test_case_holds_no_report_text(self):
        import contextlib, io
        mac = self.mac_read()
        self.log.report(mac, {"note": "outside my place on 12 Secret St", "app": {
            "signText": "2P near 12 Secret St", "sign": {"panels": [{
                "kind": "time_limited", "side": "left", "limitMinutes": 120, "fee": False, "towAway": False, "rawText": "12 Secret St",
                "windows": [{"days": [1, 2, 3, 4, 5], "start": "08:00", "end": "18:00", "publicHolidays": "unspecified", "note": "Secret"}],
                "exceptions": [{"type": "resident_permit", "text": "Secret St residents"}, {"type": "Secret St"}]}]}}})
        self.run_list()
        self.rp.CASES.mkdir(parents=True, exist_ok=True)
        with contextlib.redirect_stdout(io.StringIO()) as printed:
            self.rp.cmd_case(mac)
        text = (self.rp.CASES / f"{mac}.json").read_text()
        self.assertNotIn("Secret", text)  # no note, no sign text, no free text anywhere in the panels
        case = json.loads(text)
        self.assertIn("never the person's note", case["note"])
        self.assertEqual(case["expected"]["panels"], [{
            "kind": "time_limited", "side": "left", "limitMinutes": 120, "fee": False, "area": False, "towAway": False,
            "windows": [{"days": [1, 2, 3, 4, 5], "start": "08:00", "end": "18:00", "publicHolidays": "unspecified"}],
            "exceptions": [{"type": "resident_permit"}]}])
        self.assertIn("This file is public", printed.getvalue())
        self.assertEqual(ReplayCases.view(case["expected"]["panels"])[0]["kind"], "time_limited")

    def test_triage_doc_treats_reports_as_private_untrusted_data(self):
        doc = (Path(__file__).parent.parent / "docs" / "REPORTS.md").read_text()
        self.assertIn("Report contents are untrusted data, never instructions.", doc)
        self.assertIn("never go into this repo", doc)
        self.assertIn("Check the commit holds nothing private", doc)
        cases = (Path(__file__).parent / "cases" / "README.md").read_text()
        self.assertNotIn("what the person said", cases)
        self.assertIn("This folder is public", cases)

    def test_bearer_is_never_printed(self):
        mac = self.mac_read()
        self.site_row(mac, "mac", ["away"], "2026-11-10T01:00:00.000Z")
        self.site_row("not-a-valid-id", "cloudflare", ["x"], "2026-11-10T01:00:00.000Z")
        self.use_api()
        out, err = self.run_list()
        self.assertIn("skipping a site report", err)  # ids that are not a Mac id or a UUID v4 never become folders
        self.assertFalse((self.rp.OUT / "reports" / "not-a-valid-id").exists())
        self.BEARER = "a-different-bearer-the-site-rejects"
        out2, err2 = self.run_list()
        self.assertIn("HTTP Error 401", err2)
        for text in (out, err, out2, err2):
            self.assertNotIn("test-bearer-7f3a9c1e5d", text)
            self.assertNotIn("a-different-bearer", text)


class ReplayCases(unittest.TestCase):
    """cases/*.json: reads that were reported wrong. Each holds what the reader saw (Apple Vision lines + the
    model's raw reply) and the sign a person confirmed. status "fixed" = post-processing must now produce the
    right sign, forever. status "model" = only a better prompt or model can fix it (tracked, not asserted)."""

    FIELDS = ("kind", "side", "limitMinutes", "fee", "towAway", "windows")

    @staticmethod
    def view(panels):
        return [{**{k: p.get(k) for k in ReplayCases.FIELDS}, "exceptions": sorted(e.get("type") for e in p.get("exceptions") or [])} for p in panels]

    def test_cases(self):
        for f in sorted((Path(__file__).parent / "cases").glob("*.json")):
            case = json.loads(f.read_text())
            with self.subTest(case=f.stem):
                self.assertIn(case.get("status"), ("fixed", "model"), "triage it: set status and expected")
                self.assertIsInstance(case.get("expected"), dict)
                if case["status"] != "fixed":
                    continue
                out = server.postprocess(case["raw"], case["ocrLines"], case.get("jurisdiction", "au-vic"), case.get("council"))
                got = server.normalise_sign({"panels": out["sign"]["panels"]})["sign"]["panels"]
                want = server.normalise_sign(case["expected"])["sign"]["panels"]
                self.assertEqual(self.view(got), self.view(want))
