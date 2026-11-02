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
