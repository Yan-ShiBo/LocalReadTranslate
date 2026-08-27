# ChatGPT formula copy repair — userscript 1.15.7

## Cause

The live ChatGPT page retained the full LaTeX in an outer `data-math-source`
and `role="math"` wrapper, while the inner KaTeX output contained only visual
HTML. The userscript recognized the inner KaTeX node but not its source owner.
It therefore flattened the formula through `textContent` before wrapping it
in display delimiters. The reported radius formula copied as `ρz=πAz,`.

## Repair

- Recognize usable source wrappers and retain them when expanding partial selections.
- Prefer the explicit original source over rendered glyphs and accessibility prose.
- Preserve the display/inline mode when the source is outside the renderer container.
- Do not let empty source attributes, generic role labels, or descriptive wrappers
  replace existing descendant LaTeX, MathML, or MathJax formulas.
- Share the production selection path through `createSelectionTools` so real DOM
  Range/Selection tests can exercise it without starting the userscript UI.

The installed userscript has no new runtime dependency. jsdom is test-only.

## Verification

- Clicking the old installed Copy button on the user's original ChatGPT formula
  reproduced the reported string in the system clipboard.
- The sanitized real DOM fixture reproduced the same failure before the fix;
  both full and partial selection checks pass in the browser after the fix.
- `pnpm test`: 109 passed, including 29 DOM selection regression tests.
- `node --check tts-userscript.js`: passed.
- `python -E scripts/sync_catalog.py --check`: passed; two independent catalog
  tests passed. Backend-dependent Python checks could not complete because the
  available Python environment lacks `soundfile` and `fastapi`; backend code is unchanged.
- `git diff --check`: passed.

On 2026-08-27, the user completed the manual Tampermonkey update and confirmed
that copying formulas now works. This installed-script acceptance result was
reported by the user; the automated browser checks above used the local fixture.

Run `node scripts/serve_formula_copy_fixture.cjs` for the local browser fixture
and a local userscript update link. Close stale installer confirmations and
open the link again after code changes so the installer reads the final file.
