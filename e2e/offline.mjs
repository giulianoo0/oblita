// A promessa central: visitou uma vez, abre sem rede. Testa com o servidor realmente desligado.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = process.env.BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BUN = join('node_modules', '.bin', 'bun.exe')
const PORT = 3000
const CDP = 9344
const ORIGIN = `http://localhost:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (name, ok, extra = '') => {
  results.push(ok)
  console.log(`${ok ? 'ok  ' : 'FALHOU'} ${name}${extra ? `: ${extra}` : ''}`)
}

function startServer() {
  const proc = spawn(process.platform === 'win32' ? join('node_modules', 'bun', 'bin', 'bun.exe') : BUN, ['server/index.ts'], { stdio: 'ignore', env: { ...process.env, PORT: String(PORT) } })
  return proc
}

async function waitHttp(url) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return true
    } catch {
      await sleep(100)
    }
  }
  return false
}

const profile = mkdtempSync(join(tmpdir(), 'oblita-offline-'))
let server = startServer()
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' })

try {
  check('servidor subiu', await waitHttp(`${ORIGIN}/healthz`))
  let info
  for (let i = 0; i < 50 && !info; i++) {
    try {
      info = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json()
    } catch {
      await sleep(200)
    }
  }
  const ws = new WebSocket(info.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const pending = new Map()
  const errors = []
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
  }
  const send = (method, params = {}, sessionId) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params, sessionId }))
    })

  const { result: { targetId } } = await send('Target.createTarget', { url: `${ORIGIN}/` })
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Runtime.enable', {}, sessionId)
  await send('Page.enable', {}, sessionId)
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
    return r.result?.result?.value
  }

  const started = Date.now()
  let ready = false
  for (let i = 0; i < 240 && !ready; i++) {
    await sleep(500)
    ready = await evaluate(`document.body.innerText.includes('Baixado neste computador')`)
  }
  check('status "Baixado neste computador" apareceu', ready, `${Math.round((Date.now() - started) / 1000)} s`)
  check('service worker controla a página', await evaluate(`(async () => { await navigator.serviceWorker.ready; for (let i = 0; i < 40 && !navigator.serviceWorker.controller; i++) await new Promise(r => setTimeout(r, 100)); return !!navigator.serviceWorker.controller })()`))

  const manifest = await evaluate(`fetch('/precache.json', { cache: 'no-store' }).then(r => r.json())`)
  const big = manifest.files.filter((f) => f.gz)
  check('manifesto lista o compilador em gzip', big.length === 2, big.map((f) => f.url).join(', '))

  server.kill()
  await sleep(800)
  let alive = true
  try {
    await fetch(`${ORIGIN}/healthz`, { signal: AbortSignal.timeout(800) })
  } catch {
    alive = false
  }
  check('servidor está desligado', !alive)

  await send('Page.reload', {}, sessionId)
  await sleep(2500)
  check('página inicial abre sem servidor', await evaluate(`document.body.innerText.includes('Sou aluno') && document.body.innerText.includes('Sou professor')`))
  check('status continua baixado', await evaluate(`document.body.innerText.includes('Baixado neste computador')`))

  for (const route of ['/entrar', '/nova', '/sala/inexistente']) {
    await send('Page.navigate', { url: `${ORIGIN}${route}` }, sessionId)
    await sleep(1800)
    const text = await evaluate(`document.body.innerText.length`)
    check(`rota ${route} abre sem servidor`, text > 0, `${text} caracteres`)
  }

  for (const f of big) {
    const size = await evaluate(`caches.match('${f.url}').then(async (r) => r ? [(await r.blob()).size, r.headers.get('content-type')] : null)`)
    check(`${f.url} aberto no cache`, !!size && size[0] > 20 * 1024 * 1024, JSON.stringify(size))
  }

  await send('Page.navigate', { url: `${ORIGIN}/` }, sessionId)
  await sleep(1500)
  const compiled = await evaluate(`(async () => {
    const files = await fetch('/precache.json').catch(() => null)
    const wasm = (await caches.keys()).length
    const names = await caches.open((await caches.keys())[0]).then((c) => c.keys())
    const core = names.find((r) => r.url.includes('llvm.core-'))
    const res = await caches.match(new URL(core.url).pathname)
    const module = await WebAssembly.compile(await res.arrayBuffer())
    return { caches: wasm, compiled: module instanceof WebAssembly.Module }
  })()`)
  check('compilador em WebAssembly carrega do cache', compiled?.compiled === true, JSON.stringify(compiled))
  check('nenhum erro de JavaScript na página', errors.length === 0, errors.slice(0, 3).join(' | '))
  ws.close()
} finally {
  server.kill()
  edge.kill()
  await sleep(500)
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    // O Edge pode segurar arquivos do perfil por um instante; é só uma pasta temporária.
  }
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed} ok, ${failed} falhas`)
process.exit(failed ? 1 : 0)
