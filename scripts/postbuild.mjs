// Prepara dist/ para o Workers: comprime o que passa do limite por arquivo e lista tudo para o service worker.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { gzipSync } from 'node:zlib'

const DIST = process.argv[2] ?? 'dist'
const GZIP_OVER = 20 * 1024 * 1024
const ASSET_LIMIT = 25 * 1024 * 1024
const SKIP = new Set(['_headers', '_redirects', 'sw.js', 'precache.json', 'index.html'])
const MIME = { '.wasm': 'application/wasm', '.tar': 'application/x-tar' }

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

const files = [{ url: '/' }]
const hash = createHash('sha256')
hash.update(readFileSync(join(DIST, 'index.html')))

for (const path of walk(DIST).sort()) {
  const rel = relative(DIST, path).split(sep).join('/')
  if (SKIP.has(rel)) continue
  const data = readFileSync(path)
  hash.update(rel)
  hash.update(data)
  if (data.length <= GZIP_OVER) {
    files.push({ url: `/${rel}` })
    continue
  }
  const gz = gzipSync(data, { level: 9 })
  if (gz.length > ASSET_LIMIT) throw new Error(`${rel} continua grande demais em gzip: ${gz.length} bytes`)
  writeFileSync(`${path}.gz`, gz)
  unlinkSync(path)
  const ext = rel.slice(rel.lastIndexOf('.'))
  files.push({ url: `/${rel}`, gz: true, type: MIME[ext] ?? 'application/octet-stream' })
  console.log(`${rel}: ${(data.length / 2 ** 20).toFixed(1)} MiB -> ${(gz.length / 2 ** 20).toFixed(1)} MiB`)
}

for (const path of walk(DIST)) {
  const size = statSync(path).size
  if (size > ASSET_LIMIT) throw new Error(`${path} passa do limite do Workers: ${size} bytes`)
}

const version = hash.digest('hex').slice(0, 16)
writeFileSync(join(DIST, 'precache.json'), JSON.stringify({ version, files }))
console.log(`precache ${version}: ${files.length} arquivos`)
