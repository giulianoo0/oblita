// Vídeo de demonstração: o professor monta a sala, Ana e Bruno entram pela página inicial, fazem a prova
// juntos e entregam. Tudo pelo fluxo real (site, hub e navegador), gravado por screencast e montado com ffmpeg.
// Uso (Windows): set BROWSER=C:\...\chrome.exe && node e2e/demo.mjs [--no-build] [--out=pasta]
//                node e2e/demo.mjs --compose=pasta   (só remonta o vídeo a partir dos quadros já gravados)
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFile, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Edge, Person, sleep, withTimeout } from './helpers/cdp.mjs'
import { exam, solutions } from './helpers/fixtures.mjs'
import { hubPortShim } from './helpers/inject.mjs'
import { Servers, lanIp } from './helpers/servers.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const opt = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const NO_BUILD = argv.includes('--no-build')
const COMPOSE_ONLY = opt('compose')
const OUT = resolve(COMPOSE_ONLY ?? opt('out') ?? join(tmpdir(), 'oblita-demo'))
const FRAMES = join(OUT, 'frames')
const BLOCK = ['*www.gstatic.com*', '*1.1.1.1*', '*oblita.giuli.dev*']
const TEAM = 'Equipe Alfa'

// Professor em 1280x720 com 1.5x: quadro 1920x1080, letra grande. Alunos em 1200x1290 com 0.8x:
// quadro 960x1032, metade da tela com a faixa do nome em cima.
const SIZES = {
  T: { w: 1280, h: 720, dsf: 1.5 },
  A: { w: 1200, h: 1290, dsf: 0.8 },
  B: { w: 1200, h: 1290, dsf: 0.8 },
}
const LABELS = { T: 'Professor', A: 'Ana', B: 'Bruno' }
const FPS = 30
const XFADE = 0.4
const BG = '0x0d0f14'

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a)
const now = () => Date.now() / 1000

// ---- o que vai por cima da página

// O headless não desenha cursor: uma seta segue os eventos de mouse que o roteiro despacha.
const CURSOR = String.raw`(() => {
  if (window.top !== window) return
  let host, arrow, ring, x = -100, y = -100, shown = false
  try { const p = JSON.parse(sessionStorage.getItem('__demoCursor') || 'null'); if (p) { x = p.x; y = p.y; shown = true } } catch {}
  const place = () => {
    if (!arrow) return
    arrow.style.transform = 'translate(' + (x - 4) + 'px,' + (y - 3) + 'px)'
    arrow.style.opacity = shown ? '1' : '0'
  }
  const mount = () => {
    if (host && host.isConnected) return
    if (!document.body) return
    host = document.createElement('div')
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none'
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = '<style>' +
      '.c{position:absolute;left:0;top:0;width:28px;height:28px;transition:opacity .2s;filter:drop-shadow(0 2px 3px rgb(0 0 0 / 45%))}' +
      '.c svg{display:block;transform-origin:4px 3px;transition:transform .12s ease-out}.c.down svg{transform:scale(.84)}' +
      '.r{position:absolute;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;border:2px solid rgb(255 255 255 / 85%);background:rgb(255 255 255 / 12%);opacity:0}' +
      '.r.go{animation:r .5s cubic-bezier(.2,.7,.3,1)}@keyframes r{from{opacity:.95;transform:scale(.35)}to{opacity:0;transform:scale(1.25)}}' +
      '</style><div class="r"></div><div class="c"><svg width="28" height="28" viewBox="0 0 28 28"><path d="M4 3 L4 22 L9.2 17.2 L12.8 25 L16 23.5 L12.5 15.9 L19.5 15.9 Z" fill="#fff" stroke="#0b0d12" stroke-width="1.7" stroke-linejoin="round"/></svg></div>'
    ring = root.querySelector('.r')
    arrow = root.querySelector('.c')
    document.documentElement.append(host)
    place()
  }
  const save = () => { try { sessionStorage.setItem('__demoCursor', JSON.stringify({ x, y })) } catch {} }
  addEventListener('mousemove', (e) => { mount(); x = e.clientX; y = e.clientY; shown = true; place(); save() }, { capture: true, passive: true })
  addEventListener('mousedown', () => {
    mount()
    arrow?.classList.add('down')
    if (ring) { ring.style.left = x + 'px'; ring.style.top = y + 'px'; ring.classList.remove('go'); void ring.offsetWidth; ring.classList.add('go') }
  }, { capture: true, passive: true })
  addEventListener('mouseup', () => arrow?.classList.remove('down'), { capture: true, passive: true })
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
  else mount()
})()`

// A captura de tela do aluno: em headless a real filma a área de trabalho, então a trilha é um canvas
// com os próprios quadros do screencast da página (o professor vê a tela de verdade) e o selo por cima.
const SCREEN_STUB = String.raw`(() => {
  if (window.top !== window) return
  const md = navigator.mediaDevices
  if (!md) return
  let latest = null
  window.__demoFeed = (url) => { const im = new Image(); im.onload = () => { latest = im }; im.src = url }
  const fake = () => {
    const canvas = document.createElement('canvas')
    canvas.width = innerWidth
    canvas.height = innerHeight
    const ctx = canvas.getContext('2d')
    const draw = () => {
      if (latest) ctx.drawImage(latest, 0, 0, canvas.width, canvas.height)
      else { ctx.fillStyle = '#111318'; ctx.fillRect(0, 0, canvas.width, canvas.height) }
      const sx = canvas.width / innerWidth
      const sy = canvas.height / innerHeight
      const seal = document.querySelector('[data-beacon]')
      if (!seal || getComputedStyle(seal).visibility === 'hidden') return
      for (const cell of seal.children) {
        const b = cell.getBoundingClientRect()
        ctx.fillStyle = getComputedStyle(cell).backgroundColor
        ctx.fillRect(Math.round(b.left * sx), Math.round(b.top * sy), Math.ceil(b.width * sx), Math.ceil(b.height * sy))
      }
    }
    draw()
    const timer = setInterval(draw, 100)
    const stream = canvas.captureStream(10)
    stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer))
    return stream
  }
  md.getDisplayMedia = async () => {
    const stream = fake()
    const track = stream.getVideoTracks()[0]
    const settings = track.getSettings.bind(track)
    track.getSettings = () => ({ ...settings(), displaySurface: 'monitor' })
    return stream
  }
})()`

// ---- gravação

class Recorder {
  constructor(tab, key) {
    this.tab = tab
    this.key = key
    this.frames = []
    this.pending = 0
    this.last = null
    tab.cdp.on('Page.screencastFrame', (p, sid) => {
      if (sid !== tab.sessionId) return
      void tab.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {})
      const file = `${key}-${String(this.frames.length).padStart(6, '0')}.jpg`
      this.frames.push({ file, meta: p.metadata.timestamp ?? null, recv: now() })
      this.last = p.data
      this.pending++
      writeFile(join(FRAMES, file), Buffer.from(p.data, 'base64'), () => this.pending--)
    })
  }

  async start() {
    const s = SIZES[this.key]
    await this.tab.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: Math.round(s.w * s.dsf), maxHeight: Math.round(s.h * s.dsf), everyNthFrame: 1 })
  }

  async stop() {
    await this.tab.send('Page.stopScreencast').catch(() => {})
    for (let i = 0; i < 200 && this.pending > 0; i++) await sleep(50)
  }

  // O carimbo do quadro é o do compositor; a mediana da diferença para a chegada põe tudo no relógio do roteiro.
  timed() {
    const diffs = this.frames.filter((f) => f.meta).map((f) => f.recv - f.meta).sort((a, b) => a - b)
    const off = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 0
    return this.frames.map((f) => ({ file: f.file, t: f.meta ? f.meta + off : f.recv }))
  }
}

// ---- cenas: intervalos do relógio real, cada um com as telas que aparecem

const timeline = []
let current = null
// Ações no relógio do roteiro, para a trilha e os efeitos: a montagem converte para o tempo do vídeo.
const events = []
const WHO = { T: 'professor', A: 'ana', B: 'bruno' }
const mark = (tipo, key) => events.push({ t: now(), tipo, quem: WHO[key] })

function scene(panes, nome) {
  const t = now()
  if (current) {
    current.t1 = t
    timeline.push(current)
  }
  current = panes ? { panes, nome, t0: t } : null
  if (panes) log(`cena: ${panes.join(' | ')}`)
}

// Espera longa vira corte: fica o começo (o clique) e o fim (o resultado).
async function waitCut(fn, keep = 1.4, tail = 0.9) {
  const t0 = now()
  const v = await fn()
  const t1 = now()
  if (current && t1 - t0 > keep + tail + 1.5) {
    log(`corte de ${(t1 - t0 - keep - tail).toFixed(1)} s`)
    current.t1 = t0 + keep
    timeline.push(current)
    current = { panes: current.panes, nome: current.nome, t0: t1 - tail, cut: true }
  }
  return v
}

// ---- mão humana: o mouse anda até o alvo, clica com pausa, digita letra a letra

const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2)
const rand = (a, b) => a + Math.random() * (b - a)

class Hand {
  constructor(tab, key) {
    this.tab = tab
    this.key = key
    this.x = SIZES[key].w * 0.55
    this.y = SIZES[key].h * 0.6
  }

  async moveTo(x, y, { ms, buttons = 0 } = {}) {
    const d = Math.hypot(x - this.x, y - this.y)
    const total = ms ?? Math.min(950, Math.max(320, 260 + d * 0.75))
    const steps = Math.max(6, Math.round(total / 16))
    const x0 = this.x
    const y0 = this.y
    // Uma leve curva, como a mão de alguém, e não uma régua.
    const bend = Math.min(60, d * 0.12) * (Math.random() < 0.5 ? -1 : 1)
    const nx = d ? -(y - y0) / d : 0
    const ny = d ? (x - x0) / d : 0
    for (let i = 1; i <= steps; i++) {
      const k = ease(i / steps)
      const arc = Math.sin(Math.PI * k) * bend
      const px = x0 + (x - x0) * k + nx * arc
      const py = y0 + (y - y0) * k + ny * arc
      await this.tab.mouse('mouseMoved', px, py, buttons ? { button: 'left', buttons } : {})
      await sleep(16)
    }
    this.x = x
    this.y = y
  }

  async clickXY(x, y, { pause = 140 } = {}) {
    await this.moveTo(x, y)
    await sleep(pause)
    mark('clique', this.key)
    await this.tab.mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 })
    await sleep(90)
    await this.tab.mouse('mouseReleased', x, y, { button: 'left', clickCount: 1 })
    await sleep(220)
  }

  async click(finder, label) {
    const c = await this.tab.centerOf(finder, label)
    await this.clickXY(c.x, c.y)
  }

  clickText(text, opts) {
    return this.click(this.tab.byText(text, opts), `botão "${text}"`)
  }

  clickSel(sel) {
    return this.click(`document.querySelector(${JSON.stringify(sel)})`, sel)
  }

  async hover(finder, label) {
    const c = await this.tab.centerOf(finder, label)
    await this.moveTo(c.x, c.y)
  }

  async drag(from, to, { ms = 750, hold = 260 } = {}) {
    await this.moveTo(from.x, from.y)
    await sleep(160)
    mark('arrasto-ini', this.key)
    await this.tab.mouse('mousePressed', from.x, from.y, { button: 'left', buttons: 1, clickCount: 1 })
    await sleep(120)
    await this.moveTo(to.x, to.y, { ms, buttons: 1 })
    await sleep(hold)
    await this.tab.mouse('mouseReleased', to.x, to.y, { button: 'left', clickCount: 1 })
    mark('arrasto-fim', this.key)
    await sleep(200)
  }

  async type(text, { min = 45, max = 95 } = {}) {
    mark('digitacao-ini', this.key)
    for (const ch of text) {
      await this.tab.type(ch, 0)
      let d = rand(min, max)
      if (ch === ' ') d += 35
      if (/[,.;:)]/.test(ch)) d += 70
      await sleep(d)
    }
    mark('digitacao-fim', this.key)
  }

  async fill(label, value) {
    await this.click(this.tab.fieldInput(label), `campo "${label}"`)
    await sleep(160)
    await this.type(value)
    await sleep(250)
  }
}

// ---- editor

const EDITOR_TEXT = `[...document.querySelectorAll('.editor-mount .view-line')].sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top)).map((e) => e.textContent.replace(/\\u00a0/g, ' ')).join('\\n')`
const lineBox = (tab, i) =>
  tab.ev(`(() => { const l = [...document.querySelectorAll('.editor-mount .view-line')].sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top))[${i}]; const b = l.getBoundingClientRect(); const s = l.querySelector('span')?.getBoundingClientRect(); return { left: b.left, right: s ? s.right : b.left, y: b.top + b.height / 2 } })()`)
const blockBox = (tab, id) => tab.ev(`(() => { const b = document.querySelector('[data-block="${id}"]').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height } })()`)
const settled = async (tab) => {
  let last = ''
  for (let i = 0; i < 40; i++) {
    const s = JSON.stringify(await tab.ev(`({ a: !!document.querySelector('.blk-area[data-animate]'), r: [...document.querySelectorAll('[data-block]')].map((e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] }) })`))
    if (s === last && !JSON.parse(s).a) return
    last = s
    await sleep(80)
  }
}

const BODY = ['int a, b;', 'scanf("%d %d", &a, &b);', 'printf("%d\\n", a + b);']
const SOLUTION = `#include <stdio.h>\n\nint main(void) {\n    int a, b;\n    scanf("%d %d", &a, &b);\n    printf("%d\\n", a + b);\n    return 0;\n}\n`

// ---- mundo

let servers
let browser
let tmp
let T, A, B
let hT, hA, hB
const rec = {}
let feeder

async function student(h, tab, hubAddr, name, enroll) {
  await sleep(600)
  await h.clickText('Sou aluno')
  mark('modal-abre', h.key)
  await tab.waitFor(`!!(${tab.fieldInput('IP do professor')})`)
  await sleep(800)
  await h.fill('IP do professor', hubAddr)
  await h.clickSel('.join-inline .pill')
  await tab.waitText('Quem é você?')
  await sleep(450)
  await h.fill('Nome', name)
  await h.fill('Matrícula (opcional)', enroll)
  await sleep(300)
  await h.clickText('Entrar')
  await tab.waitText('Sua equipe', { timeout: 30000 })
  mark('modal-fecha', h.key)
  await sleep(700)
}

async function shareScreen(h, tab) {
  await tab.waitText('Compartilhe a tela inteira', { timeout: 15000 })
  await sleep(600)
  await h.clickText('Compartilhar tela')
  await tab.waitText('Entre em tela cheia')
  await sleep(600)
  await h.clickText('Entrar em tela cheia')
  await tab.waitNoText('Entre em tela cheia')
}

async function openTab(person, key) {
  const t = await person.tab(null)
  const s = SIZES[key]
  await t.send('Emulation.setDeviceMetricsOverride', { width: s.w, height: s.h, deviceScaleFactor: s.dsf, mobile: false, screenWidth: s.w, screenHeight: s.h })
  await t.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  return t
}

async function record() {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(FRAMES, { recursive: true })
  tmp = mkdtempSync(join(tmpdir(), 'oblita-demo-'))
  const examPath = join(tmp, 'exam.json')
  const solPath = join(tmp, 'solutions.json')
  writeFileSync(examPath, JSON.stringify(exam, null, 2))
  writeFileSync(solPath, JSON.stringify(solutions, null, 2))

  const lan = lanIp()
  if (!lan) throw new Error('sem IP de rede local')
  servers = await new Servers(ROOT).start()
  const origin = servers.origin
  const hubAddr = servers.altHub ? `${lan}:${servers.hubPort}` : lan
  log(`site ${origin}, hub ${hubAddr}${servers.altHub ? ' (porta alternativa)' : ''}`)

  browser = await Edge.launch({ tag: 'demo', windowSize: '1920,1290' })
  log(`navegador: ${browser.product}`)
  const tP = await Person.create(browser, 'professor')
  const aP = await Person.create(browser, 'ana')
  const bP = await Person.create(browser, 'bruno')
  for (const perm of ['local-network', 'loopback-network', 'local-network-access']) {
    for (const p of [tP, aP, bP]) await p.setPermission(origin, perm, 'granted').catch(() => {})
  }
  tP.inits.push(CURSOR)
  if (servers.altHub) tP.inits.push(hubPortShim(servers.hubPort))
  for (const p of [aP, bP]) p.inits.push(SCREEN_STUB, CURSOR)

  T = await openTab(tP, 'T')
  A = await openTab(aP, 'A')
  B = await openTab(bP, 'B')
  hT = new Hand(T, 'T')
  hA = new Hand(A, 'A')
  hB = new Hand(B, 'B')

  // Fora de cena: o site baixa para uso sem internet nas três telas.
  for (const t of [T, A, B]) await t.navigate(`${origin}/`)
  for (const t of [T, A, B]) await t.waitText('Baixado neste computador', { timeout: 280_000, every: 500 })
  log('as três telas baixaram o site')
  await aP.block(BLOCK)
  await bP.block(BLOCK)

  rec.T = new Recorder(T, 'T')
  rec.A = new Recorder(A, 'A')
  rec.B = new Recorder(B, 'B')
  for (const r of Object.values(rec)) await r.start()
  // O professor vê a tela de verdade de cada aluno: os quadros do screencast alimentam a captura.
  feeder = setInterval(() => {
    for (const [k, t] of [['A', A], ['B', B]]) {
      const data = rec[k].last
      if (data) void t.send('Runtime.evaluate', { expression: `window.__demoFeed?.('data:image/jpeg;base64,${data}')` }).catch(() => {})
    }
  }, 400)
  for (const t of [T, A, B]) await t.navigate(`${origin}/`)
  for (const t of [T, A, B]) await t.waitText('Sou professor')
  await sleep(300)

  // ---- 1. Professor monta a sala
  scene(['T'], 'Professor monta a sala')
  await sleep(1300)
  await hT.clickText('Sou professor')
  await T.waitText('Nova sala')
  await sleep(800)
  const zone = (i) => `document.querySelectorAll('.dropzone')[${i}]`
  await hT.hover(zone(0), 'arquivo da prova')
  await sleep(250)
  await T.setFile(0, examPath)
  await T.waitText(`3 questões em "${exam.title}"`)
  await sleep(600)
  await T.waitFor(`${zone(1)}?.getAttribute('aria-disabled') !== 'true'`)
  await hT.hover(zone(1), 'gabarito')
  await sleep(250)
  await T.setFile(1, solPath)
  await T.waitText('Gabarito com 3 respostas')
  await sleep(600)
  await hT.clickText('Em equipe')
  await T.waitFor(`!!(${T.fieldInput('Máximo por equipe')})`)
  await sleep(500)
  for (let i = 0; i < 6; i++) {
    const n = Number(await T.ev(`${T.fieldInput('Máximo por equipe')}.value`))
    if (n === 2) break
    await hT.click(`document.querySelector('[aria-label="${n > 2 ? 'Menos' : 'Mais'} pessoas"]')`, 'seletor da equipe')
    await sleep(250)
  }
  await sleep(600)
  await hT.clickText('Criar sala')
  await T.waitFor(`location.pathname.startsWith('/sala/')`, { timeout: 30000 })
  const connected = `[...document.querySelectorAll('.conn h2')].some((h) => h.textContent === 'Programa')`
  const auto = await T.waitFor(connected, { timeout: 6000 }).catch(() => false)
  if (!auto) {
    await sleep(600)
    await hT.clickText('Conectar ao programa')
    await T.waitFor(connected, { timeout: 15000 })
  }
  await sleep(600)
  await hT.hover(`document.querySelector('.conn .conn-big')`, 'IP')
  await sleep(900)

  // ---- 2. Ana entra pelo IP e cria a equipe; o painel do professor ao lado
  scene(['A', 'T'], 'Ana entra e cria a equipe')
  await student(hA, A, hubAddr, 'Ana', '2024A')
  await hA.fill('Nome da equipe', TEAM)
  await hA.clickText('Criar')
  await A.waitFor(`!!document.querySelector('.team-card .team-code')`)
  const code = await A.ev(`document.querySelector('.team-card .team-code').textContent`)
  log(`equipe ${code}`)
  await T.waitFor(`[...document.querySelectorAll('.team-name')].some((e) => e.textContent === ${JSON.stringify(TEAM)})`, { timeout: 10000 })
  await hA.hover(`document.querySelector('.team-card .team-code')`, 'código')
  await sleep(1000)

  // ---- 3. Bruno entra na equipe da Ana pelo código; os dois compartilham a tela
  scene(['A', 'B'], 'Bruno entra na equipe e os dois compartilham a tela')
  await student(hB, B, hubAddr, 'Bruno', '2024B')
  await hB.clickText('Entrar com código')
  await B.waitFor(`!!(${B.fieldInput('Código da equipe')})`)
  await sleep(500)
  await hB.fill('Código da equipe', code)
  await hB.clickText('Entrar')
  await B.waitFor(`document.querySelector('.team-card .team-code')?.textContent === ${JSON.stringify(code)}`)
  await A.waitFor(`document.querySelectorAll('.team-card .member').length === 2`, { timeout: 10000 })
  await sleep(1400)
  await Promise.all([
    shareScreen(hA, A),
    (async () => {
      await sleep(700)
      await shareScreen(hB, B)
    })(),
  ])
  await Promise.all([A, B].map((t) => t.waitText('Aguardando o professor começar', { timeout: 20000 })))
  await sleep(1100)

  // ---- 4. O professor abre a prova
  scene(['T'], 'Professor abre a prova')
  await T.waitFor(`[...document.querySelectorAll('.dash-main section')].some((s) => s.querySelector('.team-name')?.textContent === ${JSON.stringify(TEAM)} && s.querySelectorAll('.member').length === 2)`)
  await sleep(1200)
  await hT.clickText('Abrir prova')
  await T.waitText('Em prova')
  await sleep(1100)

  // ---- 5. Ana | Bruno: a prova, juntos
  scene(['A', 'B'], 'Ana e Bruno fazem a prova juntos e entregam')
  await A.waitText('Bater ponto e começar', { timeout: 15000 })
  await sleep(500)
  await Promise.all([
    hA.clickText('Bater ponto e começar'),
    (async () => {
      // Pronto antes da prova abrir, Bruno também bate o ponto; quem chega depois recebe direto.
      await sleep(1100)
      if (await B.ev(`!!(${B.byText('Bater ponto e começar')})`)) await hB.clickText('Bater ponto e começar')
    })(),
  ])
  for (const t of [A, B]) await t.waitFor(`!!document.querySelector('.editor-mount .view-line') && ${EDITOR_TEXT}.includes('int main')`, { timeout: 20000 })
  // O título da questão se revela e voa para o enunciado.
  await sleep(2600)
  const seed = await A.ev(EDITOR_TEXT)
  const blank = seed.split('\n').findIndex((l, i, all) => i > 0 && all[i - 1].includes('int main') && !l.trim())
  if (blank < 0) throw new Error(`semente inesperada:\n${seed}`)

  const bruno = async () => {
    const box = await lineBox(B, blank)
    await hB.clickXY(box.left + 90, box.y)
    await B.press('End')
    await sleep(300)
    for (const [i, line] of BODY.entries()) {
      await hB.type(line, { min: 38, max: 85 })
      if (i < BODY.length - 1) {
        await B.press('Escape')
        await B.press('Enter')
        await sleep(220)
      }
    }
    await B.press('Escape')
  }
  const ana = async () => {
    await sleep(1000)
    const first = await lineBox(A, 0)
    await hA.clickXY(first.left + 4, first.y)
    await A.press('Home')
    await sleep(250)
    await hA.type('// Equipe Alfa: soma')
    await A.press('Escape')
    await A.press('Enter')
    await sleep(600)
    // Mexe no layout: a entrada vai para baixo do enunciado.
    const st = await blockBox(A, 'statement')
    const head = await A.centerOf(`document.querySelector('[data-block="input"] .blk-title')`, 'título da entrada')
    await hA.drag(head, { x: st.x + st.w * 0.5, y: st.y + st.h * 0.85 }, { ms: 900, hold: 420 })
    await settled(A)
    await sleep(700)
    // Recolhe o enunciado e abre de novo.
    await hA.clickSel('[data-block="statement"] .blk-toggle')
    await settled(A)
    await sleep(800)
    const strip = await blockBox(A, 'statement')
    await hA.clickXY(strip.x + strip.w / 2, strip.y + strip.h * 0.4)
    await settled(A)
    await sleep(600)
    // A divisória entre as colunas.
    const div = await A.centerOf(`document.querySelector('[data-divider=":0"]')`, 'divisória')
    await hA.drag(div, { x: div.x + 70, y: div.y + 10 }, { ms: 650, hold: 200 })
    await settled(A)
  }
  await Promise.all([bruno(), ana()])
  await sleep(500)
  const want = (t) => t.ev(`${EDITOR_TEXT}.includes('printf("%d\\\\n", a + b);') && ${EDITOR_TEXT}.includes('scanf("%d %d", &a, &b);')`)
  await A.waitFor(`${EDITOR_TEXT}.includes('a + b')`, { timeout: 6000 }).catch(() => {})
  if (!(await want(A)) || !(await want(B))) {
    log(`o editor não ficou como esperado; corrigindo:\n${await B.ev(EDITOR_TEXT)}`)
    await B.press('a', 2)
    await B.insertText(`// Equipe Alfa: soma\n${SOLUTION}`)
  }
  log(`código final:\n${await A.ev(EDITOR_TEXT)}`)
  await sleep(800)

  // Ana roda com entrada.
  await hA.clickSel('textarea[aria-label="Entrada do programa"]')
  await sleep(200)
  await hA.type('7 8')
  await sleep(350)
  await hA.clickSel('button[title="Rodar (Ctrl+Enter)"]')
  await waitCut(() => A.waitFor(`document.querySelector('.console-out')?.textContent.includes('Saiu com código')`, { timeout: 150_000, every: 200, label: 'saída do Rodar' }))
  mark('rodou', 'A')
  log(`saída: ${JSON.stringify(await A.ev(`document.querySelector('.console-out').textContent`))}`)
  await sleep(1400)

  // Bruno testa na máquina do professor.
  await hB.clickText('Testar')
  await waitCut(() => B.waitFor(`document.querySelector('.console-out')?.textContent.includes('Ocultos:')`, { timeout: 170_000, every: 200, label: 'relatório do Testar' }))
  mark('teste-ok', 'B')
  log(`teste: ${JSON.stringify(await B.ev(`document.querySelector('.console-out').textContent`))}`)
  await sleep(2100)

  // ---- 6. Entregam
  const deliver = async (h, t) => {
    await h.clickText('Entregar')
    await t.waitText('Entregar a prova?')
    mark('modal-abre', h.key)
    await sleep(700)
    await h.clickText('Entregar', { within: `document.querySelector('.modal')` })
    mark('modal-fecha', h.key)
    await t.waitText('Prova entregue', { timeout: 60000 })
    mark('entregou', h.key)
  }
  await Promise.all([
    deliver(hA, A),
    (async () => {
      await sleep(1000)
      await deliver(hB, B)
    })(),
  ])
  await sleep(1300)

  // ---- 7. O professor encerra e vê as notas
  scene(['T'], 'Professor encerra e vê as notas')
  await sleep(1000)
  const end = await T.ev(`!!(${T.byText('Encerrar')})`)
  if (end) {
    await hT.clickText('Encerrar')
    await T.waitText('Encerrar a prova para todos?')
    mark('modal-abre', 'T')
    await sleep(650)
    await hT.clickText('Encerrar', { within: `document.querySelector('.modal')` })
    mark('modal-fecha', 'T')
  }
  await T.waitFor(`!!document.querySelector('table.results')`, { timeout: 15000 })
  await waitCut(() => T.waitFor(`!document.querySelector('table.results .spin')`, { timeout: 150_000, every: 300, label: 'correção' }), 1.2, 0.6)
  await sleep(600)
  const row = `[...document.querySelectorAll('table.results tbody tr')].find((r) => r.textContent.includes(${JSON.stringify(TEAM)}))`
  log(`notas: ${JSON.stringify(await T.ev(`[...${row}.querySelectorAll('td')].map((e) => e.textContent.trim())`))}`)
  await hT.hover(row, 'linha da equipe')
  await sleep(2400)
  scene(null)

  clearInterval(feeder)
  for (const r of Object.values(rec)) await r.stop()
  const frames = Object.fromEntries(Object.entries(rec).map(([k, r]) => [k, r.timed()]))
  writeFileSync(join(OUT, 'timeline.json'), JSON.stringify({ timeline, frames, events }, null, 1))
  log(`quadros: ${Object.entries(frames).map(([k, f]) => `${k}=${f.length}`).join(', ')}`)
}

// ---- montagem

function ff(args, label) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: OUT, encoding: 'utf8', maxBuffer: 64 * 2 ** 20 })
  if (r.status !== 0) throw new Error(`ffmpeg (${label}) falhou:\n${r.stderr}`)
}

// Lista do concat com a duração real de cada quadro, recortada no intervalo da cena.
function paneList(frames, t0, t1, name) {
  const sorted = frames.filter((f) => existsSync(join(FRAMES, f.file))).sort((a, b) => a.t - b.t)
  if (!sorted.length) throw new Error(`sem quadros para ${name}`)
  let i = 0
  while (i + 1 < sorted.length && sorted[i + 1].t <= t0) i++
  const lines = ['ffconcat version 1.0']
  let last = null
  for (; i < sorted.length && sorted[i].t < t1; i++) {
    const start = Math.max(sorted[i].t, t0)
    const stop = Math.min(sorted[i + 1]?.t ?? t1, t1)
    if (stop - start <= 0.0005) continue
    lines.push(`file 'frames/${sorted[i].file}'`, `duration ${(stop - start).toFixed(4)}`)
    last = sorted[i].file
  }
  if (!last) {
    last = sorted[Math.min(i, sorted.length - 1)].file
    lines.push(`file 'frames/${last}'`, `duration ${(t1 - t0).toFixed(4)}`)
  }
  lines.push(`file 'frames/${last}'`)
  writeFileSync(join(OUT, name), lines.join('\n') + '\n')
  return name
}

const label = (text, x, y) => `drawtext=fontfile=font.ttf:text='${text}':fontsize=24:fontcolor=0xe6e9f0:x=${x}:y=${y}`

function compose() {
  const { timeline: raw, frames, events = [] } = JSON.parse(readFileSync(join(OUT, 'timeline.json'), 'utf8'))
  const font = 'C:\\Windows\\Fonts\\segoeuib.ttf'
  copyFileSync(existsSync(font) ? font : 'C:\\Windows\\Fonts\\arialbd.ttf', join(OUT, 'font.ttf'))
  const scenes = raw.filter((s) => s.t1 - s.t0 >= XFADE + 0.4)
  const clips = []
  for (const [n, s] of scenes.entries()) {
    const dur = s.t1 - s.t0
    const inputs = s.panes.flatMap((k, j) => ['-f', 'concat', '-safe', '0', '-i', paneList(frames[k], s.t0, s.t1, `s${n}-${j}-${k}.txt`)])
    let graph
    if (s.panes.length === 1) {
      graph = `[0:v]fps=${FPS},scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=${BG},setsar=1,${label(LABELS[s.panes[0]], 28, 'h-th-26')}:box=1:boxcolor=0x000000@0.55:boxborderw=12,scale=out_range=tv,format=yuv420p[v]`
    } else {
      const half = s.panes.map((k, j) => `[${j}:v]fps=${FPS},scale=960:1032:force_original_aspect_ratio=decrease:flags=lanczos,pad=960:1080:(ow-iw)/2:48+(1032-ih)/2:color=${BG},setsar=1,${label(LABELS[k], '(w-tw)/2', 12)}[p${j}]`)
      graph = `${half.join(';')};[p0][p1]hstack=inputs=2,drawbox=x=958:y=0:w=4:h=ih:color=0x262b36:t=fill,scale=out_range=tv,format=yuv420p[v]`
    }
    const out = `scene-${String(n).padStart(2, '0')}.mp4`
    writeFileSync(join(OUT, `scene-${n}.filter`), graph)
    ff([...inputs, '-/filter_complex', `scene-${n}.filter`, '-map', '[v]', '-t', dur.toFixed(3), '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-color_range', 'tv', out], `cena ${n}`)
    clips.push({ out, dur, panes: s.panes, nome: s.nome, t0: s.t0, t1: s.t1 })
    log(`cena ${n} (${s.panes.join(' | ')}): ${dur.toFixed(1)} s`)
  }
  // Uma cena entra na outra com fade de 0.4 s; o vídeo abre e fecha no preto.
  const parts = []
  let acc = clips[0].dur
  let lastLabel = '0:v'
  const starts = [0]
  for (let i = 1; i < clips.length; i++) {
    const offset = acc - XFADE
    starts.push(offset)
    parts.push(`[${lastLabel}][${i}:v]xfade=transition=fade:duration=${XFADE}:offset=${offset.toFixed(3)}[x${i}]`)
    lastLabel = `x${i}`
    acc = offset + clips[i].dur
  }
  const total = acc
  parts.push(`[${lastLabel}]fade=t=in:st=0:d=0.5,fade=t=out:st=${(total - 0.7).toFixed(3)}:d=0.7,format=yuv420p[v]`)
  writeFileSync(join(OUT, 'final.filter'), parts.join(';'))
  ff([...clips.flatMap((c) => ['-i', c.out]), '-/filter_complex', 'final.filter', '-map', '[v]', '-r', String(FPS), '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-movflags', '+faststart', 'oblita-demo.mp4'], 'final')
  // Tempo no vídeo: a cena i começa em starts[i]; o que caiu num corte fica de fora.
  const ev = []
  for (const e of events) {
    const i = clips.findIndex((c) => e.t >= c.t0 && e.t < c.t1)
    if (i >= 0) ev.push({ t: +(starts[i] + e.t - clips[i].t0).toFixed(3), tipo: e.tipo, quem: e.quem })
  }
  for (let i = 1; i < clips.length; i++) ev.push({ t: +starts[i].toFixed(3), tipo: 'transicao', quem: WHO[clips[i].panes[0]] })
  ev.sort((a, b) => a.t - b.t)
  // Os pedaços de uma mesma cena (cortes de espera) viram uma cena só na lista.
  const cenas = []
  for (const [i, c] of clips.entries()) {
    const ini = +starts[i].toFixed(3)
    const fim = +(starts[i] + c.dur).toFixed(3)
    const prev = cenas.at(-1)
    if (prev && prev.nome === c.nome) prev.fim = fim
    else cenas.push({ nome: c.nome ?? c.panes.join(' | '), ini, fim })
  }
  writeFileSync(join(OUT, 'eventos.json'), JSON.stringify({ duracao: +total.toFixed(3), cenas, eventos: ev }, null, 2))
  log(`vídeo: ${join(OUT, 'oblita-demo.mp4')} (${total.toFixed(1)} s, ${clips.length} cenas)`)

  // Amostras: o meio da primeira cena do professor, Ana com o painel, o meio da prova a dois e o fim.
  const pick = [
    clips.findIndex((c) => c.panes.join() === 'T'),
    clips.findIndex((c) => c.panes.join() === 'A,T'),
    clips.reduce((best, c, i) => (c.panes.join() === 'A,B' && c.dur > (clips[best]?.dur ?? 0) ? i : best), -1),
    clips.length - 1,
  ].filter((i, k, all) => i >= 0 && all.indexOf(i) === k)
  for (const [k, i] of pick.entries()) {
    const at = starts[i] + clips[i].dur * (i === clips.length - 1 ? 0.8 : 0.6)
    ff(['-ss', at.toFixed(2), '-i', 'oblita-demo.mp4', '-frames:v', '1', `amostra-${k + 1}.png`], `amostra ${k + 1}`)
  }
  log(`amostras: ${pick.map((_, k) => `amostra-${k + 1}.png`).join(', ')}`)
}

// ---- execução

let cleaned = false
async function cleanup() {
  if (cleaned) return
  cleaned = true
  clearInterval(feeder)
  await browser?.close().catch(() => {})
  servers?.stop()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => cleanup().finally(() => process.exit(130)))

let code = 0
try {
  if (!COMPOSE_ONLY) {
    if (!NO_BUILD) {
      log('build...')
      for (const [what, file] of [['tsc', join('node_modules', 'typescript', 'bin', 'tsc')], ['vite', join('node_modules', 'vite', 'bin', 'vite.js')], ['postbuild', join('scripts', 'postbuild.mjs')]]) {
        const r = spawnSync(process.execPath, what === 'tsc' ? [join(ROOT, file), '-b'] : what === 'vite' ? [join(ROOT, file), 'build'] : [join(ROOT, file)], { cwd: ROOT, encoding: 'utf8' })
        if (r.status !== 0) throw new Error(`${what} falhou:\n${r.stdout}${r.stderr}`)
      }
    }
    await withTimeout(record(), 15 * 60_000, 'gravação')
    await cleanup()
  }
  compose()
} catch (err) {
  console.error(err.stack ?? err.message)
  for (const [k, t] of [['T', T], ['A', A], ['B', B]]) {
    if (!t) continue
    const shot = await withTimeout(t.send('Page.captureScreenshot', { format: 'png' }), 8000, 'foto').catch(() => null)
    if (shot) writeFileSync(join(OUT, `falha-${k}.png`), Buffer.from(shot.data, 'base64'))
  }
  code = 1
} finally {
  await cleanup()
}
process.exit(code)
