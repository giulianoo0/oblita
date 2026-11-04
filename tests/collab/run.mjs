// Abre dois integrantes num Edge sem janela e usa teclado e mouse de verdade via CDP.
// Uso: node tests/collab/run.mjs [--shots=pasta]
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAC = process.platform === 'darwin'
// Edge no Windows, Chrome fora dele; BROWSER troca o executável.
const EDGE = process.env.BROWSER ?? (process.platform === 'win32' ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : MAC ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome')
const SHOTS = process.argv.find((a) => a.startsWith('--shots='))?.split('=')[1]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const freePort = () =>
  new Promise((res, rej) => {
    const srv = createServer()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => res(port))
    })
  })

let vite, edge, userDir
const killTree = (p) => {
  if (!p?.pid || p.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' })
  else p.kill('SIGKILL')
}
async function cleanup() {
  killTree(edge)
  killTree(vite)
  for (let i = 0; i < 10 && userDir && existsSync(userDir); i++) {
    try {
      rmSync(userDir, { recursive: true, force: true })
    } catch {
      await sleep(400)
    }
  }
}

async function startVite() {
  const port = await freePort()
  vite = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', join(ROOT, 'tests', 'collab', 'vite.config.ts'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  vite.stdout.on('data', (d) => (log += d))
  vite.stderr.on('data', (d) => (log += d))
  const url = `http://127.0.0.1:${port}`
  for (let i = 0; i < 120; i++) {
    if (vite.exitCode !== null) throw new Error(`vite saiu: ${log}`)
    try {
      if ((await fetch(`${url}/tests/collab/index.html`)).ok) return url
    } catch {}
    await sleep(500)
  }
  throw new Error(`vite não subiu: ${log}`)
}

async function startEdge() {
  userDir = mkdtempSync(join(tmpdir(), 'oblita-collab-'))
  edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDir}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' })
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

class Cdp {
  static async open(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => {
      ws.onopen = res
      ws.onerror = () => rej(new Error('WebSocket falhou'))
    })
    return new Cdp(ws)
  }
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
        if (m.error) w?.rej(new Error(m.error.message))
        else w?.res(m.result)
      } else this.handlers.get(m.method)?.forEach((h) => h(m.params))
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
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), fn])
  }
}

let page
const pageErrors = []

async function ev(expr) {
  const r = await page.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.exceptionDetails) throw new Error(`${expr}\n${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  return r.result.value
}
const pf = (p) => `document.getElementById('${p}').contentWindow`
const t = (p, expr) => ev(`((w) => { const t = w.__t; const document = w.document; const getComputedStyle = w.getComputedStyle.bind(w); return (${expr}) })(${pf(p)})`)

// ---- mouse e teclado de verdade: entram pelo navegador, passam pelo foco e pelos atalhos do Monaco
async function frameOrigin(p) {
  return ev(`(() => { const r = document.getElementById('${p}').getBoundingClientRect(); return { x: r.left, y: r.top } })()`)
}
async function mouse(type, x, y, extra = {}) {
  await page.send('Input.dispatchMouseEvent', { type, x, y, ...extra })
}
async function click(x, y) {
  await mouse('mouseMoved', x, y)
  await mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 })
  await mouse('mouseReleased', x, y, { button: 'left', clickCount: 1 })
  await sleep(40)
}
async function clickAt(p, line, column) {
  const o = await frameOrigin(p)
  const r = await t(p, `t.relative(${line}, ${column})`)
  await click(o.x + r.x, o.y + r.y)
}
async function clickSel(p, selector) {
  const o = await frameOrigin(p)
  const r = await t(p, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('sem ' + ${JSON.stringify(selector)}); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
  await click(o.x + r.x, o.y + r.y)
}
async function centerOf(p, selector) {
  const o = await frameOrigin(p)
  const r = await t(p, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('sem ' + ${JSON.stringify(selector)}); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
  return { x: o.x + r.x, y: o.y + r.y }
}
async function dblClick(x, y) {
  await mouse('mouseMoved', x, y)
  await mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 })
  await mouse('mouseReleased', x, y, { button: 'left', clickCount: 1 })
  await mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 2 })
  await mouse('mouseReleased', x, y, { button: 'left', clickCount: 2 })
  await sleep(60)
}
// Arrasta de verdade, em passos; sem `release` o botão fica apertado no fim.
async function dragTo(from, to, { release = true, steps = 8 } = {}) {
  await mouse('mouseMoved', from.x, from.y)
  await mouse('mousePressed', from.x, from.y, { button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, { button: 'left', buttons: 1 })
    await sleep(16)
  }
  await sleep(60)
  if (release) {
    await mouse('mouseReleased', to.x, to.y, { button: 'left', clickCount: 1 })
    await sleep(60)
  }
}
async function clickFile(p, name) {
  await clickSel(p, `.file[title="${name}"] .file-name`)
  await sleep(60)
}
// No Mac o Monaco usa Cmd onde o Windows usa Ctrl.
const CTRL = MAC ? 4 : 2
const SHIFT = 8
async function press(key, modifiers = 0, code = `Key${key.toUpperCase()}`, vk = key.toUpperCase().charCodeAt(0)) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await sleep(30)
}
const undo = () => press('z', CTRL)
const redoY = () => press('y', CTRL)
const redoZ = () => press('z', CTRL | SHIFT)
const enter = async () => {
  const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...base })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await sleep(30)
}
async function type(text) {
  for (const ch of text) {
    const vk = /[a-z0-9]/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : 0
    const base = { key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, ...base })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }
  await sleep(30)
}
const settle = (ms = 80) => sleep(ms)
// Pausa maior que o captureTimeout: o próximo trecho vira um passo próprio de desfazer.
const newStep = () => sleep(480)

// Com `frame`, só aquele integrante sai na imagem.
async function shot(name, frame) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  const clip = frame && (await ev(`(() => { const r = document.getElementById('${frame}').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, scale: 1 } })()`))
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) })
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'))
}

// ---- relatório
let failed = 0
let passed = 0
function check(name, ok, detail) {
  if (ok) passed++
  else failed++
  console.log(`${ok ? 'ok  ' : 'FALHOU'} ${name}${!ok && detail !== undefined ? `\n       ${JSON.stringify(detail)}` : ''}`)
}
const main = (p, q = 'q1', f = 'main.cpp') => t(p, `t.text('${q}', '${f}')`)
async function converged(q = 'q1', f = 'main.cpp') {
  await settle()
  const [a, b, ma, mb] = await Promise.all([main('a', q, f), main('b', q, f), t('a', 't.modelText()'), t('b', 't.modelText()')])
  return { ok: a === b, a, b, ma, mb }
}
async function reset() {
  // Volta ao estado semeado sem depender de desfazer, para um teste não contaminar o próximo.
  await t('a', `(() => { const y = t.session.doc.files('q1').get('main.cpp'); y.doc.transact(() => { y.delete(0, y.length); y.insert(0, window.parent.__host.STARTERS.q1) }) })()`)
  await settle()
}

async function run() {
  const url = await startVite()
  const debugPort = await startEdge()
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json()
  page = await Cdp.open(target.webSocketDebuggerUrl)
  page.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
    const text = d.exception?.description ?? d.text
    if (!/^Canceled: Canceled/.test(text)) pageErrors.push(text)
  })
  page.on('Runtime.consoleAPICalled', ({ type: kind, args }) => {
    if (kind === 'error') pageErrors.push(`console.error: ${args.map((a) => a.value ?? a.description).join(' ')}`)
    if (kind === 'warning' && args.some((a) => /Yjs was already imported/.test(a.value ?? ''))) pageErrors.push('Yjs duplicado')
  })
  // A prova avisa antes de sair da página: é o trocar de tela do teste que confirma.
  page.on('Page.javascriptDialogOpening', () => void page.send('Page.handleJavaScriptDialog', { accept: true }))
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.send('Emulation.setDeviceMetricsOverride', { width: 2010, height: 900, deviceScaleFactor: 1, mobile: false })
  await page.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: url }).catch(() => {})
  await page.send('Page.navigate', { url: `${url}/tests/collab/index.html` })
  for (let i = 0; i < 400; i++) {
    const ready = await ev('!!window.__host?.ready').catch(() => false)
    if (ready) break
    if (i === 399) throw new Error(`não carregou: ${JSON.stringify(pageErrors)}`)
    await sleep(250)
  }
  for (let i = 0; i < 200; i++) {
    if ((await t('a', '!!t.editor()?.getModel()')) && (await t('b', '!!t.editor()?.getModel()'))) break
    await sleep(100)
  }
  await sleep(400)

  // ---- semente e fim de linha
  const seeded = await converged()
  check('os dois recebem a semente', seeded.ok && seeded.a === seeded.ma && seeded.a.startsWith('int main'), seeded)
  check('modelo em LF no Windows', (await t('a', 't.modelEol()')) === '\n')
  await shot('01-sala')

  // ---- rótulo do colega: inteiro enquanto mexe, só a inicial parado; e onde cada um está
  await clickAt('a', 2, 5)
  await type('x')
  await settle(200)
  const aLabel = () => t('b', `(() => { const h = document.querySelector('[class*="yRemoteSelectionHead-"]'); return h && getComputedStyle(h, '::after').content })()`)
  const busy = await aLabel()
  await shot('01b-colega-digitando')
  await sleep(2900)
  const idle = await aLabel()
  check('nome inteiro enquanto o colega mexe, só a inicial parado', busy === '"Ana"' && idle === '"A"', { busy, idle })
  await shot('01c-colega-parado')
  const dots = await t('b', `({ file: document.querySelectorAll('.file .peer-dots i').length, tab: document.querySelectorAll('.exam-tab .peer-dots i').length, where: document.querySelector('.peer')?.title })`)
  check('o colega aparece na aba da questão e no arquivo em que está', dots.file === 1 && dots.tab === 1 && /questão 1 · main\.cpp/.test(dots.where ?? ''), dots)
  await reset()

  // ---- digitação concorrente, com a rede parada
  await ev('window.__host.pause()')
  await clickAt('a', 1, 1)
  await type('aaa')
  await clickAt('b', 3, 2)
  await type('bbb')
  await clickAt('a', 2, 5)
  await type('AA')
  await clickAt('b', 2, 5)
  await type('BB')
  await ev('window.__host.resume()')
  let c = await converged()
  check('digitação concorrente converge', c.ok && c.ma === c.a && c.mb === c.a && /aaa/.test(c.a) && /bbb/.test(c.a) && /AA/.test(c.a) && /BB/.test(c.a), c)
  await reset()

  // ---- desfazer só o que é seu
  await newStep()
  await clickAt('a', 2, 5)
  await type('XX')
  await newStep()
  await clickAt('b', 2, 6)
  await type('Y')
  await newStep()
  await clickAt('a', 3, 2)
  await undo()
  c = await converged()
  check('Ctrl+Z de A tira só o texto de A', c.ok && !c.a.includes('XX') && c.a.includes('Y') && c.ma === c.a && c.mb === c.a, c)
  const afterUndo = await t('a', `t.editor().getPosition().lineNumber`)
  check('o cursor vai para onde o desfazer mexeu', afterUndo === 2, afterUndo)
  await redoY()
  c = await converged()
  check('Ctrl+Y refaz', c.ok && c.a.includes('X') && c.a.includes('Y') && c.a.replace(/[XY]/g, '') === (await ev('window.__host.STARTERS.q1')), c)
  const full = c.a
  let stable = true
  for (let i = 0; i < 4; i++) {
    await undo()
    const u = await converged()
    stable &&= u.ok && !u.a.includes('X') && u.a.includes('Y')
    if (i % 2) await redoY()
    else await redoZ()
    const r = await converged()
    stable &&= r.ok && r.a === full
  }
  check('desfazer e refazer repetidos são estáveis, com Ctrl+Y e Ctrl+Shift+Z', stable)
  for (let i = 0; i < 15; i++) await undo()
  c = await converged()
  check('Ctrl+Z demais nunca passa do que A escreveu', c.ok && c.a.includes('Y') && !c.a.includes('X') && c.a.includes('int main') && c.a.includes('return 0'), c)
  await clickAt('b', 1, 1)
  for (let i = 0; i < 15; i++) await undo()
  c = await converged()
  check('B desfaz o dele e não apaga a semente', c.ok && c.a === (await ev('window.__host.STARTERS.q1')), c)

  // Texto do colega no meio do meu, e colega digitando enquanto desfaço.
  await newStep()
  await clickAt('a', 2, 5)
  await type('foo')
  await newStep()
  await clickAt('b', 2, 7)
  await type('Q')
  await newStep()
  await clickAt('a', 3, 2)
  await undo()
  c = await converged()
  check('desfazer em volta do texto do colega deixa o dele', c.ok && c.a.includes('Q') && !c.a.includes('fo') && !c.a.includes('oo'), c)
  await reset()

  // ---- cursor local diante de edição remota
  await clickAt('a', 2, 12)
  await clickAt('b', 2, 5)
  await type('ZZ')
  await settle()
  let pos = await t('a', `(() => { const p = t.editor().getPosition(); return [p.lineNumber, p.column] })()`)
  check('edição remota antes do cursor empurra o cursor', pos[0] === 2 && pos[1] === 14, pos)
  await t('b', `(() => { const y = t.session.doc.files('q1').get('main.cpp'); y.insert(0, '// a\\n// b\\n') })()`)
  await settle()
  pos = await t('a', `(() => { const p = t.editor().getPosition(); return [p.lineNumber, p.column] })()`)
  check('linhas remotas acima mantêm o cursor no mesmo texto', pos[0] === 4 && pos[1] === 14, pos)
  await t('a', `t.editor().setSelection({ startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 4 })`)
  await t('b', `(() => { const y = t.session.doc.files('q1').get('main.cpp'); y.delete(0, 5) })()`)
  await settle()
  const sel = await t('a', `t.editor().getModel().getValueInRange(t.editor().getSelection())`)
  check('seleção local segue o texto selecionado', sel === 'int', sel)
  await reset()

  // ---- cursores com nome e nome hostil
  await t('b', `t.session.awareness.setLocalStateField('user', { name: window.parent.__host.HOSTILE })`)
  await clickAt('b', 2, 5)
  await sleep(150)
  const bId = await t('b', 't.session.awareness.clientID')
  const caret = () =>
    t('a', `(() => {
      const head = document.querySelector('.yRemoteSelectionHead-${bId}')
      const style = document.querySelector('style[data-collab]')
      const after = head && getComputedStyle(head, '::after')
      return {
        head: !!head,
        content: after?.content,
        events: after?.pointerEvents,
        rules: style?.sheet.cssRules.length,
        raw: style?.textContent,
        body: getComputedStyle(document.body).display,
        root: document.getElementById('root').getBoundingClientRect().height,
        chips: [...document.querySelectorAll('.peer')].map((e) => e.title),
        border: head && getComputedStyle(head).borderLeftWidth,
      }
    })()`)
  let cs = await caret()
  check('o cursor do colega aparece com o nome', cs.head && cs.content?.includes('body{display:none}'), cs)
  check('nome hostil é texto inerte: o body continua visível e são só 3 regras', cs.body !== 'none' && cs.root > 100 && cs.rules === 3, cs)
  check('o rótulo não recebe clique', cs.events === 'none', cs)
  check('o colega aparece no cabeçalho', cs.chips.length === 1 && cs.chips[0].includes('display:none'), cs)
  await shot('02-cursor-hostil')
  await t('b', `t.session.awareness.setLocalStateField('user', { name: 'a\\\\"\\n</style><img src=x onerror=alert(1)>}*{display:none}' })`)
  await settle(150)
  cs = await caret()
  const img = await t('a', `document.querySelectorAll('img').length`)
  check('barra, aspas, quebra de linha e tag não escapam', cs.rules === 3 && cs.body !== 'none' && img === 0 && !cs.raw.includes('</style>') && !cs.raw.includes('\n'), cs)
  check('o nome é cortado em 24 caracteres', [...cs.chips[0].split(' · ')[0]].length <= 24, cs.chips)
  await t('b', `t.session.awareness.setLocalStateField('user', { name: 'Bruno' })`)
  await t('b', `t.session.awareness.setLocalStateField('selection', { anchor: {}, head: { item: 'x' } })`)
  await settle(150)
  await clickAt('a', 1, 1)
  await type('k')
  c = await converged()
  check('cursor malformado de um cliente adulterado não derruba ninguém', c.ok && c.a.startsWith('k'), { c, pageErrors })
  await clickAt('b', 2, 5)
  await settle(150)
  await t('a', `t.removeAware([${bId}])`)
  await settle(100)
  cs = await caret()
  check('quem sai some: regra CSS, cursor e colega', cs.rules === 0 && !cs.head && cs.chips.length === 0, cs)
  await clickAt('b', 2, 6)
  await settle(150)
  cs = await caret()
  check('quem volta aparece de novo', cs.head && cs.rules === 3, cs)
  await reset()

  // ---- arquivos e desfazer ao trocar de arquivo
  await clickSel('a', '[aria-label="Novo arquivo"]')
  await type('util')
  await enter()
  await settle(150)
  check('novo arquivo pela tela chega ao colega e abre', (await t('b', `t.names('q1').join()`)) === 'main.cpp,util.cpp' && (await t('a', 't.file()')) === 'util.cpp')
  check('Enter em arquivo vazio não cria CRLF', await (async () => {
    await clickSel('a', '.editor-mount')
    await enter()
    await settle()
    return (await main('b', 'q1', 'util.cpp')) === '\n'
  })(), await main('b', 'q1', 'util.cpp'))
  await newStep()
  await type('UTIL')
  await newStep()
  await clickFile('a', 'main.cpp')
  await clickAt('a', 1, 1)
  await type('MAIN')
  await newStep()
  await clickFile('a', 'util.cpp')
  await clickFile('a', 'main.cpp')
  await undo()
  await settle()
  check('Ctrl+Z depois de trocar de arquivo desfaz o arquivo aberto', !(await main('a')).includes('MAIN') && (await main('a', 'q1', 'util.cpp')).includes('UTIL'))
  await redoY()
  await settle()
  check('Ctrl+Y depois de trocar de arquivo refaz', (await main('b')).includes('MAIN'))
  await clickFile('a', 'util.cpp')
  await undo()
  await settle()
  check('o histórico do outro arquivo sobreviveu à troca', !(await main('b', 'q1', 'util.cpp')).includes('UTIL') && (await main('b')).includes('MAIN'))
  await redoY()
  await settle()
  check('e refaz', (await main('b', 'q1', 'util.cpp')).includes('UTIL'))
  await clickFile('b', 'main.cpp')
  await clickAt('b', 2, 5)
  await settle(120)
  await clickFile('a', 'main.cpp')
  await settle(120)
  check('o cursor do colega volta ao reabrir o arquivo', (await caret()).head)
  await reset()

  // ---- ficar sem o arquivo aberto
  await clickFile('a', 'util.cpp')
  await t('b', `t.session.doc.removeFile('q1', 'util.cpp')`)
  await settle(150)
  check('apagado pelo colega: troca para outro arquivo', (await t('a', 't.file()')) === 'main.cpp' && (await t('a', `t.editor().getModel().uri.path`)).endsWith('main.cpp'))
  check('e o modelo foi embora', (await t('a', `t.monaco.editor.getModels().filter((m) => m.uri.path.endsWith('util.cpp')).length`)) === 0)
  await clickAt('a', 1, 1)
  await type('ok')
  c = await converged()
  check('e continua editando', c.ok && c.a.startsWith('ok'), c)
  await reset()

  await t('a', `t.session.doc.addFile('q1', 'velho.cpp', 'um\\ndois\\ntres\\n')`)
  await settle(100)
  await clickFile('a', 'velho.cpp')
  await clickAt('a', 2, 3)
  await t('b', `t.session.doc.renameFile('q1', 'velho.cpp', 'novo.cpp')`)
  await settle(150)
  pos = await t('a', `(() => { const p = t.editor().getPosition(); return [p.lineNumber, p.column] })()`)
  check('renomeado pelo colega: vai junto, com o cursor no lugar', (await t('a', 't.file()')) === 'novo.cpp' && pos[0] === 2 && pos[1] === 3, pos)
  await type('u')
  await settle()
  check('e edita no arquivo novo', (await main('b', 'q1', 'novo.cpp')).includes('douis'))
  await t('b', `t.session.doc.removeFile('q1', 'novo.cpp')`)
  await settle(120)

  // Mesmo nome criado ao mesmo tempo: o Y.Text perdedor some por baixo da chave.
  await ev('window.__host.pause()')
  await t('a', `t.session.doc.addFile('q1', 'dup.cpp', 'de A')`)
  await t('b', `t.session.doc.addFile('q1', 'dup.cpp', 'de B')`)
  await settle()
  await clickFile('a', 'dup.cpp')
  await clickFile('b', 'dup.cpp')
  await ev('window.__host.resume()')
  await settle(150)
  const dup = await converged('q1', 'dup.cpp')
  check('mesmo nome ao mesmo tempo converge, com o editor ligado ao texto vencedor', dup.ok && dup.ma === dup.a && dup.mb === dup.a, dup)
  await clickAt('a', 1, 1)
  await type('z')
  const dup2 = await converged('q1', 'dup.cpp')
  check('e a edição seguinte chega ao colega', dup2.ok && dup2.a.startsWith('z') && dup2.mb === dup2.a, dup2)
  await t('b', `t.session.doc.removeFile('q1', 'dup.cpp')`)
  await settle(120)

  await t('b', `t.session.doc.removeFile('q1', 'main.cpp')`)
  await settle(150)
  check('sem nenhum arquivo o editor fica vazio, sem erro', (await t('a', 't.file()')) === '' && (await t('a', `t.editor().getModel()`)) === null)
  await t('b', `t.session.doc.addFile('q1', 'main.cpp', window.parent.__host.STARTERS.q1)`)
  await settle(150)
  check('e volta quando alguém cria de novo', (await t('a', 't.file()')) === 'main.cpp' && (await t('a', 't.modelText()')).includes('int main'))

  // ---- pastas
  await clickSel('a', '[aria-label="Nova pasta"]')
  await type('lib')
  await enter()
  await settle(150)
  check('pasta nova pela tela chega ao colega', (await t('b', `t.session.doc.folders('q1').join()`)) === 'lib' && (await t('b', `!!document.querySelector('.file.folder[title="lib"]')`)))
  await clickSel('a', '[aria-label="Novo arquivo em lib"]')
  await type('util.h')
  await enter()
  await settle(150)
  check('arquivo dentro da pasta chega ao colega, e o header nasce com #pragma once', (await t('b', `t.names('q1').join()`)) === 'lib/util.h,main.cpp' && (await main('b', 'q1', 'lib/util.h')) === '#pragma once\n' && (await t('a', 't.file()')) === 'lib/util.h')
  const level = await t('b', `document.querySelector('.file[title="lib/util.h"]')?.getAttribute('aria-level')`)
  check('na árvore do colega o arquivo fica dentro da pasta', level === '2', level)
  await clickFile('b', 'lib/util.h')
  await clickAt('b', 1, 1)
  await shot('07-arvore')
  await clickSel('a', '.file[title="lib"] .file-name')
  await settle()
  check('clicar na pasta recolhe', (await t('a', `!document.querySelector('.file[title="lib/util.h"]') && document.querySelector('.file[title="lib"]').getAttribute('aria-expanded') === 'false'`)))
  await clickSel('a', '.file[title="lib"] .file-name')
  // Dois arquivos na pasta: quem está num deles precisa ir para o mesmo, não para o vizinho.
  await t('b', `t.session.doc.addFile('q1', 'lib/outro.h', '')`)
  await settle()
  await t('a', `document.querySelector('.file[title="lib"]').focus()`)
  await press('F2', 0, 'F2', 113)
  await settle()
  await type('src')
  await shot('07b-renomear')
  await enter()
  await settle(150)
  check('pasta renomeada com F2 chega ao colega, com o texto', (await t('b', `t.names('q1').join()`)) === 'main.cpp,src/outro.h,src/util.h' && (await main('b', 'q1', 'src/util.h')) === '#pragma once\n')
  check('quem estava no arquivo vai junto, dos dois lados', (await t('a', 't.file()')) === 'src/util.h' && (await t('b', 't.file()')) === 'src/util.h', [await t('a', 't.file()'), await t('b', 't.file()')])
  await t('a', `t.session.doc.addFile('q1', 'src/io/ler.cpp', '')`)
  await settle(100)
  await clickSel('b', '[aria-label="Apagar src"]')
  await settle(300)
  const confirm = await t('b', `document.querySelector('.modal')?.textContent ?? ''`)
  check('apagar pasta pede confirmação com quantos arquivos', /Apagar src\?/.test(confirm) && /Os 3 arquivos/.test(confirm), confirm)
  await shot('07c-apagar-pasta')
  await clickSel('b', '.modal .pill.danger')
  await settle(300)
  check('pasta apagada pelo colega some com o que estava dentro', (await t('a', `t.names('q1').join()`)) === 'main.cpp' && (await t('a', `t.session.doc.folders('q1').length`)) === 0 && (await t('a', 't.file()')) === 'main.cpp')
  check('o único arquivo de código não pode ser apagado', (await t('a', `document.querySelector('[aria-label="Apagar main.cpp"]').disabled`)) === true)

  // Rodar de verdade: o clang do navegador compila e linka o .cpp da subpasta.
  await t('a', `(() => {
    const d = t.session.doc
    d.addFile('q1', 'lib/util.h', '#pragma once\\nint dobro(int x);\\n')
    d.addFile('q1', 'lib/util.cpp', '#include "util.h"\\nint dobro(int x) { return 2 * x; }\\n')
    const y = d.files('q1').get('main.cpp')
    y.doc.transact(() => { y.delete(0, y.length); y.insert(0, '#include <cstdio>\\n#include "lib/util.h"\\nint main() { printf("%d\\\\n", dobro(21)); }\\n') })
  })()`)
  await settle(150)
  // O primeiro worker de execução do Vite às vezes não sobe a tempo ("não pôde ser iniciado"): uma segunda vez.
  let ran
  for (let attempt = 0; attempt < 2; attempt++) {
    await clickSel('a', '[title="Rodar (Ctrl+Enter)"]')
    for (let i = 0; i < 360; i++) {
      ran = await t('a', `({ ...t.session.runOutput, main: t.text('q1', 'main.cpp'), names: t.names('q1').join() })`)
      if (ran.state === 'done' || ran.state === 'compile-error') break
      await sleep(250)
    }
    if (ran.error !== 'O programa não pôde ser iniciado') break
  }
  check('Rodar compila e linka o projeto com subpasta', ran.state === 'done' && ran.stdout === '42\n', ran)
  await clickFile('a', 'main.cpp')
  await clickAt('a', 4, 1)
  await type('#include "')
  await settle(500)
  const sug = await t('a', `[...document.querySelectorAll('.suggest-widget .monaco-list-row')].map((e) => e.getAttribute('aria-label') ?? e.textContent).join('|')`)
  check('o #include sugere o header da subpasta, com o caminho', /lib\/util\.h/.test(sug), sug)
  await press('Escape', 0, 'Escape', 27)
  await t('b', `t.session.doc.removeFolder('q1', 'lib')`)
  await reset()

  // ---- vazamento
  const base = await t('a', 't.listeners()')
  for (let i = 0; i < 10; i++) {
    await t('b', `t.session.doc.addFile('q1', 'f${i}.cpp', 'x')`)
    await settle(20)
    await t('b', `t.session.doc.removeFile('q1', 'f${i}.cpp')`)
    await settle(20)
  }
  let later = await t('a', 't.listeners()')
  check('criar e apagar arquivos não acumula ouvintes nem modelos', JSON.stringify(base) === JSON.stringify(later), { base, later })

  // ---- Ctrl+S
  await clickAt('a', 1, 1)
  await t('a', `(() => { w.__saved = []; w.addEventListener('keydown', (e) => e.key === 's' && setTimeout(() => w.__saved.push(e.defaultPrevented)), true) })()`)
  const beforeSave = await main('a')
  const nodes = await t('a', 'document.querySelectorAll("*").length')
  await press('s', CTRL)
  await settle(120)
  check('Ctrl+S não faz nada e não mostra nada', (await t('a', 'w.__saved[0]')) === true && (await main('a')) === beforeSave && (await t('a', 'document.querySelectorAll("*").length')) === nodes)

  // ---- passar por questão sem código desmonta o editor
  await newStep()
  await clickAt('a', 1, 1)
  await type('PRIMEIRO')
  await newStep()
  await type('SEGUNDO')
  await newStep()
  const mounted = await t('a', 't.listeners()')
  await clickSel('a', '.exam-tab:nth-child(4)')
  await settle(150)
  check('questão de texto desmonta: sem estilo e sem editor', (await t('a', 't.listeners().styles')) === 0 && (await t('a', 't.monaco.editor.getEditors().length')) === 0, await t('a', 't.monaco.editor.getEditors().length'))
  await t('b', `t.session.doc.files('q1').get('main.cpp').insert(0, 'REMOTO ')`)
  await settle()
  await clickSel('a', '.exam-tab:nth-child(1)')
  await settle(200)
  later = await t('a', 't.listeners()')
  check('voltar não acumula nada', later.styles === 1 && later.editors === 1 && later.models === mounted.models && later.cursor === mounted.cursor && later.awareness === mounted.awareness && later.before === mounted.before && later.after === mounted.after, { mounted, later })
  check('o modelo pega o que mudou enquanto estava fechado', (await t('a', 't.modelText()')).startsWith('REMOTO '))
  await clickAt('a', 3, 1)
  await undo()
  await settle()
  c = await converged()
  check('o desfazer sobrevive e o atalho dispara uma vez só', c.ok && c.a.includes('PRIMEIRO') && !c.a.includes('SEGUNDO') && c.a.includes('REMOTO') && c.ma === c.a, c)
  await undo()
  await settle()
  await reset()

  // ---- linguagem
  await clickSel('a', '.exam-tab:nth-child(2)')
  await clickSel('b', '.exam-tab:nth-child(2)')
  await settle(200)
  await clickSel('a', '.editor-tabs .segmented button:nth-child(2)')
  await settle(200)
  const q2 = await t('b', `({ names: t.names('q2'), lang: t.session.doc.lang('q2'), text: t.text('q2', 'main.c'), file: t.file() })`)
  check('sem editar, trocar para C troca arquivo e modelo inicial nos dois', q2.lang === 'c' && q2.names.join() === 'main.c' && q2.text.includes('stdio.h') && q2.file === 'main.c' && (await t('a', 't.file()')) === 'main.c', q2)
  await clickAt('b', 1, 1)
  await type('//')
  await settle()
  await clickSel('a', '.editor-tabs .segmented button:nth-child(1)')
  await settle(200)
  const q2b = await t('b', `({ names: t.names('q2'), lang: t.session.doc.lang('q2'), text: t.text('q2', 'main.cpp'), file: t.file(), model: t.modelText() })`)
  check('editado, trocar para C++ renomeia e mantém o texto', q2b.lang === 'cpp' && q2b.names.join() === 'main.cpp' && q2b.text.startsWith('//') && q2b.text.includes('stdio.h') && q2b.file === 'main.cpp' && q2b.model === q2b.text, q2b)

  // ---- CRLF vindo do JSON do professor
  await clickSel('a', '.exam-tab:nth-child(3)')
  await clickSel('b', '.exam-tab:nth-child(3)')
  await settle(300)
  const q3 = await converged('q3')
  check('CRLF do modelo inicial vira LF sem duplicar', q3.ok && !q3.a.includes('\r') && q3.a === q3.ma && q3.a === q3.mb && q3.a === (await ev('window.__host.STARTERS.q1')), q3)
  await clickAt('a', 2, 5)
  await type('v')
  const q3b = await converged('q3')
  check('e os offsets batem depois disso', q3b.ok && q3b.a.split('\n')[1] === '    vreturn 0;' && q3b.mb === q3b.a, q3b)
  await t('b', `t.session.doc.files('q3').get('main.cpp').insert(0, 'x\\r\\ny\\r\\n')`)
  await settle(200)
  const q3c = await converged('q3')
  check('CR que chega depois também é limpo', q3c.ok && !q3c.a.includes('\r') && q3c.ma === q3c.a && q3c.mb === q3c.a, q3c)

  // ---- hover
  await clickSel('a', '.exam-tab:nth-child(1)')
  await settle(200)
  const code = ['#include <cmath>', '#include <vector>', 'using namespace std;', 'int main() {', '    vector<int> notas = {7, 8, 9};', '    double r = sqrt(notas[0]);', '    int n = notas.size();', '    vector<double> outra = {1, sqrt(2.0)};', '    return n + (int)r + outra.size();', '}', ''].join('\\n')
  await t('a', `t.session.doc.addFile('q1', 'hover.cpp', '${code}')`)
  await settle(100)
  await clickFile('a', 'hover.cpp')
  const hover = async (line, column) => {
    const o = await frameOrigin('a')
    await mouse('mouseMoved', o.x + 5, o.y + 5)
    await sleep(250)
    const r = await t('a', `t.relative(${line}, ${column})`)
    await mouse('mouseMoved', o.x + r.x + 2, o.y + r.y)
    await sleep(40)
    await mouse('mouseMoved', o.x + r.x + 4, o.y + r.y)
    await sleep(700)
    return t('a', `[...document.querySelectorAll('.monaco-hover:not(.hidden)')].map((e) => e.textContent).join(' | ')`)
  }
  const hSize = await hover(7, 19)
  const hNotas = await hover(7, 13)
  const hSqrt = await hover(6, 17)
  const hSqrt2 = await hover(8, 33)
  console.log('     hover:', JSON.stringify({ hSize, hNotas, hSqrt, hSqrt2 }))
  check('hover em size mostra size', /size/.test(hSize) && !/notas/.test(hSize), hSize)
  check('hover em notas mostra o vetor', /vector<int> notas/.test(hNotas), hNotas)
  check('hover em sqrt mostra sqrt', /sqrt/.test(hSqrt) && !/notas/.test(hSqrt) && !/vector/.test(hSqrt), hSqrt)
  check('hover em sqrt dentro de um inicializador', /sqrt/.test(hSqrt2) && !/vector/.test(hSqrt2), hSqrt2)
  await t('a', `t.session.doc.removeFile('q1', 'hover.cpp')`)
  await settle(100)

  // ---- trocar de documento, como begin() e clear()
  const oldDoc = await t('a', `(() => { w.__old = t.session.doc.doc; return true })()`)
  await t('a', 't.swap()')
  await t('b', 't.swap()')
  await settle(300)
  check('trocar de documento não deixa modelo antigo', oldDoc && (await t('a', 't.monaco.editor.getModels().filter((m) => m.uri.scheme === "file").length')) === 0, await t('a', 't.listeners()'))
  await ev('window.__host.seed()')
  await settle(300)
  await clickAt('a', 1, 1)
  await type('novo')
  c = await converged()
  check('o documento novo funciona', c.ok && c.a.startsWith('novo'), c)
  await newStep()
  await undo()
  c = await converged()
  check('e o desfazer dele também', c.ok && !c.a.includes('novo'), c)
  check('uma folha de estilo só depois da troca', (await t('a', 't.listeners().styles')) === 1)

  // ---- selo e barra do topo
  const top = await t('a', `(() => {
    const beacon = document.querySelector('[data-beacon]').getBoundingClientRect()
    const items = [...document.querySelector('.exam-top').children].map((e) => e.getBoundingClientRect()).filter((r) => r.width)
    const vw = w.innerWidth / 100
    let node = document.querySelector('[data-beacon]').parentElement
    const bad = []
    while (node) {
      const st = getComputedStyle(node)
      if (st.transform !== 'none' || st.filter !== 'none' || st.perspective !== 'none' || st.backdropFilter !== 'none' && st.backdropFilter) bad.push(node.tagName + '.' + node.className)
      node = node.parentElement
    }
    const right = Math.max(...items.map((r) => r.right))
    return { x: beacon.left, y: beacon.top, width: beacon.width, height: beacon.height, vw, right, bad, under: document.elementsFromPoint(beacon.left + 2, beacon.top + 2).map((e) => e.className || e.tagName).slice(0, 3), bodyTop: document.querySelector('.exam-body').getBoundingClientRect().top }
  })()`)
  const chip = await t('a', `(() => { const c = document.querySelector('.fp-chip'); return c && { text: c.textContent, title: c.title } })()`)
  check('barra do topo com o código do professor', chip?.text === 'ABC-123' && chip?.title === 'Código do professor', chip)
  check('selo no canto, em 7vw por 2vw', top.y === 0 && Math.abs(top.width - 7 * top.vw) < 1 && Math.abs(top.height - 2 * top.vw) < 1 && Math.abs(top.x + top.width - top.vw * 100) < 1, top)
  check('nada da barra do topo fica embaixo do selo', top.right <= top.x, top)
  check('nenhum ancestral com transform ou filter', top.bad.length === 0, top)
  check('o corpo da prova começa abaixo do selo', top.bodyTop >= top.height, top)
  await clickSel('a', '.exam-top .pill.brand')
  await sleep(500)
  const modal = await t('a', `(() => {
    const b = document.querySelector('[data-beacon]').getBoundingClientRect()
    const hit = document.createElement('i')
    const z = getComputedStyle(document.querySelector('[data-beacon]')).zIndex
    return { z, modal: getComputedStyle(document.querySelector('.modal-back')).zIndex, hit: !!hit }
  })()`)
  check('o selo fica acima do diálogo de entregar', Number(modal.z) > Number(modal.modal), modal)
  await shot('03-modal')
  await press('Escape', 0, 'Escape', 27)
  await t('a', `document.querySelector('.modal-back') && document.querySelector('.modal [aria-label="Fechar"]').click()`)
  await sleep(400)
  await t('a', `(() => { t.session.status = { ...t.OK, fullscreen: false }; t.refresh() })()`)
  await sleep(300)
  const locked = await t('a', `({ z: Number(getComputedStyle(document.querySelector('[data-beacon]')).zIndex), lock: Number(getComputedStyle(document.querySelector('.lock-screen')).zIndex), vis: getComputedStyle(document.querySelector('[data-beacon]')).visibility, exam: getComputedStyle(document.querySelector('.exam')).visibility })`)
  check('com a prova bloqueada o selo continua na tela', locked.z > locked.lock && locked.vis === 'visible' && locked.exam === 'hidden', locked)
  await shot('04-bloqueada')
  await t('a', `(() => { t.session.status = t.OK; t.refresh() })()`)
  await sleep(200)

  // ---- tela cai no meio da prova: avisa e segue editável
  await t('a', `(() => { t.session.status = { ...t.OK, screen: false }; t.refresh() })()`)
  await sleep(400)
  const dropped = await t('a', `({ lock: !!document.querySelector('.lock-screen'), inert: document.querySelector('.exam').inert, notice: document.querySelector('.exam-notice')?.textContent ?? null, button: [...document.querySelectorAll('.exam-notice button')].map((b) => b.textContent).join() })`)
  check('tela caiu na prova: sem tela de bloqueio', !dropped.lock && dropped.inert === false, dropped)
  check('tela caiu na prova: aviso fixo com compartilhar de novo', /parou de ser compartilhada/.test(dropped.notice ?? '') && /Compartilhar de novo/.test(dropped.button), dropped)
  await shot('04b-tela-caiu')
  await t('a', `t.editor().focus()`)
  await clickAt('a', 1, 1)
  await type('z')
  await settle()
  check('tela caiu na prova: o editor continua editável', (await main('a')).startsWith('z'), await main('a'))
  await t('a', `(() => { const y = t.session.doc.files('q1').get('main.cpp'); y.delete(0, 1) })()`)
  await t('a', `(() => { w.__shared = 0; t.session.shareScreen = async () => { w.__shared++; t.session.status = t.OK; t.refresh(); return true } })()`)
  await clickSel('a', '.exam-notice button')
  await sleep(400)
  const back = await t('a', `({ shared: w.__shared, notice: !!document.querySelector('.exam-notice') })`)
  check('compartilhar de novo pelo aviso volta ao normal', back.shared === 1 && !back.notice, back)

  // ---- blocos: recolher, redimensionar e arrastar, sem tirar o foco do editor
  await clickSel('a', '.exam-tab:nth-child(1)')
  await settle(300)
  const blocks = () => t('a', `Object.fromEntries([...document.querySelectorAll('[data-block]')].map((e) => { const r = e.getBoundingClientRect(); return [e.dataset.block, { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), strip: e.dataset.strip ?? null }] }))`)
  const overlaps = (bl) => Object.values(bl).some((a, i, all) => all.some((b, j) => j > i && Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1))
  // Espera os blocos pararem de deslizar: com a máquina ocupada, a animação passa dos 220 ms.
  const settled = async () => {
    await sleep(120)
    let last = ''
    for (let i = 0; i < 40; i++) {
      const now = JSON.stringify(await t('a', `({ anim: !!document.querySelector('.blk-area[data-animate]'), r: [...document.querySelectorAll('[data-block]')].map((e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] }) })`))
      if (now === last && !JSON.parse(now).anim) return
      last = now
      await sleep(80)
    }
  }
  const frameA = await frameOrigin('a')
  const inA = (bl, id, fx, fy) => ({ x: frameA.x + bl[id].x + bl[id].w * fx, y: frameA.y + bl[id].y + bl[id].h * fy })
  const head = (id) => `[data-block="${id}"] .blk-title`
  const choose = async (text) => {
    await sleep(120)
    const ok = await t('a', `(() => { const b = [...document.querySelectorAll('.popover:not([inert]) .popover-row')].find((e) => e.textContent.trim() === ${JSON.stringify(text)}); b?.click(); return !!b })()`)
    await settled()
    return ok
  }
  await t('a', `w.localStorage.removeItem('oblita.blocks.TESTE.code')`)
  await clickSel('a', '.blk-layout-menu')
  await choose('Restaurar layout padrão')
  const initial = await blocks()
  check('quatro blocos lado a lado, sem sobrepor', Object.keys(initial).sort().join() === 'editor,input,output,statement' && !overlaps(initial), initial)
  await shot('blocos-01-padrao', 'a')

  await clickSel('a', '[data-block="statement"] .blk-toggle')
  await settled()
  let bl = await blocks()
  check('recolher vira uma faixa fina e o vizinho ocupa o lugar', bl.statement.strip === 'v' && bl.statement.w === 40 && bl.editor.x < initial.editor.x && !overlaps(bl), bl)
  await shot('blocos-02-recolhido', 'a')
  await click(inA(bl, 'statement', 0.5, 0.5).x, inA(bl, 'statement', 0.5, 0.5).y)
  await settled()
  bl = await blocks()
  check('clicar na faixa abre de novo', bl.statement.strip === null && bl.statement.w === initial.statement.w, bl)

  const inputHead = await centerOf('a', head('input'))
  await dblClick(inputHead.x, inputHead.y)
  await settled()
  bl = await blocks()
  check('duplo clique no cabeçalho recolhe', bl.input.strip === 'v', bl)
  await clickSel('a', '[data-block="input"] .blk-toggle')
  await settled()

  // Um de cada vez: os blocos deslizam ao recolher, e o clique seguinte mira onde o botão parou.
  for (const id of ['statement', 'input', 'output']) {
    await clickSel('a', `[data-block="${id}"] .blk-toggle`)
    await settled()
  }
  const lastOpen = await t('a', `({ disabled: document.querySelector('[data-block="editor"] .blk-toggle').disabled, open: document.querySelectorAll('[data-block]:not([data-strip])').length })`)
  check('o último bloco aberto não recolhe', lastOpen.disabled === true && lastOpen.open === 1, lastOpen)
  await clickSel('a', '.blk-layout-menu')
  await choose('Restaurar layout padrão')
  check('restaurar o layout padrão volta tudo', JSON.stringify(await blocks()) === JSON.stringify(initial), await blocks())

  // Seleção no editor antes de arrastar: ela tem de sobreviver ao arrasto.
  await t('a', `(() => { w.__ed = t.editor(); t.editor().focus(); t.editor().setSelection(new t.monaco.Selection(1, 1, 2, 4)) })()`)
  const outHead = await centerOf('a', head('output'))
  const below = inA(initial, 'statement', 0.5, 0.88)
  await dragTo(outHead, below, { release: false })
  // A prévia desliza de um destino para o outro: espera ela parar.
  await sleep(250)
  const preview = await t('a', `(() => { const p = document.querySelector('.blk-preview'); if (!p) return null; const r = p.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), drag: document.documentElement.hasAttribute('data-blk-drag') } })()`)
  check('arrastando: prévia do destino embaixo do enunciado', !!preview && preview.drag && Math.abs(preview.x - initial.statement.x) < 2 && preview.y > initial.statement.y + 100 && Math.abs(preview.w - initial.statement.w) < 2, preview)
  await shot('blocos-03-arrastando', 'a')
  await mouse('mouseReleased', below.x, below.y, { button: 'left', clickCount: 1 })
  await settled()
  bl = await blocks()
  check('soltar embaixo divide a coluna', Math.abs(bl.output.x - bl.statement.x) < 2 && bl.output.y > bl.statement.y + bl.statement.h - 1 && bl.output.w === bl.statement.w && !overlaps(bl), bl)
  // A única seleção na página é a do editor (o Chrome mostra a do textarea dele em getSelection).
  const focus = await t('a', `({ same: w.__ed === t.editor(), focus: t.editor().hasTextFocus(), sel: t.editor().getSelection().toString(), text: w.getSelection().toString(), inEditor: t.editor().getModel().getValueInRange(t.editor().getSelection()), drag: document.documentElement.hasAttribute('data-blk-drag'), preview: !!document.querySelector('.blk-preview') })`)
  check('o editor continua o mesmo, com foco e seleção, sem texto selecionado na página', focus.same && focus.focus && focus.sel === '[1,1 -> 2,4]' && (focus.text === '' || focus.text === focus.inEditor) && !focus.drag && !focus.preview, focus)
  await shot('blocos-04-movido-embaixo', 'a')
  const saved = await t('a', `w.localStorage.getItem('oblita.blocks.TESTE.code')`)
  check('o layout fica guardado por prova', !!saved && JSON.parse(saved).v === 1 && /output/.test(saved), saved)

  const moved = await blocks()
  const upper = inA(moved, 'statement', 0.5, 0.2)
  await dragTo(await centerOf('a', head('editor')), upper, { release: false })
  await press('Escape', 0, 'Escape', 27)
  const escaped = await t('a', `({ preview: !!document.querySelector('.blk-preview'), drag: document.documentElement.hasAttribute('data-blk-drag') })`)
  await mouse('mouseReleased', upper.x, upper.y, { button: 'left', clickCount: 1 })
  await settled()
  check('Esc cancela o arrasto', !escaped.preview && !escaped.drag && JSON.stringify(await blocks()) === JSON.stringify(moved), escaped)

  await dragTo(await centerOf('a', head('editor')), { x: frameA.x + 400, y: frameA.y + 8 })
  await settled()
  check('soltar fora da área cancela', JSON.stringify(await blocks()) === JSON.stringify(moved), await blocks())
  await dragTo(await centerOf('a', head('editor')), { x: frameA.x + 1300, y: frameA.y + 300 })
  await settled()
  const outside = await t('a', `({ drag: document.documentElement.hasAttribute('data-blk-drag'), dragging: document.querySelectorAll('[data-dragging]').length })`)
  check('soltar fora da janela cancela e não deixa estado preso', JSON.stringify(await blocks()) === JSON.stringify(moved) && !outside.drag && outside.dragging === 0, outside)

  await clickSel('a', '[data-block="statement"] .blk-menu')
  const swapped = await choose('Trocar com Código')
  bl = await blocks()
  check('pelo teclado: menu do bloco troca com outro', swapped && bl.statement.x === moved.editor.x && bl.editor.x === moved.statement.x && bl.editor.w === moved.statement.w, bl)
  await clickSel('a', '[data-block="input"] .blk-menu')
  await sleep(120)
  const focusedItem = await t('a', `document.activeElement?.classList.contains('popover-row')`)
  await choose('Mover para baixo')
  const nudged = await blocks()
  // A entrada já estava embaixo na coluna dela: vai para baixo de tudo, de ponta a ponta.
  check('pelo teclado: o menu recebe o foco e move para baixo', focusedItem && nudged.input.w > bl.input.w + 100 &&nudged.input.y >= bl.input.y - 1 && !overlaps(nudged), { focusedItem, before: bl.input, after: nudged.input })
  await clickSel('a', '.blk-layout-menu')
  await choose('Restaurar layout padrão')

  const divider = await centerOf('a', '[data-divider=":0"]')
  await dragTo(divider, { x: divider.x + 100, y: divider.y })
  await settled()
  bl = await blocks()
  check('a divisória redimensiona os dois vizinhos', Math.abs(bl.statement.w - initial.statement.w - 100) <= 2 && Math.abs(bl.editor.x - initial.editor.x - 100) <= 2, bl)
  await dragTo(await centerOf('a', '[data-divider=":0"]'), { x: frameA.x + 5000, y: divider.y })
  await settled()
  const widest = await blocks()
  check('e para no limite dos blocos', widest.statement.w <= 560 && widest.editor.w >= 300, widest)
  const d2 = await centerOf('a', '[data-divider=":0"]')
  await dblClick(d2.x, d2.y)
  await settled()
  check('duplo clique na divisória volta ao tamanho padrão', (await blocks()).statement.w === initial.statement.w, await blocks())
  await t('a', `document.querySelector('[data-divider=":0"]').focus()`)
  await press('ArrowRight', 0, 'ArrowRight', 39)
  await settled()
  check('divisória pelo teclado: setas', (await blocks()).statement.w === initial.statement.w + 16, await blocks())
  await press('Enter', 0, 'Enter', 13)
  await settled()

  await t('a', `w.localStorage.setItem('oblita.blocks.TESTE.code', '{"v":1,"root":{"type":"block","id":"velho"},"collapsed":[]}')`)
  await clickSel('a', '.exam-tab:nth-child(4)')
  await settle(200)
  const textBlocks = await blocks()
  check('questão de texto: enunciado e resposta como blocos', Object.keys(textBlocks).sort().join() === 'answer,statement', textBlocks)
  await clickSel('a', '.exam-tab:nth-child(1)')
  await settle(300)
  check('layout salvo inválido cai no padrão', JSON.stringify(await blocks()) === JSON.stringify(initial), await blocks())
  await t('a', `w.localStorage.removeItem('oblita.blocks.TESTE.code')`)

  // ---- tela estreita
  const widths = [[900, 640], [560, 700]]
  for (const [width, height] of widths) {
    await ev(`(() => { const f = document.getElementById('a'); f.style.width = '${width}px'; f.style.height = '${height}px' })()`)
    await sleep(500)
    const box = await t('a', `(() => {
      const m = document.querySelector('.editor-mount').getBoundingClientRect()
      const e = document.querySelector('.exam')
      return { mount: m.height, width: m.width, st: document.querySelector('.exam-statement').getBoundingClientRect().height, scrolls: e.scrollHeight > e.clientHeight, horizontal: e.scrollWidth > e.clientWidth, consoleH: document.querySelector('[data-block="output"]').getBoundingClientRect().height }
    })()`)
    check(`em ${width}x${height} o editor não colapsa`, box.mount >= 300 && box.width >= 200 && box.st >= 100 && box.consoleH >= 200 && !box.horizontal, box)
    await shot(`05-estreita-${width}`)
    await t('a', `t.editor().layout()`)
    await clickAt('a', 1, 1)
    await type('w')
    await settle()
    check(`e digita em ${width}px`, (await main('a')).startsWith('w'), await main('a'))
    await t('a', `(() => { const y = t.session.doc.files('q1').get('main.cpp'); y.delete(0, 1) })()`)
  }
  await ev(`(() => { const f = document.getElementById('a'); f.style.width = ''; f.style.height = '' })()`)
  await sleep(300)
  await shot('06-fim')

  // ---- entrar: IP, senha e recusas
  await ev(`document.getElementById('a').src = '/tests/collab/peer.html?id=a&name=Ana&stage=connect'`)
  await sleep(300)
  for (let i = 0; i < 100; i++) {
    if (await ev(`!!document.getElementById('a').contentWindow.__t && !!document.getElementById('a').contentDocument.querySelector('form.gate')`).catch(() => false)) break
    await sleep(100)
  }
  const labels = () => t('a', `[...document.querySelectorAll('.field > span')].map((e) => e.textContent)`)
  let fields = await labels()
  check('modo IP: só IP, nome e matrícula', JSON.stringify(fields) === JSON.stringify(['IP do professor', 'Nome', 'Matrícula (opcional)']), fields)
  await shot('07-entrar')
  await clickSel('a', '.field input')
  await type('127.0.0.1')
  await clickSel('a', '.field:nth-of-type(2) input')
  await type('Ana')
  await t('a', `(() => { t.session.needsPassword = true; t.session.refused = 'password-required'; t.refresh() })()`)
  await settle(120)
  fields = await labels()
  const err = () => t('a', `document.querySelector('.errbox')?.textContent`)
  check('sala com senha: pede a senha e mantém o que foi digitado', fields.includes('Senha da sala') && /senha/i.test(await err()) && (await t('a', `[...document.querySelectorAll('.field input')].map((i) => i.value).join()`)).startsWith('127.0.0.1,Ana'), { fields, e: await err() })
  check('sem senha digitada o botão fica travado', await t('a', `document.querySelector('form.gate button[type=submit]').disabled`))
  await type('errada')
  await t('a', `(() => { t.session.needsPassword = false; t.session.refused = 'password'; t.refresh() })()`)
  await settle(120)
  check('senha errada', (await err()) === 'Senha incorreta' && (await labels()).includes('Senha da sala'), await err())
  await t('a', `(() => { t.session.refused = 'identity'; t.refresh() })()`)
  await settle(80)
  check('vaga em uso', (await err()) === 'Esta vaga já está em uso por outro computador', await err())
  await t('a', `(() => { t.session.refused = 'full'; t.refresh() })()`)
  await settle(80)
  check('sala cheia', (await err()) === 'A sala está cheia', await err())
  await shot('08-senha')
  await t('a', `(() => { t.session.refused = null; t.refresh() })()`)
  await clickSel('a', '.segmented button:nth-child(2)')
  await settle(80)
  fields = await labels()
  check('modo código: pede o código da sala', fields[0] === 'Código da sala', fields)
  await clickSel('a', '.segmented button:nth-child(1)')
  await settle(80)
  await clickSel('a', 'form.gate button[type=submit]')
  await sleep(2000)
  const real = await t('a', `({ via: t.session.saved?.via, refused: t.session.refused, connect: t.session.connectError, value: document.querySelector('.field input').value })`)
  check('conectar de verdade sem hub dá erro claro e mantém o IP', real.via?.kind === 'hub' && real.via.address === '127.0.0.1' && !!real.connect && real.value === '127.0.0.1', real)

  // ---- equipe
  await ev(`document.getElementById('a').src = '/tests/collab/peer.html?id=a&name=Ana&stage=team'`)
  await sleep(300)
  for (let i = 0; i < 100; i++) {
    if (await ev(`!!document.getElementById('a').contentWindow.__t && !!document.getElementById('a').contentDocument.querySelector('form.stack')`).catch(() => false)) break
    await sleep(100)
  }
  await settle(200)
  check('equipe antes de compartilhar a tela', (await t('a', `document.querySelector('.gate h1').textContent`)) === 'Sua equipe')
  await t('a', `(() => { w.__calls = []; t.session.createTeam = (n) => w.__calls.push(['create', n]); t.session.joinTeam = (c) => w.__calls.push(['join', c]) })()`)
  await clickSel('a', 'form.stack button[type=submit]')
  await settle(80)
  await t('a', `(() => { t.session.teamError = 'name'; t.refresh() })()`)
  await settle(80)
  check('sem nome', (await err()) === 'Dê um nome', await err())
  await shot('09-equipe')
  await clickSel('a', '.segmented button:nth-child(2)')
  await settle(100)
  await clickSel('a', '.field input')
  await type('k7qx')
  await settle(50)
  check('código em maiúsculas e mono', (await t('a', `(() => { const i = document.querySelector('.field input'); return i.value + '|' + i.classList.contains('mono') })()`)) === 'K7QX|true')
  await clickSel('a', 'form.stack button[type=submit]')
  await settle(80)
  check('entrar envia o código', (await t('a', `JSON.stringify(w.__calls.at(-1))`)) === '["join","K7QX"]')
  for (const [reason, text] of [['code', 'Código não encontrado'], ['full', 'Equipe cheia'], ['started', 'Esta equipe já terminou']]) {
    await t('a', `(() => { t.session.teamError = '${reason}'; t.refresh() })()`)
    await settle(60)
    check(`erro ${reason}`, (await err()) === text, await err())
  }
  await t('a', `(() => { t.session.teamError = null; t.session.team = t.TEAM; t.session.status = { ...t.OK, screen: false }; t.refresh() })()`)
  await sleep(1200)
  const card = () => t('a', `({ code: document.querySelector('.team-code')?.textContent, members: document.querySelectorAll('.team-members .member').length, on: document.querySelectorAll('.team-members .dot.on').length, h1: document.querySelector('.gate h1')?.textContent, leave: !!document.querySelector('.team-leave') })`)
  let info = await card()
  check('com equipe, o código aparece antes de compartilhar a tela', info.code === 'K7QX2M' && info.members === 2 && info.on === 1 && info.h1 === 'Compartilhe a tela inteira' && info.leave, info)
  await shot('10-equipe-tela')
  await t('a', `(() => { t.session.status = t.OK; t.refresh() })()`)
  await sleep(1200)
  info = await card()
  check('e continua na sala de espera', info.code === 'K7QX2M' && info.h1 === 'Aguardando o professor começar', info)
  await shot('11-espera')
  const wait = await t('a', `({ fp: document.querySelector('.fp-code')?.textContent, text: document.querySelector('.fp-card')?.textContent })`)
  check('sala de espera mostra o código do professor', wait.fp === 'ABC-123' && wait.text.includes('Código do professor') && wait.text.includes('Se for diferente, chame o professor'), wait)
  await clickSel('a', '.team-card .pill.icon')
  await sleep(150)
  const copied = await t('a', `w.navigator.clipboard.readText().catch((e) => 'erro ' + e.message)`)
  check('copiar leva o código', copied === 'K7QX2M' || /erro/.test(copied), copied)
  console.log('     área de transferência:', copied)
  await t('a', `(() => { w.__left = 0; t.session.leaveTeam = () => { w.__left++; t.session.team = null; t.refresh() } })()`)
  await clickSel('a', '.team-leave')
  await sleep(1200)
  check('sair da equipe volta ao passo de equipe', (await t('a', `document.querySelector('.gate h1').textContent`)) === 'Sua equipe' && (await t('a', 'w.__left')) === 1)

  // ---- outra chave respondendo pelo professor
  await t('a', `(() => { t.session.refused = 'impostor'; t.refresh() })()`)
  await settle(120)
  const blocked = await t('a', `({ text: document.querySelector('.errbox')?.textContent, buttons: [...document.querySelectorAll('button')].map((b) => b.textContent), inputs: document.querySelectorAll('input').length })`)
  check('impostor: tela de bloqueio, e a única saída é voltar ao início', blocked.text === 'A identidade do professor mudou. Chame o professor antes de continuar.' && blocked.buttons.join() === 'Voltar ao início' && blocked.inputs === 0, blocked)
  await shot('12-impostor')
  await clickSel('a', '.gate .pill')
  await sleep(400)
  const left = await t('a', `({ path: w.location.pathname, saved: t.session.saved, refused: t.session.refused })`)
  check('voltar ao início limpa a sessão', left.path === '/' && left.saved === null && left.refused === null, left)

  // ---- sandbox onde o professor roda o programa do aluno
  const sb = await t('b', 't.sandboxChecks()')
  console.log('     sandbox:', JSON.stringify({ doc: sb.doc, worker: sb.worker }))
  const closed = (r) => Object.entries(r).filter(([k]) => k !== 'importScripts').every(([, v]) => String(v).startsWith('falhou'))
  check('sandbox sem allow-same-origin', sb.doc.sandbox === 'allow-scripts', sb.doc.sandbox)
  check('documento do sandbox: sem IndexedDB, caches, OPFS, seletor de arquivos, rede nem origem', closed(sb.doc.out) && Object.keys(sb.doc.out).length === 9, sb.doc.out)
  check('worker do sandbox: sem IndexedDB, caches, OPFS, rede nem origem, e importScripts barrado', closed(sb.worker) && String(sb.worker.importScripts).startsWith('falhou'), sb.worker)
  check('controle: fora do sandbox o IndexedDB abre', sb.control === 'abriu', sb.control)
  check('o programa roda no sandbox', sb.soma.stdout === '42\n' && sb.soma.exitCode === 0, sb.soma)
  check('no sandbox, nenhum arquivo da máquina abre e o programa termina', /passwd:falhou/.test(sb.disco.stdout) && /winini:falhou/.test(sb.disco.stdout) && /raiz:falhou/.test(sb.disco.stdout) && /escrita:falhou/.test(sb.disco.stdout) && /fim/.test(sb.disco.stdout) && !/ABRIU/.test(sb.disco.stdout) && sb.disco.exitCode === 0, sb.disco)
  check('laço infinito no sandbox para no limite de tempo', sb.loop.timedOut === true, sb.loop)

  check('nenhum erro na página', pageErrors.length === 0, pageErrors)
  console.log(`\n${passed} ok, ${failed} falharam`)
  return failed === 0
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => cleanup().finally(() => process.exit(130)))

run()
  .then(async (ok) => {
    await cleanup()
    process.exit(ok ? 0 : 1)
  })
  .catch(async (err) => {
    console.error(err)
    console.error('erros da página:', pageErrors)
    await cleanup()
    process.exit(2)
  })
