# Phase 01 — Audit Report (PDF Translator)

Date: 2026-10-12 · Phase: 01 (audit/report only — no production code was changed)
Read together with: `AGENTS.md`, `PHASE-01-AUDIT.md`, `IMPLEMENTATION_PLAN.md`.

## 1. Scope and method

- Read `AGENTS.md` and `PHASE-01-AUDIT.md` in full before any action.
- Inspected the project tree, `package.json`, `tsconfig.json`, `vite.config.ts`, docs,
  routes, state stores, workers, PDF extraction/OCR, chunking, translation orchestration,
  key pool, provider adapters, export pipeline, editor, and CSS/layout.
- Traced the two required end-to-end flows (task 3) — see §4.
- Evidence labels used below:
  - **Confirmed** — verified by reading the code path and/or running a command; the cited
    line/function exists and behaves as described.
  - **Likely** — mechanism confirmed in code, but the runtime/visual outcome was **not**
    observed in this environment (no browser render, no live provider call).
  - **Unknown** — cannot be judged without credentials, a browser, or sample data.
- No secrets appear in this report. API keys were never present in the environment.
- No application code, dependency, or file was modified. The only environment action was
  installing dependencies so the mandated scripts could run (see §5).

## 2. As-built architecture (verified, not assumed)

| Layer | Actual implementation | Evidence |
|---|---|---|
| Framework | React 18.3 + TypeScript + Vite, `"type": "module"` | `package.json` |
| Tests | Vitest 3.2.7 (`vitest run`), jsdom setup | `vite.config.ts:113-117` |
| Storage | Dexie 4 (IndexedDB), Zustand stores, Dexie live queries | `src/db/db.ts`, `src/stores/*` |
| PDF read | `pdfjs-dist` 6.4.299 inside an analysis worker (`OffscreenCanvas`, `disableFontFace`) | `src/workers/analysis.worker.ts`, `src/pdf/pdfAssets.test.ts:15` |
| PDF write | `pdf-lib` 1.17.1 **only** for `pdf-raster`; `pdf`/`bilingual-pdf` are print-HTML → hidden iframe → browser print-to-PDF | `src/export/pdfRaster.ts:15`, `src/export/runExport.ts:283-291`, `src/export/printFrame.ts` |
| OCR | `tesseract.js` 7 + optional sidecar/proxy extraction | `src/pdf/ocr/*`, `src/sidecar/*` |
| Export formats | `pdf`, `bilingual-pdf`, `html`, `markdown`, `text`, `csv`, `tsv`, `json`, `docx`, `epub`, `pdf-raster`, `images` | `src/export/types.ts:24-32`, `src/workers/export.worker.ts:205-347` |
| Workers | `analysis.worker`, `translation.worker` (key unsealing + provider calls), `export.worker` (byte-heavy formats) | `src/workers/*` |
| Routing | `/`, `/welcome`, `/projects`, `/projects/new`, `/workspace`, `/workspace/:projectId`, `/translate/:projectId`, `/settings`, `/knowledge`, `/logs`, `/dev/myanmar-test` | `src/App.tsx:35-47` |
| i18n | i18next, `en.json` + `my.json` | `src/i18n/locales/*` |
| Fonts | `@fontsource` CSS on the main thread; export embeds `@font-face` with data URLs | `src/styles/fonts.ts`, `src/fonts.ts:179-222` |

Commands: `npm run dev | build | preview | test | lint | typecheck | format | smoke`.

## 3. End-to-end flow A — import → extract → normalize → chunk → translate → store → preview/edit → export

1. **Import/parse** — `WorkspacePage.tsx` drives a `PipelineMachine` (`src/core/fsm.ts`);
   the analysis worker opens the PDF and extracts blocks (`src/pdf/pdfExtract.ts`,
   `lineGrouping.ts`, `structure.ts`), classifies pages
   (`contentClass: 'text'|'scanned'|'mixed'|'complex'|'empty'`, `src/pdf/pageClassify.ts`)
   and writes `pageRepo`/`blockRepo` rows to Dexie.
2. **Text-less pages** — OCR (`src/pdf/ocr/*`) or sidecar extraction produce the same block
   rows; `pageNeedsOcr()` gates it (`src/db/types.ts:83-85`).
3. **Chunk** — `translateQueue.buildTranslatePlan()` reads all blocks, groups per page,
   classifies each block (`src/translate/translateQueue.ts:186-194`) and builds batches via
   `src/translate/batching.ts` (`maxLines 25`; token budget from
   `BudgetProfile.fillTargetTokens`, `src/translate/budget.ts:190`, default `maxTokens 1500`).
4. **Translate** — round-robin across pages through an adaptive limiter
   (`AdaptiveLimiter`, `src/translate/concurrency.ts`: ceiling 3, initial 2, halve at
   30% error rate) with a per-page mutex; each batch goes
   `translation.worker → engine.ts (prompt, validation, repair ladder) → executor.ts
   (key lease, retry) → providers/{openaiCompat,gemini}.ts → http.ts`.
5. **Store** — `persistLines()` (`translateQueue.ts:598-643`) writes `translatedText`,
   `status:'translated'`, confidence/flag, timestamps and the auto-fit layout patch back to
   `blockRepo` after every batch; key state is persisted via `persistKeyStates()` (`:863`).
6. **Progress** — `TickMessage` per round trip (`src/translate/protocol.ts:99-110`) →
   `publish()` → `TranslateProgress` (requests/retries/tokens/RPM/masked key) →
   `TranslatePage.tsx:943-961` renders it; events go to the log page through `logEvent`.
7. **Preview/edit** — `WorkspaceEditor` (`WorkspacePage.tsx:275`, mounted only when
   `blockCount > 0`) edits through `src/editor/commands.ts` → `commitCommand()` →
   `blockRepo.update()` (Dexie), with undo/redo, find/replace, font controls, overflow
   badges (`src/editor/*`).
8. **Export** — `ExportDialog` → `runExport()` (`src/export/runExport.ts:158`) →
   `collectExportDocument()` (reads **the same** `blockRepo` rows, `src/export/collect.ts:55`)
   → `export.worker` builds the format → `deliverExport()` (`runExport.ts:283`): PDF paths
   print through a hidden iframe, everything else downloads.

## 4. End-to-end flow B — add key → choose key/model → request → classify → rotate/cooldown/retry → resume

1. **Add key** — `src/pages/settings/ProvidersTab.tsx` → `apiKeyRepo`; secrets are sealed
   with WebCrypto (`src/db/keyBundle.ts`, `src/core/crypto.ts`).
2. **Open run** — `startTranslate()` (`translateQueue.ts:978`): refuses zero enabled keys
   (`NO_API_KEY`), stops any prior run, `resetTokenScale()`, loads glossary, builds the
   plan, `modelChain()` = selected model + fallback chain, `limitsFor()` maps the model spec
   to RPM/TPM/RPD/TPD (defaults 30 / 100k / 1k / `tpd 0` = never block).
3. **Unseal + pick** — `translation.worker.ts` unseals the secret, `KeyPool.pick()`
   (`keyPool.ts:378`) filters by enabled/invalid/cooldown/capacity (RPM, TPM, RPD, TPD
   buckets; `quotaScope` `per-key` vs `per-provider`) and rotates round-robin or least-used.
4. **Request** — adapters build the call; every error path passes `secrets:[key]` to
   `redactSecret()` (`http.ts:37,104,128,148`).
5. **Classify** — `statusToKind()` (`http.ts:89-94`): 401 unauthorized, 403 forbidden,
   404 model_missing, 429 → `looksLikeQuota()` body regex (`http.ts:71-92`, daily hints
   first, then burst hints, then generic quota), 400/422 bad_request, 408/425/5xx server.
   `parseRateLimitHeaders()` normalises `Retry-After`/reset windows
   (`src/providers/rateLimit.ts:142`).
6. **Rotate/cooldown** — `reportRateLimit()` (`keyPool.ts:529`) = exponential backoff
   (base 2 s, cap 5 min) ±25% jitter, then server deadlines can only *lengthen* it
   (`Retry-After` > token-window reset > request-window reset); quota without a hint parks
   `quotaFallbackMs` = 60 min (`:201,547-548`); `reportTransient()` for 5xx
   (`:575`); `markInvalid()` for 401/403 (`:592`).
7. **Retry** — `engine.ts` ladder: attempt → halved budget → per-line singles → repair
   prompt → split rescue → keep original (`engine.ts:258-317`); `executor.ts` loops with
   `maxConsecutiveFailures = 30` (`:187`), throws immediately on bad_request/unknown,
   parks with `waitingDetail()` when no key is usable (`:311-335`).
8. **Waiting UI** — `waitingWindow` labels the reason (`minute`/`day`/`cooldown`,
   `keyPool.ts:30-43`); "Try now" calls `tryNowTranslate()` (`translateQueue.ts:1195`) =
   `clearCooldowns()` (guessed windows only — bucket counters untouched) + `runner.wake()`.
9. **Resume** — Dexie is the source of truth; `restoreTranslate()` (`:1108`) early-returns
   if a live run exists, rebuilds pending work from block status, and only auto-starts from
   a `running` snapshot. Already `translated`/`edited` blocks are "done" (`:193`), so
   completed chunks are not retransmitted.

## 5. Diagnostics actually run (real results)

| Command | Result |
|---|---|
| `git status` | `fatal: not a git repository` — the project is **not** under version control |
| `npm run typecheck` / `lint` / `test` (first attempt) | **Failed**: `node_modules` missing → `'tsc'/'vitest'/'eslint' is not recognized` |
| `npm ci --no-audit --no-fund` | Succeeded: 393 packages in 35 s. Note: `tesseract.js@7.0.0` install script blocked by `allowScripts` policy (documented npm warning; OCR still runs at runtime, not build time) |
| `npm run typecheck` (`tsc --noEmit`) | **Passed** (exit 0, no diagnostics) |
| `npm run lint` (`eslint .`) | **Passed** (exit 0, no findings) |
| `npm test` (`vitest run`) | **Passed**: 103/104 test files passed, 1 skipped; 1554/1560 tests passed, 6 skipped; duration 129.85 s |
| `npx vitest run src/verify/liveRun.test.ts` | 1 file, 6 tests **skipped** — confirms the skipped file is the env-gated live suite (`VERIFY_LIVE=1`, `OR_KEY*`/`GROQ_KEY*`), not a failure |
| `npm run smoke` | **Not run** — requires `npm run dev` on :5173 plus a local Chrome CDP path (`scripts/smoke.mjs:11-21`). Documented limitation |

Not run on purpose: any live provider request (no credentials; Phase 01 forbids inventing
results), any PDF render/visual inspection (requires a browser; Phase 03 scope).

## 6. Findings — Confirmed

Severity: **H** = high, **M** = medium, **L** = low. "Fix phase" maps to the phase files.

### C-01 · Environment: dependencies were absent (H, resolved)
All three mandated scripts failed on a clean checkout because `node_modules` did not exist.
Fixed by `npm ci` (safe, non-destructive). Baseline for every later phase: typecheck, lint
and 1554 tests pass. Risk if skipped: "tests fail" reports that are really install issues.

### C-02 · Text erasure covers only the pdf.js text layer (H → Phase 03)
- **Where**: `src/pdf/pageRender.ts` — `textBoxes()` (`:139-173`) builds erase boxes from
  `page.getTextContent()`; `renderPage()` inpaints only those boxes when
  `maskText: true` (`:259-263`). `src/export/pageImages.ts` always requests
  `mode:'background'`; `src/workers/analysis.worker.ts:566` sets
  `maskText: entry.mode === 'background'`.
- **Evidence**: for an image-only page `getTextContent()` yields no runs → `boxes = []` →
  nothing is erased. `contentClass` is carried into `ExportPage` (`src/export/types.ts:165`)
  but is never read by any renderer (`html.ts`, `composite.ts`: 0 matches for
  `scanned|ocr` in `src/export`), and `composite.ts:drawBlock` paints `fillText` with no
  backing chip while `.block` CSS has no background (`html.ts:440-451`).
- **Consequence**: on scanned/OCR pages the original-language text stays in the background
  image and the translation is painted directly on top → duplicated/overlapping text.
- **Status**: mechanism confirmed by code; the rendered pages were **not** inspected
  (see U-03). Risk of fixing badly: masking the wrong rectangles would erase figures.

### C-03 · Raster export reports no layout problem and can paint past a box (H → Phase 03)
- **Where**: `DEFAULT_EXPORT_OPTIONS.adjustLayout = false` (`src/export/types.ts:228`);
  `composite.ts:layoutBlocks` returns immediately when `adjustLayout !== true`
  (`:127`, skipping `reflowBlocks`); `export.worker.ts:322/335` builds
  `layoutReporter(issues, options.adjustLayout)`, which is `null` when off (`:129-130`) →
  `reportLayout()`/`EXPORT_LAYOUT_CLIPPED` never fire for `pdf-raster`/`images`.
- Meanwhile `drawBlock` (`composite.ts:101-105`) writes **every** fitted line with no
  height clamp, and `fitBlockText` bottoms out at `FIT_MIN_SIZE = 6`
  (`src/editor/autofit.ts:59`) returning `fits:false` — so text that still does not fit
  overruns its box onto the block below, with no issue raised. The `block.overflow` flag is
  rendered only in HTML (`html.ts:244,453`) and stats (`shared.ts:361`); `composite.ts`
  never reads it.
- **Contrast (healthy)**: the HTML/print path always reflows and always reports
  (`html.ts:284`, `export.worker.ts:222-243` → `EXPORT_LAYOUT_CLIPPED` with a count), and
  `ExportDialog.tsx:199-210` surfaces it.
- **Status**: code path confirmed; visual outcome not rendered.

### C-04 · No font is ever registered in a worker scope (H → Phase 03)
- **Evidence**: no `FontFace` constructor or `fonts.add()` exists anywhere in `src`
  (grep: only the `FontFaceInfo` *type* name). Fonts are installed solely through
  main-thread `@fontsource` CSS (`src/styles/fonts.ts`). The export worker measures with
  `ctx.font` family strings on an `OffscreenCanvas` (`composite.ts:84`,
  `autofit.ts:272-295`) and HTML export embeds `@font-face` **into the output file**
  (`src/fonts.ts:179-222`), which does not help the worker's own canvas.
- **Consequence**: worker text rendering only sees worker/system fonts, so `pdf-raster`
  and `images` (and worker-side measurement for the HTML/print reflow) likely fall back to
  a non-Myanmar font and mismatched metrics unless the OS has the family installed.
- The project already knows this class of problem: `src/pdf/pdfAssets.test.ts:15` —
  *"paints glyphs as paths, because a worker cannot install a font"* — the analysis worker
  was handled (`disableFontFace`), the export worker was not.
- **Status**: registration absence confirmed. **Resolved in Phase 03/3.3** —
  `src/export/workerFonts.ts` registers the collected families via `FontFace` +
  `self.fonts.add()` in the export worker before measurement; pinned by
  `workerFonts.test.ts` and exercised by the 3.7 harness (fresh browser, families
  served locally, no OS install).

### C-05 · Editor → preview → export share one document model (OK, verified)
`commitCommand()` → `blockRepo.update()` (`src/editor/commands.ts:106-139`); export reads
`blockRepo.listByProject()` and resolves layout/suggestions from those rows
(`src/export/collect.ts:55-90`). No second model exists. Editor mounted at
`WorkspacePage.tsx:275` behind `hasEditor = (blockCount ?? 0) > 0` (`:92`).

### C-06 · Re-translation does not overwrite user edits in normal flow (OK, with a race)
`blockClass()` treats `translated` **and** `edited` as done (`translateQueue.ts:193`), so
planning excludes them; `WRITABLE_FIELDS` (`editor/commands.ts:26-35`) whitelists patches.
Residual risk = L-06 (edit made *during* an in-flight batch).

### C-07 · No duplicate request trigger or effect loop found (OK)
`TranslatePage.tsx` has 4 effects (`:137,214,228,250`) with `cancelled` flags and stable
deps; `startDisabled` blocks Start while `phase==='running'` (`:566`); `restoreTranslate`
early-returns for a live run (`translateQueue.ts:1112-1119`); `startTranslate` calls
`stopCurrentRun()` first (`:993`); `jobQueue.setPhase` dedupes identical phases
(`src/core/jobQueue.ts:207`); cache hits become a `#cache` batch instead of a re-request
(`translateQueue.ts:740-743`).

### C-08 · Concurrency and retries are bounded (OK)
AIMD limiter (ceiling 3 / initial 2 / halve above 30% errors, `concurrency.ts:20-97`),
per-page mutex + round-robin (`translateQueue.ts:13,376`), `maxConsecutiveFailures = 30`
(`executor.ts:187`), `bad_request`/`unknown` throw immediately (no retry storm), bounded
backoff with jitter (`keyPool.ts:549-552`). Exception: L-05.

### C-09 · Secret hygiene is sound (OK)
Sealed keys (`db/keyBundle.ts`), unsealed only in the translation worker
(`translation.worker.ts:21`); `redactSecret` on every provider error path; UI shows only
`maskedKey` (`protocol.ts:108`); only 8 `console.*` calls exist, none logging keys;
`providers/secrets.test.ts` (6 tests) and `assistant/assistant.test.ts` redaction cases
pass. `assistant/redact.ts` also scrubs logs sent to the assistant.

### C-10 · Request/token telemetry already exists and is secret-safe (OK)
Per-round-trip `TickMessage` → `TranslateProgress{requests, retries, tokensIn, tokensOut,
requestsPerMinute, activeKey (masked), model}` (`translateQueue.ts:948-954`) rendered at
`TranslatePage.tsx:943-961`; provider-reported usage is treated as authoritative
(`reportSuccess(tokensIn/tokensOut)`), estimates are calibrated at runtime
(`recordTokenCalibration`, `tokenEstimate.ts:23`). The live suite prints the same counters
when `VERIFY_LIVE=1`.

### C-11 · The editor/navigation discoverability gap (M → Phase 05)
Sidebar `NAV_ITEMS` points at `/workspace` **without** a project id
(`navigation.ts:26`), `WorkspacePage` then renders `EmptyState` "create your first project"
(`WorkspacePage.tsx:183-195`) even when projects exist; no redirect to the last project
exists (grep `lastProjectId|defaultProject` → 0 matches). The editor is reachable only via
a project card (`ProjectsPage.tsx:356`) or the Translate header link
(`TranslatePage.tsx:611`), and only after blocks exist.

### C-12 · Tooling baseline is green (OK)
Typecheck, lint and the full unit suite pass on a clean install (§5). The only skipped
file is the intentionally env-gated live suite.

## 7. Findings — Likely (mechanism confirmed, outcome unverified)

| ID | Severity | Finding | Evidence | Minimal fix | Phase |
|---|---|---|---|---|---|
| L-01 | H | Scanned/OCR pages keep original text under the translation → duplicated text in `pdf-raster`/`images`/HTML-with-background | C-02 + no `contentClass` branch in `src/export` | Feed stored block/OCR bboxes to the background render as extra erase boxes (keeps `cutOut` figure handling), or blank text regions for `contentClass !== 'text'`, or default such pages to text-only | 03 |
| L-02 | H | Default raster export can silently overlap and never emits `EXPORT_LAYOUT_CLIPPED` | C-03 | Always run `reflowBlocks` for *reporting* while leaving `adjustLayout` off (geometry promise unchanged), and/or clamp painted lines to the box and flag `overflow` in the raster path | 03 |
| L-03 | H | Wrong font/metrics for Myanmar in raster exports (worker font fallback) | C-04 | Register the collected families in the export worker (`new FontFace` + `self.fonts.add`, URLs already available from `collectFontFaces`) before measuring/drawing, or measure on the main thread | 03 |
| L-04 | M | A burst 429 misread as daily quota parks a key for 60 min | `http.ts:71-92` regex order; `keyPool.ts:547-548` (`quota ? quotaFallbackMs : backoff`); headers can only lengthen, never shorten | Only use `quotaFallbackMs` when no `Retry-After`/reset header exists *and* the daily hint is unambiguous; add fixture tests for mixed messages | 02 |
| L-05 | M | `maxConsecutiveFailures` is effectively unreachable for 5xx/429 loops because every wait resets the counter → a run can park/retry indefinitely instead of failing | `executor.ts:335` (`consecutiveFailures = 0` before sleeping); every failure kind sets a cooldown, so the next iteration always takes the wait branch with a single key | Count wait cycles (or a run-level deadline) and surface a terminal, retryable failure after N cycles while keeping backoff/jitter | 02 |
| L-06 | M/L | A block edited while its batch is in flight can be overwritten by `persistLines` (`status:'translated'`) | `translateQueue.ts:615-621` writes unconditionally; exclusions happen only at plan time | Compare-and-set inside `persistLines` (skip/merge when `status==='edited'` or `translatedAt` moved), or a `dirty` flag checked before write | 02/04 |
| L-07 | L | Visible rectangles where erasure repaints figures/gradients with a single ring-median colour | `pageRender.ts:185,259-263` | Keep, but bound: only repaint when the ring variance is low; otherwise sample per side or feather edges | 03 |
| L-08 | L | Double-click Start can start twice (second call cancels the first mid-flight) | `TranslatePage.tsx:387-406` has no busy guard (contrast `handleExport`'s `if (running) return` and `sampleBusy`) | Add an in-flight ref/disable while `startTranslate` is pending | 05 |
| L-09 | M | Sidebar "Workspace" always lands on a "create your first project" empty state | C-11 | Redirect `/workspace` to the most recently opened project (or render a project picker) — targeted change only | 05 |
| L-10 | L | Sub-pixel/tiny text runs are never erased (`width <= 0.5`, `w < 0.5` skips) → stray original glyphs under overlay | `pageRender.ts:160,169` | Lower the threshold and clamp to the union of neighbouring runs | 03 |
| O-01 | L | Availability probes have a side effect: `waitingDetail`/`isExhausted` call `pick()`, which advances the round-robin cursor | `keyPool.ts:395` cursor mutation inside `pick`; `:426`, `:744` | Make a non-mutating `canPick()` used by probes | 02 |

### 7.1 Phase 02 resolutions (2026-10-12)

Code changes were made in Phase 02; each row below is closed by a specific diff + test.
All claims here rest on unit tests actually run — no live provider was involved.

- **L-04 → fixed.** Two-sided fix: (a) `DAILY_QUOTA_HINT` now requires
  `exceeded your current…quota`, so OpenAI's *burst* text ("exceeded your current rate
  limit") classifies as `rate_limit` (`http.ts`); (b) `KeyPool.reportRateLimit` treats the
  server as authoritative for a quota in **both** directions — `Retry-After` or a window
  reset replaces the 60-minute `quotaFallbackMs` guess instead of only ever lengthening it;
  the fallback (with jitter) is used only when the provider named no deadline. Tests:
  `http.test.ts` (new OpenAI burst/daily fixtures, 16 pass) and `keyPool.test.ts`
  (quota+Retry-After → server window; quota+no hint → fallback, 43 pass). Before/after in
  one number: a quota 429 with `Retry-After: 60s` parked 60 min → now parks 60 s
  (`executor.test.ts` pins both sides).
- **L-05 → fixed.** The executor now counts consecutive *parks* (`waitCycles`; any
  successful request resets the count, and each park is still a full wait window with the
  existing backoff/jitter). After `maxWaitCycles` (default 12, configurable) parks with
  zero successes it throws a retryable `ProviderError` — `quota` → `QUOTA_EXHAUSTED`,
  `rate_limit` → `ALL_KEYS_COOLING_DOWN` — whose message names the wait count, the last
  deadline and the next step. Tests: stall after N parks, quota variant, and a
  park-then-succeed run at a low cap that is never cut off (`executor.test.ts`).
- **L-06 → fixed.** `persistLines` reads the batch's current blocks once
  (`blockRepo.getMany`, new one-round-trip method) and skips the block write when
  `status === 'edited'`, keeping the user's edit; the provider's answer is still recorded
  as the provider row and in translation memory, and the kept-edit count is logged
  (`translate.batch.edits_kept`). Test: `resume.test.ts` "never overwrites a block the user
  edited while its batch was in flight" (fake runner edits mid-batch).
- **O-01 → fixed.** New non-mutating `KeyPool.canPick()`; `waitingDetail`, `availableAt`
  and `isExhausted` use it, so availability probes no longer advance the round-robin
  cursor. Test: five probes then `pick()` still starts at the first key (`keyPool.test.ts`).
- **C-10 → extended.** Per-attempt structured diagnostics (`AttemptDiag`: attempt no.,
  model, key id + masked alias, duration, error category, provider-reported usage, and our
  estimate labelled as such) are emitted by the executor, collected per batch
  (`BatchRunResult.attempts`) and surfaced through the existing event log
  (`translate.batch.attempts`, rendered by `LogsPage`) — masked key only. Tests assert the
  record's contents **and** that no `sk-` secret-shaped string appears in them (executor +
  engine suites).
- **U-02 → partially closed.** The *budget* half is verified by pre-existing tests
  (`budget.test.ts`: overhead+content+output ≤ window, content ≤ what the completion can
  express, reasoning headroom, glossary priced) — no gap found, nothing changed. Estimate
  *accuracy* per provider tokenizer remains open (needs live keys, U-01/U-05).

### 7.2 Phase 03 resolutions (2026-10-13)

Code changes were made in Phase 03 (tasks 3.1-3.7). Claims rest on unit tests, the
3.7 CDP harness renders, and direct pixel/PDF-content inspection of the exported
artifacts — no live provider was involved.

- **C-02 / L-01 → fixed (3.1).** Erase planning now lets the pdf.js text layer win and
  masks both the text-layer runs and the stored block boxes (`planErase` in
  `src/pdf/pageRender.ts`); the stored-erase-boxes policy is applied to scanned/mixed
  content only, so text-layer pages no longer erase box areas that carry no glyphs.
  Verified visually on the `scanned` fixture (3 pages: bars become feathered inpaint,
  injected Myanmar lines are clean, no duplicated original glyphs).
- **C-03 / L-02 → fixed (3.2).** The raster path clamps only when `adjustLayout !== true`
  (the Adjust path pushes instead of shrinking), reports `EXPORT_LAYOUT_CLIPPED` via
  `onClipped`, and marks blocks that still overflow at the 6pt floor with a red dashed
  `strokeRect` (raster) / `.block.overflow` outline (HTML). Observed in the harness:
  clamp-mode exports report counts (e.g. text-300p raster = 8, mixed raster = 2),
  adjust/print exports report none.
- **L-03 → fixed (3.3, closes C-04).** Collected font faces are registered in the export
  worker with `FontFace` + `self.fonts.add()` before measurement
  (`src/export/workerFonts.ts`). Myanmar shaping in raster renders is clean in every
  inspected page.
- **L-07 → mitigated (3.4).** Feathered per-side ring repaint: per-side ring medians with
  bilinear blending instead of one flat colour. Residual trade-off observed and kept:
  black text loses contrast where the blend darkens toward a bar colour (scanned p1/p3).
- **L-10 → fixed (3.4).** `runExtent` estimates degenerate text-run widths at 0.75 em per
  glyph instead of skipping them, so sub-pixel runs are erased too.
- **3.5 → verified and pinned.** The Layout pass stays review-only (proposes
  positions/fit sizes, writes nothing on its own); `FIT_MIN_SIZE` = 6pt is pinned to both
  measure and paint paths by tests (`composite.test.ts`).
- **U-03 → closed.** The 3.7 CDP harness renders, rasterises and captures every fixture
  export; all 10 exports / 25 PNGs were inspected (acceptance table below).
  Remaining gaps are listed as limitations, not unknowns.
- **3.6 → verified, no code change.** Font embedding/licensing review: the project
  already bundles its fonts locally via `@fontsource` (present since the baseline, no
  remote CDN loads), and Myanmar shaping was verified on rendered pages. The OFL
  attribution note for the bundled families remains outstanding (tracked as a
  limitation, not a finding).
- **New finding (3.7 → fixed): HTML-family exports lost every per-block declaration
  after `font-family`.** The font stack quotes its family names and the block
  `style="…"` attribute was interpolated unescaped, so the parser ended the attribute at
  the first inner quote and dropped font-size, line-height, color, font-weight,
  text-align and min-height for every block. Affected `html`, `pdf`, `bilingual-pdf`
  and print exports — the print artifacts rendered all text at the inherited size in the
  body color (`#111827`; the fixture's red head produced **0** red pixels and
  `mixed-print-p1` overlapped heavily) while the canvas raster path was unaffected.
  Evidence chain: raw style attribute in the exported HTML → print-PDF content streams
  contain only `1 1 1 rg` / `0 0 0 rg` / `.0667 .0941 .1529 rg` (no `1 0 0 rg`) → PNG
  pixel probe of the head band = (17,24,39) → figure `<img>` kept its colors (baked
  pixels). Fix: escape the style value at the single emission point
  (`src/export/html.ts`), regression test in `html.test.ts`. After the fix every print
  page shows the red head, per-block sizes and no overlaps; all 15 raster PNGs are
  pixel-identical before/after. Pre-existing since the Phase 01 baseline (`html.ts`
  untouched since `178d4a7`).
- **Not a defect (closed with evidence): "missing" red overflow flags.** Two distinct
  signals: `block.overflow` (editor-model flag written by `src/editor/layout.ts` when the
  user's own translation does not fit) drives the painted outline; `EXPORT_LAYOUT_CLIPPED`
  is the export-time clamp report (`onClipped`) and never sets that flag. The 3.7 mock
  writes `translatedText` at repo level and bypasses the editor pass, so no stored block
  carries `overflow: true` — no flags anywhere is expected. Flag drawing is pinned by
  `composite.test.ts`.
- **Not a defect (closed with evidence): identical text-300p pages 2/4.** Stored model
  pages differ but the harness mock clips each target at the last space, and the
  Myanmar sentence stream has long space-free runs, so all body targets collapse to the
  same string; blank post-erase backgrounds then composite identically. Harness
  mock-fidelity limitation only.

#### 3.7 acceptance table (fixture → format → result)

Artifact set: full plan on the post-fix build — 7 fixtures / 10 exports / 25 PNGs, zero
errors (`validate-out/summary.json`; artifacts are git-ignored, this table is the durable
record). "Inspected" means the rasterised PNG of every page of that export was opened
and examined, not merely that the export succeeded.

| Fixture | Format | Result |
|---|---|---|
| text-300p (300 pp, 1502 blocks, 2.5× stress block, EN→Myanmar growth) | `pdf-raster` (clamp) | ✅ inspected (p1, p2≡p4, p3) — clean; 8 blocks reported `EXPORT_LAYOUT_CLIPPED` (clamp floors at 6pt and clips at the box edge by design); stress head clamped + clipped; English skip/source-fallback lines render as designed |
| text-300p | `pdf-raster` (adjust) | ✅ inspected (p1–p4) — clean; push-down gives the stress head room; red head preserved; p3 below-base marks verified as marks, not overlap |
| text-300p | `pdf` (print path) | ✅ inspected (p1–p4) **after the style-escaping fix** — red bold head, per-block sizes, no overlaps; before the fix: 0 red pixels, uniform inherited size (defect, fixed) |
| mixed (figure + red head + footers) | `pdf-raster` (clamp) | ✅ inspected (p1–p2) — clean; figure lines preserved; footers source-fallback |
| mixed | `pdf` (print path) | ✅ inspected (p1–p2) **after the fix** — p1 repaired (was heavily overlapped); figure survives (baked pixels) |
| scanned (injected bars, no text layer) | `pdf-raster` (clamp) | ✅ inspected (p1–p3) — erase + feathered inpaint working, injected Myanmar clean, no duplicated original glyphs; contrast caveat: glyph tops can cross above the inpainted band and black text over dark blends loses contrast (L-07 trade-off) |
| table | `pdf-raster` | ✅ inspected (p1–p2) — clean; table grid not repainted in the raster path (tables paint as text there); faint source grid remnants on p2, non-intrusive |
| table-spans | `pdf-raster` | ✅ inspected (p1) — clean |
| table-continued | `pdf-raster` | ✅ inspected (p1–p2) — clean; dense p1 paragraph separated |
| slide (landscape) | `pdf-raster` | ✅ inspected (p1) — clean; two columns do not collide |
| EN→Myanmar growth | covered by text-300p stress block | ✅ wrapped (print) / pushed (adjust) / clipped+reported (clamp) |
| In-app previews (7 captured) | — | 2 inspected (text-300p, mixed): translated view renders the same model, growth shows as overlap in preview because push-down happens at export with Adjust layout on; **5 (table*, slide, scanned) captured but not individually inspected** |
| In-browser erase probe (3.7) | — | ✅ erased band under the app's own render path measures ≈173 light px vs ≈20 on the un-erased control — 3.1+3.4 confirmed working in-page |

Honest caveats: identical text-300p pages 2/4 are a mock-translator artifact (above);
no stored block carried `overflow: true`, so no red dashed flags were expected anywhere
(flag machinery unit-tested); print exports keep the source page image as background by
design, so page-image artifacts remain visible there.

### 7.3 Phase 04 resolutions (2026-10-13)

Code changes were made in Phase 04 (tasks 4.1-4.4). Scope: the pre-export editor and its
export path only — no provider, pipeline or layout changes.

**4.1 Discoverability verdict (C-11 answered; test-pinned).** The editor is neither
missing nor hidden: `/workspace/:projectId` mounts `WorkspaceEditor` as the primary view
whenever the project has at least one block — the mount condition `blockCount > 0` the
plan asked to confirm — and the workspace is reachable from five places: the Projects
page (project card), the Translate page after a job, the Preview tab, the
post-translation toast action, and direct URL. The bare `/workspace` route shows the
create-project empty state (with the project picker below it), not an editor with no
document; a project whose parse produced zero blocks keeps the pipeline (OCR/language)
as the primary view and shows no editor. Verified by `WorkspacePage.test.tsx` (three
route assertions). Caveat carried to Phase 05: the bare-route empty state is functional
but generic; task 5.1 may give it an explicit "open a project to edit" framing (L-09
deferred per the plan).

**4.2 Round-trip persistence (C-05 closed).** Edits persist across unmount/remount,
navigation and export, through one model end to end (no second document model): inline
text and toolbar changes commit through `commitCommand` → Dexie → live query →
`collectExportDocument` → `buildHtmlDocument`/print. Evidence:

- unit (`WorkspaceEditor.test.tsx`): inline text edit + toolbar font size 14pt →
  unmount/remount → exported HTML contains the edited text, `font-size:14pt` and the
  block's `left/top/width` geometry;
- unit (`BlockInspector.test.tsx`): geometry change (y=200, width=320.5) → Dexie →
  exported markup contains `top:200pt;width:320.5pt` → undo restores the original;
- browser (harness edit round-trip, all seven fixtures): a marker typed into a block
  through the real UI survives `runExport` into the print HTML artifact and into the
  text layer of the PDF Chrome prints from that HTML; Ctrl+Z afterwards restores the
  original text.

Limitation, honestly stated: `runExport` itself cannot run under jsdom — a probe
(`ExportBuildError: export worker unavailable: Worker is not defined`) shows preflight,
collect and the empty check all pass and only the `Worker` global is missing — so the
unit tests assert the collect → HTML boundary (the exact composition `runExport`
performs), while the browser harness covers the full `runExport` → print → PDF path.
Both were run; neither is claimed without evidence.

**4.3 Late-response race (L-06, pairs with 2.4).** The editor-side half is now
test-pinned: an inline commit writes `status: 'edited'` synchronously with the text
(`WorkspaceEditor.test.tsx` asserts it), and Phase 02's `persistLines` skips
`status === 'edited'` blocks (`resume.test.ts`), so a translation response landing after
an edit cannot overwrite it. The browser round-trip additionally asserts
`status: 'edited'` after each real UI edit (`status=true` for all fixtures).

**4.4 Overflow, shortcuts, undo/redo, unsaved state — verified and documented, not
rebuilt.**

- Overflow: a 100×10pt block holding long text renders the warning badge, and a wide
  468×120pt block does not (`WorkspaceEditor.test.tsx`; jsdom falls back to the
  deterministic 0.52em measurer).
- Keyboard (documented + pinned): Ctrl/Cmd on the modifier — undo Ctrl+Z, redo
  Ctrl+Shift+Z, find Ctrl+F, replace Ctrl+H, select all Ctrl+A, bold Ctrl+B, italic
  Ctrl+I, zoom in Ctrl+=, out Ctrl+-, reset Ctrl+0, export Ctrl+Shift+E; Escape cancels
  editing; Enter / Shift+Enter and ArrowDown / ArrowUp walk matches and blocks;
  Ctrl+Enter / Ctrl+Backspace accept/reject a suggestion. While typing inside a block
  only find/replace/export fire. The previously inert Ctrl+S entry was removed (it was
  swallowed by `shouldPreventDefault` with no handler behind it) and `keyboard.test.ts`
  pins the map.
- Undo/redo: stack-driven and exact for text, styling, geometry and reloads; Ctrl+Z
  mid-typing is ignored (typing-guard test).
- Unsaved state: none exists by design — auto-save on commit (the Dexie write precedes
  the stack push); the `busy.autosave` i18n key is vestigial (no call site), left for
  the Phase 05 pass.

**Position/dimension editing (brief item).** The geometry card (inspector → Block tab)
edits X/Y/W/H numerically — deliberately no drag: keyboard-friendly, undoable, same
command stack as text. Inputs reject non-finite values, negative x/y and w/h below 1,
round to 2 dp, and Save stays disabled while a field is invalid (`geom-invalid` shown) —
both directions pinned in `BlockInspector.test.tsx`.

**Harness edit round-trip (task 4.2 browser evidence).** Once per fixture (opt out with
`--skip-edit`): pick a mock-translated paragraph on an exported page (preferring a row
the virtualized list has mounted, otherwise walking the editor's inner scroller until it
mounts), double-click it, type a unique marker, let the real commit path run (inline
commit → command stack → Dexie, `status: 'edited'`), export through the same `runExport`
the dialog calls, assert the marker in the print HTML and in the printed PDF's text
layer (Node-side pdf.js legacy build; the in-page mainline build proved
environment-sensitive and was replaced), then Ctrl+Z via the editor's own window handler
and assert the original text is back. If the shortcut ever fails, the row is rewritten
directly and the failure is reported, so a fixture is never left dirty for later runs.
Full plan with the final harness: 7/7 fixtures `edit:ok`, `errors=none`, standard
exports green in the same runs (§12).

Changed files: `src/editor/types.ts` (BlockFields geometry), `src/editor/commands.ts`
(WRITABLE_FIELDS geometry), `src/db/types.ts` (`edit-layout` revision action),
`src/editor/keyboard.ts` + `keyboard.test.ts` (inert `save` removed, map pinned),
`src/i18n/locales/{en,my}.json` (geometry labels, layout command, action label),
`src/pages/workspace/BlockInspector.tsx` + tests (geometry card),
`src/pages/workspace/WorkspaceEditor.test.tsx` (round-trip, race, guard, overflow),
`src/pages/WorkspacePage.test.tsx` (new, route discoverability),
`scripts/validate-export.mjs` (edit round-trip, Node-side pdfText, `--skip-edit`).

### 7.4 Phase 05 resolutions (2026-10-13)

- **L-09 → fixed (5.1).** Bare `/workspace` now resolves through a live query of the most
  recently opened non-archived project (`projectRepo.list({ sort: 'recent', limit: 1 })` —
  the same order the Projects page uses) and `<Navigate replace>`s into it; while the
  query settles a skeleton shows, and a genuinely empty account — or one whose only
  projects are archived — keeps the create-project empty state. Route tests pin all three
  cases (`WorkspacePage.test.tsx`); the redirect was additionally confirmed in the real
  browser over CDP (bare `/workspace` → `/workspace/prj_…`). "Most recently opened"
  tracks `lastOpenedAt`, which the Projects page updates on open.
- **L-08 → fixed (5.2).** `handleStart` guards on a synchronous ref (mirrored to state)
  before awaiting `startTranslate`; a second activation inside the await window returns
  immediately, so a double-click can no longer fire a run that cancels the first one
  mid-flight. Start (`startDisabled`), Resume, Fix and Retry are disabled while pending.
  `TranslatePage.test.tsx` (new; queue mocked at the module boundary, no network) pins:
  one call for a double activation, disabled while pending, re-enabled after settle, and
  a sequential second start allowed.
- **Myanmar script in the UI (found in 5.3, fixed).** Mixed-script UI strings — "Burmese —
  မြန်မာ" in the language selects and the preflight Languages check — rendered as tofu
  boxes: `--font-sans` had no Myanmar family, so those glyphs fell through to the generic
  `sans-serif` mapping, which only resolves when the OS itself ships a Myanmar font. The
  app has bundled `Noto Sans Myanmar`/`Padauk` via `@fontsource` since the baseline
  (`src/styles/fonts.ts`); they are now appended to the general stack, making the
  fallback deterministic on every machine. Before/after browser screenshots recorded;
  Latin glyphs and `.mm-text`/`--font-mm` are unaffected.
- **Logs total accuracy (found in 5.4, fixed).** `totalCount` was read as a
  `limit: 5000` list — understating the count on busy accounts and disagreeing with the
  severity chips next to it. It is now the sum of `countBySeverity()` (all five keys,
  zero-filled), and the extra query is gone.
- **Editor helper copy (5.3).** `workspace.editorBody` (en/my) described a left/right pane
  layout that only holds at ≤~45 % zoom; the default desktop layout wraps a page's two
  panes into a stacked layout (`flex-wrap` with two 612 pt panes in an ~820 px card). The
  copy now describes what every layout does; the wrap itself is deliberate — panes keep
  page fidelity at any width.
- **Vestigial `editor.busy.autosave` (carry-over from §7.3) → removed.** No setter ever
  existed; the store union member, the en/my key and the coverage-test pin are deleted,
  and the store interface documents why (commits persist on push — there is no unsaved
  window to report).
- **Scroll/blank-space audit (5.3).** CDP audit over the stable harness profile: 8 routes
  × 4 viewports (1440×900, 1024×768, 820×1180, 390×844), metrics + screenshots.
  Results: exactly one document-flow scroll region (`app-scrollbar`) on every page; the
  nested scrollers are intentional (virtualized editor list, thumbnails, logs list capped
  at 1000 rows); no horizontal overflow in any of the 32 combinations
  (`scrollWidth == clientWidth`); no console exceptions; the responsive collapse at
  390 px is clean (bottom nav bar, wrapping toolbar, overlay sidebar). Editor panes show
  the designed skeleton while the analysis worker parses the document — on `text-300p`
  both panes resolve to real artwork after ~10 s (probe: `918×1188` images, shimmer gone,
  zero errors), so the blank panes in early screenshots were the loading state, not a
  failure. Document-level trailing-gap readings were an artifact of measuring outside the
  app's internal scroll region.
- **Keyboard/a11y (5.5).** Browser tab-crawl over `/translate/:id`: Tab 1 is the
  "Skip to main content" link, then header and sidebar controls in visual order; 12/12
  stops report `:focus-visible` with the global 2 px focus ring; icon-only header
  controls carry `aria-label`s. The controls touched this phase are native buttons/links,
  so disabled state is semantic.
- **`ProjectsPage` bulk-delete flake → fixed.** Reproduced in isolation (not load-only):
  the card list empties through Dexie's live-query lane while the selection clears in
  `deleteSelectedProjects`'s promise continuation — two independent React updates with no
  guaranteed render order. The test now waits for the bulk bar (the same pattern the
  cancel test already used); 8/8 consecutive isolated runs green and the full suite green.

Changed files: `src/pages/WorkspacePage.tsx` (+ `WorkspacePage.test.tsx`, redirect),
`src/pages/TranslatePage.tsx` (+ new `TranslatePage.test.tsx`, run guard),
`src/index.css` (Myanmar fallback in `--font-sans`), `src/pages/LogsPage.tsx` (true
total), `src/i18n/locales/{en,my}.json` (helper copy, `busy.autosave` removal),
`src/editor/store.ts` (union member removal + doc comment), `src/i18n/coverage.test.ts`
(pinned list), `src/pages/ProjectsPage.test.tsx` (flake fix).

No export-affecting code changed in this phase, so the CDP export harness was not
re-run; the Phase 04 evidence (7/7 fixtures `edit:ok`, §7.3) stands.

### 7.5 Phase 06 resolutions (2026-10-13)

- **Raster export dropped whole blocks → fixed (regression from Phase 03).** Visual
  inspection of the harness PNGs found that `val-text-300p-raster-p1.png` had **zero ink**
  in band 0 (the running header) and band 18 (the footer), while `adjust` and `print`
  rendered both *from the same export document* (adjust band 0 = 401 / band 18 = 103, print
  band 0 = 113 / band 18 = 45). Page 3 lost its header/footer the same way.
  Root cause: `3c9c2fa` (Phase 03/3.2) added the clamp in `drawBlock`, which cuts a line
  when `block.y*scale + (index+1)*step > boxBottom + 1`. `step` is the line *advance*
  (`fontSize × lineHeight × scale`) but `block.height` for a single-line run is the *glyph*
  height — the stored header is `x:72 y:13 w:139.03 h:9`. At the 6 pt floor the advance is
  `6 × 1.7 = 10.2 pt`, which exceeds `9 pt + 1/scale`, so the test held for `index = 0`
  too and the block painted **nothing**. That is why only the plain raster path lost them:
  the baseline had no clamp (it painted these blocks), and `adjustLayout`/HTML disable it.
  Fix: the clamp now applies only *after* the first line has painted — a block may never
  paint zero lines. The first line lands (past the box if that is the only place it fits);
  the lines after it are still cut and still reported through `onClipped`, so C-03's
  reporting contract is unchanged. Deliberate trade-off: in a box too short for one line
  the first line may now touch the block below, which is chosen over silently losing the
  block — the HTML path already prints that line.
  Evidence: new test `never paints zero lines…` uses the real header geometry and **fails
  on the pre-fix code** (verified by stashing `composite.ts`: 1 failed / 24 passed) and
  passes after; harness re-run 7/7 fixtures `errors=none`; `val-text-300p-raster.pdf`
  636,664 → 661,901 bytes; p1 ink bands 0/18 `0 → 401` and `0 → 103`, now identical to
  adjust; crops show the red running header and the footer with correctly shaped Myanmar.
- **"Pages 2 and 4 export byte-identically" → not a defect (synthetic-translation
  artifact).** SHA-256 showed `val-text-300p-raster-p2.png` == `p4.png` (and the adjust
  pair), which looked like page duplication. The stored model says otherwise: `pageTexts`
  reports pages 3/4/5 sharing `ttHash 562ad164` / `ttLen 1994` while their `srcHash`
  differs — the harness's mock builds `translatedText` as a function of source *length*
  from a fixed Myanmar sentence list, so different pages of the same length receive
  identical translations. The source pages differ (text extracted: p2 starts "Employee
  satisfaction…", p4 "The training programme…"), the print export renders them distinctly
  (different PNG hashes), and the raster PDF holds a distinct image object per page
  (`img_p0_1 … img_p3_1`). No product defect; recorded so the next reader does not chase it.
- **Method note — "blank page" readings are display artifacts.** Whole-page previews of
  sparse pages look empty at display scale and the image viewer even drew a blue rectangle
  that is not in the file (0 blue pixels on sampling). Every visual claim in this phase is
  therefore backed by a pixel ink profile (20 vertical bands) plus a 3–4× crop of the
  exact region, not by the thumbnail.

Commands run this phase: `npm run typecheck` ✅ (exit 0), `npm run lint` ✅ (exit 0),
`npx vitest run` ✅ 1640 passed / 6 skipped (109 files + 1 env-gated skipped; +1 for the
new clamp test), `npm run build` ✅ (exit 0, 29.6 s), `node scripts/validate-export.mjs`
✅ 7 fixtures / 10 exports / `edit:ok` / `errors=none`.

Changed files: `src/export/composite.ts` (clamp guarantee), `src/export/composite.test.ts`
(regression test).

## 8. Findings — Unknown (need credentials / browser / data)

- **U-01** Real provider rate-limit, quota and header behaviour per model. The harness
  exists (`src/verify/liveRun.test.ts`, 6 tests) but needs `VERIFY_LIVE=1` plus real keys —
  unavailable here; nothing was simulated as a result.
- **U-02** Token-estimate accuracy vs each provider tokenizer (calibration code exists; no
  before/after numbers recorded).
- **U-03** ~~Rendered-page visual inspection of exported PDFs~~ — **closed in Phase 03
  (3.7)**: the CDP harness renders every fixture export to PNGs and they were inspected
  (acceptance table in §7.2).
- **U-04** OCR quality and sidecar parity on real scans (offline parity tests pass:
  `src/sidecar/extractParity.test.ts`).
- **U-05** Whether each adapter's reported `tokensIn` includes chat-template overhead —
  affects calibration bias.

## 9. Checked and found healthy (negative results matter)

- Effect loops in `TranslatePage` / `WorkspacePage` / `WorkspaceEditor`: none found
  (guards, `cancelled` flags, debounced overflow measurement at
  `WorkspaceEditor.tsx:72-77`).
- Infinite hot retry loop: none — waits dominate and backoff is capped (L-05 is about
  *stalling*, not hammering).
- Secret logging/UI leakage: none found (C-09).
- Inert controls in the translate status panel: none found — Start/Pause/Resume/Try-now/Fix
  are wired to real actions and Start is genuinely disabled by `startDisabled`
  (`StatusPanel.tsx:260-268`); `adjustLayout` is a real, wired checkbox
  (`ExportDialog.tsx:387-396` → `runExport` → worker).
- Second/duplicate document model for export: does not exist (C-05).
- Chunks re-sent after completion: excluded by planning (`:193`) plus cache hits.
- Secrets in fixtures/logs/reports: none found; live keys only ever come from env vars.

## 10. Recommended minimal fixes (ordered by risk)

1. **Phase 02 (API)** — L-05 (terminal failure after N wait cycles), L-04 (quota vs burst
   with header precedence), L-06 (compare-and-set in `persistLines`), O-01 (non-mutating
   probe), plus the structured diagnostics PHASE-02 requires (request id, chunk id,
   attempt, duration, category, estimated vs reported usage — all secret-safe; C-10 already
   provides the plumbing).
2. **Phase 03 (PDF)** — L-01 (erase OCR text before overlay), L-02 (report/clamp raster
   overlap without breaking the geometry-exact default), L-03 (worker font registration),
   then visual validation on `fixtures/scanned.pdf`, `mixed.pdf`, `text-300p.pdf`, table and
   Myanmar fixtures (U-03).
3. **Phase 04 (Editor)** — prove C-05/C-06 with export round-trip tests, close L-06,
   verify discoverability (feeds L-09).
4. **Phase 05 (UI/UX)** — L-09, L-08, and only targeted layout polish
   (`PageLayout` inspector gains a second scroll region at ≥1024 px — verify by eye before
   touching).
5. **Phase 06** — full regression, `FINAL_VERIFICATION.md`, secrets/diff review.

Change risks to watch: erasure changes can damage artwork (test on `mixed.pdf`);
worker font registration shifts measurement (re-run the whole suite and compare HTML vs
raster measurements); stricter failure surfacing must not kill runs that previously
recovered (keep the ladder, only add the terminal condition). Rollback note: the project
is **not** a git repository (§5) — see `IMPLEMENTATION_PLAN.md` §2 for the version-control
prerequisite.

## 11. Limitations of this audit

- No browser, no dev server, no live provider: every "Likely" finding is a code-level
  mechanism, not an observed defect. Do not treat §7 items as user-confirmed bugs.
- The Phase 01 audit itself changed no code. Phase 02 (2026-10-12) then changed the
  API-pipeline files listed in `docs/CHANGELOG.md`; §7.1 records what was fixed and how it
  was verified. Live-provider behaviour is still unverified (U-01) — the Phase 02 fixes are
  proven against mocks/fixtures only.
- Docs `docs/TRANSLATION_ARCHITECTURE.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`,
  `docs/API_KEYS_GUIDE.md`, `docs/TEST_CHECKLIST.md`, `docs/TROUBLESHOOTING.md` were
  located and are consistent with the as-built description in §2-§4; they were not
  re-audited line by line.

## 12. Phase status

Phase 01 tasks 1-10 are complete: tree/docs/manifests inspected, stack identified from
evidence, both flows traced, suspected causes searched (duplicates, loops, chunk overlap,
token estimates, concurrency, retry limits, false rate-limit detection — see §6-§9),
findings classified with severity/fix/risk (§6-§10), and the plan is in
`IMPLEMENTATION_PLAN.md`. **Phase 02 must not start until this report and the plan are
reviewed.**

Phase 02 (2026-10-12, user-approved start) is complete: L-04, L-05, L-06 and O-01 are
fixed with targeted tests, per-attempt secret-safe diagnostics extend C-10, and U-02's
budget half was verified as already covered (§7.1). Final gates: `typecheck` ✅, `lint` ✅,
full suite ✅ 1571 passed / 6 skipped (103/104 files; the 1 skipped file remains the
env-gated `VERIFY_LIVE=1` suite; baseline was 1554 passed — +17 tests). One pre-existing
flaky `ProjectsPage` timing test was observed once under full-suite load and was green on
re-run, in isolation, and in both subsequent full runs — untouched file, unrelated to this
phase. Secret-pattern scan of `src/` + phase documents: 0 matches. Remaining provider-side
items (U-01, U-05) need live keys. Phase 03 (PDF export) may proceed.

Phase 03 (2026-10-13) is complete: tasks 3.1-3.5 and 3.7 landed as six scoped commits —
erase planning (C-02/L-01), clamp/reporting semantics (C-03/L-02), worker font
registration (L-03, closes C-04), feathered per-side repaint (L-07) and degenerate-run
erasing (L-10), review-only layout suggestions with the 6pt floor pinned, font
bundling/licensing verified (3.6 — fonts already ship via `@fontsource` since the
baseline, so no code change; OFL note outstanding), and the CDP visual-validation
harness. The harness found and closed a
pre-existing export defect: HTML-family exports (html/pdf/bilingual-pdf/print) dropped
every per-block declaration after `font-family` because the quoted font stack broke the
`style` attribute — fixed with one escaping change plus a regression test (§7.2).
Evidence: full plan green (7 fixtures / 10 exports / 25 PNGs / zero errors), every
print page re-inspected after the fix, raster pages pixel-identical before/after, erase
probe confirms in-browser erase under the app's own path. Final gates: `typecheck` ✅,
`lint` ✅, full suite ✅ 1626 passed / 6 skipped (107/108 files; the 1 skipped file
remains the env-gated `VERIFY_LIVE=1` suite). One pre-existing flaky `ProjectsPage`
timing test was observed once under load and was green on re-run, in isolation, and in
the next full run — untouched file, unrelated to this phase. Provider-side items
(U-01, U-05) still need live keys; the OFL note for the bundled fonts is still
outstanding. Phase 04 (pre-export editor) may proceed.

Phase 04 (2026-10-13) is complete: tasks 4.1-4.4. The editor exists, is reachable (five
entry points; mount gate `blockCount > 0` confirmed), and its changes persist through
export via one model (§7.3). Genuinely missing scope was closed: position/size editing
(geometry card → command stack → Dexie → export), the editor-side race assertion (pairs
with Phase 02's `persistLines` skip), and a browser-level edit round-trip in the
harness. The inert Ctrl+S shortcut was removed and the map documented. Full-plan harness
with the final code: 7/7 fixtures `edit:ok`, `errors=none` (marker in print HTML and in
the printed PDF's text layer, Ctrl+Z restore verified per fixture), standard exports
green in the same runs. Final gates: `typecheck` ✅, `lint` ✅, full suite ✅ 1635
passed / 6 skipped (108/109 files; the 1 skipped file remains the env-gated
`VERIFY_LIVE=1` suite). Provider-side items (U-01, U-05) and the OFL note remain
outstanding and are unchanged by this phase. Phase 05 (UI/UX polish) may proceed.

Phase 05 (2026-10-13) is complete: tasks 5.1-5.5, targeted fixes with identity preserved.
L-09/C-11 (bare `/workspace` dead-end) and L-08 (double-start) are closed with route and
component tests; the audit surfaced and fixed three real defects — mixed-script UI strings
rendering as tofu (`--font-sans` had no Myanmar family), a Logs total that understated
itself, and helper copy describing a pane layout that only holds at low zoom — plus the
vestigial `editor.busy.autosave` key and the recurring `ProjectsPage` bulk-delete flake.
Evidence: CDP audit of 8 routes × 4 viewports (one scroll region everywhere, no horizontal
overflow in 32/32, no console exceptions) and a browser tab-crawl (skip link first, 2 px
focus ring on 12/12 stops); full-page thumbnails were cross-checked with pixel ink
profiles and 3-4× crops so loading skeletons were not mistaken for blank pages. Final
gates: `typecheck` ✅, `lint` ✅, full suite ✅ 1639 passed / 6 skipped (109/110 files; the
1 skipped file remains the env-gated `VERIFY_LIVE=1` suite; +4 tests over Phase 04).
Export-affecting code was untouched, so the harness was not re-run and Phase 04's evidence
stood. Phase 06 (regression + release readiness) may proceed.

Phase 06 (2026-10-13) is complete: full regression, production build and release
readiness. Gates: `typecheck` ✅, `lint` ✅, full suite ✅ 1640 passed / 6 skipped
(109/110 files; +1 clamp test), `npm run build` ✅ (29.6 s), `npm run smoke` ✅ 161/161
with a clean console (routes, responsive breakpoints, theme/language persistence, PDF
wizard, Dexie persistence, backup round-trip, editor find/replace, export, knowledge,
sync controls, assistant, tooling, `.env` hygiene). Full export harness ✅ 7/7 fixtures /
10 exports / `edit:ok` / `errors=none`, and every fixture's PNGs were inspected by pixel
ink profile rather than by thumbnail. That inspection found a **regression introduced in
Phase 03**: the raster clamp could drop a block's first line and paint the whole block
from the sheet (running header and footer gone on `text-300p`), fixed by guaranteeing at
least one painted line and pinned by a test that fails on the old code (§7.5). Two
suspicious artifacts were run to ground and are *not* defects: byte-identical export pages
(traces to the mock translator writing length-derived text) and "blank" pages (display
scaling). Live-provider verification (U-01/U-05, before/after API metrics against a real
provider) remains blocked — no keys in this environment, `VERIFY_LIVE=1` suite skipped —
as does the OFL note for the bundled fonts. Ready for push and real-user testing with the
limitations in `FINAL_VERIFICATION.md`.

Post-release follow-up (2026-10-13, three user reports) is complete. Diagnosis came before
any edit: the landing/first-time-setup screen was **not** missing — a fresh profile lands on
`/welcome` with the setup screen rendered (verified over CDP: testid + headline present) and
only an already-onboarded profile skips it (`aidt.ui` in localStorage). The other two
reports shared the root cause: the Data tab's "Delete all local data?" deleted only the
Dexie database and reloaded the current URL, so `aidt.ui` survived (the app stayed
onboarded) and the reload dropped the user on the settings page of an emptied app — verified
before the fix (`path=/settings?tab=data`, `aidt.ui` still `onboarded:true`). The editor was
present in the workspace all along; the translate page advertised it only through a ghost
"Back to workspace" button that never mentioned it. Fixes: the Data wipe now runs
`resetEverything()` (database + device secret + device id + `aidt.ui`) and navigates to
`/welcome`, the Cache-tab factory reset gets the same hand-off instead of reloading
`/settings` in place, and the translate page carries a labelled "Open editor" button
(`translate.openEditor`, both locales) to `/workspace/:projectId`. Coverage: `App.test.tsx`
pins `/` → `/welcome` on a fresh profile and the already-onboarded bounce;
`DataTab.test.tsx` pins that the wipe clears the localStorage first-run keys (the redirect
itself is unobservable in jsdom — `location.replace` is unforgeable — so it is asserted in
smoke instead); a `TranslatePage` test pins the editor entry; `scripts/smoke.mjs` gained
four real-browser checks (fresh profile shows the landing screen, the translate page's
Open editor entry is visible and links to `/workspace/:id`, delete-all ends at
`/welcome`, first-run state restored). Final gates: `typecheck` ✅, `lint` ✅, full suite ✅
1644 passed / 6 skipped (111/112 files; +4 tests), `npm run build` ✅ (29.7 s),
`npm run smoke` ✅ **165/165** with a clean console. Export-affecting code was untouched and
smoke's export checks still pass, so the full export harness was not re-run (Phase 04/06
evidence stands). Live-provider items (U-01/U-05) and the OFL note remain blocked as before.
