// CDP puro: um Edge por modo, um contexto isolado por pessoa, e mouse e teclado de verdade.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const killTree = (p) => {
  if (p?.pid && p.exitCode === null) spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' })
}

export function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`passou de ${ms} ms: ${label}`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

export class Cdp {
  constructor(ws) {
    this.ws = ws
    this.next = 1
    this.waiting = new Map()
    this.handlers = new Map()
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id) {
        const w = this.waiting.get(m.id)
        this.waiting.delete(m.id)
        if (m.error) w?.rej(new Error(`${w.method}: ${m.error.message}`))
        else w?.res(m.result)
      } else {
        for (const h of this.handlers.get(m.method) ?? []) h(m.params, m.sessionId)
      }
    }
    ws.onclose = () => {
      for (const w of this.waiting.values()) w.rej(new Error('CDP fechou'))
      this.waiting.clear()
    }
  }

  send(method, params = {}, sessionId) {
    return new Promise((res, rej) => {
      if (this.ws.readyState !== WebSocket.OPEN) return rej(new Error('CDP fechado'))
      const id = this.next++
      this.waiting.set(id, { res, rej, method })
      this.ws.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }

  on(method, fn) {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), fn])
  }
}

export class Edge {
  static async launch({ visible = false, windowSize = '1600,900', tag = 'e2e' } = {}) {
    const userDir = mkdtempSync(join(tmpdir(), `oblita-${tag}-`))
    const args = [
      ...(visible ? [] : ['--headless=new', `--window-size=${windowSize}`]),
      '--remote-debugging-port=0',
      `--user-data-dir=${userDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen',
      'about:blank',
    ]
    const proc = spawn(EDGE, args, { stdio: 'ignore' })
    const file = join(userDir, 'DevToolsActivePort')
    let port = 0
    for (let i = 0; i < 160 && !port; i++) {
      if (existsSync(file)) port = Number(readFileSync(file, 'utf8').split('\n')[0]) || 0
      if (!port) await sleep(250)
    }
    if (!port) {
      killTree(proc)
      throw new Error('Edge não abriu a porta de depuração')
    }
    const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    const ws = new WebSocket(info.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.onopen = res
      ws.onerror = () => rej(new Error('CDP não conectou'))
    })
    return new Edge(new Cdp(ws), proc, userDir, info.Browser, visible)
  }

  constructor(cdp, proc, userDir, product, visible) {
    this.cdp = cdp
    this.proc = proc
    this.userDir = userDir
    this.product = product
    this.visible = visible
  }

  async close() {
    await withTimeout(this.cdp.send('Browser.close'), 3000, 'fechar Edge').catch(() => {})
    killTree(this.proc)
    for (let i = 0; i < 10 && existsSync(this.userDir); i++) {
      try {
        rmSync(this.userDir, { recursive: true, force: true })
      } catch {
        await sleep(400)
      }
    }
  }
}

export const CTRL = 2
export const SHIFT = 8

const KEY_CODES = {
  Enter: 13,
  Escape: 27,
  Backspace: 8,
  Tab: 9,
  Delete: 46,
  End: 35,
  Home: 36,
  ArrowDown: 40,
  ArrowUp: 38,
  ArrowLeft: 37,
  ArrowRight: 39,
  F5: 116,
  F12: 123,
}

// Uma aba: tudo aqui entra pelo navegador, como uma pessoa faria, e não pelo estado do React.
export class Tab {
  constructor(person, targetId, sessionId) {
    this.person = person
    this.cdp = person.browser.cdp
    this.targetId = targetId
    this.sessionId = sessionId
    this.errors = []
    this.dialogs = []
    this.wsFrames = []
    this.cdp.on('Runtime.exceptionThrown', (p, sid) => {
      if (sid !== this.sessionId) return
      const d = p.exceptionDetails
      const text = d.exception?.description ?? d.text
      if (!/Canceled: Canceled/.test(text)) this.errors.push(text)
    })
    this.cdp.on('Runtime.consoleAPICalled', (p, sid) => {
      if (sid !== this.sessionId || p.type !== 'error') return
      this.errors.push(`console.error: ${p.args.map((a) => a.value ?? a.description).join(' ')}`)
    })
    // A prova avisa antes de sair da página: o F5 do teste confirma, como o aluno clicaria.
    this.cdp.on('Page.javascriptDialogOpening', (p, sid) => {
      if (sid !== this.sessionId) return
      this.dialogs.push(p.type)
      void this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
    })
    // Pedaços de gravação ficam de fora: são centenas de KB cada, e o que interessa aqui são as mensagens.
    const keep = (dir, data) => {
      if (data.length < 90_000) this.wsFrames.push({ dir, data, at: Date.now() })
    }
    this.cdp.on('Network.webSocketFrameReceived', (p, sid) => sid === this.sessionId && keep('in', p.response.payloadData))
    this.cdp.on('Network.webSocketFrameSent', (p, sid) => sid === this.sessionId && keep('out', p.response.payloadData))
  }

  send(method, params = {}) {
    return this.cdp.send(method, params, this.sessionId)
  }

  async boot({ focus = true } = {}) {
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('Network.enable')
    await this.send('DOM.enable')
    if (focus) await this.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  }

  async ev(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(`${expression.slice(0, 160)}\n${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    return r.result.value
  }

  navigate(url) {
    return this.send('Page.navigate', { url })
  }

  reload() {
    return this.send('Page.reload')
  }

  url() {
    return this.ev('location.href')
  }

  text() {
    return this.ev('document.body ? document.body.innerText : ""')
  }

  async waitFor(expr, { timeout = 15000, every = 80, label } = {}) {
    const start = Date.now()
    for (;;) {
      try {
        const last = await this.ev(expr)
        if (last) return last
      } catch (err) {
        // Navegação em curso destrói o contexto: tenta de novo até o prazo.
        if (!/context|navigat|Target closed|Inspected|Cannot read/i.test(String(err.message))) throw err
      }
      if (Date.now() - start > timeout) throw new Error(`não apareceu em ${timeout} ms: ${label ?? expr.slice(0, 200)}`)
      await sleep(every)
    }
  }

  waitText(text, opts = {}) {
    const test = text instanceof RegExp ? `${text}.test(document.body.innerText)` : `document.body.innerText.includes(${JSON.stringify(text)})`
    return this.waitFor(`!!document.body && ${test}`, { label: `texto "${text}"`, ...opts })
  }

  waitNoText(text, opts = {}) {
    const test = text instanceof RegExp ? `${text}.test(document.body.innerText)` : `document.body.innerText.includes(${JSON.stringify(text)})`
    return this.waitFor(`!!document.body && !(${test})`, { label: `sumir "${text}"`, ...opts })
  }

  // Centro do elemento depois de parar de animar: a física de mola move os botões por um instante.
  async centerOf(finder, label, timeout = 12000) {
    let prev = null
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const r = await this.ev(`(() => { const el = ${finder}; if (!el) return null; el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height, off: !!el.disabled || el.getAttribute('aria-disabled') === 'true' } })()`).catch(() => null)
      if (r && r.w > 0 && r.h > 0 && !r.off && prev && Math.abs(prev.x - r.x) < 1 && Math.abs(prev.y - r.y) < 1 && Math.abs(prev.w - r.w) < 1) return r
      prev = r
      await sleep(60)
    }
    throw new Error(`sem elemento clicável: ${label ?? finder.slice(0, 160)}`)
  }

  async mouse(type, x, y, extra = {}) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra })
  }

  async clickAt(x, y) {
    await this.mouse('mouseMoved', x, y)
    await this.mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 })
    await this.mouse('mouseReleased', x, y, { button: 'left', clickCount: 1 })
    await sleep(40)
  }

  // O texto visível é o localizador: o mais próximo do que a pessoa procura na tela.
  byText(text, { exact = true, within = 'document' } = {}) {
    return `(() => {
      const want = ${JSON.stringify(text)}
      const list = [...${within}.querySelectorAll('button, a, [role=button], [role=tab], [role=option], [role=radio], [role=checkbox], summary')]
      const seen = list.filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden' })
      const clean = (e) => (e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim()
      return seen.find((e) => clean(e) === want) ?? ${exact ? 'null' : 'seen.find((e) => clean(e).includes(want)) ?? null'}
    })()`
  }

  async clickText(text, opts = {}) {
    const c = await this.centerOf(this.byText(text, opts), `botão "${text}"`)
    await this.clickAt(c.x, c.y)
  }

  async clickSel(selector) {
    const c = await this.centerOf(`document.querySelector(${JSON.stringify(selector)})`, selector)
    await this.clickAt(c.x, c.y)
  }

  fieldInput(label) {
    return `[...document.querySelectorAll('label.field, .field')].find((f) => f.querySelector('span')?.textContent.trim() === ${JSON.stringify(label)})?.querySelector('input, textarea')`
  }

  // Clica no campo pelo rótulo, limpa e digita tecla a tecla.
  async fill(label, value) {
    const c = await this.centerOf(this.fieldInput(label), `campo "${label}"`)
    await this.clickAt(c.x, c.y)
    await this.press('a', CTRL, { commands: ['selectAll'] })
    await this.press('Backspace')
    await this.type(value)
  }

  async press(key, modifiers = 0, { commands } = {}) {
    const named = KEY_CODES[key]
    const vk = named ?? key.toUpperCase().charCodeAt(0)
    const code = named ? key : /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, ...(commands ? { commands } : {}) })
    if (key === 'Enter') await this.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...base })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    await sleep(20)
  }

  async type(text, delay = this.person.typeDelay ?? 0) {
    for (const ch of text) {
      if (ch === '\n') {
        await this.press('Enter')
        continue
      }
      const vk = /[a-z0-9]/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : 0
      const base = { key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, ...base })
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      if (delay) await sleep(delay)
    }
    await sleep(20)
  }

  // Bloco inteiro de uma vez, como a entrada de um IME: autocompletar e fechar parênteses não atrapalham o programa.
  async insertText(text) {
    await this.send('Input.insertText', { text })
    await sleep(40)
  }

  // Arquivo de verdade no seletor de arquivos: o React recebe o mesmo change de quem escolhe no diálogo.
  async setFile(index, path) {
    const r = await this.send('Runtime.evaluate', { expression: `document.querySelectorAll('input[type=file]')[${index}]` })
    await this.send('DOM.setFileInputFiles', { files: [path], objectId: r.result.objectId })
  }

  async shot(name) {
    const dir = this.person.shotsDir
    if (!dir) return null
    mkdirSync(dir, { recursive: true })
    const { data } = await withTimeout(this.send('Page.captureScreenshot', { format: 'png' }), 15000, `foto ${name}`)
    const path = join(dir, `${name}.png`)
    writeFileSync(path, Buffer.from(data, 'base64'))
    return path
  }

  async close() {
    this.person.tabs = this.person.tabs.filter((t) => t !== this)
    await this.cdp.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {})
  }
}

// Uma pessoa: contexto próprio, com disco, cookies e service worker separados dos outros.
export class Person {
  constructor(browser, name, contextId, { shotsDir, typeDelay } = {}) {
    this.browser = browser
    this.name = name
    this.contextId = contextId
    this.shotsDir = shotsDir
    this.typeDelay = typeDelay
    this.tabs = []
    this.inits = []
    this.bindings = []
    this.blocked = []
  }

  static async create(browser, name, opts = {}) {
    const { browserContextId } = await browser.cdp.send('Target.createBrowserContext', { disposeOnDetach: false })
    return new Person(browser, name, browserContextId, opts)
  }

  async setPermission(origin, name, setting) {
    await this.browser.cdp.send('Browser.setPermission', { browserContextId: this.contextId, origin, permission: { name }, setting })
  }

  async tab(url, { boot = {}, newWindow = false } = {}) {
    const { targetId } = await this.browser.cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: this.contextId, ...(newWindow ? { newWindow: true } : {}) })
    const { sessionId } = await this.browser.cdp.send('Target.attachToTarget', { targetId, flatten: true })
    const t = new Tab(this, targetId, sessionId)
    await t.boot(boot)
    for (const b of this.bindings) await t.send('Runtime.addBinding', { name: b })
    for (const source of this.inits) await t.send('Page.addScriptToEvaluateOnNewDocument', { source })
    if (this.blocked.length) await t.send('Network.setBlockedURLs', { urls: this.blocked })
    this.tabs.push(t)
    if (url) await t.navigate(url)
    return t
  }

  async block(urls) {
    this.blocked = urls
    for (const t of this.tabs) await t.send('Network.setBlockedURLs', { urls })
  }

  async unblock() {
    this.blocked = []
    for (const t of this.tabs) await t.send('Network.setBlockedURLs', { urls: [] })
  }
}
