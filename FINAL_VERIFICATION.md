# Final Verification — Release Readiness Report

**Date:** 2026-10-13 · **Branch:** `master` · **Scope:** Phases 01–06 (audit → API → export →
editor → UI/UX → regression & release) · **Report for:** `PHASE-06-TEST-RELEASE.md`

---

## Verdict

**Ready for real-user testing**, with the limitations in §5 stated openly. Every gate below
was executed in this environment and produced the result shown; nothing is inferred from a
green build. The one release-blocking defect found during this phase's PDF inspection (a
regression introduced in Phase 03) is fixed and pinned by a test that fails on the old code.

The only work that *cannot* be done here is live-provider verification: no API keys are
available in this environment, so `src/verify/liveRun.test.ts` skips (`VERIFY_LIVE=1` gate)
and §4's live half is a documented blocker, not a pass.

---

## 1. What was fixed

| Phase | Fixed |
|---|---|
| 02 — API & pipeline | Quota/burst 429 classification (L-04); server-authoritative rate-limit windows instead of the 60-minute guess; bounded park cycles with a real terminal error (L-05, `maxWaitCycles` 14 → 12); `persistLines` no longer overwrites a block the user edited mid-batch (L-06); non-mutating availability probe (O-01); per-attempt masked diagnostics (C-10) |
| 03 — PDF export | Text-erasure planning on background renders (C-02/L-01); clamp + `EXPORT_LAYOUT_CLIPPED` reporting so a clipped export says so (C-03/L-02); font faces registered in the export worker before measuring (L-03/C-04); feathered per-side repaint (L-07); degenerate text-run widths (L-10); HTML `style` escaping that dropped every per-block declaration after `font-family` |
| 04 — Editor | X/Y/W/H geometry editing through the command stack; browser edit round-trip proof (save → status → HTML → printed PDF → Ctrl+Z); inert `Ctrl+S` shortcut removed |
| 05 — UI/UX | `/workspace` dead-end (L-09/C-11); double-start in-flight guard (L-08); tofu in mixed-script UI strings; understated Logs total; wrong helper copy; vestigial `editor.busy.autosave`; `ProjectsPage` bulk-delete flake |
| **06 — regression** | **Raster export could paint *zero* lines for a block** — the Phase 03 clamp (`3c9c2fa`) tested the first line too, so a box stored at its glyph height (a running header/footer is `h: 9`) lost the block entirely while HTML/print/adjust still printed it. The clamp now applies only after the first line has painted; the rest are still cut and still reported. Test: `composite.test.ts › never paints zero lines…` |
| **Post-release follow-up** (3 user reports) | **"Delete all local data" reloaded the settings page of an emptied app** — it deleted only the Dexie database, leaving `aidt.ui` (`onboarded`, theme, language) in localStorage behind; the wipe now runs `resetEverything()` and lands on `/welcome` (the Cache-tab factory reset gets the same hand-off instead of reloading `/settings` in place). The translate page advertised the editor only through a ghost "Back to workspace" button — now a labelled **"Open editor"** button to `/workspace/:projectId`. The landing/first-time-setup screen was never missing (fresh profile → `/welcome`, verified over CDP and asserted in smoke): it is skipped once the profile has onboarded, which the old wipe never undid |

---

## 2. Commands actually run

| Command | Result |
|---|---|
| `npm run typecheck` | ✅ exit 0 |
| `npm run lint` | ✅ exit 0 |
| `npx vitest run` | ✅ **1644 passed / 6 skipped**, 111 files passed + 1 skipped (112) — exit 0 |
| `npm run build` | ✅ exit 0 (29.6 s); `dist/` complete: `index.html`, `assets/`, `sw.js`, `pdfjs-assets/`, manifest, icons |
| `npm run smoke` | ✅ **165/165 passed**, `no console/runtime errors :: clean` (first-run landing screen on a fresh profile, routes, breakpoints, theme/language persistence, PDF wizard, Dexie persistence across reload, backup export/import, translate page's visible Open editor entry, editor find/replace, export + format menu, knowledge tabs, sync controls, assistant offline answers, `tools/launcher.html`, `.env` hygiene, model list, delete-all → welcome screen) |
| `node scripts/validate-export.mjs` (full plan) | ✅ 7 fixtures / 10 exports / every `edit:ok` / `errors=none` |
| Secret-pattern scan (tracked diff + whole tree) | ✅ 0 matches for real key shapes; only `.env.example` files are tracked, `.env` is git-ignored |
| Debug-leftover scan (`console.log`, `debugger`, `TODO`, `.only`) | ✅ 0 added (4 pre-existing `console.error/warn` on error paths) |
| `npx vitest run src/verify/liveRun.test.ts` | ⛔ **not run** — env-gated on `VERIFY_LIVE=1` + real `OR_KEY*`/`GROQ_KEY*`; skipped by design |

Test counts by phase: 1554 (baseline) → 1571 (02) → 1626 (03) → 1635 (04) → 1639 (05) →
1640 (06) → **1644 (post-release follow-up: 2 App routing, 1 DataTab wipe, 1 TranslatePage
editor entry)**. The 6 skipped tests are always the env-gated live suite.

---

## 3. PDF fixtures rendered and inspected

Inspection method: harness PNGs were checked with a **pixel ink profile** (20 vertical bands)
plus **3–4× crops of the exact region** — never by whole-page thumbnail, which renders
sparse pages as blank and once showed a rectangle that does not exist in the file (0 blue
pixels when sampled).

| Fixture | Exports | What inspection showed |
|---|---|---|
| `table`, `table-spans`, `table-continued` | raster | Cell text and rules present; `EXPORT_LAYOUT_CLIPPED` reported honestly (1 block each) |
| `slide` | raster | Content painted, no overflow |
| `scanned` | raster | OCR/inpaint path paints; erased artwork preserved |
| `mixed` | raster + print | Figure artwork (blue pipeline rules) preserved as background; the 5 text items render translated; print reflows the same document |
| `text-300p` | raster + adjust + print | Myanmar shaping correct at 3–4× on every inspected page; **header/footer were missing from raster and are restored by the Phase 06 fix** (band 0 `0 → 401`, band 18 `0 → 103`, now identical to adjust's 401/103) |

Also verified, and recorded so nobody re-investigates them:

- **Byte-identical export pages are a mock artifact, not a bug.** `val-text-300p-raster-p2`
  and `p4` hash the same because the harness's synthetic translator writes `translatedText`
  as a function of source *length*: the stored model shows pages 3/4/5 sharing
  `ttHash 562ad164` while their `srcHash` differs. The source pages differ, the print export
  renders them distinctly, and the raster PDF holds a separate image object per page.
- **Edit round-trip passes on all 7 fixtures** (`saved / status / html / pdf / undo`), so
  editor changes reach the exported artifact through the same document model.

---

## 4. Before/after API metrics

**Available (mock/unit based, Phase 02 — no live provider):**

| Metric | Before | After |
|---|---|---|
| Quota 429 with `Retry-After: 60s` | parked for the 60-minute fallback | parks 60 s (server window wins in both directions) |
| Stall protection | unbounded-ish wait (`maxWaitCycles` 14) | bounded parks (12), terminal `QUOTA_EXHAUSTED` / `ALL_KEYS_COOLING_DOWN` naming the wait count and next step |
| User edits during an in-flight batch | could be overwritten by `persistLines` | preserved (`status === 'edited'` skipped; provider answer still recorded) |
| Availability probes | advanced the round-robin cursor | non-mutating `canPick()` |

**Not available (blocker):** live request/token counts per provider and tokenizer-accurate
budget estimates (U-01/U-05). Requires real keys — see §7.

---

## 5. Known limitations and unresolved issues

1. **Live-provider verification is unrun** — no keys in this environment. Rate-limit,
   invalid-key and unavailable-model behaviour is proven against fixtures only.
2. **OFL licence note for the bundled fonts** (`@fontsource` families) is still outstanding.
3. **6 pt fit floor** — text that cannot fit its box at the floor is clipped and reported as
   `EXPORT_LAYOUT_CLIPPED` (mode `clamp`); turning on *Adjust layout* reflows instead. This
   is by design and surfaced to the user, not silent.
4. **jsdom cannot run the export worker** — `runExport` is covered by the browser harness,
   unit tests cover the logic around it.
5. **`analysisState` wipe-on-open** is an unresolved product question (see `AUDIT_REPORT.md` §8).
6. **Service worker** — the app registers `sw.js` in production; after a deploy, a hard
   reload may be needed to pick up the new shell.
7. Per-phase findings not repeated here remain in `AUDIT_REPORT.md` §6–§9.

---

## 6. Safe setup / configuration

**Local**

```bash
npm ci
npm run dev          # http://localhost:5173
npm test             # vitest run
npm run build        # typecheck + vite build -> dist/
npm run smoke        # E2E (needs the dev server + Chrome)
```

- `.env` is optional; copy `.env.example` → `.env` and fill only what you use
  (`VITE_APPS_SCRIPT_URL`, `VITE_APPS_SCRIPT_TOKEN`, `VITE_ASSISTANT_PROXY_URL`).
  `.env` is git-ignored — never commit it, never paste a real key into an issue or screenshot.
- All documents and keys live in the browser (IndexedDB). No database or backend is required
  for the core workflow.

**Hosting (GitHub + Vercel)**

- Remote `origin` → `https://github.com/minkhantthu2692-gif/ai-document-editor-translator-final-version.git`,
  `master` tracking `origin/master`, pushed from this machine.
- `vercel.json` already ships the whole configuration: `installCommand: npm ci`,
  `buildCommand: npm run build`, `outputDirectory: dist`, SPA rewrite
  `/(.*) → /index.html` (deep links like `/workspace` survive a hard reload) and cache
  headers for `/assets/`, `/pdfjs-assets/` and `sw.js`.
- To deploy: [vercel.com/new](https://vercel.com/new) → import the repository → Deploy.
  Build settings come from `vercel.json`; `VITE_BASE` stays unset (domain root).
- GitHub Pages alternative (needs `VITE_BASE=/REPO/` and the `404.html` copy) is documented
  in `docs/DEPLOYMENT.md` — do not enable both, or the site deploys twice.

---

## 7. Manual verification the user must perform

These cannot be done without your accounts/keys:

1. **Import the repo into Vercel and deploy** (account required), then open the URL and
   hard-reload (`Ctrl+Shift+R`) once to refresh the service worker.
2. **Check a deep link** — reload `…/workspace` directly; the SPA rewrite should serve the app.
3. **Add a real API key in the app** and run a short translation (1–2 pages). Confirm the
   progress line, that Logs show masked key ids only, and that a completed chunk is not
   translated again on resume.
4. **Run the live suite** if you want provider-side proof:
   `set VERIFY_LIVE=1` + `OR_KEY1=…` (and/or `GROQ_KEY1=…`) + `VERIFY_PDF_1=…`,
   then `npx vitest run src/verify/liveRun.test.ts`.
5. **Proof-read one exported Myanmar PDF** at 100 % zoom — legibility is a visual judgement.
6. **Licence pass** for the bundled fonts before any commercial distribution.
7. **See the landing/first-time setup screen**: Settings → Data → "Delete all local data?"
   now returns to `/welcome` (smoke asserts it end to end). It is otherwise only shown on a
   fresh browser profile — once a profile has completed setup, `aidt.ui` skips it by design.
