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
- **Status**: registration absence confirmed; visual effect unverified (needs a browser).

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

## 8. Findings — Unknown (need credentials / browser / data)

- **U-01** Real provider rate-limit, quota and header behaviour per model. The harness
  exists (`src/verify/liveRun.test.ts`, 6 tests) but needs `VERIFY_LIVE=1` plus real keys —
  unavailable here; nothing was simulated as a result.
- **U-02** Token-estimate accuracy vs each provider tokenizer (calibration code exists; no
  before/after numbers recorded).
- **U-03** Rendered-page visual inspection of exported PDFs (needs dev server + browser;
  `scripts/diagnose-render.mjs` and `scripts/smoke.mjs` are the available tools).
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
