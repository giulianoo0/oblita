// Processos, CDP puro e o registro dos casos. Cada participante é um contexto isolado do navegador.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BUN = join(ROOT, 'node_modules', 'bun', 'bin', 'bun.exe')
const VITE = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
export const TOKEN = 'token-do-teste-de-motor'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

export function eq(actual, expected, msg) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${msg}: esperava ${b}, veio ${a}`)
}

export const withTimeout = (p, ms, what) => {
  let t
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`HANG: ${what} passou de ${ms} ms`)), ms)))]).finally(() => clearTimeout(t))
}

function freePort(wanted = 0) {
  return new Promise((res, rej) => {
    const s = createServer()
    s.on('error', rej)
    s.listen(wanted, '0.0.0.0', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })
}

export function lanAddress() {
  const all = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal)
  const hit = all.find((i) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address))
  if (!hit) throw new Error('nenhum IP de rede privada nesta máquina')
  return hit.address
}

function killTree(p) {
  if (!p?.pid || p.exitCode !== null) return
  // Só a árvore que abrimos: nunca o Edge do usuário.
  spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' })
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.next = 1
    this.pending = new Map()
    this.sessions = new Map()
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id) {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) p?.reject(new Error(`${p.method}: ${msg.error.message}`))
        else p?.resolve(msg.result)
      } else if (msg.sessionId) {
        this.sessions.get(msg.sessionId)?.(msg.method, msg.params)
      }
    }
    ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error('navegador caiu'))
      this.pending.clear()
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.ws.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }
}

export class Harness {
  results = []
  procs = {}
  participants = []
  scenario = ''
  userDir = null

  async start() {
    await this.startVite()
    await this.startHub()
    await this.startEdge()
  }

  // ---- vite

  async startVite() {
    const port = await freePort()
    const p = spawn(process.execPath, [VITE, '--config', join(ROOT, 'tests', 'engine', 'vite.config.ts'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    this.procs.vite = p
    let log = ''
    p.stdout.on('data', (d) => (log += d))
    p.stderr.on('data', (d) => (log += d))
    p.on('exit', (code) => this.closing || console.log(`  [vite saiu: ${code}] ${log.slice(-400)}`))
    this.origin = `http://localhost:${port}`
    this.pageUrl = `${this.origin}/tests/engine/page.html`
    for (let i = 0; i < 120; i++) {
      if (p.exitCode !== null) throw new Error(`vite saiu: ${log}`)
      try {
        if ((await fetch(this.pageUrl)).ok) return
      } catch {}
      await sleep(250)
    }
    throw new Error(`vite não subiu: ${log}`)
  }

  // ---- hub

  async startHub() {
    this.lanIp = lanAddress()
    let port = 7787
    try {
      await freePort(7787)
    } catch {
      // Outro programa está com a porta real: o teste não pode derrubá-lo.
      port = await freePort()
      console.log(`porta 7787 ocupada, hub do teste em ${port}`)
    }
    this.hubPort = port
    this.controlPort = await freePort()
    await this.hubUp()
  }

  async hubUp() {
    const p = spawn(BUN, [join(ROOT, 'tests', 'engine', 'hub.ts'), String(this.hubPort), String(this.controlPort), TOKEN], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    this.procs.hub = p
    let log = ''
    p.stdout.on('data', (d) => (log += d))
    p.stderr.on('data', (d) => (log += d))
    p.on('exit', (code) => this.closing || (this.procs.hub === p && console.log(`  [hub saiu: ${code}] ${log.slice(-400)}`)))
    for (let i = 0; i < 80; i++) {
      if (p.exitCode !== null) throw new Error(`hub saiu: ${log}`)
      try {
        const res = await fetch(`http://127.0.0.1:${this.hubPort}/ping`)
        if (res.ok) return
      } catch {}
      await sleep(100)
    }
    throw new Error(`hub não subiu: ${log}`)
  }

  async hubDown() {
    killTree(this.procs.hub)
    this.procs.hub = null
    for (let i = 0; i < 40; i++) {
      try {
        await fetch(`http://127.0.0.1:${this.hubPort}/ping`)
        await sleep(100)
      } catch {
        return
      }
    }
    throw new Error('hub não caiu')
  }

  hubReset = () => fetch(`http://127.0.0.1:${this.controlPort}/reset`).then((r) => r.json())

  hubSearch = (needles) =>
    fetch(`http://127.0.0.1:${this.controlPort}/search`, { method: 'POST', body: JSON.stringify({ needles }) }).then((r) => r.json())

  get hubLocal() {
    return `localhost:${this.hubPort}`
  }

  get hubLan() {
    return `${this.lanIp}:${this.hubPort}`
  }

  // ---- navegador

  async startEdge() {
    const port = await freePort()
    this.userDir = mkdtempSync(join(tmpdir(), 'oblita-motor-'))
    this.procs.edge = spawn(
      EDGE,
      [
        '--headless=new',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${this.userDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-features=CalculateNativeWinOcclusion',
        'about:blank',
      ],
      { stdio: 'ignore' },
    )
    let url = null
    for (let i = 0; i < 120 && !url; i++) {
      try {
        url = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl
      } catch {
        await sleep(250)
      }
    }
    if (!url) throw new Error('Edge não abriu a porta de depuração')
    this.version = port
    const ws = new WebSocket(url)
    await new Promise((res, rej) => {
      ws.onopen = res
      ws.onerror = () => rej(new Error('CDP não conectou'))
    })
    this.cdp = new Cdp(ws)
    this.browserVersion = (await this.cdp.send('Browser.getVersion')).product
  }

  async participant(name) {
    const { cdp } = this
    const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true })
    this.grants ??= {}
    for (const perm of ['local-network', 'loopback-network', 'local-network-access']) {
      try {
        await cdp.send('Browser.setPermission', { browserContextId, origin: this.origin, permission: { name: perm }, setting: 'granted' })
        this.grants[perm] = true
      } catch {
        this.grants[perm] ??= false
      }
    }
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId, width: 1280, height: 800 })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    const p = new Participant(this, name, browserContextId, targetId, sessionId)
    this.participants.push(p)
    await p.boot()
    return p
  }

  async closeAll() {
    const list = this.participants
    this.participants = []
    for (const p of list) await p.dispose()
    // O hub precisa ver as conexões fechando antes do próximo painel entrar.
    if (list.length) await sleep(200)
  }

  // ---- casos

  async case(name, fn, timeoutMs = 30_000) {
    const started = Date.now()
    const row = { scenario: this.scenario, name, ok: false, ms: 0, err: '' }
    this.results.push(row)
    try {
      await withTimeout(Promise.resolve().then(fn), timeoutMs, name)
      row.ok = true
      console.log(`  ok    ${name} (${Date.now() - started} ms)`)
    } catch (err) {
      row.err = String(err?.message ?? err)
      console.log(`  FALHA ${name}\n        ${row.err.slice(0, 600)}`)
    }
    row.ms = Date.now() - started
    return row.ok
  }

  async cleanup() {
    this.closing = true
    try {
      await this.closeAll()
    } catch {}
    try {
      await withTimeout(this.cdp?.send('Browser.close') ?? Promise.resolve(), 3000, 'fechar')
    } catch {}
    killTree(this.procs.edge)
    killTree(this.procs.hub)
    killTree(this.procs.vite)
    if (this.userDir) {
      for (let i = 0; i < 40 && existsSync(this.userDir); i++) {
        try {
          rmSync(this.userDir, { recursive: true, force: true })
        } catch {
          await sleep(500)
        }
      }
    }
  }
}

class Participant {
  exceptions = []
  consoleErrors = []

  constructor(h, name, contextId, targetId, sessionId) {
    Object.assign(this, { h, name, contextId, targetId, sessionId })
    h.cdp.sessions.set(sessionId, (method, params) => {
      if (method === 'Runtime.exceptionThrown') {
        const d = params.exceptionDetails
        this.exceptions.push(`${d.text} ${d.exception?.description ?? d.exception?.value ?? ''}`.slice(0, 400))
      } else if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
        this.consoleErrors.push(params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300))
      } else if (method === 'Inspector.targetCrashed') {
        this.exceptions.push('aba travou')
      }
    })
  }

  send(method, params = {}) {
    return this.h.cdp.send(method, params, this.sessionId)
  }

  async boot() {
    await this.send('Runtime.enable')
    await this.send('Page.enable')
    await this.send('Inspector.enable').catch(() => {})
    // Sem isto a aba de trás contaria como sem foco, e os relógios seriam atrasados.
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    await this.send('Page.navigate', { url: this.h.pageUrl })
    await this.ready()
  }

  async ready() {
    const until = Date.now() + 60_000
    while (Date.now() < until) {
      try {
        if (await this.call(() => window.__ready === true)) return
      } catch {}
      await sleep(100)
    }
    const state = await this.call(() => ({ href: location.href, ready: document.readyState, T: typeof window.T })).catch((e) => String(e))
    throw new Error(`${this.name}: página não carregou: ${JSON.stringify(state)} ${JSON.stringify(this.exceptions).slice(0, 400)} ${JSON.stringify(this.consoleErrors).slice(0, 400)}`)
  }

  // Recarrega de verdade, sem dar chance a nenhum código de saída.
  async reload() {
    await this.send('Page.reload', { ignoreCache: false })
    await sleep(50)
    await this.ready()
  }

  async call(fn, ...args) {
    const expression = `(${fn.toString()})(...${JSON.stringify(args)})`
    const res = await withTimeout(this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), 120_000, `${this.name}: avaliação`)
    if (res.exceptionDetails) {
      const d = res.exceptionDetails
      throw new Error(`${this.name}: ${d.exception?.description ?? d.text}`)
    }
    return res.result.value
  }

  async until(fn, args = [], { timeout = 15_000, what = fn.toString().slice(0, 120), every = 60 } = {}) {
    const end = Date.now() + timeout
    let last
    let lastErr
    while (Date.now() < end) {
      try {
        last = await this.call(fn, ...args)
        lastErr = null
        if (last) return last
      } catch (err) {
        lastErr = err
      }
      await sleep(every)
    }
    throw new Error(`${this.name}: esperou ${timeout} ms por ${what}${lastErr ? ` (${lastErr.message})` : ''}; último valor ${JSON.stringify(last)}`)
  }

  async dispose() {
    this.h.cdp.sessions.delete(this.sessionId)
    await this.h.cdp.send('Target.disposeBrowserContext', { browserContextId: this.contextId }).catch(() => {})
  }
}
