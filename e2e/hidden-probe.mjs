// Mede o que uma página faz depois de ficar escondida: timers, cifra e rede continuam vivos?
// Sem isto não dá para saber se um alerta atrasado é defeito do app ou do navegador sem janela.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const HTTP = 18099
const CDP = 9346
const HIDDEN_MS = 20_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PAGE = `<!doctype html><title>sonda</title><canvas id=c width=64 height=64></canvas><script>
const log = (kind) => fetch('/log?kind=' + kind + '&state=' + document.visibilityState, { method: 'POST', keepalive: true })
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'hidden') return log('visivel')
  log('escondeu')
  await crypto.subtle.digest('SHA-256', new Uint8Array(32))
  log('depois-da-cifra')
})
setInterval(() => log('tick'), 2000)
window.startCapture = async () => {
  const stream = document.getElementById('c').captureStream(5)
  const rec = new MediaRecorder(stream)
  rec.start(1000)
  window.keep = rec
  const ctx = document.getElementById('c').getContext('2d')
  setInterval(() => { ctx.fillRect(Math.random() * 60, 0, 2, 2) }, 200)
}
</script>`

async function runCase(label, args, withCapture) {
  const events = []
  const server = createServer((req, res) => {
    if (req.url.startsWith('/log')) {
      const q = new URL(req.url, 'http://x').searchParams
      events.push({ at: Date.now(), kind: q.get('kind'), state: q.get('state') })
      res.end('ok')
      return
    }
    res.setHeader('content-type', 'text/html')
    res.end(PAGE)
  })
  await new Promise((r) => server.listen(HTTP, '127.0.0.1', r))
  const profile = mkdtempSync(join(tmpdir(), 'oblita-sonda-'))
  const edge = spawn(EDGE, [...args, `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let info
  for (let i = 0; i < 60 && !info; i++) {
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
  const { result: { targetId } } = await send('Target.createTarget', { url: `http://127.0.0.1:${HTTP}/` })
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Runtime.enable', {}, sessionId)
  await sleep(1500)
  if (withCapture) await send('Runtime.evaluate', { expression: 'window.startCapture()', awaitPromise: true, userGesture: true }, sessionId)
  await sleep(2500)
  const started = Date.now()
  const { result: other } = await send('Target.createTarget', { url: 'about:blank' })
  await send('Target.activateTarget', { targetId: other.targetId })
  await sleep(HIDDEN_MS)
  const state = await send('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true }, sessionId)
  await send('Target.activateTarget', { targetId })
  await sleep(2500)

  const during = events.filter((e) => e.at >= started && e.at < started + HIDDEN_MS)
  const first = (kind) => {
    const hit = events.find((e) => e.kind === kind && e.at >= started)
    return hit ? `${hit.at - started} ms` : 'nunca'
  }
  const ticks = during.filter((e) => e.kind === 'tick')
  const gaps = ticks.slice(1).map((e, i) => e.at - ticks[i].at)
  console.log(`\n${label}`)
  console.log(`  estado reportado no meio: ${state.result?.result?.value}`)
  console.log(`  alerta "escondeu": ${first('escondeu')}   depois da cifra: ${first('depois-da-cifra')}`)
  console.log(`  timers em ${HIDDEN_MS / 1000} s escondida: ${ticks.length} (esperado cerca de ${HIDDEN_MS / 2000}), maior intervalo: ${gaps.length ? Math.max(...gaps) : 'n/a'} ms`)

  ws.close()
  edge.kill()
  server.close()
  await sleep(1500)
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    // Pasta temporária: o Edge pode segurar arquivos por um instante.
  }
}

const mode = process.argv[2] ?? 'all'
if (mode !== 'headful') {
  await runCase('sem janela', ['--headless=new'], false)
  await runCase('sem janela, gravando', ['--headless=new'], true)
}
if (mode !== 'headless') {
  await runCase('com janela de verdade', ['--window-position=40,40', '--window-size=900,600'], false)
  await runCase('com janela de verdade, gravando', ['--window-position=40,40', '--window-size=900,600'], true)
}
process.exit(0)
