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
