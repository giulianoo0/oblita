// Lado aluno e lado painel do protocolo do Oblita, reusando shared/ (via lib.mjs), para os
// testes de carga e de abuso. O painel conecta em /ws/host e fala o enquadramento do hub
// ([u32 conn][u8 op][dados]); o aluno conecta em /ws/student e troca quadros crus.
import {
  encodeJson,
  encodeBinary,
  decodeFrame,
  deflateFrame,
  inflateFrame,
  encodeHub,
  decodeHub,
  HubOp,
  SecureChannel,
  deriveRoomKey,
  newEphemeral,
  newTeacherIdentity,
  signHello,
  verifyHello,
  helloTranscript,
  fingerprint,
  sha256Hex,
  tokenProof,
  verifyTokenProof,
  toB64,
  fromB64,
  randomBytes,
  checkStudentWasm,
  RateLimiter,
  isAllowed,
  PROTOCOL_VERSION,
  MAX_INFLATED_TO_TEACHER,
  MAX_INFLATED_TO_STUDENT,
} from './lib.mjs'

export {
  encodeJson,
  encodeBinary,
  decodeFrame,
  deflateFrame,
  inflateFrame,
  encodeHub,
  decodeHub,
  HubOp,
  checkStudentWasm,
  PROTOCOL_VERSION,
  randomBytes,
  toB64,
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function wsOpen(url) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url)
    sock.binaryType = 'arraybuffer'
    sock.onopen = () => resolve(sock)
    sock.onerror = () => reject(new Error(`falha ao abrir ${url}`))
  })
}

// ------------------------------------------------------------------- O painel
// Mínimo para o aluno completar o fluxo: handshake assinado, welcome+token, prova, ack de
// event/rec, e validação do executável no test-wasm (como faz src/teacher/room.ts).
export class Panel {
  constructor(base, opts = {}) {
    this.base = base
    this.opts = opts
    this.identity = null
    this.salt = toB64(randomBytes(16))
    this.roomCode = opts.roomCode ?? 'ABC-123'
    this.password = opts.password ?? '' // '' = sala sem senha
    this.hasPassword = !!this.password
    this.links = new Map() // conn -> link state
    // clientId -> { tokenHash, lastEvent, lastRec }. Simula a store persistida do painel: ao
    // reabrir o painel (ou após o hub reiniciar) ela é recarregada, e o token é reconhecido.
    this.byClient = opts.byClient ?? new Map()
    this.stats = { students: 0, resumed: 0, rec: 0, events: 0, tests: 0, testsInvalid: 0, ysync: 0, badFrames: 0 }
    this.examFrame = null // Promise<Uint8Array> compartilhado (exam comprimido uma vez)
    this.onReady = opts.onReady ?? (() => {})
  }

  async start() {
    this.identity = this.opts.identity ?? (await newTeacherIdentity())
    this.roomKey = await deriveRoomKey(this.roomCode, this.password, fromB64(this.salt))
    const examJson = this.opts.exam ?? { t: 'exam', endsAt: null, clocks: {}, now: Date.now() }
    this.examFrame = deflateFrame(encodeJson(examJson))
    this.sock = await wsOpen(`${this.base}/ws/host?token=${this.opts.token}`)
    this.sock.onmessage = (e) => this.onHub(new Uint8Array(e.data))
    this.sock.onclose = () => (this.closed = true)
    return this
  }

  send(conn, frame) {
    if (this.sock.readyState === WebSocket.OPEN) this.sock.send(encodeHub(conn, HubOp.data, frame))
  }

  onHub(frame) {
    const { conn, op, data } = decodeHub(frame)
    if (op === HubOp.open) return void this.openStudent(conn)
    if (op === HubOp.close) return void this.links.delete(conn)
    if (op === HubOp.data) return void this.onData(conn, data)
  }

  async openStudent(conn) {
    const eph = await newEphemeral()
    const nonce = randomBytes(16)
    const pub = toB64(eph.pub)
    const nonceB64 = toB64(nonce)
    const transcript = helloTranscript(this.roomCode, this.salt, nonceB64, pub)
    const sig = await signHello(this.identity, transcript)
    this.links.set(conn, { eph, nonce, pub, transcript, channel: null, authed: false, inChain: Promise.resolve(), outChain: Promise.resolve(), limiter: new RateLimiter(), lastEvent: 0, lastRec: 0 })
    this.send(conn, encodeJson({ t: 'hi', v: PROTOCOL_VERSION, salt: this.salt, nonce: nonceB64, pub, password: this.hasPassword, code: this.roomCode, signPub: this.identity.publicRaw, sig }))
  }

  onData(conn, frame) {
    const link = this.links.get(conn)
    if (!link) return
    if (!link.channel) return this.onKey(conn, link, frame)
    link.inChain = link.inChain.then(async () => {
      let plain
      try {
        plain = await (await link.channel).open(frame)
      } catch {
        this.stats.badFrames++
        return
      }
      let opened
      try {
        opened = await inflateFrame(plain, MAX_INFLATED_TO_TEACHER)
      } catch {
        return
      }
      try {
        await this.onPlain(conn, link, opened)
      } catch {}
    })
  }

  onKey(conn, link, frame) {
    if (frame[0] !== 1) return
    try {
      const { json } = decodeFrame(frame)
      if (json.t !== 'key' || typeof json.pub !== 'string') return
      const pub = fromB64(json.pub)
      link.channel = SecureChannel.create('teacher', link.eph, pub, this.roomKey, link.nonce, link.eph.pub, pub)
      link.channel.catch(() => {})
    } catch {}
  }

  sealTo(conn, link, frame, compress = true) {
    const packed = compress ? deflateFrame(frame) : Promise.resolve(frame)
    link.outChain = link.outChain.then(async () => {
      const sealed = await (await link.channel).seal(await packed)
      this.send(conn, sealed)
    })
  }

  async onPlain(conn, link, frame) {
    const { json: msg, bytes } = decodeFrame(frame)
    if (!link.authed) {
      if (msg?.t === 'hello') {
        link.authed = true
        link.clientId = msg.clientId
        const known = this.byClient.get(msg.clientId)
        let token
        if (known && typeof msg.proof === 'string' && (await verifyTokenProof(known.tokenHash, msg.proof, link.transcript).catch(() => false))) {
          // Reconexão legítima: sem novo token, retoma os contadores confirmados.
          link.rec = known
          this.stats.resumed++
        } else {
          token = randomId(32)
          const tokenHash = await sha256Hex(token)
          link.rec = { tokenHash, lastEvent: 0, lastRec: 0 }
          this.byClient.set(msg.clientId, link.rec)
          this.stats.students++
        }
        this.onReady(conn)
        this.sealTo(conn, link, encodeJson({ t: 'welcome', token, config: this.opts.studentConfig ?? defaultConfig(), phase: 'running', lastEvent: link.rec.lastEvent, lastRec: link.rec.lastRec }))
        // Prova inteira, reaproveitando o quadro comprimido para a sala toda (como o painel real).
        this.sealTo(conn, link, await this.examFrame, false)
      }
      return
    }
    if (typeof msg?.t !== 'string') return
    if (!link.limiter.allow(msg.t)) return
    switch (msg.t) {
      case 'event':
        this.stats.events++
        if ((msg.event?.seq ?? 0) > link.rec.lastEvent) link.rec.lastEvent = msg.event.seq
        this.sealTo(conn, link, encodeJson({ t: 'ack', stream: 'event', seq: link.rec.lastEvent }))
        break
      case 'rec':
        this.stats.rec++
        if (typeof msg.seq === 'number' && msg.seq > link.rec.lastRec) link.rec.lastRec = msg.seq
        this.sealTo(conn, link, encodeJson({ t: 'ack', stream: 'rec', seq: link.rec.lastRec }))
        break
      case 'test-wasm': {
        this.stats.tests++
        const check = bytes ? checkStudentWasm(bytes) : { ok: false, reason: 'sem bytes' }
        if (!check.ok) {
          this.stats.testsInvalid++
          this.sealTo(conn, link, encodeJson({ t: 'test-result', result: { reqId: msg.reqId, questionId: msg.questionId, status: 'invalid', log: check.reason } }))
        } else {
          this.sealTo(conn, link, encodeJson({ t: 'test-result', result: { reqId: msg.reqId, questionId: msg.questionId, status: 'done', log: '', samples: [], hidden: { passed: 0, total: 0 }, nextInMs: 60000 } }))
        }
        break
      }
      case 'y-sync':
      case 'y-update':
        this.stats.ysync++
        break
      default:
        break
    }
  }

  close() {
    try {
      this.sock?.close()
    } catch {}
  }
}

function defaultConfig() {
  return { title: 'Prova de dureza', mode: 'individual', flow: 'free', timing: 'global', durationMin: 60, compiler: true, requireIsolation: false, recordScreen: true, maxTeamSize: 4 }
}

function randomId(n) {
  return Array.from(randomBytes(n), (b) => b.toString(16).padStart(2, '0')).join('')
}

// -------------------------------------------------------------------- O aluno
export class Student {
  constructor(base, opts = {}) {
    this.base = base
    this.opts = opts
    this.clientId = opts.clientId ?? randomId(16)
    this.name = opts.name ?? `Aluno ${this.clientId.slice(0, 4)}`
    this.password = opts.password ?? ''
    this.channel = null
    this.transcript = null
    this.token = undefined
    this.inChain = Promise.resolve()
    this.outChain = Promise.resolve()
    this.welcomed = false
    this.eventSeq = 0
    this.recSeq = 0
    this.sendCount = 0
    this.onWelcome = opts.onWelcome ?? (() => {})
    this.onTestResult = opts.onTestResult ?? (() => {})
    this.waitWelcome = new Promise((res) => (this._welcomeResolve = res))
  }

  async connect() {
    this.sock = await wsOpen(`${this.base}/ws/student`)
    this.sock.onmessage = (e) => this.onFrame(new Uint8Array(e.data))
    this.sock.onclose = () => (this.closed = true)
    return this
  }

  // Reconecta reusando clientId e token (prova de posse presa à nova abertura), como o cliente real.
  async reconnect() {
    this.channel = null
    this.transcript = null
    this.inChain = Promise.resolve()
    this.outChain = Promise.resolve()
    this.welcomed = false
    this.closed = false
    this.waitWelcome = new Promise((res) => (this._welcomeResolve = res))
    return this.connect()
  }

  raw(frame) {
    if (this.sock.readyState === WebSocket.OPEN) {
      this.sock.send(frame)
      this.sendCount++
    }
  }

  sendSealed(frame, compress = true) {
    const channel = this.channel
    if (!channel) return
    const packed = compress ? deflateFrame(frame) : Promise.resolve(frame)
    this.outChain = this.outChain.then(async () => {
      const sealed = await (await channel).seal(await packed)
      if (this.channel === channel) this.raw(sealed)
    }).catch(() => {})
  }

  send(msg) {
    this.sendSealed(encodeJson(msg))
  }

  onFrame(frame) {
    if (frame[0] !== 3) return void this.onPlain(frame)
    const channel = this.channel
    if (!channel) return
    this.inChain = this.inChain.then(async () => {
      let plain
      try {
        plain = await (await channel).open(frame)
      } catch {
        return
      }
      let opened
      try {
        opened = await inflateFrame(plain, MAX_INFLATED_TO_STUDENT)
      } catch {
        return
      }
      await this.onMessage(opened)
    }).catch(() => {})
  }

  async onPlain(frame) {
    let msg
    try {
      msg = decodeFrame(frame).json
    } catch {
      return
    }
    if (msg.t === 'hi') return this.onHi(msg)
    if (msg.t === 'refused') {
      this.refused = msg.reason
      this._welcomeResolve?.()
    }
  }

  async onHi(hi) {
    if (hi.v !== PROTOCOL_VERSION) {
      this.refused = 'version'
      return this._welcomeResolve?.()
    }
    const transcript = helloTranscript(hi.code, hi.salt, hi.nonce, hi.pub)
    let valid = false
    try {
      valid = await verifyHello(hi.signPub, hi.sig, transcript)
    } catch {}
    if (!valid) {
      this.badSig = true
      return
    }
    this.teacherFp = await fingerprint(hi.signPub)
    const key = await deriveRoomKey(hi.code, this.password, fromB64(hi.salt))
    const eph = await newEphemeral()
    const teacherPub = fromB64(hi.pub)
    this.raw(encodeJson({ t: 'key', pub: toB64(eph.pub) }))
    this.channel = SecureChannel.create('student', eph, teacherPub, key, fromB64(hi.nonce), teacherPub, eph.pub)
    this.transcript = transcript
    const proof = this.token ? await tokenProof(await sha256Hex(this.token), transcript) : undefined
    this.send({ t: 'hello', v: PROTOCOL_VERSION, clientId: this.clientId, proof, name: this.name, lastEvent: this.eventSeq, lastRec: this.recSeq, resumed: !!this.token })
  }

  async onMessage(frame) {
    let decoded
    try {
      decoded = decodeFrame(frame)
    } catch {
      return
    }
    const msg = decoded.json
    switch (msg.t) {
      case 'welcome':
        this.token = msg.token ?? this.token
        this.welcomed = true
        this.onWelcome(msg)
        this._welcomeResolve?.()
        break
      case 'exam':
        this.hasExam = true
        break
      case 'ack':
        if (msg.stream === 'rec') this.ackedRec = msg.seq
        if (msg.stream === 'event') this.ackedEvent = msg.seq
        this.onAck?.(msg.stream, msg.seq)
        break
      case 'test-result':
        this.onTestResult(msg.result)
        break
      default:
        break
    }
  }

  // ---- mensagens típicas de prova
  sendEvent(kind = 'focus-lost') {
    const seq = ++this.eventSeq
    this.send({ t: 'event', event: { seq, kind, at: Date.now(), hash: '0'.repeat(64) } })
  }

  sendBeat() {
    this.send({ t: 'beat', at: Date.now(), status: { screen: true, fullscreen: true, focused: true, isolated: null, extended: false } })
  }

  sendThumb(bytes) {
    this.sendSealed(encodeBinary({ t: 'frame', at: Date.now(), focus: false }, bytes), false)
  }

  sendRec(bytes, segment, part, last) {
    const seq = ++this.recSeq
    this.sendSealed(encodeBinary({ t: 'rec', seq, segment, part, startedAt: Date.now(), last, mime: 'video/webm' }, bytes), false)
  }

  sendYUpdate(bytes) {
    this.sendSealed(encodeBinary({ t: 'y-update' }, bytes))
  }

  sendTestWasm(wasm, reqId = randomId(6), questionId = 'q1') {
    this.sendSealed(encodeBinary({ t: 'test-wasm', reqId, questionId, lang: 'cpp' }, wasm))
  }

  close() {
    try {
      this.sock?.close()
    } catch {}
  }
}

export { randomId }
