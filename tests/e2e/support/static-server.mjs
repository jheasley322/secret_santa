// Tiny static server for e2e only. Serves the site from the repo root on
// 127.0.0.1. Refuses dotfiles (so .env can never be fetched) and folders that
// aren't part of the site.
//
// Usage: node tests/e2e/support/static-server.mjs [port]

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'

const ROOT = resolve(new URL('../../..', import.meta.url).pathname)
const PORT = Number(process.argv[2] ?? 8787)
const BLOCKED_TOP = new Set(['supabase', 'tests', 'node_modules', '.zReference', 'design'])
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8'
}

function refuse (res, code = 404) {
  res.writeHead(code, { 'content-type': 'text/plain' })
  res.end('not found')
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x')
    let path = decodeURIComponent(url.pathname)
    if (path.endsWith('/')) path += 'index.html'
    const parts = path.split('/').filter(Boolean)
    if (parts.some(p => p.startsWith('.')) || BLOCKED_TOP.has(parts[0])) return refuse(res)
    const file = normalize(join(ROOT, ...parts))
    if (!file.startsWith(ROOT + sep)) return refuse(res)
    const s = await stat(file).catch(() => null)
    if (!s || !s.isFile()) return refuse(res)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(await readFile(file))
  } catch {
    refuse(res, 500)
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`static site on http://127.0.0.1:${PORT}`)
})
