/**
 * Shared static-file server for the screenshot harnesses in this folder.
 *
 * Every harness runs the REAL built SPA (website/dist) behind a tiny in-process
 * server with index.html fallback, so deep links like /settings resolve, and
 * binds to 127.0.0.1 on an ephemeral port. Keeping it here means one copy of the
 * MIME table and the fallback rule instead of one per capture script.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not URL.pathname: on Windows .pathname yields "/C:/…", which
// join() then turns into an invalid "\C:\…" and every read fails with ENOENT.
export const DEFAULT_DIST = fileURLToPath(new URL('../../dist/', import.meta.url))

/**
 * Assets the REAL dashboard serves from its own routes rather than from the
 * SPA bundle, mapped to the file on disk.
 *
 * `/logo.png` is an aiohttp route (`server.py`: `add_get("/logo.png",
 * handlers.logo)`) reading the packaged PNG — it is NOT in `website/dist`, so a
 * plain static server 404s it and the brand mark renders as a broken-image
 * placeholder in EVERY harness screenshot. That was silently wrong in every
 * capture script in this folder until it was noticed in a review.
 */
const SERVER_ROUTED = {
  '/logo.png': fileURLToPath(new URL('../../../src/kiro_crew/static/kirocrew-logo.png', import.meta.url)),
}

export const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon',
}

/**
 * Serve `dist` on a loopback ephemeral port with index.html fallback.
 * @returns {Promise<{srv: import('node:http').Server, base: string}>}
 */
/**
 * Refuse to serve a `dist` older than the sources it was built from.
 *
 * Every harness in this folder screenshots the BUILT bundle, so a source edit is
 * invisible until `npm run build` runs again. A stale bundle does not fail — it
 * silently photographs the previous version of the UI, and the frames look
 * entirely plausible. That cost real review time: three hours of edits were
 * captured against an older build, and the missing surface was reported as a
 * product defect (the queue-read failure "not rendering") before the bundle's
 * timestamp was checked. Failing loudly here is the whole fix.
 *
 * Compares dist/index.html's mtime against the newest file under website/src.
 * @param {string} dist resolved dist directory
 */
function assertDistFresherThanSources(dist) {
  const indexHtml = join(dist, 'index.html')
  if (!existsSync(indexHtml)) {
    throw new Error(`No build to serve at ${dist} — run \`npm run build\` in website/ first.`)
  }
  const builtAt = statSync(indexHtml).mtimeMs
  const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url))
  let newest = { at: 0, path: '' }
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      const at = statSync(full).mtimeMs
      if (at > newest.at) newest = { at, path: full }
    }
  }
  if (existsSync(srcRoot)) walk(srcRoot)
  if (newest.at > builtAt) {
    const ago = Math.round((newest.at - builtAt) / 60000)
    throw new Error(
      `STALE BUILD: ${indexHtml} was built ${ago} minute(s) BEFORE the newest source file\n`
      + `  ${newest.path}\n`
      + 'Screenshots would show the previous version of the UI. Run `npm run build` in website/ and re-run this harness.',
    )
  }
}

export function serveDist(dist = DEFAULT_DIST) {
  // Resolved once so the per-request containment test compares two absolute,
  // normalized paths (a trailing-slash dist would otherwise fail the prefix).
  const root = resolve(dist)
  // Only the REAL build can be stale against src. Callers that serve some other
  // directory (serveDist.routes.test.ts serves website/ itself, deliberately, so
  // it needs no build) are not making a claim about the bundle and must not be
  // held to one -- gating this on the default is what keeps the guard honest.
  if (root === resolve(DEFAULT_DIST)) assertDistFresherThanSources(root)
  return new Promise(resolve_ => {
    const srv = createServer((req, res) => {
      // Decode FIRST, then containment-check the resolved path. new URL()
      // normalizes literal ".." segments, but it runs BEFORE decoding, so an
      // encoded "%2e%2e%2f" survives normalization and only becomes "../" at
      // decodeURIComponent — which is why normalization alone is not a defence.
      // resolve() + a prefix test on the real dist root is.
      let rel
      try {
        rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '')
      } catch {
        // Malformed percent-escapes throw; treat as a bad request rather than
        // crashing the harness mid-capture.
        res.writeHead(400); res.end('bad request'); return
      }
      // Server-routed assets first, keyed on the decoded path. Checked before
      // the dist lookup so a same-named file in dist could not shadow the real
      // route, and skipped silently when the file is absent (a source checkout
      // without the Python package still captures, just without the mark).
      const routed = SERVER_ROUTED['/' + rel]
      if (routed && existsSync(routed)) {
        res.writeHead(200, { 'Content-Type': MIME[extname(routed)] || 'application/octet-stream' })
        res.end(readFileSync(routed)); return
      }
      let file = resolve(root, rel)
      if (file !== root && !file.startsWith(root + sep)) {
        res.writeHead(403); res.end('forbidden'); return
      }
      if (!rel || !existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html')
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' })
      res.end(readFileSync(file))
    })
    srv.listen(0, '127.0.0.1', () => resolve_({ srv, base: `http://127.0.0.1:${srv.address().port}` }))
  })
}
