// Expõe as classes reais em window.T. Rede, cifra, Yjs, compilador e IndexedDB são os de verdade.
import * as Y from 'yjs'
import { Room } from '../../src/teacher/room'
import { StudentSession } from '../../src/student/session'
import { idb } from '../../src/lib/idb'
import { BEACON, beaconCells } from '../../shared/beacon'
import { encodeBinary, encodeJson, decodeFrame, inflate } from '../../shared/frames'
import { validateExam, validateSolutions } from '../../shared/exam'
import { PROTOCOL_VERSION } from '../../shared/protocol'
import { SEALED_TAG, helloTranscript, newEphemeral, newTeacherIdentity, signHello, toB64 } from '../../shared/secure'

const dec = new TextDecoder()
const enc = new TextEncoder()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const T: any = {
  Room,
  StudentSession,
  idb,
  Y,
  room: null,
  s: null,
  rx: [],
  // O único falso do lado do aluno: sem tela real, o estado do vigia vem daqui.
  proctor: { screen: true, fullscreen: true, focused: true, isolated: true, extended: false },
  beaconMode: 'right',
  beaconSeen: new Set<number>(),
}

T.createRoom = async (o: any, exam: any, solutions: any, addr: string, token: string) => {
  const checked = validateExam(exam)
  if (!checked.exam) throw new Error(`prova inválida: ${checked.errors.join('; ')}`)
  if (solutions) {
    const sol = validateSolutions(solutions, checked.exam)
    if (!sol.solutions) throw new Error(`gabarito inválido: ${sol.errors.join('; ')}`)
  }
  const roomId = `sala-${Math.random().toString(36).slice(2, 10)}`
  const config = {
    roomId,
    title: exam.title,
    mode: o.mode ?? 'individual',
    flow: o.flow ?? 'free',
    timing: o.timing ?? 'global',
    compiler: o.compiler ?? true,
    requireIsolation: o.requireIsolation ?? false,
    recordScreen: o.recordScreen ?? false,
    maxTeamSize: o.maxTeamSize ?? 4,
    groups: [],
  }
  T.room = await Room.create(config as any, exam, solutions, o.password ?? '')
  await T.room.holdTab()
  await T.room.useHub(addr, token)
  return { roomId, code: T.room.roomCode }
}

T.loadRoom = async (roomId: string, addr: string, token: string) => {
  T.room = await Room.load(roomId)
  if (!T.room) throw new Error('sala não achada')
  // O mesmo caminho do painel: o relógio e a retomada das correções nascem com a trava da aba.
  if (!(await T.room.holdTab())) throw new Error('aba sem a trava')
  await T.room.useHub(addr, token)
  return { phase: T.room.phase }
}

T.reloadRoom = async (addr: string, token: string) => {
  const id = T.room.config.roomId
  T.room.dispose()
  return T.loadRoom(id, addr, token)
}

T.reattach = async (addr: string, token: string) => {
  for (let i = 0; i < 40; i++) {
    try {
      await T.room.useHub(addr, token)
      return true
    } catch {
      await sleep(250)
    }
  }
  return false
}

const safeSnap = (d: any, q: string) => {
  try {
    return d.snapshot(q)
  } catch (err) {
    return { error: String(err) }
  }
}

T.summary = () => {
  const r = T.room
  const codeQ = r.exam.questions.filter((q: any) => q.type === 'code')
  return {
    phase: r.phase,
    endsAt: r.endsAt,
    code: r.roomCode,
    busState: r.busState,
    config: r.config,
    students: [...r.students.values()].map((s: any) => ({
      clientId: s.clientId,
      name: s.name,
      enrollment: s.enrollment,
      online: s.online,
      peer: s.peer,
      examSent: s.examSent,
      examGranted: s.examGranted,
      groupId: s.groupId,
      status: s.status,
      alerts: s.alerts,
      lastEvent: s.lastEvent,
      lastRec: s.lastRec,
      finishedAt: s.finishedAt,
      chainBroken: s.chainBroken,
      beaconOk: s.beaconOk,
      signalLost: s.signalLost,
      segments: s.segments,
    })),
    teams: [...r.teams.values()].map((t: any) => ({ key: t.key, endsAt: t.endsAt, clockInAt: t.clockInAt, closed: !!t.closed, answers: t.answers, submissions: t.submissions, grades: t.grades })),
    alerts: r.alerts.map((a: any) => ({ kind: a.kind, clientId: a.clientId, at: a.at, detail: a.detail })),
    codes: [...r.teamCodes],
    docs: Object.fromEntries([...r.docs].map(([k, d]: any) => [k, Object.fromEntries(codeQ.map((q: any) => [q.id, safeSnap(d, q.id)]))])),
    links: r.links.size,
    peers: r.peers.size,
    // A fila de trabalho (shared/jobs.ts) junta esperando e rodando.
    gradeQueue: r.queue?.pending ?? 0,
    gradeRunning: 0,
  }
}

// Tudo o que o painel e o exportador vão ler precisa continuar de pé depois de um ataque.
T.sane = () => {
  const r = T.room
  JSON.stringify(T.summary())
  const csv = r.resultsCsv()
  for (const team of r.teams.values()) r.scoreOf(team)
  return { csv: csv.length, protoKeys: Object.keys(Object.prototype), polluted: ({} as any).polluted ?? null }
}

T.gradeOf = (clientId: string, q: string) => {
  const s = T.room.students.get(clientId)
  return s ? (T.room.teamOf(s).grades[q] ?? null) : null
}

T.team = (clientId: string) => {
  const s = T.room.students.get(clientId)
  if (!s) return null
  const key = T.room.teamKey(s)
  const t = T.room.teams.get(key)
  return { key, endsAt: t?.endsAt ?? null, closed: !!t?.closed, answers: t?.answers ?? {}, submissions: t?.submissions ?? {} }
}

T.dumpIdb = async () => {
  const out: Record<string, unknown> = {}
  for (const store of ['kv', 'outbox'] as const) {
    for (const key of await idb.keys(store)) out[`${store}:${String(key)}`] = await idb.get(store, key)
  }
  const blobs: string[] = []
  for (const key of await idb.keys('chunks')) {
    const b = await idb.get<Blob>('chunks', key)
    if (b) blobs.push(dec.decode(await b.arrayBuffer()))
  }
  return JSON.stringify(out) + blobs.join('')
}

// ---- aluno

T.newStudent = (status: any = {}) => {
  const s: any = new StudentSession()
  T.s = s
  T.rx = []
  Object.assign(T.proctor, status)
  s.proctor.status = () => ({ ...T.proctor })
  const onMessage = s.onMessage
  s.onMessage = async function (frame: Uint8Array) {
    let t = '?'
    let text = dec.decode(frame)
    try {
      const { json, bytes } = decodeFrame(frame) as any
      t = json?.t
      if (t === 'beacon') T.beaconSeen.add(json.code)
      // A prova vem comprimida nos bytes: a busca de vazamentos precisa ver o texto aberto.
      if (t === 'exam' && bytes) text += dec.decode(await inflate(bytes, 64 * 1024 * 1024))
    } catch {}
    if (t !== 'time') T.rx.push({ t, text })
    return onMessage.call(s, frame)
  }
  const onPlain = s.onPlain
  s.onPlain = function (frame: Uint8Array) {
    try {
      const json = decodeFrame(frame).json as any
      if (json?.t === 'hi' && !T.lastHi) T.lastHi = json
    } catch {}
    return onPlain.call(s, frame)
  }
  const send = s.send
  T.hellos = []
  s.send = function (msg: any) {
    if (msg?.t === 'hello') T.hellos.push(msg)
    return send.call(s, msg)
  }
  T.installGrabber()
}

const beaconPng = (code: number) => {
  const size = 20
  const canvas = new OffscreenCanvas(BEACON.cols * size, BEACON.rows * size)
  const ctx = canvas.getContext('2d')!
  beaconCells(code).forEach((row, y) =>
    row.forEach((on, x) => {
      ctx.fillStyle = on ? '#fff' : '#000'
      ctx.fillRect(x * size, y * size, size, size)
    }),
  )
  return canvas.convertToBlob({ type: 'image/png' })
}

// Sem captura real da tela: a imagem do selo nasce aqui, mas o PNG é decodificado de verdade pelo professor.
T.installGrabber = () => {
  T.s.grabber = {
    grab: async () => {
      const c = new OffscreenCanvas(8, 8)
      c.getContext('2d')!.fillRect(0, 0, 4, 4)
      return c.convertToBlob({ type: 'image/jpeg' })
    },
    cropRegion: async () => {
      if (T.beaconMode === 'none') return null
      if (T.beaconMode === 'garbage') return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
      let code = T.s.beaconCode
      if (T.beaconMode === 'wrong') {
        code = 0
        while (T.beaconSeen.has(code)) code++
      }
      return beaconPng(code)
    },
    dispose() {},
  }
}

T.join = (addr: string, name: string, password = '', enrollment?: string) => T.s.begin({ kind: 'hub', address: addr }, '', name, enrollment, undefined, password)

T.view = () => {
  const s = T.s
  return {
    linkState: s.linkState,
    connectError: s.connectError,
    refused: s.refused,
    needsPassword: s.needsPassword,
    welcomed: s.welcomed,
    phase: s.phase,
    config: s.config,
    team: s.team,
    teamError: s.teamError,
    hasExam: !!s.exam,
    exam: s.exam,
    endsAt: s.saved?.endsAt,
    clientId: s.saved?.clientId,
    token: s.saved?.token,
    roomCode: s.saved?.roomCode,
    finished: !!s.saved?.finished,
    pending: s.pendingUploads(),
    events: s.events.length,
    rec: s.recQueue.length,
    testing: s.testing,
    testReport: s.testReport,
    running: s.running,
    runOutput: s.runOutput,
    warning: s.warning,
    resumed: s.resumed,
    hasChannel: !!s.channel,
    hasLink: !!s.link,
  }
}

T.setStatus = (patch: any, emit = true) => {
  Object.assign(T.proctor, patch)
  if (emit) T.s.onStatus(T.s.proctor.status())
}

T.code = (q: string, file: string) => T.s.doc.files(q).get(file)?.toString() ?? null
T.snap = (q: string) => T.s.doc.snapshot(q)

T.setCode = (q: string, file: string, text: string) => {
  const files = T.s.doc.files(q)
  T.s.doc.doc.transact(() => {
    const cur = files.get(file)
    if (cur) cur.delete(0, cur.length)
    else files.set(file, new Y.Text())
    files.get(file).insert(0, text)
  })
}

// Digita em lugares aleatórios, com outro digitando ao mesmo tempo.
T.type = async (q: string, file: string, mark: string, n: number, delay = 2) => {
  for (let i = 0; i < n; i++) {
    const text = T.s.doc.files(q).get(file)
    text.insert(Math.floor(Math.random() * (text.length + 1)), mark)
    if (delay) await sleep(delay)
  }
}

T.busy = (mark: string, ms = 20) => {
  clearInterval(T.busyTimer)
  T.busyCount = 0
  T.busyTimer = setInterval(() => {
    const text = T.s.doc.files('q2').get('main.cpp')
    if (!text) return
    text.insert(text.length, mark)
    T.busyCount++
  }, ms)
}
T.calm = () => {
  clearInterval(T.busyTimer)
  return T.busyCount
}

// Mensagens de um cliente adulterado, pelo canal cifrado real.
T.raw = (msg: unknown) => T.s.send(msg)
T.rawBin = (header: unknown, bytes: number[] | Uint8Array) => T.s.sendSealed(encodeBinary(header, Uint8Array.from(bytes)))
T.rawBinSize = (header: unknown, size: number) => T.s.sendSealed(encodeBinary(header, new Uint8Array(size).fill(7)))
T.rawText = (text: string, tag = 1) => {
  const body = enc.encode(text)
  const out = new Uint8Array(body.length + 1)
  out[0] = tag
  out.set(body, 1)
  T.s.sendSealed(out)
}
T.rawBytes = (bytes: number[]) => T.s.sendSealed(Uint8Array.from(bytes))
T.helloWith = (patch: Record<string, unknown> | null) => {
  if (!patch) return void delete T.s.sendHello
  T.s.sendHello = () => {
    const s = T.s.saved
    T.s.send({ t: 'hello', v: PROTOCOL_VERSION, clientId: s.clientId, name: s.name, lastEvent: 0, lastRec: 0, resumed: false, ...patch })
  }
}

// Um update de Yjs válido, feito à parte, sem passar pelo documento da sessão.
T.foreignUpdate = (q: string, file: string, text: string) => {
  const doc = new Y.Doc()
  doc.getMap(`files:${q}`).set(file, new Y.Text(text))
  return [...Y.encodeStateAsUpdate(doc)]
}

// ---- quem está no meio da rede: quadros em claro, entregues pelo mesmo caminho do que vem do hub

T.inject = (msg: unknown) => T.s.link.onframe(encodeJson(msg))

T.spyLink = () => {
  T.tx = []
  const link = T.s.link
  const send = link.send
  link.send = (frame: Uint8Array) => {
    T.tx.push(frame[0])
    return send(frame)
  }
}
T.txPlain = () => T.tx.filter((tag: number) => tag !== SEALED_TAG).length

// Assinatura válida, feita com uma chave que não é a do professor.
T.forgeHi = async () => {
  const hi = T.lastHi
  const identity = await newTeacherIdentity()
  const eph = await newEphemeral()
  const pub = toB64(eph.pub)
  const sig = await signHello(identity, helloTranscript(hi.code, hi.salt, hi.nonce, pub))
  return { ...hi, pub, signPub: identity.publicRaw, sig }
}

T.badSigHi = async () => {
  const eph = await newEphemeral()
  return { ...T.lastHi, pub: toB64(eph.pub) }
}

T.goOffline = () => {
  T.s.closing = true
  T.s.link?.close()
}
T.goOnline = () => {
  T.s.closing = false
  return T.s.connect()
}

T.part = (segment: number, part: number, last: boolean, text: string) =>
  T.s.enqueuePart({ segment, part, startedAt: Date.now(), last, mime: 'video/webm', blob: new Blob([text], { type: 'video/webm' }) })

T.rxFind = (needles: string[]) => Object.fromEntries(needles.map((n) => [n, T.rx.filter((m: any) => m.text.includes(n)).length]))
T.rxCount = (t: string) => T.rx.filter((m: any) => m.t === t).length
const rxJson = (text: string) => {
  const head = text.charCodeAt(0) === 2 ? text.slice(5) : text.slice(1)
  try {
    return JSON.parse(head)
  } catch {
    return { t: '?' }
  }
}
T.rxAll = (t: string) => T.rx.filter((m: any) => m.t === t).map((m: any) => rxJson(m.text))
T.rxLast = (t: string) => T.rxAll(t).pop() ?? null

const w = window as any
w.T = T
w.__ready = true
