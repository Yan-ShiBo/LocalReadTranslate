import json
import unittest
from pathlib import Path

import tts_catalog


ROOT = Path(__file__).resolve().parents[1]


class CatalogTests(unittest.TestCase):
    def test_catalog_has_unique_voices_and_valid_defaults(self):
        catalog = tts_catalog.load_catalog()
        voice_ids = [
            voice["id"]
            for group in catalog["groups"]
            for voice in group["voices"]
        ]

        self.assertEqual(len(voice_ids), len(set(voice_ids)))
        self.assertIn(catalog["default_voice"], voice_ids)
        self.assertIn(catalog["default_speed"], catalog["speeds"])
        self.assertEqual(len(voice_ids), 17)

    def test_userscript_generated_catalog_matches_source(self):
        catalog = tts_catalog.load_catalog()
        userscript = (ROOT / "tts-userscript.js").read_text(encoding="utf-8")
        self.assertIn("/* CATALOG:START */", userscript)
        self.assertIn("/* CATALOG:END */", userscript)
        start = userscript.index("/* CATALOG:START */") + len("/* CATALOG:START */")
        end = userscript.index("/* CATALOG:END */")
        generated = userscript[start:end].strip()
        prefix = "const TTS_CATALOG = "

        self.assertTrue(generated.startswith(prefix))
        userscript_catalog = json.loads(generated[len(prefix):].removesuffix(";"))
        self.assertEqual(userscript_catalog, catalog)

    def test_server_and_tray_use_catalog_defaults(self):
        import server
        import tray_app

        catalog = tts_catalog.load_catalog()
        voice_ids = {
            voice["id"]
            for group in catalog["groups"]
            for voice in group["voices"]
        }

        self.assertEqual(server.AVAILABLE_VOICES, voice_ids)
        self.assertEqual(tray_app.DEFAULT_VOICE, catalog["default_voice"])
        self.assertEqual(tray_app.SPEEDS, catalog["speeds"])


if __name__ == "__main__":
    unittest.main()
