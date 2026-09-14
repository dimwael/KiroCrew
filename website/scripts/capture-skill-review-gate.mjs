/**
 * Screenshot harness for the pending skill-review queue's approval gate.
 *
 * The queue used to render a permanently-disabled Approve on every collapsed
 * row. Approve now lives at the foot of the open review panel, the refusal
 * sentence for an un-appliable update sits in that same row as the button it
 * disables, and a refused approve/dismiss renders through `ErrorNotice`. Each of
 * those is a state a still image can prove, so each gets a frame -- including
 * the two update refusals, which no earlier harness covered.
 *
 * Same pattern as capture-skill-approval-surface.mjs: the REAL built SPA behind
 * an in-process static server, every /api/** answered from fixtures.
 *
 * Frames:
 *   01-queue-collapsed     three candidates, Review primary, no Approve anywhere
 *   02-new-candidate-open  prose candidate expanded: SKILL.md, then Approve
 *   03-update-stale-open   stale update: diff, then refusal BESIDE disabled Approve
 *   04-update-gone-open    update whose target is gone: same adjacency
 *   05-approve-refused     a 409 from the approve endpoint, rendered with the
 *                          agent hand-off on the row that failed
 *
 * Usage: node scripts/capture-skill-review-gate.mjs [outDir] [prefix]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { serveDist } from './lib/serve-dist.mjs'
import { logPageProblems, stubDashboardApi, json } from './lib/stub-dashboard-api.mjs'

const OUT = process.argv[2] || '../temp-screenshots/skill-review-gate'
const PREFIX = process.argv[3] || 'after'

mkdirSync(OUT, { recursive: true })

const NEW_ROW = {
  slug: 'summarize-oncall-handoffs',
  name: 'auto/summarize-oncall-handoffs',
  description: "Digest the week's pages into a handoff brief",
  has_scripts: false,
  kind: 'new',
  target: null,
  base_version: null,
}

const STALE_ROW = {
  slug: 'deploy-helper-update',
  name: 'auto/deploy-helper-update',
  description: 'handles the new retry flag',
  has_scripts: false,
  kind: 'update',
  target: 'auto/deploy-helper',
  base_version: 5,
}

const GONE_ROW = {
  slug: 'rotate-fixtures-update',
  name: 'auto/rotate-fixtures-update',
  description: 'regenerate fixtures from the latest schema',
  has_scripts: false,
  kind: 'update',
  target: 'auto/rotate-staging-fixtures',
  base_version: 2,
}

const PENDING = [NEW_ROW, STALE_ROW, GONE_ROW]

/**
 * A real `difflib.unified_diff` payload in the shape the backend emits for an
 * update candidate (`skills.py` names the file `<target> (v<n>, live)` /
 * `(v<n+1>, proposed)`, with no git `a/` `b/` prefixes), so the frame shows what
 * the panel actually renders rather than a hand-shaped approximation.
 */
const DIFF = [
  '--- auto/deploy-helper (v5, live)',
  '+++ auto/deploy-helper (v6, proposed)',
  '@@ -5,7 +5,8 @@',
  ' ## Steps',
  ' ',
  ' 1. Read the deploy plan.',
  '-2. Run the deploy.',
  '+2. Run the deploy with --retry once.',
  '+3. Re-read the plan when the retry is consumed.',
  ' ',
  ' ## Gotchas',
  ' ',
  '',
].join('\n')

/** Per-slug detail, so one page can show all three panel shapes. */
const DETAIL = {
  'summarize-oncall-handoffs': {
    name: 'auto/summarize-oncall-handoffs',
    content: '---\nname: summarize-oncall-handoffs\n---\n\n## Steps\n\n1. Read the week\'s pages.\n2. Group them by service.\n3. Write the brief.\n',
    scripts: [],
  },
  'deploy-helper-update': {
    name: 'auto/deploy-helper-update',
    content: '',
    scripts: [],
    diff: DIFF,
    from_version: 5,
    to_version: 6,
    stale_base: true,
  },
  'rotate-fixtures-update': {
    name: 'auto/rotate-fixtures-update',
    content: '',
    scripts: [],
    diff: null,
    live_body: null,
    stale_base: false,
  },
}

/**
 * `approveStatus` 409 exercises the refused-approval surface; `hangApprove`
 * leaves the request unsettled so the in-flight lock can be photographed; and
 * `pendingAfterFirst` answers the SECOND poll with a different queue, which is
 * how the "queue emptied under an in-flight action" frame is reached.
 *
 * `detailStatus` and `listAfterFirst` cover the two READ failures. A UX lane that
 * could not see them reported the change as unevaluable, which was fair: the
 * panel's whole claim is that it never offers Approve over content it has not
 * just read, and the states where a read FAILS are where that claim is tested.
 */
const apiFor = ({
  approveStatus = 200,
  hangApprove = false,
  pendingAfterFirst = null,
  detailStatus = 200,
  listFailAlways = false, // retained: the switch that exposed the non-rendering queue-read failure
} = {}) => {
  let pendingCalls = 0
  return async (path, route) => {
  if (path === '/api/skills/-/pending') {
    pendingCalls += 1
    if (listFailAlways) {
      await json(route, { error: 'skills directory is unreadable' }, 500)
      return true
    }
    const body = pendingAfterFirst && pendingCalls > 1 ? pendingAfterFirst : PENDING
    await json(route, { pending: body })
    return true
  }
  if (path.endsWith('/approve')) {
    // Never fulfilled: the page stays in its in-flight state for the screenshot.
    if (hangApprove) return true
    await json(
      route,
      approveStatus === 200
        ? { ok: true }
        : { error: 'this candidate is no longer pending', code: 'not_pending' },
      approveStatus,
    )
    return true
  }
  if (path.startsWith('/api/skills/-/pending/')) {
    const slug = decodeURIComponent(path.split('/api/skills/-/pending/')[1])
    if (detailStatus !== 200) {
      await json(route, { error: 'candidate directory is unreadable' }, detailStatus)
      return true
    }
    await json(route, DETAIL[slug] ?? { name: slug, content: '', scripts: [] })
    return true
  }
  if (path === '/api/skills') {
    await json(route, [])
    return true
  }
  return false
  }
}

const shot = (page, name) =>
  page.screenshot({ path: `${OUT}/${PREFIX}-${name}.png`, animations: 'disabled' })

/** Open the Nth row's panel and wait for a string its detail must render. */
const openRow = async (page, nth, awaitText) => {
  await page.getByRole('button', { name: 'Review', exact: true }).nth(nth).click()
  await page.getByText(awaitText).first().waitFor()
}

const { srv, base } = await serveDist()
const browser = await chromium.launch()

try {
  const open = async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    logPageProblems(page)
    return page
  }

  // ── Frame 01: the queue at rest ──
  {
    const page = await open()
    await stubDashboardApi(page, { extra: apiFor() })
    await page.goto(`${base}/capabilities?tab=skills`, { waitUntil: 'networkidle' })
    await page.getByText('rotate-fixtures-update').first().waitFor()
    await shot(page, '01-queue-collapsed')
    await page.close()
  }

  // ── Frames 02-04: each panel shape, one page per frame so the earlier
  //    panels do not push the one under test off screen ──
  {
    const page = await open()
    await stubDashboardApi(page, { extra: apiFor() })
    await page.goto(`${base}/capabilities?tab=skills`, { waitUntil: 'networkidle' })
    await openRow(page, 0, 'Read the week')
    await shot(page, '02-new-candidate-open')
    await page.close()
  }
  {
    const page = await open()
    await stubDashboardApi(page, { extra: apiFor() })
    await page.goto(`${base}/capabilities?tab=skills`, { waitUntil: 'networkidle' })
    await openRow(page, 1, 'would undo those newer changes')
    // The diff renderer is a LAZY chunk (`src/pierre/index.tsx` imports
    // PierreImpl dynamically), so the panel paints its header and an empty box
    // first. Waiting on the refusal text alone captured that empty box; wait for
    // a line of the diff itself.
    await page.getByText('Re-read the plan when the retry is consumed').first().waitFor()
    await shot(page, '03-update-stale-open')
    await page.close()
  }
  {
    const page = await open()
    await stubDashboardApi(page, { extra: apiFor() })
    await page.goto(`${base}/capabilities?tab=skills`, { waitUntil: 'networkidle' })
    await openRow(page, 2, 'no longer exists')
    await shot(page, '04-update-gone-open')
    await page.close()
  }

  // ── Frame 05: the approve the server refuses ──
  {
    const page = await open()
    await stubDashboardApi(page, { extra: apiFor({ approveStatus: 409 }) })
    await page.goto(`${base}/capabilities?tab=skills`, { waitUntil: 'networkidle' })
    await openRow(page, 0, 'Read the week')
    await page.getByRole('button', { name: 'Approve', exact: true }).click()
    await page.getByText('no longer pending').first().waitFor()
    await shot(page, '05-approve-refused')
    await page.close()
  }
  // ── Frame 06: the queue locked while one action is unsettled ──
  {
    const page = await open()
    await stubDashboardApi(page, { extra: apiFor({ hangApprove: true }) })
    await page.goto(`${base}/capabilities?tab=skills`, { waitUntil: 'networkidle' })
    await openRow(page, 0, 'Read the week')
    await page.getByRole('button', { name: 'Approve', exact: true }).click()
    // The spinner marks the acting row; every other control is disabled.
    await page.locator('[data-testid="pending-action-spinner"]').first().waitFor()
    await shot(page, '06-action-in-flight')
    await page.close()
  }

  // ── Frame 07: the queue emptied under an action that then failed ──
  {
    const page = await open()
    // Only the REFUSED candidate is gone on the second poll. The earlier fixture
    // emptied the whole queue, which a refusal never does -- and a reader shown
    // that frame reasonably asked where the other two had gone.
    await stubDashboardApi(page, { extra: apiFor({ approveStatus: 409, pendingAfterFirst: [STALE_ROW, GONE_ROW] }) })
    await page.goto(`${base}/capabilities?tab=skills`, { waitUntil: 'networkidle' })
    await openRow(page, 0, 'Read the week')
    await page.getByRole('button', { name: 'Approve', exact: true }).click()
    // The refusal reconciles the queue: the rows go, the message stays.
    await page.getByText('no longer pending').first().waitFor()
    await page.waitForFunction(() => !document.body.textContent.includes('auto/summarize-oncall-handoffs'))
    await shot(page, '07-failure-reconciled')
    await page.close()
  }
  // ── Frame 08: the candidate whose body cannot be read ──
  {
    const page = await open()
    await stubDashboardApi(page, { extra: apiFor({ detailStatus: 500 }) })
    await page.goto(`${base}/capabilities?tab=skills`, { waitUntil: 'networkidle' })
    // openRow() waits for panel CONTENT, which is exactly what never arrives here.
    await page.getByRole('button', { name: 'Review', exact: true }).first().click()
    await page.getByText('candidate directory is unreadable').first().waitFor()
    await shot(page, '08-detail-read-failed')
    await page.close()
  }

  // ── Frame 09: the queue read failing ──
  {
    const page = await open()
    await stubDashboardApi(page, { extra: apiFor({ listFailAlways: true }) })
    await page.goto(`${base}/capabilities?tab=skills`, { waitUntil: 'networkidle' })
    // The panel has no rows to show, so the notice IS the panel: `owesMessage`
    // keeps it mounted for exactly this. api/queryClient.ts retries a non-throttle
    // failure once, so the error surfaces one read later than the first refusal.
    await page.getByText('skills directory is unreadable').first().waitFor({ timeout: 20000 })
    await shot(page, '09-queue-read-failed')
    await page.close()
  }

  // ── Frame 10: an empty queue still owing an explanation ──
  {
    const page = await open()
    // The refusal takes the LAST candidate with it, so the panel would normally
    // unmount and take the only account of the failure with it. `owesMessage`
    // keeps it up: an empty queue plus the sentence that says where the row went.
    await stubDashboardApi(page, { extra: apiFor({ approveStatus: 409, pendingAfterFirst: [] }) })
    await page.goto(`${base}/capabilities?tab=skills`, { waitUntil: 'networkidle' })
    await openRow(page, 0, 'Read the week')
    await page.getByRole('button', { name: 'Approve', exact: true }).click()
    await page.getByText('no longer pending').first().waitFor()
    await page.waitForFunction(() => !document.body.textContent.includes('auto/deploy-helper-update'))
    await shot(page, '10-empty-queue-owes-message')
    await page.close()
  }

  console.log(`wrote frames to ${OUT} (prefix ${PREFIX})`)
} finally {
  await browser.close()
  srv.close()
}
