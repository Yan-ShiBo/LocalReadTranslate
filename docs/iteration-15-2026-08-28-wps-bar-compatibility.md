# WPS bar-accent compatibility — userscript 1.15.8

## Cause

The copied source `$\bar v$` is valid LaTeX. In WPS Writer
12.1.0.28043, however, the built-in LaTeX editor preview loses the bar when the
single argument has no braces. This also happens without the surrounding
dollar signs. Replacing the source with `\bar{v}` restores the bar.

The user-provided WPS export `\textbf{\textit{\overbar{v}}}` is not the required
replacement: it includes font styling, while the missing argument braces are
enough to reproduce and resolve the reported import problem.

## Repair

- Both the userscript and the document add-in reading core normalize bar
  arguments at the existing copy-text boundary.
- `$\bar v$` copies as `$\bar{v}$`; `\bar v_z` becomes `\bar{v}_z`, not
  `\bar{v_z}`. Only one unambiguous letter, number, or known symbol is grouped.
- Existing groups and other accent commands are retained. Unknown macros and
  parameter-taking commands are not guessed. No bold/italic styling is added
  or removed, and `\bar` is not globally replaced with `\overbar`.
- Prose, text-command groups, verbatim contents, comments, and escaped
  delimiters do not acquire new braces. Escaped delimiters cannot hide a
  following real formula.
- Inline/display delimiters are still canonicalized by the existing copy path.
  The source in the webpage DOM is not changed.

This is a client-side compatibility fix; backend version 1.7.20 is unchanged.
There is no new runtime dependency.

## Verification

- Reproduced the original failure in a newly created WPS test document, without
  modifying existing user documents. Compared `\bar v` and `\bar{v}` both with
  and without dollar signs. Applied the braced source with WPS's preview
  conversion shortcut and visually verified that the native equation retained
  the bar after leaving the equation editor.
- The two actual copy entry points first failed their minimal regression
  assertion, returning `$\bar v$` instead of `$\bar{v}$`.
- Review caught literal-text regressions; ten explicit failing assertions for
  verbatim contents, escaped dollars, and text commands with intervening
  comments then passed after the boundary handling was tightened.
- `pnpm test`: 179 passed, including 68 bar-compatibility cases across the two
  cores and 31 DOM selection tests. The DOM tests cover the new inline and
  partial-display bar selections as well as the previous root/fraction fix.
- Literal dollars at the end of inline math are retained. Delimiter scanning
  rejects escaped openers before searching for a close, avoiding repeated
  suffix scans on long price-like prose.
- Independent rechecks passed all 36 delimiter assertions. A 64k-character
  escaped-price probe took approximately 1.7–3.6 ms on the test machine after
  the scanner correction, down from approximately 1.3 seconds during review.
- `node --check` passes for both production JavaScript files.
- `tests/test_document_formula.py`: 14 passed using Pandoc 3.8 with
  `PANDOC_PATH` set for the test process. This also confirms that the unchanged
  native-formula backend remains functional.
- `scripts/sync_catalog.py --check` and the two backend-independent catalog
  tests passed.
- The server-importing release metadata pytest could not collect because the
  available Python environment lacks `soundfile`. The expected userscript
  version was updated to 1.15.8; the backend version was not changed.

On 2026-08-28, the user independently verified that the fix works and requested
publication to GitHub.

## Updating the installed script

Replace the installed Tampermonkey script with the complete local
`tts-userscript.js`, or open the local installer link from
`node scripts/serve_formula_copy_fixture.cjs` and confirm the update yourself.
Check for version 1.15.8, then reload the ChatGPT page. Editing the repository
alone does not update Tampermonkey's stored copy.

The copy output keeps `$...$` / `$$...$$` for document workflows. When entering
the expression directly inside an existing WPS LaTeX equation field, use
`\bar{v}` without the outer dollar delimiters.
