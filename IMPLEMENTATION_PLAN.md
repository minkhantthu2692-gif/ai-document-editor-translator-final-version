# Phase 01 — Implementation Plan (PDF Translator)

Date: 2026-10-12 · Companion to `AUDIT_REPORT.md` (finding IDs C-xx / L-xx / U-xx refer to
it). Rules from `AGENTS.md` apply to every phase: small reviewable changes, no rewrites, no
secret exposure, no claim of success without a test that was actually run.

## 1. Principles

1. Evidence first: each task cites the finding it closes; no speculative refactors.
2. Phase boundaries are hard (`AGENTS.md`): one phase's files only, unless a documented
   dependency forces otherwise.
3. Every phase ends with: targeted tests run → full `typecheck`/`lint`/`test` → diff review
   (regressions, secrets, dead code, scope creep) → `docs/CHANGELOG.md` entry → progress
   report → final response per that phase file.
4. Provider-reported usage always beats estimates; estimates stay labelled as estimates.
5. Legibility over page-count fidelity; never silently drop or clip text.
6. UI identity is preserved; only targeted fixes.

## 2. Preconditions (before Phase 02 begins)

| # | Item | Status / action |
|---|---|---|
| P1 | Dependency install | **Done** (`npm ci`, 393 pkgs). Baseline green: `typecheck` ✅, `lint` ✅, `test` 1554 passed / 6 skipped (1 file = env-gated `src/verify/liveRun.test.ts`) |
| P2 | Version control | **Not a git repository.** Recommended: `git init` + initial commit before any code change (user decision — creates the only safe rollback mechanism). Until then, rollback = keep diffs minimal and preserve an untouched copy of each file before editing |
| P3 | Live provider keys | Not available in this environment → all Phase 02/03 provider work uses mocks/fixtures; the `VERIFY_LIVE=1` suite stays skipped and is reported as such |
| P4 | Browser/CDP | `npm run smoke` needs `npm run dev` on :5173 + local Chrome; treat as optional Phase 03/05/06 tooling, and state clearly if unavailable |
| P5 | Fixture inventory | `fixtures/`: `text-300p.pdf`, `table*.pdf`, `slide.pdf`, `scanned.pdf`, `mixed.pdf` + `fixtures/sidecar/*.json` — reuse, do not invent new private-content PDFs |

## 3. Phase 02 — API & translation pipeline (`PHASE-02-API-PIPELINE.md`)

**Goal:** close the API-usage/rate-limit findings; make usage measurable and errors
classified correctly. **Depends on:** P1-P3. **Touches:** `src/translate/*`,
`src/providers/*`, `src/workers/translation.worker.ts`, `src/pages/TranslatePage.tsx`
(diagnostics display only), tests.

Ordered tasks:

| # | Task | Closes | Acceptance check |
|---|---|---|---|
| 2.1 | Structured secret-safe diagnostics per request: request id, provider/model, key alias (masked), chunk id, attempt, duration, error category, reported vs estimated usage — extend the existing `TickMessage`/`logEvent` plumbing rather than adding a parallel system | C-10, PHASE-02 req. 1-2 | New unit test asserts a diagnostics record contains category/attempt/usage and **no** secret-shaped string; UI/status shows them without keys |
| 2.2 | Quota-vs-burst classification: prefer server `Retry-After`/reset headers; use `quotaFallbackMs` (60 min) only when no header exists and the daily hint is unambiguous | L-04 | Fixture tests: burst 429 with `Retry-After`, daily-quota 429 without headers, ambiguous body → correct cooldown window and reason code |
| 2.3 | Terminal condition for endless park/retry: count wait cycles (or run deadline); after N cycles surface a retryable failure instead of waiting forever — keep the existing ladder/backoff/jitter unchanged | L-05 | Mock transport that always 429s/5xxs → run reaches a `failed` state with a reason code within bounded cycles; a transient failure that recovers must still succeed |
| 2.4 | Compare-and-set in `persistLines`: never overwrite a block whose `status === 'edited'` (or whose `translatedAt` moved) after planning | L-06, C-06 | Test: mark block edited mid-batch → persistence keeps the edit and reports it |
| 2.5 | Non-mutating pool probe (`canPick`) used by `waitingDetail`/`isExhausted`/`availableAt` | O-01 | Test: repeated availability probes do not advance the round-robin cursor |
| 2.6 | Token-budget audit: confirm `BudgetProfile.fillTargetTokens` reserves prompt+output headroom; document estimate-vs-reported calibration; label estimates in any UI | U-02, U-05 | Budget tests already exist (`budget.test.ts`) — add one asserting `promptOverhead + fill + maxOutput ≤ model context` for representative models |
| 2.7 | Chunking/dedup verification: stable chunk ids, no overlapping content, resume only incomplete chunks | PHASE-02 req. 4-5, 10-11 | Existing `resume.test.ts` (311+) extended: duplicate submission and mid-job key addition cases from the PHASE-02 test list |

**Status (2026-10-12): all tasks complete.** 2.1 → `AttemptDiag` (executor → engine →
`BatchRunResult.attempts` → event log) + secret-safety tests. 2.2 → `http.ts` hint
tightening + `keyPool.reportRateLimit` server-deadline precedence, fixture tests both
sides. 2.3 → `maxWaitCycles` (default 12) park counter in the executor with retryable
terminal failure; stall + recovery tests. 2.4 → compare-and-set in `persistLines` via new
`blockRepo.getMany`; mid-batch-edit test in `resume.test.ts`. 2.5 → `canPick()` + cursor
probe test. 2.6 → verified **already covered** by `budget.test.ts` (no new test needed;
nothing changed). 2.7 → duplicate-submission covered by `jobQueue.test.ts:224`; mid-job
key addition pinned at pool level; partial resume already covered. One behavioral change
to note: quota-429 + `Retry-After` now waits the server window (was: 60-minute fallback) —
pinned by the split quota tests in `executor.test.ts`.

Test matrix (mocks required by `PHASE-02-API-PIPELINE.md`): valid response with usage ·
response without usage · 429 with retry-after · invalid key · daily quota · context/output
limit · timeout/network · duplicate trigger & duplicate chunk · multiple keys with
different cooldowns · shared quota (`quotaScope:'per-provider'`) · add key mid-job +
partial resume · retry cap · cancellation. Map each to at least one test; record any case
the current architecture cannot represent.

Measurement (before/after where measurable): `requests`, `retries`, `tokensIn/Out`
already published per run (C-10) → record baseline numbers from a mock run, then after
2.2/2.3/2.6. Never claim provider quota changes.

**Rollback:** each task is isolated in one module with its own test; revert the file(s) +
test. 2.3 is the riskiest (could stop a run that previously recovered) → gate it behind the
existing reason-code machinery and keep the default N high.

**Exit:** root causes addressed or marked unresolved with evidence; retry/rotation/resume
have targeted tests; usage measurable; error classes distinguishable; `typecheck`/`lint`/
`test` pass. Then report per PHASE-02's "Final Response Required".

## 4. Phase 03 — PDF export & layout (`PHASE-03-PDF-EXPORT.md`)

**Goal:** readable, valid translated PDF; no duplicated/overlapped/clipped text; verified
Myanmar rendering. **Depends on:** Phase 02 exit (the file states "inspect the current
post-Phase-02 document data model"). **Touches:** `src/pdf/pageRender.ts`,
`src/workers/analysis.worker.ts`, `src/export/{composite,html,reflow,pdfRaster,runExport}.ts`,
`src/workers/export.worker.ts`, `src/fonts.ts`, export tests + fixtures.

Ordered tasks:

| # | Task | Closes | Acceptance check |
|---|---|---|---|
| 3.1 | Extend background erasure to OCR/scanned text: pass stored block (or OCR line) bboxes to the analysis worker render as extra erase boxes; keep `cutOut` figure handling intact; decide per-`contentClass` behaviour and document it | L-01, C-02, L-10 | Unit test: a page with no text layer but OCR blocks yields erased regions; `mixed.pdf` figures still intact (visual check) |
| 3.2 | Raster overlap handling: always compute reflow for *reporting* (emit `EXPORT_LAYOUT_CLIPPED` with count) while `adjustLayout` stays off by default; clamp painted lines to the box and honour `block.overflow` in `composite.ts` | L-02, C-03 | `composite.test.ts` gains: default options + non-fitting block → issue reported, geometry unchanged; `adjustLayout:true` behaviour unchanged |
| 3.3 | Register fonts in the export worker before measuring/drawing (`new FontFace` + `self.fonts.add` from `collectFontFaces` URLs); verify HTML-path measurement and raster-path drawing agree | L-03, C-04 | Test: worker font load failure degrades gracefully (documented fallback, `EXPORT_FONT_MISSING`-style issue), never throws; visual Myanmar check on a raster page |
| 3.4 | Erasure quality: bound ring-median repaint (variance threshold / feathering) so figures don't get flat rectangles | L-07 | Test on `slide.pdf`/`mixed.pdf` page image — visual |
| 3.5 | Fit/reflow policy review: verify auto-fit floor (6 pt) is the only shrink, overflow always continues rather than disappears; confirm page-count growth is allowed where the pipeline supports it | PHASE-03 req. 5-6 | Overflow fixture → no text omitted; `EXPORT_LAYOUT_CLIPPED` detail text names the count |
| 3.6 | Myanmar Unicode verification: shaping, stacked diacritics, Zawgyi detection/conversion path (`core/zawgyi.ts`) on actual output; font embedding/licensing notes | PHASE-03 req. 8 | Rendered pages inspected (see 3.7); `dev/myanmar-test` route as a manual aid |
| 3.7 | **Rendered-page validation** using fixtures: `text-300p.pdf`, `table*.pdf`, `slide.pdf`, `scanned.pdf`, `mixed.pdf` + a short EN→Myanmar growth case. Export → open → render to images (`scripts/diagnose-render.mjs` or browser) → inspect for duplicate/overlap/clipped/missing glyphs; record results honestly | U-03, PHASE-03 tests | A written table: fixture → format (`pdf`, `pdf-raster`) → result; "not inspected" stated where it applies |

**Guardrails:** no promise of pixel-perfect reconstruction; never overlay on un-erased
original text without a removal strategy (that *is* 3.1); no silent overflow omission; UI
changes limited to surfacing export warnings.

**Rollback:** 3.1/3.4 modify the shared background render used by workspace thumbnails —
keep `mode:'thumbnail'` untouched and gate new erase behaviour behind `mode:'background'`;
revert by file. 3.3 must keep the failure path (missing font → warning, not crash).

**Exit:** exported PDFs valid/readable in tested cases; longer text wraps or adds pages;
no unintended duplicates in inspected outputs; Myanmar verified on real pages; limitations
for complex/scanned PDFs documented. Then report per PHASE-03.

**Status (2026-10-13): complete.** All seven tasks landed as scoped commits (3.1-3.6) plus
the validation harness (3.7, `scripts/validate-export.mjs`). C-02/L-01, C-03/L-02,
L-03/C-04, L-07 and L-10 are closed or mitigated with tests + inspected renders; U-03 is
closed. The 3.7 inspection also found and fixed a pre-existing HTML-export defect (quoted
font stack broke the block `style` attribute, dropping font-size/color/weight for
html/pdf/bilingual-pdf/print). The acceptance table and per-page results live in the phase
notes; known limitations (clamp clips at 6pt instead of reflowing; scanned inpaint
contrast trade-off; OFL note pending) are recorded in `AUDIT_REPORT.md` §7.2 and
`docs/CHANGELOG.md`. **Phase 04 may proceed.**

## 5. Phase 04 — Pre-export editor (`PHASE-04-EDITOR.md`)

**Goal:** prove the existing editor is real, discoverable, and that its edits survive
export; fill only genuine gaps. **Depends on:** Phase 03 (position editing is
export-strategy-dependent). **Touches:** `src/pages/workspace/*`, `src/editor/*`, export
round-trip tests.

| # | Task | Closes | Acceptance check |
|---|---|---|---|
| 4.1 | Discoverability verdict: document how the editor is reached, why `/workspace` (bare) hides it (C-11/L-09 lands here only if 5.x hasn't run yet), and confirm the mount condition `blockCount > 0` | C-11, PHASE-04 "Inspect First" | Written answer + a test/route assertion |
| 4.2 | Round-trip test: edit text/font/size/position → navigate away/back → persists → export → exported artifact contains the edit | C-05, PHASE-04 tests | Test in `WorkspaceEditor.test.tsx` + an export assertion (`runExport` on a fixture project with an edited block) |
| 4.3 | Late-response race: ensure a translation finishing after an edit cannot overwrite it (pairs with 2.4) | L-06 | Same test as 2.4 plus an editor-side assertion |
| 4.4 | Overflow/unsaved-state: verify `overflow` badges, unsaved indicator, keyboard shortcuts, undo/redo already present — test and document rather than rebuild | PHASE-04 required features | Existing tests extended; shortcuts documented |

**Guardrails:** no visual-only mock, no second document model, no professional-grade
extras, design language preserved.

**Rollback:** additive tests mostly; any editor change reverts per file.

**Exit:** a user can edit and verify the change in the final PDF (test evidence), or the
gap is documented with a minimal fix in this plan.

**Status (2026-10-13): complete.** 4.1 answered in AUDIT §7.3 (five entry points; mount
gate `blockCount > 0` confirmed) and pinned by `WorkspacePage.test.tsx` route tests. 4.2
landed as the WorkspaceEditor/BlockInspector round-trip tests (collect →
buildHtmlDocument — the boundary jsdom can run, since `runExport` needs a `Worker`)
plus a browser edit round-trip in the harness: real UI edit → `runExport` → marker
asserted in the print HTML *and* in the printed PDF's text layer → Ctrl+Z restores the
original; full plan 7/7 `edit:ok`. 4.3: editor-side `status: 'edited'` assertion added,
pairs with 2.4. 4.4 verified, not rebuilt: overflow badge, typing guard, undo/redo,
shortcut map documented and pinned (inert Ctrl+S removed); no unsaved state exists by
design (autosave-on-commit), `busy.autosave` key flagged for 5.x. Geometry editing added
as numeric X/Y/W/H fields through the command stack (the position/size brief item).

## 6. Phase 05 — UI/UX polish (`PHASE-05-UI-UX.md`)

**Goal:** targeted fixes only, identity preserved. **Depends on:** Phases 02-04 (controls
they added must be real). **Touches:** `src/components/layout/*`, `src/pages/*` (small),
`src/index.css` (minimal).

| # | Task | Closes | Acceptance check |
|---|---|---|---|
| 5.1 | Fix the `/workspace` dead-end: redirect to the most recently opened project or show a picker (do not invent a new page) | L-09, C-11 | Route test: `/workspace` with ≥1 project never shows "create your first project" |
| 5.2 | Add an in-flight guard to `handleStart` (disable while `startTranslate` is pending) | L-08 | Component test: rapid double activation triggers one start |
| 5.3 | Scroll/blank-space audit of the real workflow (Import → Translate → Edit → Export) at ≥1024 px and narrow viewports: `AppShell` single scroll region, `PageLayout` inspector `xl:overflow-y-auto`, editor card `h-[70vh] overflow-hidden` inner scroller | PHASE-05 audit list | Visual checks recorded at multiple viewport heights; no clipped content, no accidental blank region |
| 5.4 | Confirm every visible control performs its action (already no inert controls found in the status panel — verify new diagnostics from 2.1 are wired, not decorative) | PHASE-05 req. 5 | Click-through checklist |
| 5.5 | Accessibility pass: focus order, keyboard operation, labels for the controls touched in 5.1-5.4 | PHASE-05 req. 10 | Manual keyboard run + existing a11y tests |

**Rollback:** each UI change is a small diff; revert individually. Do **not** restyle.

**Status (2026-10-13): complete.** 5.1 landed as a `<Navigate replace>` into the most
recently opened non-archived project (pinned by three route tests, and confirmed in the
real browser over CDP); the create-project empty state now means "nothing to open".
5.2 landed as a synchronous `startBusyRef` guard in `handleStart` plus a disabled
`startBusy` state on Start/Resume/Fix/Retry, pinned by a new `TranslatePage.test.tsx`
(queue mocked at the module boundary). 5.3 was recorded as a CDP audit — 8 routes × 4
viewports (1440×900, 1024×768, 820×1180, 390×844): one document-scroll region
everywhere, no horizontal overflow in any of the 32 combinations, no console exceptions,
clean 390 px collapse; the audit surfaced a real defect (mixed-script UI strings rendered
as tofu because `--font-sans` carried no Myanmar family) which is fixed by listing the
already-bundled `@fontsource` families. 5.4: no inert `onClick` stubs or "coming soon"
markers exist, the Phase 02 diagnostics render live values, and the Logs total was
re-derived from the severity counts (a capped list read understated it). 5.5: a browser
tab-crawl put "Skip to main content" first and showed the 2 px focus ring on 12/12 stops.
Also closed: the recurring `ProjectsPage` bulk-delete flake (two independent React update
lanes; the assertion now waits) and the vestigial `editor.busy.autosave` kind. No
export-affecting code changed, so the Phase 04 harness evidence stands.

## 7. Phase 06 — Regression & release readiness (`PHASE-06-TEST-RELEASE.md`)

1. Run the real commands and record results: `npm run lint`, `npm run typecheck`,
   `npm test`, `npm run build`; add `npm run smoke` if a dev server + Chrome are available
   (otherwise state it).
2. Render and inspect representative PDFs (from 3.7).
3. Diff review: secrets, debug leftovers, dead code, duplicate logic, unrelated changes.
4. Update `docs/CHANGELOG.md`, `AUDIT_REPORT.md`, relevant setup docs.
5. Create `FINAL_VERIFICATION.md` with: what was fixed · commands actually run + results ·
   fixtures rendered/inspected · before/after API metrics · known limitations · safe setup
   steps · manual verification the user must perform.

Guardrails: never mark unrun tests as passed; never claim visual correctness from a green
build; document any feature removed for tests.

## 8. Cross-phase test & measurement matrix

| Concern | Tooling already present | Gap to fill |
|---|---|---|
| Unit/integration | 104 Vitest files, 1560 tests, jsdom setup | Mock cases listed in §3 (esp. shared-quota, context-overflow, add-key-mid-job) |
| Live provider | `src/verify/liveRun.test.ts` (env-gated, 6 tests) | Not runnable without keys — always report as skipped |
| PDF visuals | `fixtures/*`, `scripts/diagnose-render.mjs`, `scripts/make-fixtures.mjs` | Rendered-page inspection table (3.7) |
| End-to-end UI | `scripts/smoke.mjs` (CDP, needs dev server + Chrome) | Run in Phase 06 if environment allows |
| Usage metrics | `TranslateProgress{requests,retries,tokensIn,tokensOut,rpm}` + live-run telemetry | Baseline vs post-Phase-02 numbers from mock runs |

## 9. Reporting obligations (every phase)

- `docs/CHANGELOG.md` entry under `Unreleased` (Keep a Changelog format, newest first).
- Update `AUDIT_REPORT.md` statuses (Likely → Confirmed-fixed / Unresolved-with-evidence).
- Final response lists: files inspected/changed, tests actually run + results, unresolved
  issues, next-phase recommendation — exactly as each `PHASE-*.md` requires.

## 10. Out of scope / explicitly not planned

- No provider quota increase or bypass attempt (impossible anyway) — provider limits and
  terms are respected throughout.
- No library replacement (`pdfjs-dist`/`pdf-lib` stay), no architecture rewrite, no
  deletion of features.
- No broad UI redesign, no new UI framework.
- No "unlimited translation" claims anywhere in copy or docs.
