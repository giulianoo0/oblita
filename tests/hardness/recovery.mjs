// Recuperação: nada pode crashar nem perder dado confirmado.
//  A) painel reconecta -> o hub reapresenta todos os alunos, que retomam a sessão
//  B) hub morto e ressuscitado no meio -> alunos e painel reconectam, retomam com token
//  C) rede de um aluno cortada -> reconecta e reenvia a gravação a partir do último confirmado
import { newTeacherIdentity } from './lib.mjs'
import { Hub, until, sleep } from './harness.mjs'
import { Panel, Student } from './net.mjs'

const results = []
function check(name, expected, observed, pass) {
  results.push({ name, expected, observed, pass })
  console.log(`${pass ? 'PASSOU' : 'FALHOU'} | ${name}\n   esperado: ${expected}\n   observado: ${observed}`)
}

const FOLDER = '/tmp/oblita-rec'
const identity = await newTeacherIdentity() // identidade fixa da sala: a mesma antes e depois

async function setupStudents(base, n, onResult) {
  const studs = []
  for (let i = 0; i < n; i++) {
    const s = new Student(base, { name: `Aluno ${i}` })
    await s.connect()
    studs.push(s)
  }
  await until(`${n} welcomes`, () => studs.filter((s) => s.welcomed).length === n, 15000)
  return studs
}

// ===== A) painel reconecta =====
async function panelReconnect() {
  const hub = new Hub({ folder: FOLDER })
  await hub.start()
  const token = await hub.token()
  const base = hub.base()
  let opened = 0
  let panel = await new Panel(base, { token, identity, onReady: () => opened++ }).start()
  const studs = await setupStudents(base, 10)
  const before = (await hub.ping()).students

  // painel cai
  panel.close()
  await until('hub sem painel', async () => !(await hub.ping()).host, 8000)
  const midStudents = (await hub.ping()).students // alunos continuam conectados

  // painel novo assume (mesma identidade)
  opened = 0
  for (const s of studs) {
    s.welcomed = false
    s.waitWelcome = new Promise((r) => (s._welcomeResolve = r))
  }
  panel = await new Panel(base, { token, identity, onReady: () => opened++ }).start()
  await until('todos reapresentados e re-welcome', () => studs.filter((s) => s.welcomed).length === 10, 15000).catch(() => {})
  const rewelcomed = studs.filter((s) => s.welcomed).length

  check('painel reconecta: alunos continuam conectados no hub', '10 durante e depois da queda do painel', `antes=${before} sem_painel=${midStudents}`, before === 10 && midStudents === 10)
  check('painel reconecta: hub reapresenta todos os alunos', '10 OP_OPEN + 10 re-welcome, resumidos', `reapresentados=${opened} rewelcome=${rewelcomed} resumed=${panel.stats.resumed}`, opened === 10 && rewelcomed === 10)

  for (const s of studs) s.close()
  panel.close()
  await sleep(200)
  hub.kill('SIGTERM')
  await sleep(300)
  check('hub encerra limpo no SIGTERM (sem crash)', 'saída sem pânico no log', `vivo=${hub.alive()} panico=${/pânico|panic|Erro interno/.test(hub.log)}`, !/panic|Erro interno/.test(hub.log))
}

// ===== B) hub morto e ressuscitado =====
async function hubRestart() {
  let hub = new Hub({ folder: FOLDER })
  await hub.start()
  let token = await hub.token()
  const base = hub.base()
  let panel = await new Panel(base, { token, identity }).start()
  const studs = await setupStudents(base, 10)

  // cada aluno manda um rec e recebe ack (dado "confirmado")
  for (const s of studs) s.sendRec(new Uint8Array(500), 0, 0, false)
  await until('todos com rec confirmado', () => studs.every((s) => s.ackedRec === 1), 10000)

  // store persistida do painel (tokens dos alunos) sobrevive ao reinício
  const persisted = panel.byClient

  // MATA o hub no meio
  hub.kill('SIGKILL')
  await until('sockets dos alunos caem', () => studs.every((s) => s.closed), 8000).catch(() => {})
  const allClosed = studs.every((s) => s.closed)

  // ressuscita no mesmo porto/pasta; o painel recarrega a store com os tokens
  hub = new Hub({ folder: FOLDER })
  await hub.start()
  token = await hub.token()
  panel = await new Panel(base, { token, identity, byClient: persisted }).start()
  // alunos reconectam reusando token
  let backWelcome = 0
  for (const s of studs) {
    s.onWelcome = () => backWelcome++
    await s.reconnect()
  }
  await until('alunos reconectam', () => studs.filter((s) => s.welcomed).length === 10, 15000).catch(() => {})
  const back = studs.filter((s) => s.welcomed).length

  check('hub morto (SIGKILL): sockets dos alunos caem', 'todos detectam a queda', `caíram=${allClosed}`, allClosed)
  check('hub ressuscita: 10 alunos reconectam e retomam (token)', '10 de volta, resumidos, hub vivo', `volta=${back} resumed=${panel.stats.resumed} vivo=${hub.alive()}`, back === 10 && panel.stats.resumed === 10 && hub.alive())

  for (const s of studs) s.close()
  panel.close()
  await sleep(200)
  hub.kill()
  await sleep(200)
}

// ===== C) rede de um aluno cortada, reenvia gravação =====
async function studentCut() {
  const hub = new Hub({ folder: FOLDER })
  await hub.start()
  const token = await hub.token()
  const base = hub.base()
  const panel = await new Panel(base, { token, identity }).start()
  const s = (await setupStudents(base, 1))[0]

  // confirma seq 1 e 2
  s.sendRec(new Uint8Array(300), 0, 0, false)
  s.sendRec(new Uint8Array(300), 0, 1, false)
  await until('rec 1 e 2 confirmados', () => s.ackedRec === 2, 8000)
  const confirmedBefore = panel.byClient.get(s.clientId).lastRec

  // manda seq 3 e CORTA a rede antes do ack (destrói o socket TCP imediatamente)
  s.sendRec(new Uint8Array(300), 0, 2, false)
  s.sock.close()
  await until('queda detectada', async () => s.closed || !(await hub.ping()).students, 8000).catch(() => {})

  // reconecta: o welcome traz lastRec; o aluno reenvia a partir dali
  await s.reconnect()
  await until('re-welcome', () => s.welcomed, 10000)
  const resumeLastRec = panel.byClient.get(s.clientId).lastRec
  // reenvia o que faltou (do último confirmado + 1 em diante)
  for (let seq = resumeLastRec + 1; seq <= 3; seq++) {
    s.recSeq = seq - 1
    s.sendRec(new Uint8Array(300), 0, seq - 1, false)
  }
  await until('reenvio confirmado', () => panel.byClient.get(s.clientId).lastRec >= 3, 8000).catch(() => {})
  const finalLastRec = panel.byClient.get(s.clientId).lastRec

  check('aluno com rede cortada reconecta e retoma', 'welcome aceito, sessão retomada (resumed)', `welcomed=${s.welcomed} resumed=${panel.stats.resumed >= 1}`, s.welcomed && panel.stats.resumed >= 1)
  check('dado confirmado não regride; reenvio não perde nem duplica', `lastRec monotônico, chega a 3 (antes=${confirmedBefore})`, `retomou_em=${resumeLastRec} final=${finalLastRec}`, resumeLastRec >= confirmedBefore && finalLastRec === 3)

  s.close()
  panel.close()
  await sleep(200)
  hub.kill()
  await sleep(200)
}

try {
  await panelReconnect()
  await hubRestart()
  await studentCut()
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== RECUPERAÇÃO: ${results.length - failed.length}/${results.length} passaram ===`)
  if (failed.length) console.log('FALHARAM:', failed.map((f) => f.name).join('; '))
  process.exit(failed.length ? 1 : 0)
}
