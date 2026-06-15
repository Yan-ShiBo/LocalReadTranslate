import json
from pathlib import Path


CATALOG_PATH = Path(__file__).resolve().parent / "config" / "tts_catalog.json"


def load_catalog(path=CATALOG_PATH):
    with open(path, "r", encoding="utf-8") as catalog_file:
        catalog = json.load(catalog_file)

    voice_ids = [
        voice["id"]
        for group in catalog["groups"]
        for voice in group["voices"]
    ]
    if not voice_ids or len(voice_ids) != len(set(voice_ids)):
        raise ValueError("Voice IDs must be present and unique")
    if catalog["default_voice"] not in voice_ids:
        raise ValueError("Default voice must exist in the catalog")
    if catalog["default_speed"] not in catalog["speeds"]:
        raise ValueError("Default speed must exist in the speed list")
    return catalog


CATALOG = load_catalog()
DEFAULT_VOICE = CATALOG["default_voice"]
DEFAULT_SPEED = CATALOG["default_speed"]
SPEEDS = CATALOG["speeds"]
VOICE_GROUPS = CATALOG["groups"]
AVAILABLE_VOICES = {
    voice["id"]
    for group in VOICE_GROUPS
    for voice in group["voices"]
}
VOICE_LANG_CODES = {
    voice["id"]: group["lang_code"]
    for group in VOICE_GROUPS
    for voice in group["voices"]
}
