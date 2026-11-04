// Servidor local de desenvolvimento e teste. Em produção quem serve é worker/index.ts.
import { resolve, sep } from 'node:path'
import { Elysia } from 'elysia'
import { createHub } from './hub'
import { createSignal } from './signal'
import { HUB_PORT } from '../shared/protocol'

const port = Number(process.env.PORT ?? 3000)
const root = resolve('dist')

// Mesmo comportamento do Workers: arquivo que existe, ou a página inicial para rota do app.
async function serve(path: string, headers: Record<string, string>) {
  const target = resolve(root, `.${decodeURIComponent(path)}`)
  if (target.startsWith(root + sep)) {
    const file = Bun.file(target)
    if (await file.exists()) {
      if (path === '/sw.js' || path === '/precache.json') headers['Cache-Control'] = 'no-cache'
      return file
    }
  }
  if (path.startsWith('/assets/')) return new Response('não encontrado', { status: 404 })
  return Bun.file(`${root}/index.html`)
}

new Elysia()
  .use(createSignal())
  .get('/healthz', () => 'ok')
  .get('*', ({ path, set }) => serve(path, set.headers as Record<string, string>))
  .listen(port)

console.log(`oblita em http://localhost:${port}`)

// Hub local para desenvolvimento, no lugar do programa em Rust: bun server/index.ts --hub
if (process.argv.includes('--hub')) {
  const token = process.env.OBLITA_TOKEN ?? crypto.randomUUID()
  createHub(token).listen({ hostname: '0.0.0.0', port: HUB_PORT })
  console.log(`hub na porta ${HUB_PORT}, token ${token}`)
}
