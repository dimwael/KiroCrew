/**
 * Screenshot harness for the side panel's binary-file fallback card.
 *
 * `/api/file-read` answers an envelope (`X-File-Binary: true`, empty content) for
 * a file whose first 8 KiB contain a NUL byte, and the panel renders a download /
 * open-with-default-app card instead of the Pierre editor. Without it,
 * `detectFileType` classifies an unknown extension as `'code'` and the editor
 * shows the whole file decoded with `errors="replace"` — a screenful of U+FFFD in
 * an apparently saveable buffer.
 *
 * Same house pattern as `capture-md-edit-label.mjs`: the REAL built SPA
 * (`website/dist`) behind the shared in-process static server, every `/api/**`
 * answered from fixtures via Playwright route interception — gateway-free, and
 * the client code under test unmodified. Frame judging comes from
 * `./lib/frame-assert.mjs`, so "the frame was saved" means the same thing here as
 * in every sibling harness.
 *
 * Frames:
 *   10-binary-card-light   `.sqlite` open in the side panel, light theme, REMOTE
 *                          session (no Open button; download-only hint)
 *   11-binary-card-dark    the same, dark theme
 *   12-binary-card-local   the same file on a DIRECT-LOCAL session: the Open
 *                          button renders and the hint names it
 *   13-binary-card-noext   an extension-less `coredump`: the badge falls back
 *                          to BIN because there is no extension to show
 *   14-hydrating-placeholder  a RESTORED tab whose read has not answered yet:
 *                          the placeholder, not an empty editor
 *   15-hydration-failed    a restored tab whose read failed: the failure shown
 *                          in the tab, with Retry
 *   20-text-control-light  a `.py` file in the same panel — the control: the
 *                          sniff let it through, so the editor still renders
 *
 * `CARD_MODE=before` flips only the stubbed `/api/file-read` answer, so before
 * and after are the same request answered two ways — no second build needed.
 *
 * Usage: node scripts/capture-side-panel-binary-card.mjs [outDir]
 *        CARD_MODE=before node scripts/capture-side-panel-binary-card.mjs [outDir]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveDist } from './lib/serve-dist.mjs'
import { logPageProblems, stubDashboardApi, json } from './lib/stub-dashboard-api.mjs'
import { chromiumExecutable } from './lib/chromium-executable.mjs'
import { probe, assertAbsent, shotFrame } from './lib/frame-assert.mjs'

const OUT = process.argv[2] || '../temp-screenshots/side-panel-binary-card'
const BEFORE = process.env.CARD_MODE === 'before'

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SLOT = 'chat-binary-card'

mkdirSync(OUT, { recursive: true })

// ── Fixtures ────────────────────────────────────────────────────────────────

const BIN_PATH = `${PROJECT}/var/cache/index.sqlite`
const NOEXT_PATH = `${PROJECT}/var/crash/coredump`
const PY_PATH = `${PROJECT}/tools/reindex.py`
/** A restored tab whose read never answers: the hydration placeholder. */
const HANG_PATH = `${PROJECT}/notes/roadmap.md`
/** A restored tab whose read fails: the failure state with Retry. */
const FAIL_PATH = `${PROJECT}/notes/release-notes.md`
/** Paths the stubbed /api/file-read answers with the binary envelope. */
const BINARY_PATHS = new Set([BIN_PATH, NOEXT_PATH])

const PY_CONTENT = `"""Rebuild the search index from the store."""


def reindex(store, *, batch=500):
    for chunk in store.batches(batch):
        yield store.write(chunk)
`

/** What a lossy decode of a binary file produces: the `before` body. */
const MOJIBAKE = 'SQLite format 3\u0000' + '\ufffd'.repeat(4000)

const slots = [{
  key: SLOT,
  title: 'Cache inspection',
  running: false,
  last_message: 'Cache inspection',
  messages: 2,
  agent: 'kirocrew',
  memory_mode: 'persistent',
  project: PROJECT,
  modified: Math.floor(Date.now() / 1000),
  source_links: [],
  source_links_total: 0,
}]

const t0 = Math.floor(Date.now() / 1000) - 900
const slotDetail = {
  running: false, has_more: false, total: 2, queue: [],
  messages: [
    { role: 'user', content: 'Open the cache database.', ts: String(t0) },
    { role: 'assistant', content: 'Opened it in the side panel.', ts: String(t0 + 30) },
  ],
}

const tabFor = (path, title) => ({
  id: `file:${path}`, kind: 'file', title, path, slot: SLOT, diffMode: false,
})

// ── Harness ─────────────────────────────────────────────────────────────────

async function main() {
  const { srv, base } = await serveDist()
  const executablePath = chromiumExecutable()
  console.log('chromium:', executablePath || '(playwright default)')
  console.log('card mode:', BEFORE ? 'before (mojibake in the editor)' : 'after (binary card)')
  const browser = await chromium.launch({ executablePath })
  const wrote = []

  // Flipped per page by openPanel: read at request time, not at definition.
  let localSession = false

  const extra = async (path, route) => {
    const url = new URL(route.request().url())
    const q = url.searchParams.get('path') || ''
    if (path === '/api/chat/slots') return json(route, slots), true
    if (/^\/api\/chat\/slots\/[^/]+/.test(path)) return json(route, slotDetail), true
    if (path === '/api/file-read') {
      // Every tab the harness seeds is a RESTORED tab (metadata only), so each
      // frame goes through the self-hydrating placeholder. These two answers
      // make the placeholder's own two states visible: a read that never
      // answers, and one that fails.
      if (q === HANG_PATH) {
        await new Promise(r => setTimeout(r, 60_000))
        await route.abort()
        return true
      }
      if (q === FAIL_PATH) {
        await route.fulfill({ status: 500, contentType: 'text/plain', body: 'disk unavailable' })
        return true
      }
      if (q === PY_PATH) {
        await route.fulfill({
          status: 200, contentType: 'text/plain; charset=utf-8', body: PY_CONTENT,
        })
        return true
      }
      if (!BINARY_PATHS.has(q)) {
        await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' })
        return true
      }
      // The whole point of the change: the same request, answered two ways.
      if (BEFORE) {
        await route.fulfill({
          status: 200, contentType: 'text/plain; charset=utf-8', body: MOJIBAKE,
        })
        return true
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-File-Binary': 'true' },
        body: JSON.stringify({ binary: true, content: '' }),
      })
      return true
    }
    if (path === '/api/file-diff') return json(route, { diff: '', original: '', status: 'clean' }), true
    // `direct_local` is what `useCanOpenFile` reads (with the stub's darwin
    // platform) to decide whether Open-with-default-app renders. The remote
    // frames leave it unset, which is the stub's default.
    if (path === '/api/dashboard/branding' && localSession) {
      return json(route, { bot_name: 'Kiro Crew', avatar: '/logo.png', direct_local: true }), true
    }
    if (path === '/api/project/tree') {
      return json(route, {
        root: PROJECT, paths: ['var/cache/index.sqlite', 'var/crash/coredump', 'tools/reindex.py'],
        repo: false, truncated: false,
      }), true
    }
    if (path === '/api/project/git/status') return json(route, { repo: false, files: [] }), true
    if (path === '/api/project/git') return json(route, { path: PROJECT, repo: false }), true
    if (path === '/api/recent-projects') return json(route, { dirs: [PROJECT] }), true
    return false
  }

  /** One page per (theme, file): the theme is resolved at boot, not at render. */
  async function openPanel(theme, tab, { local = false } = {}) {
    localSession = local
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
    })
    const page = await context.newPage()
    // The theme goes through the STUB as well as localStorage: `/api/theme/boot`
    // is authoritative at mount and overwrites the seeded key, which otherwise
    // makes the light and dark frames byte-identical.
    await stubDashboardApi(page, { slots, extra, theme, preserveStorage: true })
    logPageProblems(page)
    await page.addInitScript(([slot, project, tabsJson, mode]) => {
      localStorage.clear()
      localStorage.setItem('mc-theme', mode)
      localStorage.setItem('mc-onboarded', '1')
      localStorage.setItem('mc-active-slot-chat', slot)
      localStorage.setItem('mc-activity-open:' + slot, 'true')
      localStorage.setItem('mc-panel-tabs:' + slot, tabsJson)
      localStorage.setItem('mc-files-rail-open', '0')
      localStorage.setItem('mc-side-panel-width', '760')
      localStorage.setItem('kirocrew:comment-hint-dismissed', '1')
      localStorage.setItem('mc-git-panel-opened:' + slot + ':' + project, '1')
      localStorage.setItem('mc-chat-config', JSON.stringify({ pinLastPrompt: false, streamMode: 'immediate' }))
    }, [SLOT, PROJECT, JSON.stringify({ activeId: tab.id, tabs: [tab] }), theme])
    await page.goto(base + '/?sid=' + encodeURIComponent(SLOT), { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2600)
    const p = page.locator('div:has(> .side-panel-strip)').last()
    await p.waitFor({ state: 'visible', timeout: 20000 })
    return { context, page, p }
  }

  /** The top `height` CSS px of a panel, as a screenshot target. The hydration
   *  skeleton is a few grey bars under the tab strip and the rest of the panel is
   *  deliberately empty until the read answers, so a full-panel frame of it
   *  trips the blank-frame floor while carrying every pixel of evidence — this
   *  keeps the frame to the region that has something to show. Frame 15 (the
   *  failure notice under the same strip) has the same shape. */
  async function topOf(page, panel, height) {
    const box = await panel.boundingBox()
    if (!box) throw new Error('panel has no bounding box')
    const clip = { x: box.x, y: box.y, width: box.width, height: Math.min(height, box.height) }
    return { screenshot: (opts) => page.screenshot({ ...opts, clip }) }
  }

  const binTab = tabFor(BIN_PATH, 'index.sqlite')
  const pyTab = tabFor(PY_PATH, 'reindex.py')

  for (const [n, theme] of [['10', 'light'], ['11', 'dark']]) {
    const { context, page, p } = await openPanel(theme, binTab)
    if (BEFORE) {
      const name = `${n}-binary-editor-${theme}-before`
      await p.locator('.pierre-surface').first().waitFor({ timeout: 20000 })
      await page.waitForTimeout(900)
      wrote.push(await shotFrame(p, OUT, name, [
        probe('Pierre surface mounted for a binary file', p.locator('.pierre-surface'), { attr: 'class' }),
        // A non-markdown file has no Edit TOGGLE (it opens in the editor
        // outright) and Save appears only once the buffer is dirty, so the diff
        // toggle is the affordance that shows the panel treating undecodable
        // bytes as an editable source document. It is withdrawn after the fix.
        probe('diff toggle offered on undecodable bytes', p.getByRole('button', { name: /toggle diff view/i }), { attr: 'aria-label' }),
      ]))
    } else {
      const name = `${n}-binary-card-${theme}`
      await p.getByTestId('binary-file-card').waitFor({ timeout: 20000 })
      await page.waitForTimeout(900)
      await assertAbsent(name, 'Pierre editor surface', p.locator('.pierre-surface'))
      await assertAbsent(name, 'diff toggle', p.getByRole('button', { name: /toggle diff view/i }))
      await assertAbsent(name, 'Open button on a remote session', p.getByRole('button', { name: /open with default app/i }))
      wrote.push(await shotFrame(p, OUT, name, [
        probe('binary fallback card', p.getByTestId('binary-file-card')),
        probe('file named on the card', p.getByText('index.sqlite', { exact: true })),
        probe('download-only hint', p.getByText(/download a copy to open it in another app/i)),
        probe('download of the real bytes', p.getByRole('link', { name: /index\.sqlite/i }), { attr: 'href' }),
      ]))
    }
    await context.close()
  }

  if (!BEFORE) {
    // Direct-local session: Open renders and the hint names it.
    {
      const { context, page, p } = await openPanel('light', binTab, { local: true })
      const name = '12-binary-card-local'
      await p.getByTestId('binary-file-card').waitFor({ timeout: 20000 })
      await page.waitForTimeout(900)
      await assertAbsent(name, 'Pierre editor surface', p.locator('.pierre-surface'))
      wrote.push(await shotFrame(p, OUT, name, [
        probe('Open with default app button', p.getByRole('button', { name: /open with default app/i })),
        probe('open-variant hint', p.getByText(/open it in its app/i)),
        probe('download of the real bytes', p.getByRole('link', { name: /index\.sqlite/i }), { attr: 'href' }),
      ]))
      await context.close()
    }
    // Extension-less binary: the badge falls back to BIN.
    {
      const { context, page, p } = await openPanel('light', tabFor(NOEXT_PATH, 'coredump'))
      const name = '13-binary-card-noext'
      await p.getByTestId('binary-file-card').waitFor({ timeout: 20000 })
      await page.waitForTimeout(900)
      wrote.push(await shotFrame(p, OUT, name, [
        probe('BIN badge for an extension-less file', p.getByText('BIN', { exact: true })),
        probe('file named on the card', p.getByText('coredump', { exact: true })),
        probe('download-only hint on a remote session', p.getByText(/download a copy to open it in another app/i)),
      ]))
      await context.close()
    }
  }

  if (!BEFORE) {
    // Restored tab, read still in flight: the placeholder, not an editor.
    {
      const { context, page, p } = await openPanel('light', tabFor(HANG_PATH, 'roadmap.md'))
      const name = '14-hydrating-placeholder'
      await p.getByTestId('file-tab-hydrating').waitFor({ timeout: 20000 })
      await page.waitForTimeout(600)
      await assertAbsent(name, 'Pierre editor surface before hydration', p.locator('.pierre-surface'))
      wrote.push(await shotFrame(await topOf(page, p, 380), OUT, name, [
        // The skeleton carries no text, so its evidence is the test id itself;
        // the tab chip proves WHICH file is still hydrating.
        probe('hydration placeholder for a restored tab', p.getByTestId('file-tab-hydrating'), { attr: 'data-testid' }),
        probe('tab chip for the restored file', p.getByText('roadmap.md', { exact: true })),
      ]))
      await context.close()
    }
    // Restored tab whose read failed: the failure is shown in the tab, with Retry.
    {
      const { context, page, p } = await openPanel('light', tabFor(FAIL_PATH, 'release-notes.md'))
      const name = '15-hydration-failed'
      await p.getByTestId('file-tab-hydration-failed').waitFor({ timeout: 20000 })
      await page.waitForTimeout(600)
      await assertAbsent(name, 'skeleton after a failed read', p.getByTestId('file-tab-hydrating'))
      await assertAbsent(name, 'Pierre editor surface after a failed read', p.locator('.pierre-surface'))
      // Same crop as frame 14: the notice sits under the tab strip and the rest
      // of the tab is empty, so the full panel reads as a blank frame.
      wrote.push(await shotFrame(await topOf(page, p, 380), OUT, name, [
        probe('failure notice', p.getByTestId('file-tab-hydration-error')),
        probe('failure title', p.getByText(/could not read this file/i)),
        probe('the reason', p.getByText(/HTTP 500/i)),
        probe('Retry button', p.getByRole('button', { name: /^retry$/i })),
      ]))
      await context.close()
    }
  }

  // Control: a text file in the same panel keeps the editor it always had.
  {
    const { context, page, p } = await openPanel('light', pyTab)
    const name = `20-text-control-light${BEFORE ? '-before' : ''}`
    await p.locator('.pierre-surface').first().waitFor({ timeout: 20000 })
    await page.waitForTimeout(900)
    await assertAbsent(name, 'binary card on a text file', p.getByTestId('binary-file-card'))
    wrote.push(await shotFrame(p, OUT, name, [
      probe('Pierre surface mounted for a TEXT file', p.locator('.pierre-surface'), { attr: 'class' }),
    ]))
    await context.close()
  }

  await browser.close()
  srv.close()
  console.log(`done — ${wrote.length} frames in ${OUT}`)
}

main().catch(err => { console.error(err); process.exit(1) })
