/**
 * Phase 03 export validation harness — the visual half of task 3.7.
 *
 * Exports real fixture PDFs through the real pipeline (import → parse → mock
 * Myanmar translations → `runExport`) and rasterises every produced file to
 * PNGs for manual inspection. No live provider is touched:
 *
 *  - a throwaway, obviously-fake API key is written straight to Dexie so the
 *    wizard's preflight passes (it is never sent anywhere: translation never
 *    runs);
 *  - `translatedText` is filled in directly with canned Myanmar sentences
 *    (~1.35× the source length, plus one 2.5× stress block per document), so
 *    the layout, fit, clamp and shaping paths all see growth like a real
 *    EN→Myanmar run.
 *
 * Output lands in `validate-out/` (git-ignored):
 *   val-<fixture>-<kind>.pdf|.html   downloaded artifacts
 *   val-<fixture>-<kind>-p<N>.png    rasterised pages
 *   <fixture>-preview.png            workspace preview (best effort)
 *   summary.json                     machine-readable results
 *
 * The `print` kind saves the HTML artifact and converts it with CDP
 * `Page.printToPDF` — headless Chrome has no interactive print dialog, and
 * this drives the same print-media rendering the app's print frame does.
 *
 * Usage:
 *   node scripts/validate-export.mjs                 # the whole plan
 *   node scripts/validate-export.mjs table slide     # selected fixtures
 *   node scripts/validate-export.mjs --skip-print    # raster exports only
 *   node scripts/validate-export.mjs --skip-edit     # no Phase 04 edit round-trip
 *   node scripts/validate-export.mjs --fresh         # new browser profile
 *
 * The Phase 04 edit round-trip (on by default, once per fixture): double-click
 * a translated block in the real editor UI, type a marker, export through
 * `runExport`, assert the marker in the printed HTML *and* in the text layer
 * of the PDF Chrome prints from it, then Ctrl+Z and assert the original text
 * is back — so the fixture is left exactly as it was.
 *
 * Requires the dev server on :5173 (started automatically when absent) and
 * Chrome (Edge fallback) on this machine.
 */
import { execSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FIXTURE_DIR = join(ROOT, 'fixtures')
const OUT = join(ROOT, 'validate-out')
const BASE = 'http://localhost:5173'
const PORT = 9446

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]

/**
 * Fixture plan. `pages` limits the exported scope (0-based) so a 300-page
 * document exports a reviewable window; small fixtures export whole.
 * Kinds: `raster` (pdf-raster, default options), `adjust` (pdf-raster with
 * adjustLayout on), `print` (the `pdf` format — HTML through print-to-PDF).
 */
const PLAN = [
  { fixture: 'table', kinds: ['raster'] },
  { fixture: 'table-spans', kinds: ['raster'] },
  { fixture: 'table-continued', kinds: ['raster'] },
  { fixture: 'slide', kinds: ['raster'] },
  { fixture: 'scanned', kinds: ['raster'] },
  { fixture: 'mixed', pages: [0, 1], kinds: ['raster', 'print'] },
  {
    fixture: 'text-300p',
    pages: [0, 1, 2, 3],
    kinds: ['raster', 'adjust', 'print'],
  },
]

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const wanted = argv.filter((a) => !a.startsWith('--'))
const inspectFixture = argv.find((a) => a.startsWith('--inspect='))
  ? argv.find((a) => a.startsWith('--inspect=')).split('=')[1]
  : null
const plan = wanted.length
  ? PLAN.filter((entry) => wanted.includes(entry.fixture))
  : PLAN
if (flags.has('--skip-print')) {
  for (const entry of plan) entry.kinds = entry.kinds.filter((k) => k !== 'print')
}

const log = (line) => console.log(line)

// ── dev server ────────────────────────────────────────────────────────────
/**
 * True when the running server predates the sources it should be serving.
 * Vite's file watcher is unreliable on OneDrive-synced trees: a server
 * started before an edit can keep returning the pre-edit module forever,
 * which silently turns every export into a test of yesterday's code (how
 * 3.1's stored-box erasure "passed" validation while never running). The
 * canary is a symbol that exists on disk now; if the served transform lacks
 * it, the answer is yes.
 */
async function serverIsStale() {
  try {
    const res = await fetch(`${BASE}/src/export/pageImages.ts`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return false // cannot judge — leave a working server alone
    return !(await res.text()).includes('pageEraseBoxes')
  } catch {
    return false
  }
}

/** Kills whatever listens on 5173 (a stale server the harness must replace). */
function killPortListener() {
  try {
    execSync(
      'powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 5173 -State Listen ' +
        '-ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"',
      { stdio: 'ignore', windowsHide: true },
    )
  } catch {
    /* nothing listening */
  }
}

async function ensureServer() {
  let up = false
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(2000) })
    up = res.ok
  } catch {
    /* not up */
  }
  if (up && (await serverIsStale())) {
    log('dev server is serving stale modules — restarting it')
    killPortListener()
    up = false
    await sleep(2000)
  }
  if (up) {
    log('reusing dev server (serves current code)')
    return { spawned: null }
  }
  log(`starting dev server (${BASE}) …`)
  // Server output goes to a file: `stdio: 'ignore'` hid the reason a spawned
  // server died mid-run twice before this log existed.
  const logPath = join(OUT, 'dev-server.log')
  writeFileSync(logPath, `--- spawn ${new Date().toISOString()} ---\n`)
  const logFd = openSync(logPath, 'a')
  // `cmd.exe`, not `npm.cmd`: Node refuses to spawn .cmd files without a
  // shell (EINVAL since the CVE-2024-27980 fix), and that failure used to
  // be masked by an already-running stale server.
  const proc = spawn('cmd.exe', ['/d', '/s', '/c', 'npm.cmd run dev'], {
    cwd: ROOT,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  })
  proc.on('exit', (code, signal) => {
    log(`dev server exited code=${code} signal=${signal} (see ${logPath})`)
  })
  for (let i = 0; i < 120; i += 1) {
    await sleep(500)
    try {
      const res = await fetch(BASE, { signal: AbortSignal.timeout(1500) })
      if (res.ok) {
        log('dev server ready')
        return { spawned: proc }
      }
    } catch {
      /* not up yet */
    }
  }
  proc.kill()
  throw new Error('dev server did not come up on ' + BASE)
}

function killTree(pid) {
  try {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch {
    /* already gone */
  }
}

// ── chrome + cdp (same pattern as scripts/diagnose-render.mjs) ────────────
/**
 * The stable profile lives in the OS temp dir, not in `validate-out/`:
 * Vite watches the project root, and Chrome locking
 * `validate-out/chrome-profile/Default/Network/Cookies` made that watcher
 * throw EBUSY — an unhandled error that killed the dev server mid-run
 * (every later fetch then failed with ERR_CONNECTION_REFUSED). A legacy
 * profile inside the tree is moved out once so the imported fixture
 * projects stay available.
 */
const PROFILE_DIR = join(tmpdir(), 'aidt-validate-profile')
const LEGACY_PROFILE = join(OUT, 'chrome-profile')

function stableProfile() {
  if (!existsSync(PROFILE_DIR) && existsSync(LEGACY_PROFILE)) {
    try {
      renameSync(LEGACY_PROFILE, PROFILE_DIR)
      log(`moved Chrome profile out of the watched tree → ${PROFILE_DIR}`)
    } catch (e) {
      log(`could not move legacy profile (${e.message}) — starting fresh`)
    }
  }
  return PROFILE_DIR
}

function launchChrome() {
  const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p))
  if (!chromePath) throw new Error('no Chrome/Edge found')
  const profile = flags.has('--fresh')
    ? join(tmpdir(), `aidt-validate-${Date.now()}`)
    : stableProfile()
  mkdirSync(profile, { recursive: true })
  const chrome = spawn(
    chromePath,
    [
      '--headless',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
      '--window-size=1440,1200',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  )
  return chrome
}

async function connect() {
  let targets
  for (let i = 0; i < 80; i += 1) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      if (targets.some((t) => t.type === 'page')) break
    } catch {
      /* devtools not up yet */
    }
    targets = undefined
    await sleep(250)
  }
  if (!targets) throw new Error('Chrome DevTools never came up')

  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })

  let id = 0
  const pending = new Map()
  // Console/exception buffer — a blank page with no Vite overlay means the
  // entry module threw at runtime, and this is the only place it shows.
  const consoleErrors = []
  const note = (line) => {
    if (consoleErrors.length < 60) consoleErrors.push(line)
  }
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject: rej } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) rej(new Error(`${msg.method ?? msg.id}: ${msg.error.message}`))
      else res(msg.result)
      return
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? [])
        .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
        .join(' ')
      note(`${msg.params.type}: ${text}`)
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      note(`EXCEPTION: ${d.exception?.description || d.text}`)
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry
      if (e.level === 'error' || e.level === 'warning') note(`LOG ${e.level}: ${e.text}`)
    }
  })
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const callId = ++id
      pending.set(callId, { resolve: res, reject: rej })
      ws.send(JSON.stringify({ id: callId, method, params }))
    })

  for (const domain of ['Page', 'Runtime', 'Log', 'DOM']) await send(`${domain}.enable`)

  const evalJs = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.exceptionDetails) {
      return { __error: r.exceptionDetails.exception?.description || r.exceptionDetails.text }
    }
    return r.result.value
  }

  const goto = async (path) => {
    const target = path.startsWith('http') || path.startsWith('file:') ? path : BASE + path
    const wantPath = path.startsWith('http') || path.startsWith('file:')
      ? new URL(path).pathname
      : path
    try {
      await send('Page.navigate', { url: target })
    } catch {
      // A previous navigation can still be committing; the path poll below
      // decides whether this one ever lands.
    }
    for (let i = 0; i < 240; i += 1) {
      let state = null
      try {
        state = await evalJs(
          `JSON.stringify({ready: document.readyState, welcome: !!document.querySelector('[data-testid="welcome-get-started"]'), n: document.querySelector('#main-content')?.childElementCount ?? -1, p: location.protocol === 'http:' || location.protocol === 'https:' ? location.pathname : '!' + location.protocol})`,
          false,
        )
      } catch {
        // Execution context destroyed mid-navigation — poll again.
        await sleep(100)
        continue
      }
      const parsed = typeof state === 'string' ? JSON.parse(state) : state
      if (parsed?.p && parsed.p.startsWith('!')) {
        // An error/about document — wait for the real navigation to commit.
        await sleep(100)
        continue
      }
      if (parsed?.welcome) {
        await evalJs(`document.querySelector('[data-testid="welcome-get-started"]')?.click()`, false)
        await sleep(400)
        try {
          await send('Page.navigate', { url: target })
        } catch {
          /* committing; poll decides */
        }
        continue
      }
      // The path check matters: before the new document commits, the polls
      // read the OLD page (ready + populated) and would return early while
      // the navigation is still in flight.
      if (parsed?.p === wantPath && parsed?.ready === 'complete' && parsed.n > 0) {
        await sleep(200)
        return
      }
      await sleep(100)
    }
    // Timeout: say what the page actually holds — a Vite error overlay, a
    // blank boot, or an app stuck at `interactive` all look identical here.
    const diag = await evalJs(
      `JSON.stringify({
        ready: document.readyState,
        url: location.href,
        n: document.querySelector('#main-content')?.childElementCount ?? -1,
        overlay: document.querySelector('vite-error-overlay')?.shadowRoot?.innerText?.slice(0, 600) ?? null,
        body: (document.body?.innerText || '').slice(0, 400),
        scripts: document.querySelectorAll('script').length,
      })`,
      false,
    )
    throw new Error('render timeout for ' + path + ' — ' + diag + ' — console: ' + JSON.stringify(consoleErrors.slice(-12)))
  }

  const waitFor = async (expression, timeoutMs = 60000) => {
    for (let waited = 0; waited < timeoutMs; waited += 150) {
      let value = null
      try {
        value = await evalJs(expression, false)
      } catch {
        /* navigating */
      }
      if (value) return value
      await sleep(150)
    }
    return null
  }

  const click = (selector) =>
    evalJs(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.disabled) return false; el.click(); return true })()`,
      false,
    )

  const attachFile = async (path) => {
    const doc = await send('DOM.getDocument', { depth: -1 })
    const { nodeId } = await send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: 'input[data-testid="file-input"]',
    })
    if (!nodeId) throw new Error('file input not found')
    await send('DOM.setFileInputFiles', { files: [path], nodeId })
  }

  /** Screenshot one element (or the viewport) to `validate-out/<name>.png`. */
  const shoot = async (name, selector = null) => {
    let clip
    if (selector) {
      await evalJs(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.scrollIntoView({ block: 'start', inline: 'start' }); return !!el })()`,
        false,
      )
      await sleep(400)
      const doc = await send('DOM.getDocument', { depth: -1 })
      const { nodeId } = await send('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector,
      })
      if (!nodeId) {
        log(`  MISSING ELEMENT ${selector}`)
        return null
      }
      const { model } = await send('DOM.getBoxModel', { nodeId })
      const quad = model.border
      const xs = [quad[0], quad[2], quad[4], quad[6]]
      const ys = [quad[1], quad[3], quad[5], quad[7]]
      clip = {
        x: Math.max(0, Math.min(...xs)),
        y: Math.max(0, Math.min(...ys)),
        width: Math.max(1, Math.max(...xs) - Math.max(0, Math.min(...xs))),
        height: Math.max(1, Math.max(...ys) - Math.max(0, Math.min(...ys))),
        scale: 1,
      }
    }
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      ...(clip ? { clip, captureBeyondViewport: true } : {}),
    })
    const file = join(OUT, `${name}.png`)
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    log(`  shot  ${name}.png`)
    return file
  }

  return { ws, send, evalJs, goto, waitFor, click, attachFile, shoot }
}

// ── in-page helpers ───────────────────────────────────────────────────────
const SENTENCES = [
  'မြန်မာနိုင်ငံသည် အရှေ့တောင်အာရှဒေသတွင် တည်ရှိပြီး ရှေးဟောင်းယဉ်ကျေးမှုများဖြင့် ကြွယ်ဝသည်။ ',
  'ဤစာပိုဒ်ကို စာသားထုတ်ယူမှုနှင့် ဘာသာပြန်ဆိုမှုအတွက် စမ်းသပ်အသုံးပြုခြင်း ဖြစ်သည်။ ',
  'စာလုံးများ စုစည်းမှု၊ ဝဏ္ဏချိတ်ဆက်မှုနှင့် အသံထွက်ပြောင်းလဲမှုများ မှန်ကန်စွာ ပေါ်ထွက်ရန် လိုအပ်သည်။ ',
  'ကျောင်းသားများသည် သင်ခန်းစာများကို ဂရုတစိုက် လေ့လာကြသည်။ ',
  'ဤစာအုပ်ကို အင်္ဂလိပ်စကားမှ မြန်မာစကားသို့ ပြန်ဆိုထားသည်။ ',
  'ဒီဂျစ်တယ်စာရွက်စာတမ်းများကို လုံခြုံစွာ သိမ်းဆည်းထားနိုင်သည်။ ',
]

/** Builds the in-page mock-translation script for one project. */
function mockScript(pid) {
  return String.raw`(async () => {
    const { blockRepo, pageRepo } = await import('/src/db/repo-content.ts')
    const [pages, blocks] = await Promise.all([
      pageRepo.listByProject('${pid}'),
      blockRepo.listByProject('${pid}'),
    ])
    const pageOrder = new Map(pages.map((p) => [p.id, p.index]))
    const sorted = [...blocks].sort((a, b) => {
      const pa = pageOrder.get(a.pageId) ?? 0
      const pb = pageOrder.get(b.pageId) ?? 0
      return pa !== pb ? pa - pb : a.order - b.order
    })
    const SENT = ${JSON.stringify(SENTENCES)}
    // Cut at a word boundary; strip trailing Myanmar combining marks so a cut
    // never leaves a cluster half-formed.
    const clip = (text, n) => {
      if (text.length <= n) return text
      let cut = text.lastIndexOf(' ', n)
      if (cut < n * 0.5) cut = n
      return text.slice(0, cut).replace(/[\u102d-\u1037\u1039\u103a\u103b-\u103f\u1056-\u1059]+$/u, '')
    }
    const make = (src, mult, min) => {
      const target = Math.max(min, Math.ceil(src.length * mult))
      let out = ''
      let i = 0
      while (out.length < target) {
        out += SENT[i % SENT.length]
        i += 1
      }
      return clip(out, target)
    }
    let done = 0
    let skipped = 0
    let stressed = 0
    let firstEligible = true
    for (const b of sorted) {
      const eligible = b.sourceText.length > 0 && !b.skipRule && b.status !== 'skipped' && b.status !== 'locked'
      if (!eligible) {
        skipped += 1
        firstEligible = false
        continue
      }
      if (b.translatedText.length > 0) {
        skipped += 1
        firstEligible = false
        continue
      }
      // One 2.5× stress block per document guarantees the fit floor / clamp /
      // report path is actually exercised.
      const stress = firstEligible
      const mock = make(b.sourceText, stress ? 2.5 : 1.35, stress ? 260 : 16)
      await blockRepo.update(b.id, {
        translatedText: mock,
        status: 'translated',
        characterCount: mock.length,
      })
      done += 1
      if (stress) stressed += 1
      firstEligible = false
    }
    return { total: sorted.length, done, skipped, stressed, pages: pages.length }
  })()`
}

/**
 * `fixtures/scanned.pdf` pages are white sheets with black bars — no glyphs —
 * so both engines (tesseract browser OCR and the recorded sidecar answer)
 * legitimately return zero blocks. To still validate the scanned-page export
 * path (stored-erase boxes 3.1, feathered inpaint 3.4) the harness injects
 * synthetic blocks with realistic geometry through the real repo API; the
 * normal mock-translation step then fills their `translatedText` like any
 * other project. Returns null when the project has no scanned pages (i.e.
 * an empty document there would be a real problem, not this fixture's design).
 */
function injectScannedScript(pid) {
  return String.raw`(async () => {
    const { pageRepo, blockRepo } = await import('/src/db/repo-content.ts')
    const pages = await pageRepo.listByProject('${pid}')
    const scannedPages = pages.filter((p) => p.contentClass === 'scanned')
    if (scannedPages.length === 0) return null
    const SPOTS = [
      { y: 96, h: 30, kind: 'heading', size: 18, bold: true },
      { y: 190, h: 26, kind: 'paragraph', size: 12, bold: false },
      { y: 300, h: 26, kind: 'paragraph', size: 12, bold: false },
    ]
    let order = 0
    let created = 0
    for (const page of scannedPages) {
      for (const [i, spot] of SPOTS.entries()) {
        await blockRepo.upsert({
          projectId: '${pid}',
          pageId: page.id,
          order: order++,
          kind: spot.kind,
          region: 'body',
          sourceText: 'Scanned source line ' + (i + 1) + ' of page ' + (page.index + 1),
          x: 54,
          y: spot.y,
          width: 504,
          height: spot.h,
          fontSize: spot.size,
          originalFontSize: spot.size,
          bold: spot.bold,
        })
        created += 1
      }
    }
    return {
      reason: 'fixture pages contain no glyphs (synthetic bars); blocks injected as a mock',
      scannedPages: scannedPages.length,
      classes: pages.map((p) => p.contentClass),
      created,
    }
  })()`
}

// ── flow steps ────────────────────────────────────────────────────────────
async function ensureApiKey(evalJs) {
  const state = await evalJs(
    `(async () => {
      const { apiKeyRepo } = await import('/src/db/repo-apiKeys.ts')
      const rows = await apiKeyRepo.list()
      const existing = rows.find((row) => row.label === 'validate-export mock')
      if (!existing) {
        await apiKeyRepo.create({
          provider: 'gemini',
          label: 'validate-export mock',
          secret: 'not-a-real-key-validate-export',
        })
      }
      return (await apiKeyRepo.list()).length
    })()`,
  )
  if (state?.__error) throw new Error('apiKey setup failed: ' + state.__error)
  log(`dummy api key ready (${state} key rows)`)
}

async function findProject(pid, evalJs) {
  const state = await evalJs(
    `(async () => {
      const { projectRepo } = await import('/src/db/repo-projects.ts')
      const all = typeof projectRepo.list === 'function' ? await projectRepo.list() : []
      return all.map((p) => ({ id: p.id, name: p.name }))
    })()`,
  )
  if (state?.__error) return null
  return (state ?? []).find((p) => p.name === pid) ?? null
}

/** Import one fixture through the wizard; returns the workspace path. */
async function importFixture(ctx, fixture) {
  const { evalJs, goto, waitFor, click, attachFile } = ctx
  const file = join(FIXTURE_DIR, `${fixture}.pdf`)
  if (!existsSync(file)) throw new Error('missing fixture ' + file)

  await goto('/projects/new')
  await attachFile(file)
  await waitFor(`document.querySelectorAll('[data-testid="file-row"]').length`, 60000)
  await waitFor(`!!document.querySelector('[data-testid="wizard-next"]:not([disabled])')`, 120000)
  await click('[data-testid="wizard-next"]')
  const analyzed = await waitFor(
    `!!document.querySelector('[data-testid="metadata-table"]') && !!document.querySelector('[data-testid="check-integrity"]')`,
    300000,
  )
  if (!analyzed) throw new Error('analysis never finished for ' + fixture)

  // Scanned fixtures are offered OCR in the wizard; switch it on when asked.
  if (await waitFor(`!!document.querySelector('[data-testid="fix-textLayer"]')`, 3000)) {
    await click('[data-testid="fix-textLayer"]')
    log('  enabled OCR (fix-textLayer)')
    await sleep(400)
  }

  for (let step = 0; step < 4; step += 1) {
    const started = await waitFor(
      `!!(document.querySelector('[data-testid="wizard-start"]:not([disabled])') || document.querySelector('[data-testid="status-start"]:not([disabled])'))`,
      2000,
    )
    if (started) break
    const ready = await waitFor(`!!document.querySelector('[data-testid="wizard-next"]:not([disabled])')`, 4000)
    if (!ready) break
    await click('[data-testid="wizard-next"]')
    await sleep(500)
  }
  const startReady = await waitFor(
    `!!(document.querySelector('[data-testid="wizard-start"]:not([disabled])') || document.querySelector('[data-testid="status-start"]:not([disabled])'))`,
    30000,
  )
  if (!startReady) {
    const blocked = await evalJs(
      `JSON.stringify([...document.querySelectorAll('[data-testid^="check-"]')].map((e) => ({ id: e.getAttribute('data-testid'), text: (e.innerText || '').slice(0, 140) })))`,
      false,
    )
    throw new Error('Start never enabled. checks: ' + blocked)
  }
  const clicked = await evalJs(
    `(() => {
      const el = document.querySelector('[data-testid="wizard-start"]:not([disabled])') || document.querySelector('[data-testid="status-start"]:not([disabled])')
      if (!el) return false
      el.click(); return true
    })()`,
    false,
  )
  if (!clicked) log('  start click found no enabled button (state changed between polls)')

  // Poll `location.pathname` as a plain string and remember every value seen:
  // when navigation misbehaves the timeline is the diagnosis.
  const seen = []
  let workspacePath = null
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    let p = null
    try {
      p = await evalJs('location.pathname', false)
    } catch {
      /* context destroyed mid-navigation */
    }
    if (typeof p === 'string' && p.length > 0 && seen[seen.length - 1] !== p) {
      seen.push(p)
      if (p.startsWith('/workspace/')) {
        workspacePath = p
        break
      }
    }
    await sleep(250)
  }
  if (!workspacePath) {
    const diag = await evalJs(
      `JSON.stringify({
        path: location.pathname,
        seen: ${JSON.stringify(seen)},
        toasts: [...document.querySelectorAll('[data-testid^="toast"], [role="alert"], .toast')].map((t) => (t.innerText || '').slice(0, 200)),
        startStillThere: !!document.querySelector('[data-testid="wizard-start"]'),
        blocked: [...document.querySelectorAll('[data-testid^="check-"]')].map((e) => ({ id: e.getAttribute('data-testid'), text: (e.innerText || '').slice(0, 120) })),
        main: (document.querySelector('#main-content')?.innerText || '').slice(0, 300),
      })`,
      false,
    )
    throw new Error(
      'workspace never opened for ' + fixture + ' — seen paths: ' + JSON.stringify(seen) + ' — ' + diag,
    )
  }
  log('  navigation timeline: ' + JSON.stringify(seen))
  return workspacePath
}

/** Wait for the structure parse and any OCR to settle; returns a report. */
async function waitForParse(ctx, pid) {
  const { evalJs, waitFor } = ctx
  const parsed = await waitFor(
    `(() => {
      if (document.querySelector('[data-testid="page-parse-complete"]')) return true
      const el = document.querySelector('[data-testid="page-parse-progress"]')
      if (!el) return false
      const m = el.innerText.match(/(\\d+)\\s*\\/\\s*(\\d+)/)
      return !!(m && Number(m[1]) === Number(m[2]))
    })()`,
    600000,
  )
  if (!parsed) throw new Error('parse never completed for ' + pid)

  // OCR runs inside the parse queue; settle on any queued/running page.
  let ocrStates = null
  for (let i = 0; i < 20; i += 1) {
    await sleep(1500)
    ocrStates = await evalJs(
      `(async () => {
        const { pageRepo } = await import('/src/db/repo-content.ts')
        const pages = await pageRepo.listByProject('${pid}')
        return pages.map((p) => p.ocrStatus)
      })()`,
    )
    if (ocrStates?.__error) break
    if (!(ocrStates ?? []).some((s) => s === 'queued' || s === 'running')) break
  }
  const counts = {}
  for (const s of ocrStates ?? []) counts[s] = (counts[s] ?? 0) + 1
  return { ocr: counts }
}

async function countBlocks(ctx, pid) {
  const state = await ctx.evalJs(
    `(async () => {
      const { blockRepo } = await import('/src/db/repo-content.ts')
      const blocks = await blockRepo.listByProject('${pid}')
      return blocks.length
    })()`,
  )
  return typeof state === 'number' ? state : -1
}

/** Run one export through the real pipeline; returns { file, issues }. */
async function runExport(ctx, { pid, kind, fileName, pages }) {
  const { evalJs } = ctx
  const options =
    kind === 'print'
      ? { format: 'pdf', fileName }
      : { format: 'pdf-raster', fileName, ...(kind === 'adjust' ? { adjustLayout: true } : {}) }
  const pageIndexes = pages ? `pageIndexes: ${JSON.stringify(pages)},` : ''
  const expression = `(async () => {
    const mod = await import('/src/export/runExport.ts')
    const withTimeout = (p, ms) => {
      let timer
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('export-timeout')), ms) })
      return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
    }
    const toB64 = async (blob) => {
      const buf = new Uint8Array(await blob.arrayBuffer())
      let bin = ''
      const CH = 0x8000
      for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode(...buf.subarray(i, i + CH))
      return btoa(bin)
    }
    try {
      const res = await withTimeout(mod.runExport({
        projectId: '${pid}',
        ${pageIndexes}
        options: ${JSON.stringify(options)},
      }), 300000)
      // Bytes come back over CDP: the dev server only serves files that
      // existed when it started, so a fresh download cannot be fetched back.
      const b64 = await toB64(res.artifact.blob)
      return {
        ok: true,
        issues: res.issues,
        durationMs: res.durationMs,
        pages: res.doc.pages.length,
        blocks: res.doc.pages.reduce((n, p) => n + p.blocks.length, 0),
        stats: res.stats,
        fileName: res.artifact.fileName,
        mime: res.artifact.mime,
        bytes: res.artifact.bytes,
        b64,
      }
    } catch (e) {
      return {
        ok: false,
        error: String((e && e.message) || e),
        code: e && e.code,
        issues: (e && e.issues) || [],
      }
    }
  })()`
  const result = await evalJs(expression)
  if (result?.__error) return { ok: false, error: result.__error, issues: [] }
  return result
}

/** Convert a downloaded print HTML into a PDF via CDP printToPDF. */
async function printHtmlToPdf(ctx, htmlPath, backTo) {
  const { send, goto, waitFor } = ctx
  try {
    const url = 'file:///' + htmlPath.replace(/\\/g, '/')
    await send('Page.navigate', { url })
    const loaded = await waitFor(
      `document.readyState === 'complete' && !!document.querySelector('.page')`,
      60000,
    )
    if (!loaded) throw new Error('print HTML never rendered: ' + htmlPath)
    await sleep(600)
    const pdf = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true })
    const pdfPath = htmlPath.replace(/\.html$/, '.print.pdf')
    writeFileSync(pdfPath, Buffer.from(pdf.data, 'base64'))
    return pdfPath
  } finally {
    // Always get back to the app origin: a stranded file:// page would break
    // every later dynamic import (they resolve against the page's URL).
    try {
      await goto(backTo)
    } catch {
      /* leave it — reported by the caller's next step */
    }
  }
}

/**
 * Extract a PDF's text layer — Node-side, through pdfjs' legacy build.
 *
 * Text extraction needs no canvas (rasterisePdf still runs in the page for
 * that reason), and doing it in Node removes every environment variable the
 * in-page evaluate inherits: origin after the print navigation, worker state,
 * CMap resolution. Proven against `val-editproof-*.print.pdf` directly.
 */
async function pdfText(pdfPath) {
  const pdfjs = await import(
    pathToFileURL(join(ROOT, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href
  )
  const data = new Uint8Array(readFileSync(pdfPath))
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise
  let out = ''
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    out += content.items.map((it) => it.str).join(' ') + '\n'
  }
  return out
}

/**
 * Phase 04 (task 4.2) — the edit round trip, end to end.
 *
 * Drives the real editor UI (dblclick → inline contentEditable → blur →
 * command stack → Dexie), exports through the same `runExport` the dialog
 * uses, and asserts a unique marker in (a) the printed HTML artifact and
 * (b) the text layer of the PDF Chrome prints from it — the phase brief's
 * "verify that it is present in the final PDF". Ctrl+Z then goes through the
 * editor's own window handler and the original text must come back, so the
 * fixture is left exactly as it was for later runs (a direct Dexie rewrite is
 * the belt-and-braces fallback and is reported in `issues`).
 *
 * `eligible:false` (no mock-translated paragraph in scope) is a note, not a
 * failure: it means the fixture has nothing an editor could edit.
 */
async function editRoundTrip(ctx, { pid, fixture, workspacePath, pages }) {
  const { evalJs, waitFor, goto } = ctx
  const marker = 'EDITRT-' + Math.random().toString(36).slice(2, 6).toUpperCase()
  const out = {
    marker,
    eligible: false,
    saved: false,
    statusOk: false,
    html: false,
    pdf: false,
    undo: false,
    issues: [],
    file: null,
    pdfFile: null,
    pngs: [],
  }

  // The edit and the undo must share one page session — the undo stack lives
  // in the store, and printHtmlToPdf navigates away (which resets it).
  const onWorkspace = await evalJs(
    `location.pathname === ${JSON.stringify(workspacePath)}`,
    false,
  )
  if (!onWorkspace) {
    await goto(workspacePath)
    const ready = await waitFor(
      `!!document.querySelector('[data-testid="workspace-editor"]') &&
        document.querySelectorAll('[data-block-id]').length > 0`,
      60000,
    )
    if (!ready) {
      out.issues.push('workspace blocks never rendered')
      return out
    }
  }

  // Target through the model: mock-translated paragraphs inside the pages this
  // fixture exports, without a skip rule (skip blocks print their source text
  // by design, and source text must never be edited). Prefer one whose row is
  // already mounted: Virtuoso renders one row per page and only the rows near
  // the viewport, so a later page's blocks do not exist in the DOM yet.
  const target = await evalJs(`(async () => {
    const { blockRepo, pageRepo } = await import('/src/db/repo-content.ts')
    const [pages, blocks] = await Promise.all([
      pageRepo.listByProject('${pid}'),
      blockRepo.listByProject('${pid}'),
    ])
    const wanted = ${pages ? JSON.stringify(pages) : 'null'}
    const inScope = new Set(
      pages.filter((p) => !wanted || wanted.includes(p.index)).map((p) => p.id),
    )
    const pageById = new Map(pages.map((p) => [p.id, p.index]))
    const eligible = blocks
      .filter(
        (b) =>
          inScope.has(b.pageId) &&
          b.kind === 'paragraph' &&
          !b.skipRule &&
          (b.status === 'translated' || b.status === 'edited') &&
          b.translatedText.trim().length > 0,
      )
      .map((b) => ({
        id: b.id,
        text: b.translatedText,
        status: b.status,
        pageIndex: pageById.get(b.pageId),
      }))
      .sort((a, b) => a.pageIndex - b.pageIndex)
    if (eligible.length === 0) return null
    const rendered = new Set(
      [...document.querySelectorAll('[data-block-id]')].map((n) => n.getAttribute('data-block-id')),
    )
    return eligible.find((b) => rendered.has(b.id)) ?? eligible[0]
  })()`)
  if (target?.__error) throw new Error('target lookup failed: ' + target.__error)
  if (!target) {
    out.issues.push('no mock-translated paragraph in scope')
    return out
  }
  out.eligible = true

  // The real gesture: the block node, a double click, a typed marker, blur.
  // If the target's row is not mounted yet, walk the editor's inner scroller
  // a screen at a time until Virtuoso mounts it (the row only has to exist —
  // the synthetic double-click does not need it to be in the viewport).
  let nodeUp = await waitFor(`!!document.querySelector('[data-block-id="${target.id}"]')`, 5000)
  for (let step = 0; step < 16 && !nodeUp; step++) {
    const moved = await evalJs(
      `(() => {
        const scroller = [...document.querySelectorAll('[data-testid="workspace-editor"] div')].find(
          (d) =>
            d.scrollHeight > d.clientHeight + 40 &&
            /auto|scroll/.test(getComputedStyle(d).overflowY),
        )
        if (!scroller) return false
        const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4
        scroller.scrollTop = atEnd ? 0 : scroller.scrollTop + scroller.clientHeight
        return true
      })()`,
      false,
    )
    if (!moved) break
    nodeUp = await waitFor(`!!document.querySelector('[data-block-id="${target.id}"]')`, 4000)
  }
  if (!nodeUp) {
    out.issues.push(`block node never rendered (page ${target.pageIndex})`)
    return out
  }
  // Capture page-side errors from the start so a silent throw in the commit
  // path can be reported instead of guessed at.
  await evalJs(
    `(() => {
      window.__rtErrors = []
      window.addEventListener('error', (e) => window.__rtErrors.push(String(e.message)))
      window.addEventListener('unhandledrejection', (e) =>
        window.__rtErrors.push(String((e.reason && e.reason.stack) || e.reason)),
      )
      return true
    })()`,
    false,
  )
  await evalJs(
    `(() => {
      const node = document.querySelector('[data-block-id="${target.id}"]')
      node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
      return true
    })()`,
    false,
  )
  const opened = await waitFor(`!!document.querySelector('[data-testid="block-editor"]')`, 10000)
  if (!opened) {
    out.issues.push('inline editor never opened')
    return out
  }
  const typed = await evalJs(
    `(() => {
      const ed = document.querySelector('[data-testid="block-editor"]')
      if (!ed) return false
      ed.focus()
      ed.textContent = ${JSON.stringify(marker)}
      // React 18 binds onBlur to the native bubbling focusout event (see
      // registerSimpleEvents in react-dom). Dispatch it directly: a synthetic
      // focusout reaches React's root listener whether or not the headless
      // window granted the contentEditable real focus, while ed.blur()
      // fires nothing at all on an unfocused element.
      ed.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      return true
    })()`,
    false,
  )
  if (typed?.__error || !typed) {
    out.issues.push('inline edit failed: ' + (typed?.__error ?? 'editor gone'))
    return out
  }

  // Auto-save landed AND the command reached the undo stack: commitCommand
  // writes Dexie before pushing, so both are polled together.
  let state = null
  for (let i = 0; i < 80; i++) {
    state = await evalJs(`(async () => {
      const [{ blockRepo }, { useEditorStore }] = await Promise.all([
        import('/src/db/repo-content.ts'),
        import('/src/editor/store.ts'),
      ])
      const r = await blockRepo.get('${target.id}')
      return {
        text: r ? r.translatedText : null,
        status: r ? r.status : null,
        undo: useEditorStore.getState().undoStack.length,
      }
    })()`)
    if (state && !state.__error && state.text === marker && state.undo >= 1) break
    await sleep(150)
  }
  out.saved = !!state && state.text === marker && state.undo >= 1
  out.statusOk = out.saved && state.status === 'edited'
  if (!out.saved) {
    const diag = await evalJs(`(async () => {
      const [{ useEditorStore }] = await Promise.all([import('/src/editor/store.ts')])
      const s = useEditorStore.getState()
      return {
        editorOpen: !!document.querySelector('[data-testid="block-editor"]'),
        editingId: s.editingBlockId,
        undo: s.undoStack.length,
        errs: window.__rtErrors || [],
      }
    })()`)
    out.issues.push(
      'commit never persisted (state=' + JSON.stringify(state) + ' diag=' + JSON.stringify(diag) + ')',
    )
    return out // nothing was written — nothing to restore
  }
  if (!out.statusOk) out.issues.push('status after edit was ' + state.status)

  // Export through the real orchestration: format 'pdf' builds the print HTML.
  let fileAbs = null
  try {
    const fileName = `val-editproof-${fixture}`
    const run = await runExport(ctx, { pid, kind: 'print', fileName, pages })
    if (!run.ok || typeof run.b64 !== 'string') {
      out.issues.push('export failed: ' + (run.error ?? 'no bytes'))
    } else {
      fileAbs = join(OUT, `${fileName}.html`)
      writeFileSync(fileAbs, Buffer.from(run.b64, 'base64'))
      out.file = `${fileName}.html`
      out.html = readFileSync(fileAbs, 'utf8').includes(marker)
      if (!out.html) out.issues.push('marker missing from the print HTML')
    }
  } catch (e) {
    out.issues.push('export crashed: ' + (e.message ?? e))
  }

  // Undo through the editor's own Ctrl+Z handler — before printHtmlToPdf
  // navigates away and resets the store. Always reached once the marker is
  // in Dexie, so a failed export can never leave the fixture dirty.
  await evalJs(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`,
    false,
  )
  let back = null
  for (let i = 0; i < 80; i++) {
    back = await evalJs(`(async () => {
      const { blockRepo } = await import('/src/db/repo-content.ts')
      const r = await blockRepo.get('${target.id}')
      return r ? { text: r.translatedText, status: r.status } : null
    })()`)
    if (back && !back.__error && back.text === target.text) break
    await sleep(150)
  }
  out.undo = !!back && back.text === target.text
  if (!out.undo) {
    const fixed = await evalJs(`(async () => {
      const { blockRepo } = await import('/src/db/repo-content.ts')
      await blockRepo.update('${target.id}', {
        translatedText: ${JSON.stringify(target.text)},
        status: ${JSON.stringify(target.status)},
      })
      return true
    })()`)
    if (fixed?.__error) throw new Error('restore failed: ' + fixed.__error)
    out.issues.push('Ctrl+Z did not restore — row rewritten directly')
  }

  // Print the (already written) artifact and read its text layer back.
  if (fileAbs) {
    try {
      const pdfPath = await printHtmlToPdf(ctx, fileAbs, workspacePath)
      out.pdfFile = pdfPath.split(/[\\/]/).pop()
      const text = await pdfText(pdfPath)
      // pdf.js chunks a line into positioning items and pdfText joins them
      // with a space, so the marker can arrive as "EDITRT -BFJN"; compare
      // whitespace-insensitively (the marker itself has no whitespace).
      const flat = text.replace(/\s+/g, '')
      out.pdf = flat.includes(marker)
      if (!out.pdf) {
        const at = text.indexOf('EDITRT')
        out.issues.push(
          `marker missing from the printed PDF text (chars=${text.length}` +
            (at >= 0 ? ` near=${JSON.stringify(text.slice(at, at + 24))}` : '') +
            ')',
        )
      }
      const firstWanted = pages ? Math.min(...pages) : 0
      const pdfPage = Math.max(1, target.pageIndex - firstWanted + 1)
      out.pngs.push(
        ...(await rasterizePdf(ctx, pdfPath, [pdfPage], `val-editproof-${fixture}`)),
      )
    } catch (e) {
      out.issues.push('print/pdf: ' + (e.message ?? e))
    }
  }
  return out
}

/**
 * Rasterise a PDF through pdf.js served by the dev server (Node has no
 * canvas, headless Chrome does not display PDFs). The PDF bytes travel into
 * the page as base64 in the evaluate call — same reason as the artifact path.
 * Returns saved PNG paths.
 */
async function rasterizePdf(ctx, pdfPath, pageNumbers, namePrefix) {
  const { evalJs } = ctx
  const name = pdfPath.split(/[\\/]/).pop()
  const boot = await evalJs(
    `(async () => {
      if (!window.__pdfjs) {
        window.__pdfjs = await import('/node_modules/pdfjs-dist/build/pdf.mjs')
        window.__pdfjs.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.mjs'
      }
      return window.__pdfjs.version
    })()`,
  )
  if (boot?.__error) throw new Error('pdfjs load failed: ' + boot.__error)
  log(`  pdfjs ${boot} on ${name}`)

  const b64 = readFileSync(pdfPath).toString('base64')
  const saved = []
  for (const n of pageNumbers) {
    const dataUrl = await evalJs(
      `(async () => {
        const pdfjs = window.__pdfjs
        const bytes = Uint8Array.from(atob('${b64}'), (c) => c.charCodeAt(0))
        const doc = await pdfjs.getDocument({
          data: bytes,
          cMapUrl: '/node_modules/pdfjs-dist/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: '/node_modules/pdfjs-dist/standard_fonts/',
        }).promise
        const page = await doc.getPage(${n})
        const viewport = page.getViewport({ scale: 1.5 })
        const canvas = document.createElement('canvas')
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        await page.render({ canvasContext: ctx, canvas, viewport }).promise
        return canvas.toDataURL('image/png')
      })()`,
    )
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png')) {
      throw new Error(`render page ${n} failed: ` + JSON.stringify(dataUrl).slice(0, 300))
    }
    const file = join(OUT, `${namePrefix}-p${n}.png`)
    writeFileSync(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
    log(`  png   ${namePrefix}-p${n}.png`)
    saved.push(file)
  }
  return saved
}

/** Best-effort workspace preview screenshot (validates the preview erase). */
async function shootPreview(ctx, fixture) {
  const { waitFor, click, shoot } = ctx
  await click('[data-testid="view-translated"]')
  await sleep(800)
  const imgReady = await waitFor(
    `(() => {
      const img = document.querySelector('[data-testid="pane-translated"] img')
      return !!img && img.complete && img.naturalWidth > 0
    })()`,
    20000,
  )
  if (imgReady) {
    await sleep(600)
    return shoot(`${fixture}-preview`, '[data-testid="pane-translated"]')
  }
  const origReady = await waitFor(
    `(() => {
      const img = document.querySelector('[data-testid="pane-original"] img')
      return !!img && img.complete && img.naturalWidth > 0
    })()`,
    10000,
  )
  if (origReady) return shoot(`${fixture}-preview`, '[data-testid="pane-original"]')
  log('  no preview pane ready — skipped preview shot')
  return null
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(OUT, { recursive: true })
  // Clear previous artifacts but keep the (stable) browser profile. The
  // inspect mode is read-only and leaves the PNGs alone.
  if (!inspectFixture) {
    for (const f of readdirSync(OUT)) {
      if (f === 'chrome-profile') continue
      rmSync(join(OUT, f), { recursive: true, force: true })
    }
  }

  const results = []
  const server = await ensureServer()
  const chrome = launchChrome()
  let ctx = null
  try {
    ctx = await connect()
    const { evalJs, goto } = ctx

    await goto('/')
    await ensureApiKey(evalJs)

    // --inspect=<fixture>: dump the stored pages/blocks/events for one project
    // and exit — the diagnostic companion when a fixture exports nothing (or
    // exports something that should not look like that). Also renders page 0
    // through the real export pipeline twice — with and without the collected
    // erase boxes — and samples pixels inside a box, so "did erasure actually
    // reach the canvas" is answered with numbers instead of code reading.
    if (inspectFixture) {
      const found = await findProject(inspectFixture, evalJs)
      if (!found) throw new Error('no project named ' + inspectFixture)
      await goto('/workspace/' + found.id)
      // Opening the workspace re-queues unparsed pages (see restoreParse);
      // collect must see the post-reparse state, not a mid-wipe snapshot.
      const settled = await waitForParse(ctx, found.id)
      log('post-open parse state: ' + JSON.stringify(settled))
      if ((await countBlocks(ctx, found.id)) <= 0) {
        const injected = await evalJs(injectScannedScript(found.id))
        log('inspect: re-injected synthetic blocks: ' + JSON.stringify(injected))
      }
      const dump = await evalJs(
        `(async () => {
          const { pageRepo, blockRepo } = await import('/src/db/repo-content.ts')
          const pages = await pageRepo.listByProject('${found.id}')
          const blocks = await blockRepo.listByProject('${found.id}')
          let events = []
          try {
            const { getDb } = await import('/src/db/db.ts')
            events = await getDb().events.orderBy('timestamp').reverse().limit(30).toArray()
          } catch (e) { events = ['events: ' + e.message] }

          // ── erase probe: same collect + render calls runExport makes ──
          let erase = null
          try {
            const { collectExportDocument } = await import('/src/export/collect.ts')
            const pageImages = await import('/src/export/pageImages.ts')
            const pageEraseBoxes = pageImages.pageEraseBoxes
            const renderPageImages = pageImages.renderPageImages
            if (typeof pageEraseBoxes !== 'function' || typeof renderPageImages !== 'function') {
              throw new Error(
                'pageImages exports: ' +
                  Object.keys(pageImages).join(',') +
                  ' (default=' + typeof pageImages.default + ')',
              )
            }
            const doc = await collectExportDocument({ projectId: '${found.id}' })
            const pageBoxes = doc.pages.map((p) => ({
              index: p.index,
              cls: p.contentClass,
              boxes: pageEraseBoxes(p),
            }))
            const target = doc.pages.find((p) => pageEraseBoxes(p).length > 0)
            let sample = null
            if (target) {
              const boxes = pageEraseBoxes(target)
              const scale = 2
              const render = async (withErase) => {
                const imgs = await renderPageImages({
                  projectId: '${found.id}',
                  pageIndexes: [target.index],
                  scale,
                  mode: 'background',
                  eraseBoxesFor: () => (withErase ? boxes : undefined),
                })
                if (imgs.length === 0) return { error: 'no image rendered' }
                const bmp = await createImageBitmap(imgs[0].blob)
                const cv = new OffscreenCanvas(bmp.width, bmp.height)
                const g = cv.getContext('2d')
                g.drawImage(bmp, 0, 0)
                const stats = (x, y, w, h) => {
                  const sw = Math.max(1, Math.min(w, bmp.width - x))
                  const sh = Math.max(1, Math.min(h, bmp.height - y))
                  const d = g.getImageData(x, y, sw, sh).data
                  const vals = []
                  for (let i = 0; i < d.length; i += 4) vals.push(d[i])
                  vals.sort((a, b2) => a - b2)
                  return { min: vals[0], med: vals[vals.length >> 1], max: vals[vals.length - 1] }
                }
                const b = boxes[0]
                // lower half of the first box = the band most likely covered
                // by art the erase should repaint; above = untouched ring.
                const bx = Math.round(b.x * scale)
                const by = Math.round(b.y * scale)
                const bw = Math.round(b.w * scale)
                const bh = Math.round(b.h * scale)
                return {
                  size: bmp.width + 'x' + bmp.height,
                  inside: stats(bx + 10, by + Math.floor(bh / 2), bw - 20, Math.max(4, Math.floor(bh / 2) - 6)),
                  above: stats(bx + 10, Math.max(0, by - 28), bw - 20, 16),
                }
              }
              sample = { box: boxes[0], withErase: await render(true), withoutErase: await render(false) }
            }
            erase = { pages: pageBoxes, sample }
          } catch (e) {
            erase = { error: String(e.message ?? e) }
          }

          return {
            pages: pages.map((p) => ({ index: p.index, cls: p.contentClass, st: p.analysisState, ocr: p.ocrStatus, conf: p.ocrConfidence, chars: p.charCount, lines: p.lineCount })),
            blocks: blocks.length,
            // Per-page content fingerprints for the first exported pages:
            // "page 2 and page 4 export identically" is answered by comparing
            // these (stored model) instead of guessing from the artifact.
            pageTexts: (() => {
              const byPage = new Map()
              for (const b of blocks) {
                const idx = pages.find((p) => p.id === b.pageId)?.index
                if (idx === undefined || idx > 5) continue
                const cur = byPage.get(idx) || { src: '', tt: '' }
                cur.src += b.sourceText + '\\n'
                cur.tt += b.translatedText + '\\n'
                byPage.set(idx, cur)
              }
              const fnv = (s) => {
                let h = 0x811c9dc5
                for (let i = 0; i < s.length; i += 1) {
                  h ^= s.charCodeAt(i)
                  h = Math.imul(h, 0x01000193)
                }
                return (h >>> 0).toString(16)
              }
              return [...byPage.entries()].map(([idx, v]) => ({
                index: idx,
                srcLen: v.src.length,
                ttLen: v.tt.length,
                srcHash: fnv(v.src),
                ttHash: fnv(v.tt),
                ttHead: v.tt.slice(0, 80),
              }))
            })(),
            blockSample: blocks.slice(0, 6).map((b) => ({
              order: b.order,
              kind: b.kind,
              page: b.pageId.slice(-6),
              w: b.width,
              h: b.height,
              x: b.x,
              y: b.y,
              srcLen: b.sourceText.length,
              ttLen: b.translatedText.length,
              status: b.status,
            })),
            erase,
            events: events.map((e) => ({ t: e.timestamp, action: e.action, severity: e.severity, detail: (e.technicalDetail || e.messageEn || '').slice(0, 140) })),
          }
        })()`,
      )
      log(JSON.stringify(dump, null, 2))
      return
    }

    for (const entry of plan) {
      const { fixture, kinds } = entry
      const record = { fixture, exports: [], pngs: [], errors: [] }
      log(`\n=== ${fixture} ===`)
      try {
        // Reuse a previously imported project (stable profile) when present.
        let workspacePath = null
        const existing = await findProject(fixture, evalJs)
        if (existing) {
          log(`  reusing project ${existing.id}`)
          workspacePath = '/workspace/' + existing.id
          await goto(workspacePath)
        } else {
          workspacePath = await importFixture(ctx, fixture)
          log(`  imported → ${workspacePath}`)
        }
        const pid = workspacePath.split('/workspace/')[1]

        const parse = await waitForParse(ctx, pid)
        record.ocr = parse.ocr
        let blocks = await countBlocks(ctx, pid)
        record.blocks = blocks
        log(`  parse done, blocks=${blocks}, ocr=${JSON.stringify(parse.ocr)}`)
        if (blocks <= 0) {
          const injected = await evalJs(injectScannedScript(pid))
          if (injected?.__error) throw new Error('block injection failed: ' + injected.__error)
          if (!injected) throw new Error('no blocks after parse — nothing to export')
          record.injected = injected
          log(`  injected synthetic blocks: ${JSON.stringify(injected)}`)
          blocks = await countBlocks(ctx, pid)
          record.blocks = blocks
        }

        const mock = await evalJs(mockScript(pid))
        if (mock?.__error) throw new Error('mock translations failed: ' + mock.__error)
        record.mocked = mock
        log(`  mock translations: ${JSON.stringify(mock)}`)

        record.preview = await shootPreview(ctx, fixture)

        for (const kind of kinds) {
          const fileName = `val-${fixture}-${kind}`
          const run = await runExport(ctx, { pid, kind, fileName, pages: entry.pages })
          const exportRecord = {
            kind,
            ...run,
            b64: undefined,
            file: null,
          }
          if (!run.ok) {
            record.errors.push(`${kind}: ${run.error ?? 'unknown'}`)
            log(`  EXPORT ${kind} FAILED: ${run.error ?? JSON.stringify(run)}`)
          } else if (typeof run.b64 !== 'string' || run.b64.length === 0) {
            record.errors.push(`${kind}: artifact had no bytes`)
            log(`  EXPORT ${kind} produced no bytes`)
          } else {
            // Write the artifact bytes straight from the run result. The
            // `pdf` format builds print HTML (deliverExport routes it through
            // the print frame), and its artifact name still ends in `.pdf` —
            // name it `.html` here so Chrome renders it as a document.
            const name = kind === 'print' ? `${fileName}.html` : run.fileName
            const ext = name.includes('.') ? '' : kind === 'print' ? '.html' : '.pdf'
            const file = join(OUT, `${name}${ext}`)
            writeFileSync(file, Buffer.from(run.b64, 'base64'))
            exportRecord.file = `${name}${ext}`
            log(
              `  EXPORT ${kind} → ${exportRecord.file} pages=${run.pages} blocks=${run.blocks} bytes=${run.bytes} issues=${JSON.stringify(run.issues ?? [])}`,
            )
            if (kind === 'print') {
              try {
                exportRecord.pdf = (await printHtmlToPdf(ctx, file, workspacePath))
                  .split(/[\\/]/)
                  .pop()
              } catch (e) {
                record.errors.push(`print-pdf: ${e.message}`)
                log(`  print-to-pdf failed: ${e.message}`)
              }
            }
          }
          record.exports.push(exportRecord)
        }

        // Rasterise every page of every produced PDF (raster artifacts +
        // printToPDF output). The export result already limits scope when
        // `pageIndexes` was passed, so `pages` is the page count to render.
        const pdfJobs = record.exports
          .filter((ex) => ex.file && (ex.file.endsWith('.pdf') || ex.pdf))
          .map((ex) => ({
            pdf: join(OUT, ex.pdf ?? ex.file),
            prefix: `val-${fixture}-${ex.kind}`,
            pages: Array.from({ length: ex.pages ?? 1 }, (_, i) => i + 1),
          }))
        for (const job of pdfJobs) {
          try {
            record.pngs.push(...(await rasterizePdf(ctx, job.pdf, job.pages, job.prefix)))
          } catch (e) {
            record.errors.push(`rasterize ${job.pdf}: ${e.message}`)
            log(`  rasterize failed: ${e.message}`)
          }
        }

        // Phase 04 (tasks 4.2/4.3/4.4): edit through the real editor UI,
        // export, verify the marker survives into the printed PDF, then undo
        // it so later runs see an unmodified document.
        if (!flags.has('--skip-edit')) {
          try {
            const rt = await editRoundTrip(ctx, {
              pid,
              fixture,
              workspacePath,
              pages: entry.pages ?? null,
            })
            record.editRoundTrip = rt
            record.pngs.push(...(rt.pngs ?? []))
            log(
              `  edit round-trip: saved=${rt.saved} status=${rt.statusOk} html=${rt.html} pdf=${rt.pdf} undo=${rt.undo}` +
                (rt.issues.length ? ` issues=${JSON.stringify(rt.issues)}` : ''),
            )
            if (rt.eligible && (!rt.saved || !rt.statusOk || !rt.html || !rt.pdf || !rt.undo)) {
              record.errors.push(
                `edit-round-trip: saved=${rt.saved} statusOk=${rt.statusOk} html=${rt.html} pdf=${rt.pdf} undo=${rt.undo} issues=${JSON.stringify(rt.issues)}`,
              )
            }
          } catch (e) {
            record.errors.push(`edit-round-trip: ${e.message ?? e}`)
            log(`  edit round-trip FAILED: ${e.message ?? e}`)
          }
        }
      } catch (e) {
        record.errors.push(String(e.message ?? e))
        log(`  FIXTURE FAILED: ${e.message ?? e}`)
      }
      results.push(record)
    }
  } finally {
    try {
      ctx?.ws?.close()
    } catch {
      /* ignore */
    }
    chrome.kill()
    if (server.spawned) {
      log(`cleanup: killing spawned dev server tree (pid ${server.spawned.pid})`)
      killTree(server.spawned.pid)
    } else {
      log('cleanup: dev server left running')
    }
  }

  if (inspectFixture) return
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(results, null, 2))
  log('\n=== summary ===')
  for (const r of results) {
    const rt = r.editRoundTrip
    const edit = rt
      ? rt.eligible
        ? rt.saved && rt.statusOk && rt.html && rt.pdf && rt.undo
          ? 'edit:ok '
          : 'edit:FAIL '
        : 'edit:n/a '
      : ''
    log(
      `${r.fixture}: blocks=${r.blocks ?? '-'} exports=${r.exports
        .map((e) => `${e.kind}:${e.ok ? 'ok' : 'FAIL'}`)
        .join(',')} ${edit}pngs=${r.pngs.length} errors=${r.errors.length ? r.errors.join(' | ') : 'none'}`,
    )
  }
  log(`artifacts in ${OUT}`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
