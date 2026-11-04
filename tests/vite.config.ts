import { createReadStream, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeConfig, type Plugin } from 'vite'
import base from '../vite.config'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// Simula rede lenta só nos arquivos do compilador, ligada pelo processo do teste.
function throttle(): Plugin {
  let bps = 0
  return {
    name: 'oblita-test-throttle',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://x')
        if (url.pathname === '/__throttle') {
          bps = Number(url.searchParams.get('bps') ?? 0)
          res.end('ok')
          return
        }
        // ?import&url é o módulo JS que o Vite gera para o new URL do pacote, não o arquivo em si
        if (!bps || url.search || !url.pathname.startsWith('/node_modules/@yowasp/clang/gen/') || url.pathname.endsWith('.js')) return next()
        const file = join(ROOT, url.pathname)
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream')
        res.setHeader('Content-Length', statSync(file).size)
        res.setHeader('Cache-Control', 'no-store')
        const stream = createReadStream(file, { highWaterMark: Math.ceil(bps / 10) })
        stream.on('data', (chunk) => {
          res.write(chunk)
          stream.pause()
          setTimeout(() => stream.resume(), 100)
        })
        stream.on('end', () => res.end())
        res.on('close', () => stream.destroy())
      })
    },
  }
}

// Mesma configuração do app, sem recarregar a aba: outros estão editando src/ enquanto o teste roda.
export default mergeConfig(base, {
  root: ROOT,
  cacheDir: 'node_modules/.vite-wasm-test',
  server: { hmr: false, watch: null },
  plugins: [throttle()],
})
