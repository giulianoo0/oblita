// Roda tests/wasm.html num Edge sem janela via CDP, para testar o caminho real do navegador.
// Uso: node tests/run-wasm.mjs [--only=regex] [--skip-slow] [--no-bench]
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const REPORT = join(ROOT, 'tests', 'wasm-report.json')
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}`))?.split('=')[1] ?? (process.argv.includes(`--${n}`) ? true : undefined)
const ONLY = arg('only') ? new RegExp(arg('only')) : null
const SKIP_SLOW = !!arg('skip-slow')
const NO_BENCH = !!arg('no-bench')
const SLOW = /watchdog|macro-bomba|tipo-exponencial/

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const withTimeout = (p, ms, what) => {
  let t
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`HANG: ${what} passou de ${ms} ms`)), ms)))]).finally(() => clearTimeout(t))
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })
}

// ------------------------------------------------------------------- processos
let vite, edge, userDir
function killTree(p) {
  if (!p || p.exitCode !== null || !p.pid) return
  // só a árvore que abrimos: nunca o Edge do usuário
  spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' })
}
let cleaned = false
async function cleanup() {
  if (cleaned) return
  cleaned = true
  killTree(edge)
  killTree(vite)
  if (userDir) {
    for (let i = 0; i < 10 && existsSync(userDir); i++) {
      try {
        rmSync(userDir, { recursive: true, force: true })
      } catch {
        await sleep(500)
      }
    }
  }
}
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => cleanup().finally(() => process.exit(130)))
process.on('exit', () => {
  killTree(edge)
  killTree(vite)
})

async function startVite() {
  const port = await freePort()
  vite = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', join(ROOT, 'tests', 'vite.config.ts'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  vite.stdout.on('data', (d) => (log += d))
  vite.stderr.on('data', (d) => (log += d))
  const url = `http://127.0.0.1:${port}`
  for (let i = 0; i < 120; i++) {
    if (vite.exitCode !== null) throw new Error(`vite saiu: ${log}`)
    try {
      const r = await fetch(`${url}/tests/wasm.html`)
      if (r.ok) return { url, log: () => log }
    } catch {}
    await sleep(500)
  }
  throw new Error(`vite não subiu: ${log}`)
}

async function startEdge() {
  userDir = mkdtempSync(join(tmpdir(), 'oblita-edge-'))
  edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDir}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--enable-precise-memory-info', 'about:blank'], { stdio: 'ignore' })
  const file = join(userDir, 'DevToolsActivePort')
  for (let i = 0; i < 120; i++) {
    if (existsSync(file)) {
      const [port] = readFileSync(file, 'utf8').split('\n')
      if (port) return Number(port)
    }
    await sleep(250)
  }
  throw new Error('Edge não abriu a porta de depuração')
}

// ------------------------------------------------------------------------- CDP
class Cdp {
  static async open(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => {
      ws.onopen = res
      ws.onerror = () => rej(new Error(`WebSocket falhou: ${url}`))
    })
    return new Cdp(ws)
  }
  constructor(ws) {
    this.ws = ws
    this.next = 1
    this.waiting = new Map()
    this.handlers = new Map()
    this.closed = false
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id) {
        const w = this.waiting.get(m.id)
        this.waiting.delete(m.id)
        if (!w) return
        if (m.error) w.rej(new Error(`${m.error.message} ${m.error.data ?? ''}`))
        else w.res(m.result)
      } else this.handlers.get(m.method)?.forEach((h) => h(m.params))
    }
    ws.onclose = () => {
      this.closed = true
      for (const w of this.waiting.values()) w.rej(new Error('CDP fechou'))
      this.waiting.clear()
    }
  }
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = this.next++
      this.waiting.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, [])
    this.handlers.get(method).push(fn)
  }
  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

let page, browser, pageUrl, debugPort
let crashes = 0
const pageErrors = []

async function openPage() {
  const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json()
  for (const t of list) if (t.type === 'page') await fetch(`http://127.0.0.1:${debugPort}/json/close/${t.id}`).catch(() => {})
  page?.close()
  page = await Cdp.open(target.webSocketDebuggerUrl)
  page.on('Inspector.targetCrashed', () => {
    crashes++
    pageErrors.push({ type: 'targetCrashed' })
    page.crashed = true
    for (const w of page.waiting.values()) w.rej(new Error('CRASH: o renderer da aba morreu'))
    page.waiting.clear()
  })
  page.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
    pageErrors.push({ type: 'exception', text: d.exception?.description ?? d.text, url: d.url })
  })
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Inspector.enable')
  await page.send('Page.navigate', { url: pageUrl })
  for (let i = 0; i < 240; i++) {
    const r = await page.send('Runtime.evaluate', { expression: 'typeof window.__t === "object"', returnByValue: true }).catch(() => null)
    if (r?.result?.value === true) return
    await sleep(250)
  }
  throw new Error(`a página de teste não carregou: ${JSON.stringify(pageErrors.slice(-3))}`)
}

async function call(expr, ms, what) {
  const r = await withTimeout(page.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }), ms, what)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

// Memória real: soma do working set dos processos deste Edge, identificados pela pasta temporária.
function edgeMemoryMb() {
  try {
    const needle = userDir.replace(/'/g, "''")
    const ps = `(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' } | Measure-Object -Property WorkingSetSize -Sum).Sum`
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 20_000 })
    return Math.round(Number(out.trim()) / 1048576)
  } catch {
    return -1
  }
}

async function cpuSeconds() {
  const { processInfo } = await browser.send('SystemInfo.getProcessInfo')
  return processInfo.reduce((a, p) => a + p.cpuTime, 0)
}
async function cpuWindow(ms) {
  const a = await cpuSeconds()
  const t0 = performance.now()
  await sleep(ms)
  const b = await cpuSeconds()
  return (b - a) / ((performance.now() - t0) / 1000)
}

// ------------------------------------------------- cenários comandados daqui (CPU, memória)
const results = []
const metrics = {}
function record(r) {
  results.push(r)
  const tag = { pass: 'ok   ', fail: 'FALHA', known: 'limite' }[r.status] ?? r.status
  const ms = r.compileMs !== undefined ? `${r.compileMs}+${r.runMs}ms` : `${r.totalMs ?? 0}ms`
  console.log(`${tag} ${r.id.padEnd(44)} ${ms.padStart(14)}  lag ${String(r.lagMs ?? '').padStart(5)}${r.failures?.length ? `\n      ${r.failures.join('\n      ').slice(0, 900)}` : ''}`)
}

async function scenarioCpu() {
  const failures = []
  const notes = []
  const t0 = performance.now()
  // O V8 otimiza o llvm.core.wasm em segundo plano por um bom tempo: sem esperar, o ocioso não é ocioso.
  let idle = await cpuWindow(2000)
  for (let i = 0; i < 40 && idle > 0.3; i++) idle = await cpuWindow(2000)
  await call('window.__t.burnStart(3)', 60_000, 'burnStart')
  await sleep(1500)
  const burning = await cpuWindow(2500)
  const stop = await call('window.__t.burnStop()', 30_000, 'burnStop')
  await sleep(300)
  const after = await cpuWindow(2500)
  if (!stop.all) failures.push('kill não marcou todos como Interrompido')
  if (burning < 1.5) failures.push(`só ${burning.toFixed(2)} núcleos ocupados com 3 laços: medição inválida`)
  if (after > idle + 0.4) failures.push(`CPU continua alta depois do kill: ${after.toFixed(2)} núcleos (ocioso ${idle.toFixed(2)})`)
  await call('window.__t.burnTimeout(3, 1500)', 30_000, 'burnTimeout')
  await sleep(300)
  const afterTimeout = await cpuWindow(2500)
  if (afterTimeout > idle + 0.4) failures.push(`CPU continua alta depois do timeout: ${afterTimeout.toFixed(2)} núcleos`)
  notes.push(`núcleos: ocioso ${idle.toFixed(2)}, 3 laços ${burning.toFixed(2)}, após kill ${after.toFixed(2)}, após timeout ${afterTimeout.toFixed(2)}`)
  metrics.cpu = { idle, burning, afterKill: after, afterTimeout, killMs: stop.killMs }
  record({ id: 'robust.terminate-para-cpu', group: 'robust', status: failures.length ? 'fail' : 'pass', failures, notes, metrics: metrics.cpu, totalMs: Math.round(performance.now() - t0) })
}

async function scenarioThirty() {
  const failures = []
  const rows = []
  const t0 = performance.now()
  for (let i = 0; i < 30; i++) {
    const r = await call(`window.__t.compileOnce(${i})`, 120_000, `compile ${i}`)
    if (!r.ok) failures.push(`compile ${i} falhou`)
    rows.push({ i, ms: r.ms, wsMb: edgeMemoryMb(), heapMb: Math.round(r.heapUsed / 1048576) })
  }
  const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length)
  const ws = rows.map((r) => r.wsMb)
  const ms = rows.map((r) => r.ms)
  const trend = { wsInicioMb: avg(ws.slice(2, 7)), wsFimMb: avg(ws.slice(-5)), wsPicoMb: Math.max(...ws), msInicio: avg(ms.slice(2, 7)), msFim: avg(ms.slice(-5)), heapInicioMb: rows[2].heapMb, heapFimMb: rows[29].heapMb }
  if (trend.wsFimMb > trend.wsInicioMb * 1.5 && trend.wsFimMb > trend.wsInicioMb + 300) failures.push(`memória cresceu: ${trend.wsInicioMb} para ${trend.wsFimMb} MB`)
  if (trend.msFim > trend.msInicio * 1.6) failures.push(`compilação ficou lenta: ${trend.msInicio} para ${trend.msFim} ms`)
  metrics.trinta = { ...trend, serie: rows }
  record({ id: 'robust.30-compiles-sem-vazar', group: 'robust', status: failures.length ? 'fail' : 'pass', failures, notes: [JSON.stringify(trend)], metrics: trend, totalMs: Math.round(performance.now() - t0) })
}

// Rede lenta de verdade: a 1,3 MB/s os 105 MB do compilador levam mais que o watchdog de 60 s.
async function scenarioSlowDownload(url) {
  const t0 = performance.now()
  const failures = []
  await fetch(`${url}/__throttle?bps=1400000`)
  try {
    await openPage()
    const r = await call('window.__t.slowCompile()', 170_000, 'compile em rede lenta')
    if (!r.ok) failures.push(`falhou: ${r.log}`)
    if (r.ms < 62_000) failures.push(`download terminou em ${r.ms} ms: não testou nada`)
    metrics.redeLenta = r
    record({ id: 'robust.download-lento-passa-do-watchdog', group: 'robust', status: failures.length ? 'fail' : 'pass', failures, metrics: r, totalMs: Math.round(performance.now() - t0) })
  } finally {
    await fetch(`${url}/__throttle?bps=0`)
    await openPage()
  }
}

async function main() {
  const startedAt = new Date().toISOString()
  const { url } = await startVite()
  debugPort = await startEdge()
  const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()
  browser = await Cdp.open(version.webSocketDebuggerUrl)
  pageUrl = `${url}/tests/wasm.html`
  await openPage()

  // A primeira compilação da sessão é a mais cara de todas: rede, compilar 75 MB de wasm, resources.
  const first = await call('window.__t.sanity()', 240_000, 'primeira compilação')
  metrics.primeiraCompilacaoMs = first.compileMs
  console.log(`primeira compilação da aba: ${first.compileMs} ms (${first.ok ? 'ok' : first.detail})`)
  const second = await call('window.__t.sanity()', 120_000, 'segunda compilação')
  metrics.segundaCompilacaoMs = second.compileMs

  const list = (await call('window.__t.list()', 30_000, 'lista')).filter((c) => (!ONLY || ONLY.test(c.id)) && !(SKIP_SLOW && SLOW.test(c.id)))
  console.log(`${list.length} casos`)
  for (const c of list) {
    let r
    try {
      r = await call(`window.__t.runCase(${JSON.stringify(c.id)})`, c.harnessMs + 15_000, c.id)
    } catch (err) {
      r = { id: c.id, group: c.group, status: 'fail', failures: [String(err.message ?? err)] }
    }
    // Qualquer travamento vira falha do caso e uma aba nova: o resto do teste segue.
    const dead = page.crashed || page.closed || /^(Error: )?(HANG|CRASH)|CDP fechou|navigated or closed/.test(r.failures?.[0] ?? '')
    if (dead) {
      record(r)
      await openPage()
      const s = await call('window.__t.sanity()', 240_000, 'sanity pós-recarga').catch((e) => ({ ok: false, detail: String(e) }))
      if (!s.ok) record({ id: `${c.id}#sanity`, group: c.group, status: 'fail', failures: [s.detail] })
      continue
    }
    // Depois de cada falha contida, compilar e rodar de novo tem de funcionar.
    if (!/^(c-header|cpp-header|io)$/.test(c.group)) {
      try {
        const s = await call('window.__t.sanity()', 120_000, 'sanity')
        if (!s.ok) {
          r.status = 'fail'
          r.failures = [...(r.failures ?? []), s.detail]
        }
        r.sanityMs = s.compileMs + s.runMs
      } catch (err) {
        r.status = 'fail'
        r.failures = [...(r.failures ?? []), `sanity travou depois do caso: ${err.message}`]
      }
    }
    record(r)
  }

  if ((!ONLY || ONLY.test('robust.download-lento')) && !SKIP_SLOW) await scenarioSlowDownload(url).catch((e) => record({ id: 'robust.download-lento-passa-do-watchdog', group: 'robust', status: 'fail', failures: [String(e)] }))
  if (!ONLY || ONLY.test('robust.terminate-para-cpu')) await scenarioCpu().catch((e) => record({ id: 'robust.terminate-para-cpu', group: 'robust', status: 'fail', failures: [String(e)] }))
  if (!ONLY || ONLY.test('robust.30-compiles-sem-vazar')) await scenarioThirty().catch((e) => record({ id: 'robust.30-compiles-sem-vazar', group: 'robust', status: 'fail', failures: [String(e)] }))
  if (!NO_BENCH && (!ONLY || ONLY.test('bench'))) {
    try {
      metrics.flags = await call('window.__t.benchFlags()', 590_000, 'bench de flags')
      console.log(JSON.stringify(metrics.flags, null, 1))
    } catch (e) {
      record({ id: 'bench.flags', group: 'robust', status: 'fail', failures: [String(e)] })
    }
  }

  const count = (s) => results.filter((r) => r.status === s).length
  const totals = { total: results.length, pass: count('pass'), fail: count('fail'), known: count('known') }
  const slowest = [...results].sort((a, b) => (b.lagMs ?? 0) - (a.lagMs ?? 0)).slice(0, 5).map((r) => `${r.id}=${r.lagMs}`)

  // tabela final, por caso, resultado e tempos
  console.log(`\n${'caso'.padEnd(46)}${'resultado'.padEnd(10)}${'compila'.padStart(9)}${'roda'.padStart(9)}${'lag'.padStart(7)}`)
  for (const r of results) console.log(`${r.id.padEnd(46)}${r.status.padEnd(10)}${String(r.compileMs ?? r.totalMs ?? '').padStart(9)}${String(r.runMs ?? '').padStart(9)}${String(r.lagMs ?? '').padStart(7)}`)
  console.log(`\ntotal ${totals.total}: ${totals.pass} passaram, ${totals.fail} falharam, ${totals.known} limites conhecidos. Renderer morreu ${crashes} vezes.`)
  console.log(`maior travamento da página: ${slowest.join(', ')}`)
  const fails = results.filter((r) => r.status === 'fail')
  if (fails.length) console.log(`\nFALHAS:\n${fails.map((r) => `${r.id}\n  ${(r.failures ?? []).join('\n  ')}`).join('\n')}`)
  writeFileSync(REPORT, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), totals, crashes, pageErrors: pageErrors.slice(0, 50), metrics, results }, null, 1))
  console.log(`relatório: ${REPORT}`)
  return fails.length || crashes ? 1 : 0
}

let code = 1
try {
  code = await main()
} catch (err) {
  console.error(`o harness falhou: ${err.stack ?? err}`)
} finally {
  browser?.close()
  page?.close()
  await cleanup()
}
process.exit(code)
