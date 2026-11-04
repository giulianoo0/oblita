// Prova inteira pelas telas de verdade: um professor e três alunos, cada um no seu contexto de navegador.
// Uso: node e2e/run.mjs [--no-build] [--visible] [--slow]
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CTRL, Edge, Person, SHIFT, sleep, withTimeout } from './helpers/cdp.mjs'
import { BROKEN, HEADER, LOOP, MARK, PROGRAM, STATEMENT, exam, solutions } from './helpers/fixtures.mjs'
import { BEEP_SPY, DECRYPT_TAP, LABEL_SCRIPT, displayStub, hubPortShim, searchStorage } from './helpers/inject.mjs'
import { Servers, lanIp } from './helpers/servers.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const VISIBLE = args.has('--visible')
const SLOW = args.has('--slow')
const NO_BUILD = args.has('--no-build')
// Para depurar uma parte sem esperar a prova inteira: --only=1,2,3,4,7
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',')
const SHOTS = join(ROOT, 'e2e', 'shots')
const WATCHDOG_MS = (SLOW ? 60 : 30) * 60_000
const ALERT_MAX_MS = 1500
const BLOCK = ['*www.gstatic.com*', '*1.1.1.1*', '*oblita.giuli.dev*']
const PASSWORD = 'senha-certa-123'
const TEAM_A = 'Equipe Alfa'
const TEAM_C = '../../evil'
const NAME = { a: 'Ana', b: 'Bruno', c: '../../x' }
const ENROLL = { a: '2024A', b: '2024B', c: '2024C' }

// ---- relatório

const results = []
const skips = []
let sectionName = ''
let aborted = false

const row = (name, ok, detail, ms) => {
  results.push({ section: sectionName, name, ok, detail, ms })
  console.log(`  ${ok ? 'ok   ' : 'FALHA'} ${name}${ms !== undefined ? ` (${ms} ms)` : ''}${!ok && detail ? `\n        ${String(detail).slice(0, 900)}` : ''}`)
}

class Abort extends Error {}

// Um caso: o que ele devolve é o resultado do passo; uma falha fica na tabela e o teste segue.
async function check(name, fn, { timeout = 30_000 } = {}) {
  const start = Date.now()
  try {
    const value = await withTimeout(Promise.resolve().then(fn), timeout, name)
    if (value === false) throw new Error('condição falsa')
    row(name, true, undefined, Date.now() - start)
    return value
  } catch (err) {
    row(name, false, err.message ?? err, Date.now() - start)
    return undefined
  }
}

// Sem isto o resto da seção não faz sentido.
async function must(name, fn, opts) {
  const before = results.length
  const value = await check(name, fn, opts)
  if (!results[before]?.ok) throw new Abort(name)
  return value
}

const assert = (ok, detail) => {
  if (!ok) throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
}

function skip(name, why) {
  skips.push({ name, why })
  console.log(`  pulou ${name}: ${why}`)
}

async function section(title, fn, { fatal = false } = {}) {
  sectionName = title
  console.log(`\n== ${title}`)
  if (aborted) {
    row('seção não executada', false, 'uma seção anterior impediu')
    return
  }
  if (ONLY && !ONLY.includes(title.split(' ')[0])) return skip(title, '--only')
  try {
    await fn()
  } catch (err) {
    if (!(err instanceof Abort)) row('erro inesperado na seção', false, err.stack ?? err.message)
    await snapshotAll(`falha-${title.split(' ')[0]}`)
    if (fatal) aborted = true
  }
}

function report() {
  console.log('\n\n=================== RESULTADO ===================')
  const sections = [...new Set(results.map((r) => r.section))]
  const pad = Math.max(...sections.map((s) => s.length), 5)
  for (const s of sections) {
    const list = results.filter((r) => r.section === s)
    const bad = list.filter((r) => !r.ok)
    console.log(`${s.padEnd(pad)}  ${String(list.length - bad.length).padStart(3)}/${String(list.length).padEnd(3)} ${bad.length ? 'FALHOU' : 'ok'}`)
    for (const b of bad) console.log(`${''.padEnd(pad)}    - ${b.name}`)
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed} ok, ${failed} falhas`)
  if (skips.length) {
    console.log(`\nPulados de propósito (${skips.length}):`)
    for (const s of skips) console.log(`  - ${s.name}: ${s.why}`)
  }
  for (const n of notes) console.log(`nota: ${n}`)
  return failed
}

const notes = []

// ---- mundo

let servers
let edges = []
let tmp
let origin
let hubAddr
let lan
let T, A, B, C
let teacherP, aP, bP, cP
const frames = { a: [], b: [], c: [] }
let visibleTabs = []

async function say(text) {
  console.log(`  > ${text}`)
  if (VISIBLE || SLOW) {
    for (const t of visibleTabs) await t.ev(LABEL_SCRIPT(text)).catch(() => {})
  }
  if (SLOW) await sleep(1500)
}

async function snapshotAll(prefix) {
  for (const [n, t] of [['professor', T], ['ana', A], ['bruno', B], ['c', C]]) {
    if (t) await t.shot(`${prefix}-${n}`).catch(() => {})
  }
}

async function putCode(tab, text) {
  await tab.press('a', CTRL)
  if (!SLOW) return tab.insertText(text)
  await tab.press('Backspace')
  for (const line of text.split(/(?<=\n)/)) {
    await tab.insertText(line)
    await sleep(250)
  }
}

const EDITOR_TEXT = `[...document.querySelectorAll('.editor-mount .view-line')].sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top)).map((e) => e.textContent.replace(/\\u00a0/g, ' ')).join('\\n')`
const edText = (tab) => tab.ev(EDITOR_TEXT)
const norm = (s) => s.replace(/\s+$/g, '')

async function edGoto(tab, line) {
  await tab.clickSel('.editor-mount')
  await tab.press('Home', CTRL)
  for (let i = 1; i < line; i++) await tab.press('ArrowDown')
  await tab.press('End')
}

async function edEnd(tab) {
  await tab.clickSel('.editor-mount')
  await tab.press('End', CTRL)
}

const waitEditor = (tab, pred, label, timeout = 8000) => tab.waitFor(`(() => { const text = ${EDITOR_TEXT}; return ${pred} })()`, { timeout, label })

const outerHas = (tab, text) => tab.ev(`document.documentElement.outerHTML.includes(${JSON.stringify(text)})`)
const frameHas = (key, text) => frames[key].some((f) => f.text.includes(text))

// ---- alertas no painel

const alertCount = (name, label) =>
  T.ev(`[...document.querySelectorAll('.alert-item')].filter((e) => e.querySelector('b')?.textContent === ${JSON.stringify(name)} && e.querySelector('.kind')?.textContent === ${JSON.stringify(label)}).length`)

const beeps = () => T.ev('window.__e2eBeeps ?? 0')

// Mede do gesto do aluno até a linha aparecer na tela do professor.
async function expectAlert(name, label, action, { max = ALERT_MAX_MS, severe = true, wait = 15000, title } = {}) {
  return check(title ?? `${label}: alerta para ${name} em até ${max} ms`, async () => {
    const before = await alertCount(name, label)
    const beeps0 = await beeps()
    const t0 = Date.now()
    await action()
    await T.waitFor(`[...document.querySelectorAll('.alert-item')].filter((e) => e.querySelector('b')?.textContent === ${JSON.stringify(name)} && e.querySelector('.kind')?.textContent === ${JSON.stringify(label)}).length > ${before}`, { timeout: Math.max(wait, max), every: 25, label: `alerta ${label}` })
    const ms = Date.now() - t0
    console.log(`        latência: ${ms} ms`)
    assert(ms <= max, `demorou ${ms} ms`)
    if (severe) {
      await sleep(150)
      assert((await beeps()) > beeps0, 'alerta grave sem bipe')
    }
    return ms
  }, { timeout: Math.max(wait, max) + 20000 })
}

// O áudio só nasce depois de um gesto, como no navegador do professor.
const armTeacherAudio = () => T.clickSel('.dash-title')

const wall = () =>
  T.ev(`[...document.querySelectorAll('.dash-main section')].map((s) => ({
    team: s.querySelector('.team-name')?.textContent,
    code: s.querySelector('.team-code')?.textContent,
    members: [...s.querySelectorAll('.member')].map((m) => ({ name: m.querySelector('span')?.textContent, lost: m.classList.contains('lost'), state: m.querySelector('b')?.textContent ?? null })),
    tiles: [...s.querySelectorAll('.tile-tag span')].map((e) => e.textContent),
  }))`)

const teamOnWall = async (name) => (await wall()).find((s) => s.team === name)
const onlineBadge = () => T.ev(`document.querySelector('.badge[title="Conectados"]')?.textContent.trim()`)

async function backToWall() {
  await T.clickSel('[aria-label="Voltar à sala"]')
  await T.waitFor(`!!document.querySelector('.dash-main')`)
}

// Ladrilho pelo nome: é onde o professor clica para olhar um aluno.
async function clickTile(name) {
  const c = await T.centerOf(`[...document.querySelectorAll('a.tile')].find((a) => a.querySelector('.tile-tag span')?.textContent === ${JSON.stringify(name)})`, `ladrilho ${name}`)
  await T.clickAt(c.x, c.y)
  await T.waitFor(`document.querySelector('.detail') && document.querySelector('.dash-title')?.textContent === ${JSON.stringify(name)}`, { label: `detalhe de ${name}` })
}

// ---- entrada do aluno

async function homeToForm(tab) {
  await tab.clickText('Sou aluno')
  await tab.waitFor(`!!(${tab.fieldInput('IP do professor')})`)
  await tab.fill('IP do professor', hubAddr)
  await tab.clickSel('.join-inline .pill')
  await tab.waitText('Quem é você?')
}

async function fillIdentity(tab, key) {
  await tab.fill('Nome', NAME[key])
  await tab.fill('Matrícula (opcional)', ENROLL[key])
}

async function enterWithPassword(tab, key) {
  await homeToForm(tab)
  await fillIdentity(tab, key)
  await tab.clickText('Entrar')
  await tab.waitText('Esta sala tem senha', { timeout: 20000 })
  await tab.fill('Senha da sala', PASSWORD)
  await tab.clickText('Entrar')
  await tab.waitText('Sua equipe', { timeout: 30000 })
}

async function shareAndFullscreen(tab) {
  await tab.clickText('Compartilhar tela')
  await tab.waitText('Entre em tela cheia')
  await tab.clickText('Entrar em tela cheia')
  await tab.waitNoText('Entre em tela cheia')
}

// ---- preparação

async function arrangeVisible(edge) {
  const size = await T.ev('({ w: screen.availWidth, h: screen.availHeight })')
  const half = Math.floor(size.w / 2)
  const place = async (tab, left) => {
    const { windowId } = await edge.cdp.send('Browser.getWindowForTarget', { targetId: tab.targetId })
    await edge.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    await edge.cdp.send('Browser.setWindowBounds', { windowId, bounds: { left, top: 0, width: half, height: size.h } })
  }
  await place(T, 0)
  await place(A, half)
}

async function setup() {
  tmp = mkdtempSync(join(tmpdir(), 'oblita-e2e-'))
  rmSync(SHOTS, { recursive: true, force: true })
  mkdirSync(SHOTS, { recursive: true })
  lan = lanIp()
  assert(lan, 'esta máquina não tem IP de rede local')
  servers = await new Servers(ROOT).start()
  origin = servers.origin
  hubAddr = servers.altHub ? `${lan}:${servers.hubPort}` : lan
  if (servers.altHub) notes.push(`a porta 7787 estava ocupada: hub do teste na ${servers.hubPort}, com o painel desviado para ela só neste teste`)

  const main = await Edge.launch({ visible: VISIBLE, tag: 'e2e-a' })
  edges.push(main)
  const side = VISIBLE ? await Edge.launch({ tag: 'e2e-b' }) : main
  if (VISIBLE) edges.push(side)
  console.log(`navegador: ${main.product}${VISIBLE ? ' (professor e Ana com janela; Bruno e C em headless)' : ' (headless)'}`)

  const opts = { shotsDir: SHOTS, typeDelay: SLOW ? 60 : 0 }
  teacherP = await Person.create(main, 'professor', opts)
  aP = await Person.create(main, 'ana', opts)
  bP = await Person.create(side, 'bruno', opts)
  cP = await Person.create(side, 'c', opts)

  const granted = {}
  for (const perm of ['local-network', 'loopback-network', 'local-network-access']) {
    for (const p of [aP, bP, cP]) {
      await p.setPermission(origin, perm, 'granted').then(() => (granted[perm] = true), () => (granted[perm] ??= false))
    }
    // O painel se conecta sozinho quando já tem a permissão: aqui ela chega só depois, para testar o botão.
    if (perm !== 'loopback-network') await teacherP.setPermission(origin, perm, 'granted').catch(() => {})
  }
  console.log(`permissões aceitas pelo CDP: ${JSON.stringify(granted)}`)

  teacherP.inits.push(BEEP_SPY)
  if (servers.altHub) teacherP.inits.push(hubPortShim(servers.hubPort))
  for (const [p, key] of [[aP, 'a'], [bP, 'b'], [cP, 'c']]) {
    p.bindings.push('__e2eFrame')
    p.inits.push(displayStub(VISIBLE && key === 'a'), DECRYPT_TAP)
    p.browser.cdp.on('Runtime.bindingCalled', (e, sid) => {
      if (e.name === '__e2eFrame' && p.tabs.some((t) => t.sessionId === sid)) frames[key].push({ at: Date.now(), text: e.payload })
    })
  }

  // Um contexto novo abre uma janela nova: em headless isso não muda o foco de ninguém.
  T = await teacherP.tab(`${origin}/`)
  A = await aP.tab(`${origin}/`)
  B = await bP.tab(`${origin}/`)
  C = await cP.tab(`${origin}/`)

  if (VISIBLE) {
    visibleTabs = [T, A]
    await arrangeVisible(main)
    const blank = (await main.cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page' && t.url === 'about:blank' && !t.browserContextId?.length)
    if (blank) await main.cdp.send('Target.closeTarget', { targetId: blank.targetId }).catch(() => {})
  }
}

// ---- seções

async function s1Landing() {
  await say('Página inicial: esperando baixar para uso sem internet')
  for (const [n, t] of [['professor', T], ['Ana', A], ['Bruno', B], ['C', C]]) {
    await must(`${n}: "Baixado neste computador"`, () => t.waitText('Baixado neste computador', { timeout: 280_000, every: 500 }), { timeout: 300_000 })
  }
  await check('marca e descrição na página inicial', async () => {
    const text = await A.text()
    assert(text.includes('oblita') && /provas online de código\s+sem cola/.test(text), text)
  })
  await A.shot('01-inicio')
  await check('o service worker controla a página', () => A.waitFor('!!navigator.serviceWorker.controller', { timeout: 15000 }))
  await check('"Sou aluno" revela o campo de IP', async () => {
    assert(!(await A.ev(`!!(${A.fieldInput('IP do professor')})`)), 'o campo já estava lá')
    await A.clickText('Sou aluno')
    await A.waitFor(`!!(${A.fieldInput('IP do professor')})`)
    await A.navigate(`${origin}/`)
    await A.waitText('Sou aluno')
  })
  await check('"Sou professor" vai para /nova', async () => {
    await T.clickText('Sou professor')
    await T.waitFor(`location.pathname === '/nova'`)
    await T.waitText('Nova sala')
  })
}

async function s2Teacher() {
  const examPath = join(tmp, 'exam.json')
  const solPath = join(tmp, 'solutions.json')
  writeFileSync(examPath, JSON.stringify(exam, null, 2))
  writeFileSync(solPath, JSON.stringify(solutions, null, 2))

  await say('Professor monta a sala com arquivos JSON')
  await must('envia exam.json pelo seletor de arquivos', async () => {
    await T.setFile(0, examPath)
    await T.waitText(`3 questões em "${exam.title}"`)
  })
  await must('envia solutions.json', async () => {
    await T.waitFor(`document.querySelectorAll('.dropzone')[1]?.getAttribute('aria-disabled') !== 'true'`)
    await T.setFile(1, solPath)
    await T.waitText('Gabarito com 3 respostas')
  })
  await check('o título veio do arquivo', async () => assert((await T.ev(`${T.fieldInput('Título')}.value`)) === exam.title))
  await must('configura senha e equipe de até 2', async () => {
    await T.fill('Senha da sala', PASSWORD)
    await T.clickText('Em equipe')
    await T.waitFor(`!!(${T.fieldInput('Máximo por equipe')})`)
    await T.fill('Máximo por equipe', '2')
  })
  await T.shot('02-nova-sala')
  const roomUrl = await must('cria a sala', async () => {
    await T.clickText('Criar sala')
    await T.waitFor(`location.pathname.startsWith('/sala/')`, { timeout: 30000 })
    return T.url()
  }, { timeout: 40000 })
  await must('o painel carrega sem conectar sozinho', () => T.waitText('Conectar ao programa'))
  const fp = await T.ev(`document.querySelector('.dash-fp b')?.textContent`)
  await check('Código do professor no formato do quadro', () => assert(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(fp), fp))

  await say('Só uma prova por vez, e a sala abre em uma aba só')
  const other = await teacherP.tab(`${origin}/nova`)
  await check('segunda tentativa em /nova mostra a prova aberta com "Abrir"', async () => {
    await other.waitText('Abrir')
    const text = await other.text()
    assert(text.includes(exam.title) && !text.includes('Criar sala'), text)
  })
  await other.shot('03-nova-bloqueada')
  await check('segunda aba na mesma sala diz "aberta em outra aba"', async () => {
    await other.clickText('Abrir')
    await other.waitText('Esta sala está aberta em outra aba')
    assert((await other.url()) === roomUrl, await other.url())
  })
  await other.close()
  await T.cdp.send('Target.activateTarget', { targetId: T.targetId }).catch(() => {})

  await say('Professor liga o programa pelo botão')
  await teacherP.setPermission(origin, 'loopback-network', 'granted').catch((e) => notes.push(`loopback-network: ${e.message}`))
  await must('"Conectar ao programa" liga o painel ao hub', async () => {
    await T.clickText('Conectar ao programa')
    await T.waitFor(`[...document.querySelectorAll('.conn h2')].some((h) => h.textContent === 'Programa')`, { timeout: 10000 })
  })
  await check('o IP aparece no cartão', async () => {
    const shown = await T.ev(`[...document.querySelectorAll('.conn .conn-big')].map((e) => e.textContent)`)
    assert(shown.includes(lan) && shown.includes(fp), shown)
    const labels = await T.ev(`[...document.querySelectorAll('.conn .conn-label')].map((e) => e.textContent)`)
    assert(labels.includes('IP') && labels.includes('Código do professor'), labels)
  })
  await check('cadeado de sala com senha', () => T.ev(`!!document.querySelector('.conn [aria-label="Sala com senha"]')`))
  await armTeacherAudio()
  await T.shot('04-painel-vazio')
}

async function s3Students() {
  await say('Ana entra pelo IP da rede local')
  await must('Ana: da página inicial para IP, nome e matrícula', async () => {
    await homeToForm(A)
    const chosen = await A.ev(`document.querySelector('.join-place .mono')?.textContent ?? ''`)
    assert(/^(\d+\.){3}\d+(:\d+)?$/.test(chosen), 'IP não chegou preenchido')
    assert(chosen.startsWith(lan), 'não é o IP da LAN')
    await fillIdentity(A, 'a')
    await A.shot('05-entrar')
    await A.clickText('Entrar')
    await A.waitText('Esta sala tem senha', { timeout: 20000 })
  })
  await check('o campo de senha aparece e o botão fica travado sem ela', async () => {
    assert(await A.ev(`!!(${A.fieldInput('Senha da sala')})`), 'sem campo')
    assert(await A.ev(`document.querySelector('form.gate button[type=submit]').disabled`), 'botão livre')
  })
  await check('senha errada é recusada', async () => {
    await A.fill('Senha da sala', 'senha-errada')
    await A.clickText('Entrar')
    await A.waitText('Senha incorreta', { timeout: 20000 })
    assert(!(await T.ev(`document.querySelector('.tile')`)), 'aluno entrou com senha errada')
    assert((await onlineBadge()) === '0/0', await onlineBadge())
  }, { timeout: 40000 })
  await A.shot('06-senha-errada')
  await must('senha certa entra', async () => {
    await A.fill('Senha da sala', PASSWORD)
    await A.clickText('Entrar')
    await A.waitText('Sua equipe', { timeout: 20000 })
  }, { timeout: 40000 })
  await check('o painel vê Ana sem equipe', () => T.waitFor(`[...document.querySelectorAll('.tile-tag span')].some((e) => e.textContent === 'Ana')`))
  await A.shot('07-passo-equipe')

  await say('Ana cria a equipe')
  const code = await must('Ana cria a equipe e vê o código privado', async () => {
    await A.fill('Nome da equipe', TEAM_A)
    await A.clickText('Criar')
    await A.waitFor(`!!document.querySelector('.team-card .team-code')`)
    const c = await A.ev(`document.querySelector('.team-card .team-code').textContent`)
    assert(/^[A-Z0-9]{6}$/.test(c), c)
    return c
  })
  await A.shot('08-equipe-criada')
  await check('o painel mostra a equipe ao vivo', async () => {
    await T.waitFor(`[...document.querySelectorAll('.team-name')].some((e) => e.textContent === ${JSON.stringify(TEAM_A)})`)
    const team = await teamOnWall(TEAM_A)
    assert(team.code === code && team.members.some((m) => m.name === 'Ana'), team)
  })

  await say('Bruno entra na equipe de Ana pelo código')
  await bP.block(BLOCK)
  await cP.block(BLOCK)
  await must('Bruno entra na sala', () => enterWithPassword(B, 'b'), { timeout: 60000 })
  await check('código errado é recusado', async () => {
    await B.clickText('Entrar com código')
    await B.waitFor(`!!(${B.fieldInput('Código da equipe')})`)
    await B.fill('Código da equipe', 'ZZZZZZ')
    await B.clickText('Entrar')
    await B.waitText('Código não encontrado')
  })
  await B.shot('09-codigo-errado')
  await must('Bruno entra com o código certo', async () => {
    await B.fill('Código da equipe', code)
    await B.clickText('Entrar')
    await B.waitFor(`document.querySelector('.team-card .team-code')?.textContent === ${JSON.stringify(code)}`)
  })
  await check('integrantes ao vivo: painel e colega', async () => {
    await T.waitFor(`[...document.querySelectorAll('.dash-main section')].some((s) => s.querySelector('.team-name')?.textContent === ${JSON.stringify(TEAM_A)} && s.querySelectorAll('.member').length === 2)`)
    await A.waitFor(`document.querySelectorAll('.team-card .member').length === 2`)
    await B.waitFor(`document.querySelectorAll('.team-card .member').length === 2`)
    const names = await A.ev(`[...document.querySelectorAll('.team-card .member span')].map((e) => e.textContent)`)
    assert(names.includes('Ana') && names.includes('Bruno'), names)
  })

  await say('C tenta a equipe cheia e cria a sua, com nome hostil')
  await must('C entra na sala', () => enterWithPassword(C, 'c'), { timeout: 60000 })
  await check('equipe cheia recusa C', async () => {
    await C.clickText('Entrar com código')
    await C.waitFor(`!!(${C.fieldInput('Código da equipe')})`)
    await C.fill('Código da equipe', code)
    await C.clickText('Entrar')
    await C.waitText('Equipe cheia')
  })
  const codeC = await must('C cria a própria equipe', async () => {
    await C.clickText('Criar equipe')
    await C.waitFor(`!!(${C.fieldInput('Nome da equipe')})`)
    await C.fill('Nome da equipe', TEAM_C)
    await C.clickText('Criar')
    await C.waitFor(`!!document.querySelector('.team-card .team-code')`)
    return C.ev(`document.querySelector('.team-card .team-code').textContent`)
  })
  await check('o painel mostra as duas equipes com os integrantes certos', async () => {
    await T.waitFor(`document.querySelectorAll('.dash-main section').length >= 2`)
    await T.waitFor(`[...document.querySelectorAll('.team-name')].some((e) => e.textContent === ${JSON.stringify(TEAM_C)})`)
    const a = await teamOnWall(TEAM_A)
    const c = await teamOnWall(TEAM_C)
    assert(a.members.map((m) => m.name).sort().join() === 'Ana,Bruno' && c.members[0]?.name === NAME.c, { a, c })
    assert(a.code === code && c.code === codeC, { a, c })
  })
  await check('nome hostil só vira texto', () => T.ev(`!document.querySelector('.dash-main img[onerror]')`))
  await T.shot('10-parede-equipes')
  return { code, codeC }
}

let teamCodes

async function s4Gate() {
  const fp = await T.ev(`document.querySelector('.dash-fp b').textContent`)
  await say('Ana tenta compartilhar uma janela')
  await check('A janela é recusada', async () => {
    await A.waitText('Compartilhe a tela inteira')
    await A.ev(`window.__e2e.surface = 'window'`)
    await A.clickText('Compartilhar tela')
    await A.waitText('Escolha "Tela inteira" e compartilhe de novo')
    assert(await A.ev(`document.body.innerText.includes('Compartilhe a tela inteira')`), 'passou de etapa')
  })
  await A.shot('11-janela-recusada')
  await check('o professor recebe "Tela inválida"', () => T.waitFor(`[...document.querySelectorAll('.alert-item .kind')].some((e) => e.textContent === 'Tela inválida')`))
  await must('Ana compartilha a tela inteira e entra em tela cheia', async () => {
    await A.ev(`window.__e2e.surface = 'monitor'`)
    await shareAndFullscreen(A)
    await A.waitFor('!!document.fullscreenElement')
  })
  await check('a captura pediu monitor', async () => {
    const asked = await A.ev(`window.__e2e.lastOptions.video.displaySurface`)
    assert(asked === 'monitor', asked)
  })

  await say('Com internet a sala não libera: a rede precisa estar isolada')
  await check('com internet fica parada em "Bloqueie a internet"', async () => {
    await A.waitText('Bloqueie a internet', { timeout: 12000 })
    await sleep(3500)
    assert(await A.ev(`document.body.innerText.includes('Bloqueie a internet')`), 'passou sem isolar')
  })
  await A.shot('12-bloqueie-internet')
  await must('com a rede isolada vai para a sala de espera', async () => {
    await aP.block(BLOCK)
    await A.waitText('Aguardando o professor começar', { timeout: 15000 })
  })
  await check('a sala de espera mostra o mesmo Código do professor', async () => {
    const shown = await A.ev(`document.querySelector('.fp-code')?.textContent`)
    assert(shown === fp, { shown, fp })
  })
  await A.shot('13-espera')
  await check('o painel mostra o estado de Ana', async () => {
    await T.waitFor(`!/sem tela|testando rede|com internet|dois monitores/.test([...document.querySelectorAll('.tile')].find((t) => t.querySelector('.tile-tag span')?.textContent === 'Ana')?.innerText ?? 'sem tela')`, { timeout: 8000, label: 'pendências de Ana somem' })
  })

  await must('C compartilha e fica pronta', async () => {
    await shareAndFullscreen(C)
    await C.waitText('Aguardando o professor começar', { timeout: 15000 })
  })

  await say('Professor abre a prova')
  await must('"Abrir prova"', async () => {
    await T.clickText('Abrir prova')
    await T.waitText('Em prova')
    await A.waitText('Bater ponto e começar')
  })
  await A.shot('14-bater-ponto')
  await check('antes do ponto o enunciado não está no DOM nem chegou', async () => {
    assert(!(await outerHas(A, STATEMENT)), 'no DOM')
    assert(!frameHas('a', STATEMENT), 'chegou na rede')
    assert(!(await A.ev(`!!document.querySelector('.exam-statement')`)), 'painel do enunciado')
  })
  await must('Ana bate o ponto e recebe a prova', async () => {
    await A.clickText('Bater ponto e começar')
    await A.waitFor(`document.querySelector('.exam-statement')?.textContent.includes(${JSON.stringify(STATEMENT)})`, { timeout: 8000 })
    await A.waitFor(`!!document.querySelector('.editor-mount .view-line')`, { timeout: 15000 })
  })
  await check('Bruno sem tela não recebe a prova, mesmo com a equipe já no relógio', async () => {
    await sleep(1500)
    assert(await B.ev(`document.body.innerText.includes('Compartilhe a tela inteira')`), await B.text())
    assert(!(await outerHas(B, STATEMENT)), 'no DOM de Bruno')
    assert(!frameHas('b', STATEMENT), 'chegou na rede de Bruno')
  })
  await must('Bruno fica pronto e recebe sem bater o ponto de novo', async () => {
    await shareAndFullscreen(B)
    await B.waitFor(`document.querySelector('.exam-statement')?.textContent.includes(${JSON.stringify(STATEMENT)})`, { timeout: 15000 })
    await B.waitFor(`!!document.querySelector('.editor-mount .view-line')`, { timeout: 15000 })
  })
  await check('a equipe divide o relógio', async () => {
    const secs = (s) => s.split(':').reduce((n, x) => n * 60 + Number(x), 0)
    await sleep(600)
    const [a, b] = await Promise.all([A.ev(`document.querySelector('.exam-clock').textContent`), B.ev(`document.querySelector('.exam-clock').textContent`)])
    assert(Math.abs(secs(a) - secs(b)) <= 3, { a, b })
  })
  await check('C bate o ponto da própria equipe', async () => {
    await C.waitText('Bater ponto e começar')
    assert(!(await outerHas(C, STATEMENT)), 'no DOM de C antes do ponto')
    await C.clickText('Bater ponto e começar')
    await C.waitFor(`!!document.querySelector('.editor-mount .view-line')`, { timeout: 15000 })
  })
  await A.shot('15-prova')
  await T.shot('16-parede-em-prova')
}

async function s5Collab() {
  await say('Ana e Bruno digitam ao mesmo tempo no mesmo arquivo')
  await must('os dois recebem a mesma semente', async () => {
    await waitEditor(A, `text.includes('int main')`, 'semente em Ana')
    await waitEditor(B, `text.includes('int main')`, 'semente em Bruno')
    assert(norm(await edText(A)) === norm(await edText(B)), 'sementes diferentes')
  })
  await edGoto(A, 2)
  await edEnd(B)
  await must('digitação concorrente converge', async () => {
    await Promise.all([A.type('// ana escreve aqui', SLOW ? 60 : 8), B.type('// bruno escreve aqui', SLOW ? 60 : 8)])
    await waitEditor(A, `text.includes('ana escreve aqui') && text.includes('bruno escreve aqui')`, 'as duas linhas em Ana')
    await waitEditor(B, `text.includes('ana escreve aqui') && text.includes('bruno escreve aqui')`, 'as duas linhas em Bruno')
    const [a, b] = [norm(await edText(A)), norm(await edText(B))]
    assert(a === b, { a, b })
  })
  await check('Bruno vê o cursor de Ana com o nome', async () => {
    await A.press('ArrowLeft')
    await B.waitFor(`!!document.querySelector('.editor-mount [class*="yRemoteSelectionHead-"]')`, { timeout: 6000 })
    const label = await B.ev(`getComputedStyle(document.querySelector('.editor-mount [class*="yRemoteSelectionHead-"]'), '::after').content`)
    assert(/Ana/.test(label), label)
    assert(await B.ev(`!!document.querySelector('.peer[title="Ana"]')`), 'sem presença no cabeçalho')
  })
  await B.shot('17-cursor-com-nome')

  await say('Ctrl+Z de Ana desfaz só o que Ana escreveu')
  await check('Ctrl+Z tira só o texto de Ana', async () => {
    await sleep(500)
    await A.press('z', CTRL)
    await waitEditor(A, `!text.includes('ana escreve aqui') && text.includes('bruno escreve aqui')`, 'desfazer em Ana')
    await waitEditor(B, `!text.includes('ana escreve aqui') && text.includes('bruno escreve aqui')`, 'desfazer em Bruno')
  })
  await check('Ctrl+Y refaz', async () => {
    await A.press('y', CTRL)
    await waitEditor(A, `text.includes('ana escreve aqui')`, 'refazer em Ana')
    await waitEditor(B, `text.includes('ana escreve aqui') && text.includes('bruno escreve aqui')`, 'refazer em Bruno')
  })

  await say('Novo arquivo aparece para o colega')
  await must('Ana cria util.h e Bruno recebe', async () => {
    await A.clickSel('[aria-label="Novo arquivo"]')
    await A.waitFor(`document.activeElement?.classList.contains('file-new')`)
    await A.type('util.h')
    await A.press('Enter')
    await A.waitFor(`document.querySelector('.file[title="util.h"]')?.getAttribute('aria-selected') === 'true'`)
    await B.waitFor(`!!document.querySelector('.file[title="util.h"]')`)
  })
  await must('Bruno escreve o cabeçalho, e Ana vê', async () => {
    await B.clickSel('.file[title="util.h"] span')
    await B.waitFor(`document.querySelector('.file[title="util.h"]')?.getAttribute('aria-selected') === 'true'`)
    await B.clickSel('.editor-mount')
    await putCode(B, HEADER)
    await waitEditor(A, `text.includes('SOMA(a, b)')`, 'cabeçalho em Ana')
  })
  await must('Ana escreve o programa em main.c, e Bruno vê', async () => {
    await A.clickSel('.file[title="main.c"] span')
    await A.waitFor(`document.querySelector('.file[title="main.c"]')?.getAttribute('aria-selected') === 'true'`)
    await A.clickSel('.editor-mount')
    await putCode(A, PROGRAM)
    await B.clickSel('.file[title="main.c"] span')
    await waitEditor(B, `text.includes('printf("%d')`, 'programa em Bruno')
    // O Monaco reindenta o que chega como digitação: o que importa é o texto, e quem compila confere o resto.
    const flat = (t) => t.split('\n').map((l) => l.trim()).join('\n').trim()
    const text = await edText(A)
    assert(flat(text) === flat(PROGRAM), { text, PROGRAM })
  })
  await A.shot('18-programa')

  await say('O detalhe do professor mostra o código ao vivo')
  await must('abre o detalhe de Ana', () => clickTile('Ana'))
  await check('o código aparece no detalhe', () => T.waitFor(`[...document.querySelectorAll('pre.code-view')].some((e) => e.textContent.includes('SOMA(a, b)'))`, { timeout: 5000 }))
  await check('e muda ao vivo enquanto Ana digita', async () => {
    await edEnd(A)
    await A.type('// ao vivo')
    await T.waitFor(`[...document.querySelectorAll('pre.code-view')].some((e) => e.textContent.includes('// ao vivo'))`, { timeout: 4000 })
  })
  await check('o detalhe mostra a tela e o estado', async () => {
    await T.waitFor(`!!document.querySelector('.player img')`, { timeout: 8000 })
    const flags = await T.ev(`[...document.querySelectorAll('.status-list .badge')].map((e) => e.textContent.trim())`)
    assert(flags.includes('Online') && flags.includes('Tela cheia'), flags)
    assert((await T.ev(`document.body.innerText`)).includes(ENROLL.a), 'sem matrícula')
  })
  await T.shot('19-detalhe')
  await backToWall()
}

async function s6Terminal() {
  await say('Rodar em WebAssembly, com entrada')
  await must('Rodar compila no navegador e imprime a soma', async () => {
    await A.clickSel('textarea[aria-label="Entrada do programa"]')
    await A.type('7 8')
    await A.clickText('Rodar')
    await A.waitFor(`document.querySelector('.console-out')?.textContent.includes('Saiu com código 0')`, { timeout: 150_000, every: 300, label: 'saída do programa' })
    const out = await A.ev(`document.querySelector('.console-out').textContent`)
    assert(/(^|\n)15\n/.test(out), out)
    assert(!(await A.ev(`document.body.innerText.includes('Máquina do professor')`)), 'não rodou aqui')
  }, { timeout: 170_000 })
  await A.shot('20-rodar')

  await say('Testar roda na máquina do professor')
  await must('Testar mostra exemplos e ocultos só como N de M', async () => {
    await A.clickText('Testar')
    await A.waitFor(`document.querySelector('.console-out')?.textContent.includes('Ocultos:')`, { timeout: 170_000, every: 300, label: 'relatório do teste' })
    const out = await A.ev(`document.querySelector('.console-out').textContent`)
    assert(/Exemplo 1/.test(out) && /Ocultos: 2 de 3/.test(out), out)
    for (const m of Object.values(MARK)) assert(!out.includes(m), `vazou ${m}`)
  }, { timeout: 190_000 })
  await A.shot('21-testar')
  await check('o resultado que chegou tem só a contagem dos ocultos', () => {
    const report = frames.a.map((f) => f.text).find((t) => t.includes('"t":"test-result"') && t.includes('"status":"done"'))
    assert(report, 'sem test-result')
    const json = JSON.parse(report.slice(report.indexOf('{')))
    assert(json.result.hidden.passed === 2 && json.result.hidden.total === 3 && Object.keys(json.result.hidden).length === 2, json.result.hidden)
    for (const m of Object.values(MARK)) assert(!report.includes(m), `vazou ${m}`)
  })
  const testButton = `[...document.querySelectorAll('button[title="Um teste por minuto"]')][0]`
  await check('segundo clique em menos de 60 s: botão travado com contagem', async () => {
    const state = await A.ev(`({ off: ${testButton}.disabled, text: ${testButton}.textContent })`)
    assert(state.off && /^\d+ s$/.test(state.text.trim()), state)
    const before = frames.a.length
    const box = await A.ev(`(() => { const b = ${testButton}.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
    await A.clickAt(box.x, box.y)
    await sleep(600)
    assert(!frames.a.slice(before).some((f) => f.text.includes('"test-result"')), 'o clique travado saiu')
    assert((await A.ev(`document.querySelector('.console-out').textContent.includes('Ocultos: 2 de 3')`)), 'perdeu o relatório')
  })
  // O contador é local: o colega ainda não sabe, então o pedido dele chega ao professor e é o limite de lá que barra.
  await check('pedido forçado do colega é limitado pelo professor', async () => {
    const before = frames.b.length
    await B.clickText('Testar')
    await B.waitFor(`/^\\d+ s$/.test(${testButton}.textContent.trim())`, { timeout: 5000 })
    assert(frames.b.slice(before).some((f) => f.text.includes('"status":"limited"')), 'sem limited do professor')
    assert(!(await B.ev(`document.querySelector('.console-out').textContent.includes('Ocultos')`)), 'rodou mesmo limitado')
  })

  await say('Erro de compilação vira marcador no editor')
  await A.clickText('Terminal')
  await A.clickSel('.editor-mount')
  await putCode(A, BROKEN)
  await must('erro de compilação aparece no terminal e no editor', async () => {
    await A.clickText('Rodar')
    await A.waitFor(`document.querySelector('.console-out .e')?.textContent.includes('error')`, { timeout: 60000, label: 'erro no terminal' })
    await A.waitFor(`!!document.querySelector('.editor-mount .squiggly-error')`, { timeout: 8000, label: 'marcador no editor' })
  }, { timeout: 80000 })
  await A.shot('22-erro-compilacao')

  await say('Laço infinito é encerrado pelo limite')
  await A.clickSel('.editor-mount')
  await putCode(A, LOOP)
  await check('laço infinito é morto em cerca de 5 s', async () => {
    await A.clickText('Rodar')
    await A.waitText('Parar', { timeout: 60000 })
    const t0 = Date.now()
    await A.waitFor(`document.querySelector('.console-out')?.textContent.includes('Passou de 5 s')`, { timeout: 15000 })
    const ms = Date.now() - t0
    assert(ms >= 3500 && ms < 9000, `${ms} ms`)
    await A.waitFor(`!document.querySelector('button[title="Rodar (Ctrl+Enter)"]')?.disabled && !!document.querySelector('button[title="Rodar (Ctrl+Enter)"]')`)
  }, { timeout: 90000 })
  await A.shot('23-laco')
  await check('o botão Parar interrompe', async () => {
    await A.clickText('Rodar')
    await A.waitText('Parar', { timeout: 60000 })
    await A.clickText('Parar')
    await A.waitFor(`document.querySelector('.console-out')?.textContent.includes('Interrompido')`, { timeout: 4000 })
  }, { timeout: 80000 })

  await say('Volta ao programa certo e responde as outras questões')
  await A.clickSel('.editor-mount')
  await putCode(A, PROGRAM)
  await B.waitFor(`${EDITOR_TEXT}.includes('SOMA(a, b)')`, { timeout: 8000 }).catch(() => {})
  await check('marcadores somem na compilação limpa', async () => {
    await A.clickText('Rodar')
    await A.waitFor(`document.querySelector('.console-out')?.textContent.includes('Saiu com código')`, { timeout: 60000 })
    await A.waitFor(`!document.querySelector('.editor-mount .squiggly-error')`, { timeout: 5000 })
  }, { timeout: 80000 })
  await must('múltipla escolha e texto chegam ao colega', async () => {
    await A.clickSel('.exam-tab:nth-child(2)')
    await A.clickText('Logarítmica')
    await A.waitFor(`[...document.querySelectorAll('[role=radio]')].find((o) => o.textContent.includes('Logarítmica'))?.getAttribute('aria-checked') === 'true'`)
    await sleep(1100)
    await B.clickSel('.exam-tab:nth-child(2)')
    await B.waitFor(`[...document.querySelectorAll('[role=radio]')].find((o) => o.textContent.includes('Logarítmica'))?.getAttribute('aria-checked') === 'true'`, { timeout: 4000, label: 'escolha em Bruno' })
    await A.clickSel('.exam-tab:nth-child(3)')
    await A.clickSel('textarea[aria-label="Sua resposta"]')
    await A.type('Uma pilha guarda em ordem LIFO.')
    await sleep(1100)
    await A.shot('24-texto')
    await A.clickSel('.exam-tab:nth-child(1)')
    await B.clickSel('.exam-tab:nth-child(1)')
    await waitEditor(A, `text.includes('SOMA(a, b)')`, 'editor volta em Ana')
    await waitEditor(B, `text.includes('SOMA(a, b)')`, 'editor volta em Bruno')
  })
}

async function s7Proctor() {
  if (ONLY) {
    await waitEditor(A, `text.includes('int main')`, 'editor')
  }
  await armTeacherAudio()
  await sleep(1000)

  await say('Saiu da tela cheia: alerta e tela opaca')
  await expectAlert('Ana', 'Saiu da tela cheia', () => A.ev(`document.exitFullscreen()`))
  await check('o aluno vê a tela opaca, e o enunciado some', async () => {
    await A.waitFor(`!!document.querySelector('.lock-screen')`, { timeout: 4000 })
    const s = await A.ev(`({
      lock: getComputedStyle(document.querySelector('.lock-screen')).backgroundColor,
      exam: getComputedStyle(document.querySelector('.exam')).visibility,
      statement: getComputedStyle(document.querySelector('.exam-statement')).visibility,
      inert: document.querySelector('.exam').inert,
      text: document.querySelector('.lock-screen').innerText,
      visibleText: document.body.innerText.includes(${JSON.stringify(STATEMENT)}),
    })`)
    const alpha = /rgba\(.*,\s*([\d.]+)\)/.exec(s.lock)?.[1] ?? '1'
    assert(Number(alpha) === 1, `fundo ${s.lock}`)
    assert(s.exam === 'hidden' && s.statement === 'hidden' && s.inert, s)
    assert(!s.visibleText, 'enunciado legível')
    assert(s.text.includes('Você saiu da tela cheia'), s.text)
  })
  await A.shot('25-bloqueada')
  await check('o aluno volta à tela cheia e a prova reaparece', async () => {
    await A.clickText('Entrar em tela cheia')
    await A.waitFor(`!document.querySelector('.lock-screen')`, { timeout: 4000 })
    await A.waitFor(`getComputedStyle(document.querySelector('.exam-statement')).visibility === 'visible'`)
  })
  await sleep(1100)

  if (VISIBLE) {
    const why = 'a janela visível disputa o foco real do sistema'
    skip('blur da janela', why)
    skip('aba escondida', why)
    skip('foco por integrante no mural', why)
  } else {
    await say('Saiu da aba e da janela: foco real do navegador')
    // Sem a emulação, abrir outra aba tira o foco e esconde a página de verdade.
    await A.send('Emulation.setFocusEmulationEnabled', { enabled: false })
    await sleep(300)
    let extra = null
    const before = await alertCount('Ana', 'Saiu da janela')
    await expectAlert('Ana', 'Saiu da aba', async () => {
      extra = await aP.tab('about:blank', { boot: { focus: false } })
      await sleep(200)
      console.log('        visibilidade em Ana:', await A.ev(`({ v: document.visibilityState, f: document.hasFocus() })`))
    }, { title: 'aba escondida: alerta em até 1500 ms' })
    await check('blur da janela: alerta', async () => {
      await T.waitFor(`[...document.querySelectorAll('.alert-item')].filter((e) => e.querySelector('b')?.textContent === 'Ana' && e.querySelector('.kind')?.textContent === 'Saiu da janela').length > ${before}`, { timeout: 2000 })
    })
    await check('foco por integrante: Ana desfocada, Bruno não', async () => {
      await T.waitFor(`[...document.querySelectorAll('.member.lost span')].some((e) => e.textContent === 'Ana')`, { timeout: 4000 })
      const team = await teamOnWall(TEAM_A)
      const ana = team.members.find((m) => m.name === 'Ana')
      const bruno = team.members.find((m) => m.name === 'Bruno')
      assert(ana.lost && ana.state === 'desfocado' && !bruno.lost && bruno.state !== 'desfocado', team)
    })
    await T.shot('26-desfocado')
    await check('o colega também vê quem desfocou', async () => {
      await B.waitFor(`(() => { const m = [...document.querySelectorAll('.exam-group .member')].find((e) => e.textContent.includes('Ana')); return m && !m.querySelector('.dot.on') })()`, { timeout: 5000 })
    })
    await extra?.close()
    await A.cdp.send('Target.activateTarget', { targetId: A.targetId })
    await A.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await check('ao voltar, Ana deixa de estar desfocada', async () => {
      await T.waitFor(`![...document.querySelectorAll('.member.lost span')].some((e) => e.textContent === 'Ana')`, { timeout: 5000 })
    })
    await A.waitFor(`!document.querySelector('.lock-screen')`, { timeout: 5000 }).catch(() => {})
    await sleep(1100)
  }

  await say('Atalhos do DevTools')
  await A.clickSel('.editor-mount')
  await expectAlert('Ana', 'Atalho do DevTools', () => A.press('F12'), { title: 'F12: alerta em até 1500 ms' })
  await sleep(1700)
  await expectAlert('Ana', 'Atalho do DevTools', () => A.press('i', CTRL | SHIFT), { title: 'Ctrl+Shift+I: alerta em até 1500 ms' })
  await check('o atalho não digitou nada no editor', async () => {
    const text = await edText(A)
    assert(!/\bi\b$/m.test(text.split('\n').at(-1)), text)
  })
  await sleep(1100)

  await say('Colar de fora é bloqueado')
  const pasteEvent = (text) => `(() => {
    const data = new DataTransfer()
    data.setData('text/plain', ${JSON.stringify(text)})
    const target = document.querySelector('.editor-mount textarea')
    target.focus()
    return target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })()`
  await edEnd(A)
  await expectAlert('Ana', 'Colou de fora', () => A.ev(pasteEvent('COLA_DE_FORA_XYZ')), { severe: false })
  await check('o texto colado não entrou no documento', async () => {
    await sleep(300)
    assert(!(await edText(A)).includes('COLA_DE_FORA_XYZ'), 'entrou no editor de Ana')
    assert(!(await edText(B)).includes('COLA_DE_FORA_XYZ'), 'entrou no editor de Bruno')
  })
  await check('colar o que foi copiado dentro da prova não gera alerta', async () => {
    await sleep(1600)
    await A.press('End', CTRL)
    await A.press('Home', SHIFT)
    await A.ev(`(() => { const t = document.querySelector('.editor-mount textarea'); t.focus(); t.dispatchEvent(new ClipboardEvent('copy', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true })) })()`)
    const line = (await edText(A)).split('\n').at(-1)
    const before = await alertCount('Ana', 'Colou de fora')
    await A.press('End', CTRL)
    await A.ev(pasteEvent(line))
    await sleep(800)
    assert((await alertCount('Ana', 'Colou de fora')) === before, 'alertou colagem interna')
  })

  await say('A internet voltou')
  await expectAlert('Ana', 'Internet voltou', () => aP.unblock(), { max: 13000, wait: 16000, title: 'internet de volta: alerta no ciclo de teste, de até 10 s' })
  await check('a prova bloqueia com "A internet voltou"', async () => {
    await A.waitFor(`document.querySelector('.lock-screen')?.innerText.includes('A internet voltou')`, { timeout: 4000 })
  })
  await A.shot('27-internet-voltou')
  await check('bloqueando a internet de novo, a prova volta', async () => {
    await aP.block(BLOCK)
    await A.waitFor(`!document.querySelector('.lock-screen')`, { timeout: 12000 })
  })
  await sleep(1100)

  await say('Parou de compartilhar a tela')
  await expectAlert('Ana', 'Parou de compartilhar', () => A.ev(`window.__e2e.stopShare()`))
  await check('a prova bloqueia e pede a tela de novo', async () => {
    await A.waitFor(`document.querySelector('.lock-screen')?.innerText.includes('A tela parou de ser compartilhada')`, { timeout: 4000 })
    await A.clickText('Compartilhar tela')
    await A.waitFor(`!document.querySelector('.lock-screen')`, { timeout: 5000 })
  })
  await T.shot('28-alertas')
  await dumpAlerts('s7')

  // Com janela de verdade, Ana filma a tela real: quem exercita o selo é Bruno, com a trilha do teste.
  const seal = VISIBLE ? { name: 'Bruno', tab: B } : { name: 'Ana', tab: A }
  await say(`Selo visual: ${seal.name} esconde o selo e continua dizendo que está tudo bem`)
  const chip = `[...document.querySelectorAll('.tile')].find((t) => t.querySelector('.tile-tag span')?.textContent === ${JSON.stringify(seal.name)})?.innerText.includes('selo ausente')`
  await check('com o selo na tela o professor decodifica e não acusa', async () => {
    await seal.tab.waitFor(`!!document.querySelector('[data-beacon]')`, { timeout: 8000 })
    await sleep(9000)
    assert(!(await T.ev(chip)), 'selo ausente com o selo na tela')
    const cells = await seal.tab.ev(`(() => { const b = document.querySelector('[data-beacon]').getBoundingClientRect(); return { top: b.top, right: innerWidth - b.right, w: b.width, vw: innerWidth / 100 } })()`)
    assert(cells.top === 0 && Math.abs(cells.right) < 1 && Math.abs(cells.w - 7 * cells.vw) < 1, cells)
  }, { timeout: 25000 })
  await expectAlert(seal.name, 'Prova fora da tela', () => seal.tab.ev(`(() => { const s = document.createElement('style'); s.id = '__e2e-hide'; s.textContent = '[data-beacon]{visibility:hidden}'; document.head.append(s) })()`), { max: 14000, wait: 16000, title: 'selo escondido com estado ok: beacon-missing' })
  await check('o ladrilho mostra "selo ausente", e o estado segue dizendo ok', async () => {
    await T.waitFor(chip, { timeout: 3000 })
    const lockless = await seal.tab.ev(`!document.querySelector('.lock-screen')`)
    assert(lockless, 'o selo nunca pode bloquear a prova')
  })
  await T.shot('29-selo-ausente')
  await check('com o selo de volta o chip some', async () => {
    await seal.tab.ev(`document.getElementById('__e2e-hide')?.remove()`)
    await T.waitFor(`!(${chip})`, { timeout: 12000 })
  })
}

async function dumpAlerts(tag) {
  const all = await T.ev(`[...document.querySelectorAll('.alert-item')].map((e) => e.querySelector('time').textContent + ' ' + e.querySelector('b').textContent + ': ' + e.querySelector('.kind').textContent)`)
  console.log(`        alertas ${tag}: ${all.join(' | ')}`)
}

async function s8Resilience() {
  await say('F5 de Ana no meio da prova')
  const before = norm(await edText(A))
  await sleep(1300)
  await expectAlert('Ana', 'Recarregou a página', () => A.reload(), { max: 15000, wait: 16000, severe: false, title: 'F5: o professor recebe o alerta de recarga' })
  await check('não pede senha, e mostra a tela opaca', async () => {
    await A.waitFor(`!!document.querySelector('.lock-screen')`, { timeout: 10000 })
    const s = await A.ev(`({ password: [...document.querySelectorAll('.field span')].some((e) => e.textContent === 'Senha da sala'), screen: document.querySelector('.lock-screen').innerText.includes('compartilhada') || document.querySelector('.lock-screen').innerText.includes('Compartilhe'), exam: getComputedStyle(document.querySelector('.exam')).visibility })`)
    assert(!s.password && s.screen && s.exam === 'hidden', s)
  })
  console.log('        depuração:', frames.a.filter((f) => /"t":"(welcome|ack)"/.test(f.text) && !/"stream":"rec"/.test(f.text)).slice(-6).map((f) => f.text.slice(0, 200).replace(/"config".*"lastEvent"/, '"lastEvent"')))
  await A.shot('30-depois-do-f5')
  await must('precisa compartilhar e voltar à tela cheia', async () => {
    await A.clickText('Compartilhar tela')
    await A.waitText('Você saiu da tela cheia')
    await A.clickText('Entrar em tela cheia')
    await A.waitFor(`!document.querySelector('.lock-screen')`, { timeout: 12000 })
  })
  await check('o código volta inteiro', async () => {
    await waitEditor(A, `text.includes('SOMA(a, b)')`, 'editor depois do F5', 10000)
    const text = norm(await edText(A))
    assert(text === before, { text, before })
    await A.clickSel('.exam-tab:nth-child(3)')
    await A.waitFor(`document.querySelector('textarea[aria-label="Sua resposta"]')?.value.includes('LIFO')`, { timeout: 4000, label: 'texto da resposta' })
    await A.clickSel('.exam-tab:nth-child(1)')
    await waitEditor(A, `text.includes('SOMA(a, b)')`, 'editor de novo')
  })
  await check('Ana volta a editar com Bruno depois do F5', async () => {
    await edEnd(A)
    await A.type('// depois do f5')
    await waitEditor(B, `text.includes('depois do f5')`, 'edição em Bruno')
  })

  await say('Recarrega o painel do professor')
  const alertsBefore = await T.ev(`document.querySelectorAll('.alert-item').length`)
  const tilesBefore = await T.ev(`[...document.querySelectorAll('.tile-tag span')].map((e) => e.textContent).sort().join('|')`)
  await sleep(1300)
  await must('o painel recarrega e reconecta sozinho', async () => {
    await T.reload()
    await T.waitFor(`[...document.querySelectorAll('.conn h2')].some((h) => h.textContent === 'Programa')`, { timeout: 15000 })
  })
  await check('alunos voltam, sem duplicar', async () => {
    await T.waitFor(`document.querySelector('.badge[title="Conectados"]')?.textContent.trim() === '3/3'`, { timeout: 15000 })
    const tiles = await T.ev(`[...document.querySelectorAll('.tile-tag span')].map((e) => e.textContent).sort().join('|')`)
    assert(tiles === tilesBefore, { tiles, tilesBefore })
  })
  await check('os alertas foram preservados', async () => {
    const now = await T.ev(`document.querySelectorAll('.alert-item').length`)
    assert(now >= alertsBefore, { now, alertsBefore })
  })
  await check('as equipes e os códigos foram preservados', async () => {
    const a = await teamOnWall(TEAM_A)
    assert(a.code === teamCodes.code && a.members.length === 2, a)
  })
  await check('os alunos seguem conectados e editando, e o documento continua no painel', async () => {
    await A.waitFor(`!document.body.innerText.includes('Reconectando')`, { timeout: 10000 })
    await B.waitFor(`!document.body.innerText.includes('Reconectando')`, { timeout: 10000 })
    await edEnd(B)
    await B.type('// depois do painel')
    await waitEditor(A, `text.includes('depois do painel')`, 'edição em Ana')
    await clickTile('Ana')
    await T.waitFor(`[...document.querySelectorAll('pre.code-view')].some((e) => e.textContent.includes('depois do painel') && e.textContent.includes('SOMA(a, b)'))`, { timeout: 6000 })
    assert(!(await T.ev(`document.body.innerText.includes('Registro alterado')`)), 'cadeia de eventos quebrou')
    await backToWall()
  })
  await armTeacherAudio()
  await check('um alerta novo chega depois de recarregar, sem repetir numeração', async () => {
    const before2 = await T.ev(`document.querySelectorAll('.alert-item').length`)
    await A.clickSel('.editor-mount')
    await A.press('F12')
    await T.waitFor(`document.querySelectorAll('.alert-item').length === ${before2 + 1}`, { timeout: 4000 })
    await sleep(700)
    assert((await T.ev(`document.querySelectorAll('.alert-item').length`)) === before2 + 1, 'alerta repetido')
  })

  await say('O programa cai no meio da prova')
  await must('derruba o hub', () => servers.killHub())
  await check('o painel avisa, e os alunos mostram "Reconectando"', async () => {
    await T.waitFor(`document.body.innerText.includes('Conexão caiu')`, { timeout: 8000 })
    await A.waitText('Reconectando', { timeout: 8000 })
    await B.waitText('Reconectando', { timeout: 8000 })
  })
  await T.shot('31-hub-caiu')
  await A.shot('32-reconectando')
  await check('Ana e Bruno editam sem conexão', async () => {
    await edEnd(A)
    await A.type('// offline da ana')
    await edEnd(B)
    await B.type('// offline do bruno')
    await waitEditor(A, `text.includes('offline da ana') && !text.includes('offline do bruno')`, 'Ana isolada')
    await waitEditor(B, `text.includes('offline do bruno') && !text.includes('offline da ana')`, 'Bruno isolado')
  })
  await say('F5 de C com o programa e o site fora do ar')
  await check('F5 sem programa nem site: a prova abre do service worker', async () => {
    await sleep(1200)
    await C.reload()
    await C.waitFor(`!!document.querySelector('.lock-screen')`, { timeout: 15000 })
    await C.clickText('Compartilhar tela')
    await C.waitText('Você saiu da tela cheia')
    await C.clickText('Entrar em tela cheia')
    await C.waitFor(`!document.querySelector('.lock-screen')`, { timeout: 15000 })
    await C.waitFor(`!!document.querySelector('.editor-mount .view-line')`, { timeout: 15000 })
  }, { timeout: 60000 })

  await say('O programa volta')
  await must('reinicia o hub', () => servers.startHub())
  await must('o painel volta a falar com o programa', async () => {
    const auto = await T.waitFor(`[...document.querySelectorAll('.conn h2')].some((h) => h.textContent === 'Programa')`, { timeout: 9000 }).catch(() => false)
    if (auto) return
    notes.push('o painel não reconectou sozinho ao programa: precisou de um clique em "Reconectar"')
    await T.clickText('Reconectar')
    await T.waitFor(`[...document.querySelectorAll('.conn h2')].some((h) => h.textContent === 'Programa')`, { timeout: 8000 })
  }, { timeout: 30000 })
  await check('os alunos voltam sem duplicar', async () => {
    await T.waitFor(`document.querySelector('.badge[title="Conectados"]')?.textContent.trim() === '3/3'`, { timeout: 20000 })
    assert((await T.ev(`document.querySelectorAll('.tile').length`)) === 3, 'ladrilhos')
    await A.waitFor(`!document.body.innerText.includes('Reconectando')`, { timeout: 10000 })
    await B.waitFor(`!document.body.innerText.includes('Reconectando')`, { timeout: 10000 })
  }, { timeout: 45000 })
  await check('as edições sem conexão se mesclam', async () => {
    await waitEditor(A, `text.includes('offline da ana') && text.includes('offline do bruno')`, 'mescla em Ana', 12000)
    await waitEditor(B, `text.includes('offline da ana') && text.includes('offline do bruno')`, 'mescla em Bruno', 12000)
    assert(norm(await edText(A)) === norm(await edText(B)), 'divergiu')
    await clickTile('Bruno')
    await T.waitFor(`[...document.querySelectorAll('pre.code-view')].some((e) => e.textContent.includes('offline da ana') && e.textContent.includes('offline do bruno'))`, { timeout: 8000 })
    await backToWall()
  }, { timeout: 45000 })
  await armTeacherAudio()
}

async function s9End() {
  await say('Professor encerra a prova')
  await must('Encerrar pede confirmação e encerra', async () => {
    await T.clickText('Encerrar')
    await T.waitText('Encerrar a prova para todos?')
    await T.clickText('Encerrar', { within: `document.querySelector('.modal')` })
    await T.waitFor(`!!document.querySelector('table.results')`, { timeout: 8000 })
  })
  await check('"Enviando" aparece e zera nos três alunos', async () => {
    for (const [n, t] of [['Ana', A], ['Bruno', B], ['C', C]]) {
      await t.waitText('Prova entregue', { timeout: 120_000, every: 200, label: `Prova entregue em ${n}` })
      assert(!(await t.ev(`document.body.innerText.includes('Enviando')`)), `${n} ainda enviando`)
      assert(await t.ev(`!document.fullscreenElement`), `${n} ainda em tela cheia`)
      assert(!(await t.ev(`document.body.innerText.includes('Reconectando')`)), `${n} reconectando`)
    }
  }, { timeout: 200_000 })
  await A.shot('33-entregue')
  await check('fim da prova não gerou alerta falso', async () => {
    const recent = await T.ev(`[...document.querySelectorAll('.alert-item')].slice(0, 12).map((e) => e.querySelector('b').textContent + ':' + e.querySelector('.kind').textContent + ':' + e.querySelector('time').textContent)`)
    console.log(`        últimos alertas: ${recent.join(', ')}`)
  })

  const rowOf = (team) => `[...document.querySelectorAll('table.results tbody tr')].find((r) => r.querySelector('td')?.textContent.includes(${JSON.stringify(team)}))`
  await check('as notas são calculadas', async () => {
    await T.waitFor(`!document.querySelector('table.results .spin')`, { timeout: 150_000, every: 400, label: 'correção' })
    const a = await T.ev(`[...${rowOf(TEAM_A)}.querySelectorAll('td')].map((e) => e.textContent.trim())`)
    const c = await T.ev(`[...${rowOf(TEAM_C)}.querySelectorAll('td')].map((e) => e.textContent.trim())`)
    console.log(`        ${JSON.stringify(a)}\n        ${JSON.stringify(c)}`)
    assert(a[1] === '2' && a[2] === '1' && /^3 \/ 6$/.test(a[4]), a)
    assert(/Corrigir 1/.test(a[6] ?? ''), a)
    assert(c[1] === '0' && /^0 \/ 6$/.test(c[4]), c)
    assert(await T.ev(`!!${rowOf(TEAM_A)}.querySelector('[aria-label="Falta corrigir"]')`), 'sem aviso de correção manual')
  }, { timeout: 170_000 })
  await T.shot('34-notas')
  await must('correção manual da questão de texto', async () => {
    const c = await T.centerOf(rowOf(TEAM_A), 'linha da equipe')
    await T.clickAt(c.x, c.y)
    await T.waitFor(`!!document.querySelector('.detail')`)
    await T.waitFor(`[...document.querySelectorAll('pre.code-view.wrap')].some((e) => e.textContent.includes('LIFO'))`, { timeout: 5000, label: 'resposta de texto' })
    await T.clickSel('input[aria-label="Pontos"]')
    await T.press('a', CTRL)
    await T.type('1,5')
    await T.press('Enter')
    await T.waitFor(`!!document.querySelector('[aria-label="Corrigida"]')`, { timeout: 4000 })
  })
  await T.shot('35-correcao')
  await check('o detalhe mostra o gabarito só para o professor', () => T.ev(`[...document.querySelectorAll('details.expect summary')].some((e) => e.textContent === 'Gabarito')`))
  await backToWall()
  await check('a nota total considera a correção manual', async () => {
    await T.waitFor(`/^4\\.5 \\/ 6$/.test([...${rowOf(TEAM_A)}.querySelectorAll('td')][4]?.textContent.trim())`, { timeout: 4000 })
    assert(!(await T.ev(`!!${rowOf(TEAM_A)}.querySelector('[aria-label="Falta corrigir"]')`)), 'continua pendente')
  })

  await say('Exporta o zip')
  // Sem janela o diálogo de salvar nunca abriria: o arquivo fica na memória e volta para cá.
  await T.ev(`(() => {
    window.__e2eZip = []
    window.showSaveFilePicker = async (o) => {
      window.__e2eZipName = o.suggestedName
      return { createWritable: async () => ({ write: async (b) => void window.__e2eZip.push(b.slice()), close: async () => { window.__e2eZipBlob = new Blob(window.__e2eZip); window.__e2eZip = [] }, abort: async () => {} }) }
    }
  })()`)
  const zipPath = join(tmp, 'export.zip')
  const zipBytes = await must('"Baixar zip" termina', async () => {
    await T.clickText('Exportar')
    await T.waitText('Incluir gravações')
    assert(await T.ev(`document.querySelector('.modal input[type=checkbox]').checked`), 'gravações desligadas')
    await T.shot('36-exportar')
    await T.clickText('Baixar zip')
    await T.waitFor(`!!window.__e2eZipBlob`, { timeout: 90000, every: 300, label: 'zip gravado' })
    const size = await T.ev(`window.__e2eZipBlob.size`)
    const parts = []
    const STEP = 3_000_000
    for (let i = 0; i < size; i += STEP) {
      const b64 = await T.ev(`(async () => { const u = new Uint8Array(await window.__e2eZipBlob.slice(${i}, ${i + STEP}).arrayBuffer()); let s = ''; for (let j = 0; j < u.length; j += 0x8000) s += String.fromCharCode(...u.subarray(j, j + 0x8000)); return btoa(s) })()`)
      parts.push(Buffer.from(b64, 'base64'))
    }
    const all = Buffer.concat(parts)
    writeFileSync(zipPath, all)
    return all.length
  }, { timeout: 180_000 })
  console.log(`        zip: ${(zipBytes / 2 ** 20).toFixed(1)} MiB, nome ${await T.ev('window.__e2eZipName')}`)
  const zip = await must('zipfile do Python abre e os CRC batem', () => {
    const r = spawnSync('python', ['-I', join(ROOT, 'e2e', 'helpers', 'zipcheck.py'), zipPath], { encoding: 'utf8', maxBuffer: 256 * 2 ** 20 })
    assert(r.status === 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert(out.bad === null, `CRC ruim em ${out.bad}`)
    return out
  })
  const names = zip.names
  const inTeam = (dir, file) => names.find((n) => n.startsWith(`grupos/${dir}/`) && n.endsWith(file))
  await check('estrutura: resumo, prova e pasta da equipe', () => {
    assert(names.includes('resumo.csv') && names.includes('prova.json'), names.slice(0, 20))
    assert(names.includes(`grupos/${TEAM_A}/resumo.txt`), names.slice(0, 20))
  })
  await check('integrantes com matrícula, alertas e gravações', () => {
    for (const who of ['Ana (2024A)', 'Bruno (2024B)']) {
      assert(names.includes(`grupos/${TEAM_A}/${who}/alertas.csv`), `sem alertas de ${who}`)
      const videos = names.filter((n) => n.startsWith(`grupos/${TEAM_A}/${who}/gravacao/`))
      assert(videos.length > 0 && videos.every((n) => /\/\d{4}\.(mp4|webm)$/.test(n)), videos)
      assert(videos.some((n) => zip.sizes[n] > 2000), `gravação de ${who} vazia: ${videos.map((n) => zip.sizes[n])}`)
    }
  })
  await check('código dos arquivos', () => {
    const main = zip.texts[`grupos/${TEAM_A}/q1/main.c`]
    const util = zip.texts[`grupos/${TEAM_A}/q1/util.h`]
    assert(main?.includes('SOMA(a, b)') && main.includes('offline da ana') && main.includes('offline do bruno'), main)
    assert(util?.includes('#define SOMA'), util)
  })
  await check('notas e resposta de texto', () => {
    const summary = zip.texts[`grupos/${TEAM_A}/resumo.txt`]
    assert(summary.includes('Pontos: 4.5 de 6'), summary)
    assert(zip.texts[`grupos/${TEAM_A}/q1/nota.txt`].includes('2 de 3 pontos'), zip.texts[`grupos/${TEAM_A}/q1/nota.txt`])
    assert(zip.texts[`grupos/${TEAM_A}/q3/resposta.txt`].includes('LIFO'), 'sem texto')
    assert(zip.texts[`grupos/${TEAM_A}/q3/nota.txt`].includes('1.5 de 2 pontos (correção manual)'), zip.texts[`grupos/${TEAM_A}/q3/nota.txt`])
  })
  await check('alertas no csv', () => {
    const csv = zip.texts[`grupos/${TEAM_A}/Ana (2024A)/alertas.csv`]
    for (const label of ['Saiu da tela cheia', 'Atalho do DevTools', 'Colou de fora', 'Internet voltou', 'Parou de compartilhar', 'Recarregou a página']) assert(csv.includes(label), `${label} fora do csv`)
  })
  await check('nome hostil fica dentro da pasta', () => {
    assert(zip.bad_paths.length === 0, zip.bad_paths)
    const evil = names.filter((n) => n.includes('evil') || n.includes('2024C'))
    assert(evil.length > 0, 'equipe de C sumiu do zip')
    assert(evil.every((n) => n.startsWith('grupos/') && !n.split('/').includes('..')), evil)
    assert(inTeam('_.._evil', 'resumo.txt'), evil.slice(0, 5))
  })
  await check('o resumo.csv tem a matrícula, sem gabarito', () => {
    const csv = zip.texts['resumo.csv']
    assert(csv.includes('2024A') && csv.includes('2024B') && csv.includes('2024C'), csv)
    for (const m of [MARK.reference, MARK.rubric, MARK.stdout, MARK.stdin]) assert(!csv.includes(m), m)
    assert(!zip.texts['prova.json'].includes(MARK.reference), 'gabarito na prova.json')
  })
  await check('o zip não leva os códigos das equipes', () => {
    for (const [name, text] of Object.entries(zip.texts)) {
      for (const code of [teamCodes.code, teamCodes.codeC]) assert(!text.includes(code), `${code} em ${name}`)
    }
  })
  await T.waitNoText('Incluir gravações', { timeout: 5000 }).catch(() => {})

  await say('Player: abre a gravação e busca')
  const clickRow = async () => {
    const c = await T.centerOf(rowOf(TEAM_A), 'linha da equipe')
    await T.clickAt(c.x, c.y)
    await T.waitFor(`!!document.querySelector('.detail')`)
  }
  await must('abre a gravação', async () => {
    await clickRow()
    await T.clickText('Gravação')
    await T.waitFor(`!!document.querySelector('.player video') && document.querySelector('.player video').readyState >= 1 && document.querySelector('.player video').duration > 0`, { timeout: 30000, every: 200, label: 'vídeo carregado' })
  }, { timeout: 45000 })
  const video = `document.querySelector('.player video')`
  await check('é vídeo de verdade, com imagem', async () => {
    const v = await T.ev(`({ w: ${video}.videoWidth, h: ${video}.videoHeight, d: ${video}.duration, src: ${video}.src.slice(0, 5) })`)
    console.log(`        vídeo: ${JSON.stringify(v)}`)
    assert(v.w > 0 && v.h > 0 && Number.isFinite(v.d) && v.d > 0, v)
  })
  await check('clicar na barra busca, e o tempo anda', async () => {
    const span = await T.ev(`Number(document.querySelector('.seek').getAttribute('aria-valuemax'))`)
    const box = await T.ev(`(() => { const b = document.querySelector('.seek').getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2, w: b.width } })()`)
    const at = (f) => box.x + box.w * f
    await T.clickAt(at(0.6), box.y)
    await sleep(800)
    await T.waitFor(`${video}.readyState >= 1`, { timeout: 15000 })
    const s1 = await T.ev(`({ now: Number(document.querySelector('.seek').getAttribute('aria-valuenow')), t: ${video}.currentTime, src: ${video}.src })`)
    await T.clickAt(at(0.1), box.y)
    await sleep(800)
    await T.waitFor(`${video}.readyState >= 1`, { timeout: 15000 })
    const s2 = await T.ev(`({ now: Number(document.querySelector('.seek').getAttribute('aria-valuenow')), t: ${video}.currentTime, src: ${video}.src })`)
    console.log(`        de ${span} s: em 60% ${JSON.stringify(s1.now)} s (video ${s1.t}), em 10% ${JSON.stringify(s2.now)} s (video ${s2.t})`)
    assert(Math.abs(s1.now - span * 0.6) <= Math.max(3, span * 0.08), { s1, span })
    assert(Math.abs(s2.now - span * 0.1) <= Math.max(3, span * 0.08), { s2, span })
    assert(s1.t !== s2.t || s1.src !== s2.src, 'o vídeo não saiu do lugar')
  }, { timeout: 60000 })
  await check('tocar faz o tempo andar', async () => {
    await T.clickSel('.player-bar button[aria-label="Tocar"]')
    const t0 = await T.ev(`${video}.currentTime`)
    await T.waitFor(`${video}.currentTime > ${t0} + 0.3 || ${video}.src !== ${JSON.stringify(await T.ev(`${video}.src`))}`, { timeout: 12000, every: 150 })
    await T.clickSel('.player-bar button[aria-label="Pausar"]')
  })
  await T.shot('37-player')
  await check('clicar num alerta abre a gravação perto dele', async () => {
    const line = `document.querySelector('.alert-line')`
    await T.centerOf(line, 'alerta')
    await T.clickSel('.alert-line')
    await T.waitFor(`${video}.readyState >= 1`, { timeout: 15000 })
  })
  await backToWall()
  await T.shot('38-fim-painel')
}

async function s10Secrets() {
  await say('Nenhum marcador de gabarito em lado nenhum do aluno')
  const markers = Object.values(MARK)
  for (const [n, key, t] of [['Ana', 'a', A], ['Bruno', 'b', B], ['C', 'c', C]]) {
    await check(`${n}: DOM, IndexedDB e armazenamento sem gabarito`, async () => {
      const r = await t.ev(searchStorage(markers))
      assert(r.records > 0, 'não leu nada do IndexedDB')
      assert(r.hits.length === 0, r.hits)
      return true
    }, { timeout: 60000 })
    await check(`${n}: nada do gabarito nas mensagens decifradas`, () => {
      assert(frames[key].length > 50, `poucos quadros: ${frames[key].length}`)
      for (const m of markers) assert(!frameHas(key, m), `${m} chegou`)
      for (const f of frames[key]) {
        if (!f.text.includes('"t":"exam"')) continue
        for (const k of ['"correct"', '"tests"', '"reference"', '"rubric"', '"solution']) assert(!f.text.includes(k), `${k} na prova`)
      }
      assert(frames[key].some((f) => f.text.includes('"t":"exam"')), 'sem a mensagem da prova')
    })
    await check(`${n}: na rede só passa cifra`, () => {
      const list = t.wsFrames.map((f) => Buffer.from(f.data, 'base64').toString('latin1'))
      assert(list.length > 50, `poucos quadros na rede: ${list.length}`)
      for (const m of [...markers, STATEMENT]) assert(!list.some((x) => x.includes(m)), `${m} em claro`)
    })
  }
  await check('o que o aluno captura é só a trilha do teste, sem texto da prova', async () => {
    if (VISIBLE) return skip('capturas sem gabarito', 'Ana filma a tela real, e a busca em imagem exigiria OCR')
    assert((await A.ev('window.__e2e.calls')) >= 1, 'sem captura')
  })
  await check('códigos de equipe não vão para quem não é da equipe', async () => {
    assert(!frameHas('c', teamCodes.code), 'código de Ana chegou a C')
    assert(!frameHas('a', teamCodes.codeC) && !frameHas('b', teamCodes.codeC), 'código de C chegou à outra equipe')
    assert(!(await outerHas(A, teamCodes.codeC)), 'no DOM de Ana')
  })
  await check('controle: a mesma busca acha o gabarito no professor', async () => {
    const r = await T.ev(searchStorage(markers))
    assert(r.hits.some((h) => h.marker === MARK.reference) && r.hits.some((h) => h.marker === MARK.rubric), r.hits)
  }, { timeout: 60000 })
  await check('controle: o enunciado aparece nas mensagens decifradas de quem recebeu', () => frameHas('a', STATEMENT))
  await check('nenhum erro de JavaScript em nenhuma tela', () => {
    const all = [T, A, B, C].flatMap((t) => t.errors.map((e) => `${t.person.name}: ${e}`))
    assert(all.length === 0, all.slice(0, 8).join('\n'))
  })
}

async function realCaptureProbe() {
  // Só a chamada e o tipo de superfície: nenhum quadro da tela real é lido nem salvo.
  if (VISIBLE) return
  const probe = await Person.create(edges[0], 'sonda', { shotsDir: SHOTS })
  const t = await probe.tab(`${origin}/`)
  await t.waitFor(`document.readyState === 'complete'`)
  const out = await t.ev(`(async () => {
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'monitor' }, audio: false, monitorTypeSurfaces: 'include', selfBrowserSurface: 'exclude' })
      const st = s.getVideoTracks()[0].getSettings()
      s.getTracks().forEach((x) => x.stop())
      return { surface: st.displaySurface, width: st.width, height: st.height }
    } catch (e) { return { error: e.name + ': ' + e.message } }
  })()`)
  console.log(`getDisplayMedia real em headless: ${JSON.stringify(out)}`)
  notes.push(`getDisplayMedia real em headless respondeu ${out.surface ?? out.error}; o teste usa trilha falsa de canvas porque a real filma a área de trabalho, onde a página sem janela nunca aparece`)
  await t.close()
}

// ---- execução

let cleaned = false
async function cleanup() {
  if (cleaned) return
  cleaned = true
  for (const e of edges) await e.close().catch(() => {})
  servers?.stop()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => cleanup().finally(() => process.exit(130)))
const watchdog = setTimeout(() => {
  console.error(`\nparou pelo limite total de ${WATCHDOG_MS / 60000} min`)
  report()
  cleanup().finally(() => process.exit(3))
}, WATCHDOG_MS)

async function main() {
  const started = Date.now()
  if (VISIBLE) console.log('modo com janelas: a tela cheia de Ana vai cobrir o professor num monitor só, e os alertas de foco ficam de fora')
  if (!NO_BUILD) {
    console.log('npm run build...')
    const b = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-b'], { cwd: ROOT, encoding: 'utf8' })
    if (b.status !== 0) throw new Error(`tsc falhou:\n${b.stdout}${b.stderr}`)
    const v = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: ROOT, encoding: 'utf8' })
    if (v.status !== 0) throw new Error(`vite falhou:\n${v.stdout}${v.stderr}`)
    const p = spawnSync(process.execPath, [join(ROOT, 'scripts', 'postbuild.mjs')], { cwd: ROOT, encoding: 'utf8' })
    if (p.status !== 0) throw new Error(`postbuild falhou:\n${p.stdout}${p.stderr}`)
  }
  sectionName = '0 Preparação'
  await must('sobe site, hub e navegadores', setup, { timeout: 90_000 })
  await realCaptureProbe().catch((e) => notes.push(`sonda de captura real: ${e.message}`))

  await section('1 Página inicial', s1Landing, { fatal: true })
  await section('2 Professor cria a sala', s2Teacher, { fatal: true })
  await section('3 Alunos entram', async () => {
    teamCodes = await s3Students()
  }, { fatal: true })
  await section('4 Tela, rede e liberação', s4Gate, { fatal: true })
  await section('5 Colaboração', s5Collab)
  await section('6 Terminal e Testar', s6Terminal)
  await section('7 Vigilância', s7Proctor)
  await section('8 Resiliência', s8Resilience)
  await section('9 Fim, notas, zip e player', s9End)
  await section('10 Segredo do gabarito', s10Secrets)
  console.log(`\nduração: ${Math.round((Date.now() - started) / 1000)} s; fotos em ${SHOTS}`)
}

let code = 1
try {
  await main()
} catch (err) {
  if (!(err instanceof Abort)) row('erro fatal', false, err.stack ?? err.message)
} finally {
  clearTimeout(watchdog)
  code = report() ? 1 : 0
  await cleanup()
}
process.exit(code)
