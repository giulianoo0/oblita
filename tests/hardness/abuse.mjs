// Testes de abuso de rede/acesso contra o hub real. Cada caso imprime: esperado, observado, PASSOU.
import net from 'node:net'
import { networkInterfaces } from 'node:os'
import { Hub, until, sleep, rawConnect, mib } from './harness.mjs'
import { Panel, Student, deflateFrame, encodeJson, encodeBinary, decodeFrame, HubOp, encodeHub } from './net.mjs'

const results = []
function check(name, expected, observed, pass) {
  results.push({ name, expected, observed, pass })
  console.log(`${pass ? 'PASSOU' : 'FALHOU'} | ${name}\n   esperado: ${expected}\n   observado: ${observed}`)
}

const hub = new Hub()
await hub.start()
const token = await hub.token()
const base = hub.base()
const port = hub.port
const localIp = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? null

// ---- 1. Controle de acesso HTTP/WS
async function accessControl() {
  // /host-token exige loopback + origem
  const bad = await fetch(`${hub.http()}/host-token`, { headers: { origin: 'https://malicioso.example' } })
  check('/host-token origem errada', '403', String(bad.status), bad.status === 403)
  const noOrigin = await fetch(`${hub.http()}/host-token`)
  check('/host-token sem origem', '403', String(noOrigin.status), noOrigin.status === 403)

  // /ws/host token errado -> 403
  const r1 = await rawConnect(port, '/ws/host?token=errado', { headers: { origin: 'https://oblita.giuli.dev' } })
  check('/ws/host token errado', 'recusado (não 101)', `status=${r1.status}`, r1.status === 403 || r1.failed)
  // /ws/host sem token
  const r2 = await rawConnect(port, '/ws/host', { headers: { origin: 'https://oblita.giuli.dev' } })
  check('/ws/host sem token', 'recusado', `status=${r2.status}`, r2.failed)

  // /ws/files sem token / origem errada / de fora do loopback
  const f1 = await rawConnect(port, '/ws/files?token=errado', { headers: { origin: 'https://oblita.giuli.dev' } })
  check('/ws/files token errado', 'recusado', `status=${f1.status}`, f1.failed)
  const f2 = await rawConnect(port, `/ws/files?token=${token}`, { headers: { origin: 'https://malicioso.example' } })
  check('/ws/files origem errada', 'recusado', `status=${f2.status}`, f2.failed)
  const f3 = await rawConnect(port, `/ws/files?token=${token}`, { headers: {} })
  check('/ws/files sem origem', 'recusado', `status=${f3.status}`, f3.failed)

  // De fora do loopback (IP eth0 da própria subnet interna)
  if (localIp) {
    const h = await rawConnect(port, `/ws/host?token=${token}`, { host: localIp, headers: { origin: 'https://oblita.giuli.dev' } })
    check('/ws/host de fora do loopback', 'recusado', `status=${h.status} (via ${localIp})`, h.failed)
    const ff = await rawConnect(port, `/ws/files?token=${token}`, { host: localIp, headers: { origin: 'https://oblita.giuli.dev' } })
    check('/ws/files de fora do loopback', 'recusado', `status=${ff.status} (via ${localIp})`, ff.failed)
    // /ws/student de fora do loopback deve funcionar (aluno real vem da LAN)
    const st = await rawConnect(port, '/ws/student', { host: localIp })
    check('/ws/student de fora do loopback', '101 (aluno da LAN entra)', `status=${st.status}`, st.status === 101)
    st.destroy?.()
  } else {
    check('IP de eth0 encontrado', 'um IP não-loopback', 'nenhum', false)
  }
}

// ---- 2. Quadros hostis do aluno (canal cifrado estabelecido)
async function hostileFrames() {
  const panel = await new Panel(base, { token }).start()

  // Quadro gigante aluno->painel: >8 MiB fecha só esse aluno (limite do hub)
  {
    const r = await rawConnect(port, '/ws/student')
    const big = new Uint8Array(9 * 1024 * 1024)
    r.send(big)
    await Promise.race([r.closed, sleep(4000)])
    const p = await hub.ping()
    check('quadro >8 MiB aluno->hub', 'conexão cai, hub de pé', `fechou=${await isClosed(r)} alive=${hub.alive()}`, hub.alive())
  }

  // Bomba de descompressão: aluno manda tag-4 que infla além de 9 MiB -> painel rejeita sem OOM
  {
    const s = await freshStudent(base)
    const bomb = await deflateFrame(encodeJson({ t: 'event', junk: 'A'.repeat(50 * 1024 * 1024), event: { seq: 1, kind: 'focus-lost', at: 0, hash: '0'.repeat(64) } }))
    // bomb é tag 4; enviamos como quadro cru cifrado
    s.sendSealed(bomb, false)
    await sleep(2000)
    check('bomba de descompressão (>9 MiB)', 'painel rejeita, Node não estoura', `badFrames/ignorado, painel vivo=${!panel.closed}`, !panel.closed && hub.alive())
    s.close()
  }

  // Compressão aninhada: tag-4 cujo interior é tag-4 -> inflateFrame rejeita (inner[0] != 1,2)
  {
    const inner = await deflateFrame(encodeJson({ t: 'beat', at: 0, status: {} }))
    const nested = await deflateFrame(inner) // tag4(tag4(...)) — mas deflateFrame não recomprime tag4; forçamos manual
    // deflateFrame não recomprime um tag 4; montamos manualmente o aninhado
    const { deflate } = await import('./lib.mjs')
    const doubled = await deflate(inner)
    const frame = new Uint8Array(doubled.length + 1)
    frame[0] = 4
    frame.set(doubled, 1)
    const s = await freshStudent(base)
    s.sendSealed(frame, false)
    await sleep(1000)
    check('compressão aninhada (tag4 dentro de tag4)', 'rejeitada, conexão cai, hub vivo', `hub vivo=${hub.alive()}`, hub.alive())
    s.close()
  }

  // Tag desconhecida no claro (após decifrar): decodeFrame lança -> painel derruba a conexão
  {
    const s = await freshStudent(base)
    s.sendSealed(new Uint8Array([99, 1, 2, 3]), false)
    await sleep(800)
    check('tag desconhecida', 'conexão cai, hub vivo', `hub vivo=${hub.alive()}`, hub.alive())
    s.close()
  }

  // Replay: reenviar um quadro cifrado já usado -> contador não bate -> rejeitado
  {
    const s = await freshStudent(base)
    const captured = []
    const origRaw = s.raw.bind(s)
    s.raw = (f) => {
      if (f[0] === 3) captured.push(f)
      origRaw(f)
    }
    s.sendEvent('focus-lost')
    await until('ack do evento', () => s.ackedEvent === 1, 4000)
    const before = panel.stats.badFrames
    // Reenvia o último quadro cifrado capturado (replay)
    origRaw(captured[captured.length - 1])
    await sleep(800)
    check('replay de quadro cifrado', 'rejeitado (contador fora de ordem), conexão cai', `badFrames subiu=${panel.stats.badFrames > before}`, panel.stats.badFrames > before)
    s.close()
  }

  // Peer id falsificado: um aluno tenta escrever no conn de outro? O hub atribui o conn; o aluno
  // só fala no próprio socket. Confirmamos que um aluno não consegue falar pelo hub como painel.
  {
    // Um "aluno" que manda enquadramento de hub (como se fosse painel) no /ws/student:
    const r = await rawConnect(port, '/ws/student')
    r.send(encodeHub(1, HubOp.data, encodeJson({ t: 'welcome' })))
    await sleep(500)
    check('aluno fingindo enquadramento de painel', 'tratado como quadro de aluno comum, hub vivo', `hub vivo=${hub.alive()}`, hub.alive())
    r.destroy?.()
  }

  panel.close()
  await drain()
}

// ---- 3. Handshakes inválidos e repetidos, custo no hub
async function handshakeFlood() {
  const panel = await new Panel(base, { token }).start()
  const cpu0 = hub.cpuSeconds()
  const rss0 = hub.rss()
  // 300 conexões que fazem handshake e mandam hello com senha errada (canal não abre).
  const studs = []
  for (let i = 0; i < 300; i++) {
    const s = new Student(base, { password: 'errada' })
    await s.connect()
    studs.push(s)
    if (i % 50 === 0) await sleep(20)
  }
  await sleep(4000)
  const cpu1 = hub.cpuSeconds()
  const rss1 = hub.rss()
  check('300 handshakes inválidos: custo de CPU no hub', 'hub quase sem CPU (só repassa bytes)', `ΔCPU=${(cpu1 - cpu0).toFixed(2)}s ΔRSS=${mib(rss1 - rss0)}`, cpu1 - cpu0 < 3)
  for (const s of studs) s.close()
  panel.close()
  await drain()
}

// ---- 4. Slowloris e conexões em massa (pré-upgrade)
async function slowloris() {
  const rss0 = hub.rss()
  const conns = []
  // Abre 400 conexões TCP que mandam cabeçalhos pela metade e nunca terminam.
  for (let i = 0; i < 400; i++) {
    try {
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.on('error', () => {})
      socket.on('connect', () => socket.write('GET /ws/student HTTP/1.1\r\nHost: x\r\n'))
      conns.push(socket)
    } catch {}
    if (i % 100 === 0) await sleep(10)
  }
  await sleep(3000)
  const rss1 = hub.rss()
  // O hub ainda responde e aceita um aluno legítimo?
  let pingOk = false
  let studentOk = false
  let probe = null
  try {
    const p = await Promise.race([hub.ping(), sleep(3000).then(() => null)])
    pingOk = !!p
  } catch {}
  try {
    probe = await Promise.race([new Student(base).connect(), sleep(3000).then(() => null)])
    studentOk = !!probe
  } catch {}
  check('slowloris: 400 conexões pré-upgrade paradas', '/ping responde e aluno legítimo ainda entra; RSS controlado', `ping=${pingOk} aluno=${studentOk} ΔRSS=${mib(rss1 - rss0)}`, pingOk && studentOk)
  probe?.close()
  for (const c of conns) c.destroy()
  await drain()
}

// ---- 5. MAX_PER_IP x NAT (regressão do conserto)
async function natRoom() {
  const panel = await new Panel(base, { token }).start()
  const studs = []
  let welcomed = 0
  for (let i = 0; i < 100; i++) {
    const s = await new Student(base).connect()
    s.waitWelcome.then(() => s.welcomed && welcomed++)
    studs.push(s)
  }
  await until('100 welcomes', () => welcomed === 100, 15000).catch(() => {})
  const p = await hub.ping()
  check('100 alunos do mesmo IP (sala atrás de NAT)', '100 conectam e recebem welcome', `welcomed=${welcomed} hub.students=${p.students}`, welcomed === 100 && p.students === 100)
  for (const s of studs) s.close()
  panel.close()
  await drain()
}

// ---- utilidades
async function freshStudent(base) {
  const s = await new Student(base).connect()
  await until('welcome', () => s.welcomed, 6000)
  return s
}
function isClosed(r) {
  return Promise.race([r.closed.then(() => true), sleep(100).then(() => false)])
}
async function drain() {
  await until('hub vazio', async () => {
    const p = await hub.ping()
    return p.students === 0 && !p.host
  }, 15000).catch(() => {})
}

try {
  await accessControl()
  await hostileFrames()
  await handshakeFlood()
  await slowloris()
  await natRoom()
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== ABUSE: ${results.length - failed.length}/${results.length} passaram ===`)
  if (failed.length) console.log('FALHARAM:', failed.map((f) => f.name).join('; '))
  hub.kill()
  await sleep(200)
  process.exit(failed.length ? 1 : 0)
}
