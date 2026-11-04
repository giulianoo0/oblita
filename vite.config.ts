import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build, defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const RUN_WORKER = fileURLToPath(new URL('./src/compiler/run.worker.ts', import.meta.url))

// O sandbox de execução é de origem opaca: não carrega nada do site, nem pelo service worker.
// Então o worker vai como texto dentro do próprio pacote, num arquivo só.
function runWorkerSource(): Plugin {
  const id = '\0virtual:run-worker'
  return {
    name: 'oblita-run-worker',
    resolveId: (source) => (source === 'virtual:run-worker' ? id : undefined),
    async load(source) {
      if (source !== id) return
      const out = await build({
        configFile: false,
        logLevel: 'silent',
        build: { write: false, minify: true, target: 'es2022', lib: { entry: RUN_WORKER, formats: ['iife'], name: 'oblitaRun' } },
      })
      const result = (Array.isArray(out) ? out[0] : out) as { output: { type: string; code?: string }[] }
      const code = result.output.find((o) => o.type === 'chunk')?.code
      if (!code) throw new Error('run.worker não empacotou')
      return `export default ${JSON.stringify(code)}`
    },
  }
}

// Data e commit curto: é o que aparece no canto da tela para conferir que todos estão iguais.
function buildId() {
  const day = new Date().toISOString().slice(0, 10)
  try {
    return `${day}-${execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()}`
  } catch {
    return day
  }
}

const PROTOCOL = Number(readFileSync(new URL('./shared/protocol.ts', import.meta.url), 'utf8').match(/PROTOCOL_VERSION = (\d+)/)?.[1])
const BUILD = { id: buildId(), protocol: PROTOCOL }

// O postbuild junta isto ao manifesto do service worker.
function buildInfo(): Plugin {
  return {
    name: 'oblita-build-info',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify(BUILD) })
    },
  }
}

export default defineConfig({
  plugins: [react(), runWorkerSource(), buildInfo()],
  define: { __BUILD__: JSON.stringify(BUILD) },
  server: { proxy: { '/signal': { target: 'ws://localhost:3000', ws: true } } },
  // O pacote acha os .wasm pelo próprio caminho, e o pré-empacotamento do Vite quebraria isso.
  optimizeDeps: { exclude: ['@yowasp/clang'] },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false },
})
