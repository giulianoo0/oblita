// Versões no service worker: o manifesto traz o protocolo, a página fixada é a servida, e soltar volta à nova.
// Precisa de `npm run build` antes. Uso: node e2e/versions.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BROWSER = process.env.BROWSER ?? (process.platform === 'win32' ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome')
const BUN = process.env.BUN ?? (process.platform === 'win32' ? join('node_modules', 'bun', 'bin', 'bun.exe') : 'bun')
const PORT = 3017
const CDP = 9351
const ORIGIN = `http://localhost:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const manifest = JSON.parse(readFileSync('dist/precache.json', 'utf8'))

const results = []
const check = (name, ok, extra = '') => {
  results.push(ok)
  console.log(`${ok ? 'ok  ' : 'FALHOU'} ${name}${extra ? `: ${extra}` : ''}`)
}

const profile = mkdtempSync(join(tmpdir(), 'oblita-versoes-'))
const server = spawn(BUN, ['server/index.ts'], { stdio: 'ignore', env: { ...process.env, PORT: String(PORT) } })
const browser = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' })

// Pergunta ao service worker como a página faz (src/lib/offline.ts), por um canal próprio.
const ask = (msg) => `new Promise((resolve) => {
  const c = new MessageChannel()
  c.port1.onmessage = (e) => resolve(e.data)
  navigator.serviceWorker.controller.postMessage(${JSON.stringify(msg)}, [c.port2])
  setTimeout(() => resolve('sem resposta'), 3000)
})`

try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${ORIGIN}/healthz`)).ok) break
    } catch {}
    await sleep(100)
  }
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
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params = {}, sessionId) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params, sessionId }))
    })
  const { result: { targetId } } = await send('Target.createTarget', { url: `${ORIGIN}/` })
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
    return r.result?.result?.value
  }
  const navigate = async () => {
    await send('Page.navigate', { url: `${ORIGIN}/` }, sessionId)
    await sleep(1500)
  }

  let installed = false
  for (let i = 0; i < 240 && !installed; i++) {
    installed = await evaluate(`(async () => !!navigator.serviceWorker.controller && (await caches.keys()).includes('oblita-${manifest.version}') && !!(await (await caches.open('oblita-${manifest.version}')).match('/__manifest')))()`).catch(() => false)
    if (!installed) await sleep(500)
  }
  check('service worker instalado e no controle', installed)
  if (!installed) await navigate()

  check('manifesto com build e protocolo', typeof manifest.build === 'string' && manifest.protocol === 2, JSON.stringify({ build: manifest.build, protocol: manifest.protocol }))
  const shown = await evaluate(`document.querySelector('.build-version')?.textContent ?? null`)
  check('a página inicial mostra a versão', !!shown && shown.includes(manifest.build) && shown.includes('p2'), shown)
  const builds = await evaluate(ask({ type: 'builds' }))
  check('o service worker lista a versão com o protocolo', Array.isArray(builds) && builds.some((b) => b.build === manifest.build && b.protocol === 2), JSON.stringify(builds))

  // Uma versão anterior em cache, falando o protocolo 1, com uma página que se reconhece.
  await evaluate(`(async () => {
    const c = await caches.open('oblita-velha')
    await c.put('/__manifest', new Response(JSON.stringify({ version: 'velha', build: 'versao-velha', protocol: 1, files: [], at: 1 })))
    await c.put('/', new Response('<!doctype html><title>versao-velha</title><p>velha</p>', { headers: { 'Content-Type': 'text/html' } }))
  })()`)
  const both = await evaluate(ask({ type: 'builds' }))
  check('a versão anterior aparece com o protocolo dela', both.some((b) => b.build === 'versao-velha' && b.protocol === 1) && both[0].build === manifest.build, JSON.stringify(both.map((b) => [b.build, b.protocol])))
  check('fixar versão que não existe é recusado', (await evaluate(ask({ type: 'pin', build: 'nao-existe', reason: 'version' }))) === false)
  check('fixar a versão anterior', (await evaluate(ask({ type: 'pin', build: 'versao-velha', reason: 'version' }))) === true)
  await navigate()
  check('com a fixação, a página servida é a da versão anterior', (await evaluate('document.title')) === 'versao-velha', await evaluate('document.title'))
  const pin = await evaluate(ask({ type: 'pin-status' }))
  check('a fixação diz o motivo', pin?.build === 'versao-velha' && pin?.reason === 'version', JSON.stringify(pin))
  check('soltar', (await evaluate(ask({ type: 'unpin' }))) === true)
  await navigate()
  check('sem fixação, volta a mais nova', (await evaluate('document.title')) !== 'versao-velha' && !!(await evaluate(`!!document.querySelector('.build-version')`)), await evaluate('document.title'))
  check('sem fixação depois de soltar', (await evaluate(ask({ type: 'pin-status' }))) === null)
} catch (err) {
  console.error(err)
  results.push(false)
} finally {
  browser.kill('SIGKILL')
  server.kill('SIGKILL')
  await sleep(300)
  rmSync(profile, { recursive: true, force: true })
}

console.log(`\n${results.filter(Boolean).length} ok, ${results.filter((x) => !x).length} falharam`)
process.exit(results.every(Boolean) ? 0 : 1)
