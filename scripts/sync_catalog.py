import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "config" / "tts_catalog.json"
USERSCRIPT_PATH = ROOT / "tts-userscript.js"
START_MARKER = "  /* CATALOG:START */"
END_MARKER = "  /* CATALOG:END */"


def render_catalog(catalog):
    payload = json.dumps(catalog, ensure_ascii=False, separators=(",", ":"))
    return (
        f"{START_MARKER}\n"
        f"  const TTS_CATALOG = {payload};\n"
        f"{END_MARKER}"
    )


def synchronized_userscript():
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    userscript = USERSCRIPT_PATH.read_text(encoding="utf-8")
    start = userscript.index(START_MARKER)
    end = userscript.index(END_MARKER) + len(END_MARKER)
    return userscript[:start] + render_catalog(catalog) + userscript[end:]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail when the generated userscript catalog is stale.",
    )
    args = parser.parse_args()

    synchronized = synchronized_userscript()
    current = USERSCRIPT_PATH.read_text(encoding="utf-8")
    if args.check:
        if synchronized != current:
            raise SystemExit(
                "tts-userscript.js catalog is stale; run scripts/sync_catalog.py"
            )
        return

    USERSCRIPT_PATH.write_text(synchronized, encoding="utf-8")


if __name__ == "__main__":
    main()
