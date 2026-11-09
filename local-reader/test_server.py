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
    """Every read is logged; a report copies it to reports/ and pushes it to the reader-reports branch."""

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
        log = server.ReadLog(self.base, remote=str(self.remote))
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
        log = server.ReadLog(self.base, remote=str(Path(self.tmp.name) / "missing.git"))
        rid = server.Reader("fake", 10, fake=True, log=log).read(b"x", "au-vic", None)["readId"]
        res = log.report(rid, {"note": "n"})
        self.assertTrue(res["saved"]); self.assertFalse(res["uploaded"])
        log.remote = str(self.remote)
        self.assertEqual(log.sync()[0], True)
        self.assertIn(f"reports/{rid}/report.json", self.remote_files())

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
