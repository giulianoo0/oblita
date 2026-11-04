// Sessão do aluno, fora do React: sobrevive a re-renderização e é restaurada depois de um F5.
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { decodeFrame, encodeBinary, encodeJson } from '../../shared/frames'
import { SEALED_TAG, SecureChannel, deriveRoomKey, fingerprint, fromB64, helloTranscript, newEphemeral, sha256Hex, toB64, tokenProof, verifyHello } from '../../shared/secure'
import type { Exam } from '../../shared/exam'
import {
  PROTOCOL_VERSION,
  RUN_LIMITS,
  TEST_INTERVAL_MS,
  type AlertKind,
  type RunReport,
  type TestReport,
  type Answer,
  type Phase,
  type ProctorEvent,
  type StudentMsg,
  type StudentRoomConfig,
  type StudentStatus,
  type TeacherMsg,
  type TeacherPlain,
  type TeamInfo,
} from '../../shared/protocol'
import { idb, requestPersistence } from '../lib/idb'
import { Observable, randomId } from '../lib/store'
import { LinkError, connectHub, connectRtc, type ConnectError, type Link } from '../net/link'
import { ExamDoc } from '../collab/examDoc'
import { compile, run } from '../compiler/client'
import { Proctor, enterFullscreen, isExtendedDisplay, requestScreen } from './proctor'
import { FrameGrabber, ScreenRecorder, type RecPart } from './recorder'

const CLOCK_SYNC_MS = 15_000
const BEAT_MS = 2000
const THUMB_MS = 3000
const FOCUS_MS = 1000
const REC_WINDOW = 4
const DRAFT_DEBOUNCE = 800
const DOC_SAVE_MS = 1000
const BEACON_DELAY_MS = 800
const REMOTE = 'remote'

type Via = { kind: 'hub'; address: string } | { kind: 'rtc'; code: string }
type Reliable = { seq: number; msg: StudentMsg }

interface Saved {
  via: Via
  roomCode: string
  roomKey?: string
  roomSalt?: string
  token?: string
  teacherFp?: string
  docState?: string
  clientId: string
  name: string
  enrollment?: string
  groupId?: string
  exam?: Exam
  endsAt?: number
  clockOffset?: number
  // Guardada para um F5 com o professor fora do ar ainda abrir a prova com as regras certas.
  config?: StudentRoomConfig
  answers: Record<string, { answer: Answer; rev: number }>
  eventSeq: number
  recSeq: number
  segment: number
  lastHash: string
  finished?: boolean
  active: boolean
}

export type LinkState = 'idle' | 'connecting' | 'online' | 'retrying'

export interface RunOutput {
  stdout: string
  stderr: string
  log: string
  where: 'local' | 'host'
  state: 'compiling' | 'running' | 'done' | 'compile-error'
  exitCode?: number
  error?: string
}

export { defaultStarter, mainFile } from '../../shared/exam'

export class StudentSession extends Observable {
  saved: Saved | null = null
  linkState: LinkState = 'idle'
  connectError: ConnectError | null = null
  refused: string | null = null
  config: StudentRoomConfig | null = null
  phase: Phase = 'lobby'
  status: StudentStatus = { screen: false, fullscreen: false, focused: true, isolated: null, extended: false }
  screenError: 'denied' | 'not-monitor' | 'unsupported' | null = null
  warning: string | null = null
  team: TeamInfo | null = null
  teamError: string | null = null
  needsPassword = false
  teacherFp: string | null = null
  beaconCode: number | null = null
  doc = new ExamDoc()
  awareness = new Awareness(this.doc.doc)
  resumed = false
  testing = false
  testReport: Exclude<TestReport, { status: 'queued' | 'limited' }> | null = null
  nextTestAt = 0
  running = false
  runOutput: RunOutput | null = null
  savedAt = 0
  private killRun: (() => void) | null = null
  private clockBase = 0
  private clockAt = 0
  private clockRtt = Infinity

  private link: Link | null = null
  private channel: Promise<SecureChannel> | null = null
  private transcript: Uint8Array<ArrayBuffer> | null = null
  private awaitingWelcome = false
  private password = ''
  private docSaveTimer = 0
  private proctor: Proctor
  private recorder: ScreenRecorder | null = null
  private grabber: FrameGrabber | null = null
  private stream: MediaStream | null = null
  private timers: number[] = []
  private events: Reliable[] = []
  private recQueue: { seq: number; key: string; meta: Omit<RecPart, 'blob'> }[] = []
  private recInFlight = 0
  private lastRecAck = 0
  private focusOn = false
  private draftTimers = new Map<string, number>()
  private welcomed = false
  private closing = false
  private chain: Promise<unknown> = Promise.resolve()

  constructor() {
    super()
    this.proctor = new Proctor({
      alert: (kind, detail) => void this.raise(kind, detail),
      status: (status) => this.onStatus(status),
      snapshot: () => void this.sendFrame(),
    })
    this.watchDoc()
  }

  private watchDoc() {
    this.doc.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE && origin !== 'load') this.sendSealed(encodeBinary({ t: 'y-update' } satisfies StudentMsg, update))
      this.scheduleDocSave()
      this.changed()
    })
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === REMOTE || !this.team) return
      this.sendSealed(encodeBinary({ t: 'y-aware' } satisfies StudentMsg, encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed])))
    })
  }

  // Autosave: a cada edição o documento vai para o disco, e um F5 retoma de onde parou.
  private scheduleDocSave() {
    if (this.docSaveTimer) return
    this.docSaveTimer = window.setTimeout(() => {
      this.docSaveTimer = 0
      if (!this.saved) return
      this.saved.docState = bytesToB64(this.doc.encodeState())
      void this.persist()
    }, DOC_SAVE_MS)
  }

  private resetDoc() {
    this.awareness.destroy()
    this.doc.destroy()
    this.doc = new ExamDoc()
    this.awareness = new Awareness(this.doc.doc)
    this.watchDoc()
  }

  get exam() {
    return this.saved?.exam ?? null
  }

  get ready() {
    const s = this.status
    return s.screen && s.fullscreen && !s.extended && (!this.config?.requireIsolation || s.isolated === true)
  }

  // O relógio do professor é o que vale, então mudar a hora da máquina não dá tempo extra.
  remaining() {
    const saved = this.saved
    if (!saved?.endsAt) return null
    return saved.endsAt - this.serverNow()
  }

  async restore(): Promise<boolean> {
    const saved = await idb.get<Saved>('kv', 'student')
    if (!saved?.active) return false
    this.saved = saved
    this.teacherFp = saved.teacherFp ?? null
    this.resumed = true
    if (saved.docState) this.doc.apply(fromB64(saved.docState), 'load')
    this.setIdentity()
    this.config = saved.config ?? null
    if (saved.exam) this.phase = 'running'
    this.events = (await idb.values<Reliable>('outbox', idb.prefix('e:')))
    this.events.sort((a, b) => a.seq - b.seq)
    const recs = await idb.values<{ seq: number; key: string; meta: Omit<RecPart, 'blob'> }>('outbox', idb.prefix('r:'))
    this.recQueue = recs.sort((a, b) => a.seq - b.seq)
    this.changed()
    void this.connect()
    return true
  }

  private setIdentity() {
    this.awareness.setLocalStateField('user', { name: this.saved?.name ?? '' })
  }

  async begin(via: Via, roomCode: string, name: string, enrollment?: string, _groupId?: string, password = '') {
    await requestPersistence()
    // Mesma máquina volta como o mesmo aluno, mesmo depois de ser recusada ou recarregar.
    const previous = this.saved ?? (await idb.get<Saved>('kv', 'student'))
    this.password = password
    this.needsPassword = false
    // Quem foi recusado pode tentar de novo com outro código sem recarregar a página.
    this.closing = false
    this.refused = null
    this.welcomed = false
    this.config = null
    this.phase = 'lobby'
    this.saved = {
      via,
      roomCode: roomCode.trim().toUpperCase(),
      name: name.trim(),
      enrollment: enrollment?.trim() || undefined,
      clientId: previous?.clientId ?? randomId(),
      token: previous?.token,
      answers: {},
      eventSeq: 0,
      recSeq: 0,
      segment: 0,
      lastHash: '',
      active: true,
    }
    this.resetDoc()
    this.setIdentity()
    await this.persist()
    return this.connect()
  }

  async connect(): Promise<boolean> {
    const saved = this.saved
    if (!saved) return false
    this.linkState = this.link ? this.linkState : 'connecting'
    this.connectError = null
    this.changed()
    try {
      const link = saved.via.kind === 'hub' ? await connectHub(saved.via.address) : await connectRtc(saved.via.code)
      this.attach(link)
      return true
    } catch (err) {
      this.connectError = err instanceof LinkError ? err.code : 'unreachable'
      this.linkState = this.welcomed ? 'retrying' : 'idle'
      if (this.welcomed || this.resumed) this.scheduleReconnect()
      this.changed()
      return false
    }
  }

  private scheduleReconnect() {
    if (this.closing) return
    window.setTimeout(() => {
      if (!this.link && !this.closing) void this.connect()
    }, 1500)
  }

  private attach(link: Link) {
    this.link?.close()
    this.link = link
    link.onframe = (frame) => this.onFrame(frame)
    link.onclose = () => {
      if (this.link !== link) return
      this.link = null
      this.channel = null
      this.linkState = 'retrying'
      this.recInFlight = 0
      this.abandonRemoteJobs()
      this.changed()
      this.scheduleReconnect()
    }
    this.channel = null
    this.transcript = null
    this.awaitingWelcome = false
    this.linkState = 'online'
    this.connectError = null
    this.changed()
  }

  // A resposta destes pedidos vinha pela conexão que caiu: sem isto os botões ficariam presos.
  private abandonRemoteJobs() {
    this.testing = false
    if (this.running && this.runOutput?.where === 'host') {
      this.running = false
      this.runOutput = { ...this.runOutput, state: 'done', error: 'A conexão com o professor caiu' }
    }
  }

  private async sendHello() {
    const s = this.saved
    const transcript = this.transcript
    if (!s || !transcript) return
    const proof = s.token ? await tokenProof(await sha256Hex(s.token), transcript) : undefined
    if (this.transcript !== transcript) return
    this.awaitingWelcome = true
    this.send({
      t: 'hello',
      v: PROTOCOL_VERSION,
      clientId: s.clientId,
      proof,
      name: s.name,
      enrollment: s.enrollment,
      lastEvent: s.eventSeq,
      lastRec: s.recSeq,
      resumed: this.resumed,
    })
  }

  // Nada sai em claro: a ordem é a do canal, e sem canal a mensagem é descartada.
  private sendSealed(frame: Uint8Array<ArrayBuffer>) {
    const link = this.link
    const channel = this.channel
    if (!link || !channel) return
    void channel
      .then((c) => c.seal(frame))
      .then(
        // Cifrado com uma chave que já foi trocada, o quadro não abriria do outro lado.
        (sealed) => this.link === link && this.channel === channel && link.send(sealed),
        () => link.close(),
      )
  }

  private send(msg: StudentMsg) {
    this.sendSealed(encodeJson(msg))
  }

  private onFrame(frame: Uint8Array) {
    const link = this.link
    if (frame[0] !== SEALED_TAG) return void this.onPlain(frame)
    const channel = this.channel
    if (!channel) return
    void channel
      .then((c) => c.open(frame))
      .then(
        (plain) => this.link === link && this.onMessage(plain),
        () => link?.close(),
      )
  }

  private async onPlain(frame: Uint8Array) {
    let msg: TeacherPlain
    try {
      msg = decodeFrame<TeacherPlain>(frame).json
    } catch {
      return
    }
    if (msg.t === 'refused') {
      // Recusa em claro só vale enquanto a entrada está sendo decidida. Fora disso, é forjada.
      if (!this.awaitingWelcome) return
      if (this.saved) {
        this.saved.roomKey = undefined
        this.saved.roomSalt = undefined
      }
      return this.refuse(msg.reason)
    }
    if (msg.t === 'hi') await this.onHi(msg)
  }

  // Recusado não volta a esta sala: a tela e o gravador não ficam ligados à toa.
  private stopCapture() {
    this.proctor.stop()
    this.proctorStarted = false
    this.recorder?.stop()
    this.recorder = null
    this.grabber?.dispose()
    this.grabber = null
    this.stream = null
  }

  private refuse(reason: string) {
    this.refused = reason
    this.stopCapture()
    this.closing = true
    this.link?.close()
    this.link = null
    this.channel = null
    this.linkState = 'idle'
    if (this.saved) this.saved.active = false
    void this.persist()
    this.changed()
  }

  private async onHi(hi: Extract<TeacherPlain, { t: 'hi' }>) {
    const s = this.saved
    const link = this.link
    if (!s || !link) return
    // Vem antes da assinatura: quem já entrou não pode ser derrubado por um hi em claro de qualquer um.
    if (hi.v !== PROTOCOL_VERSION) return this.welcomed ? undefined : this.refuse('version')
    const transcript = helloTranscript(hi.code, hi.salt, hi.nonce, hi.pub)
    let valid = false
    try {
      valid = await verifyHello(hi.signPub, hi.sig, transcript)
    } catch {
      valid = false
    }
    if (!valid) return
    const fp = await fingerprint(hi.signPub)
    if (s.teacherFp && s.teacherFp !== fp) {
      // No meio de uma prova, outra chave é outra pessoa. Antes dela ou depois de entregar,
      // é só uma sala nova neste IP, e a sessão antiga salva no navegador não vale mais.
      if (s.exam && !s.finished) return this.refuse('impostor')
      await this.forgetOldRoom(s)
    }
    s.teacherFp = fp
    this.teacherFp = fp
    this.channel = null
    this.transcript = null
    let key = s.roomKey && s.roomSalt === hi.salt ? fromB64(s.roomKey) : null
    if (!key) {
      if (hi.password && !this.password) {
        this.needsPassword = true
        return this.refuse('password-required')
      }
      s.roomCode = hi.code
      key = (await deriveRoomKey(hi.code, this.password, fromB64(hi.salt))) as Uint8Array<ArrayBuffer>
      s.roomKey = toB64(key)
      s.roomSalt = hi.salt
      void this.persist()
    }
    const eph = await newEphemeral()
    const teacherPub = fromB64(hi.pub)
    if (this.link !== link) return
    link.send(encodeJson({ t: 'key', pub: toB64(eph.pub) }))
    this.channel = SecureChannel.create('student', eph, teacherPub, key, fromB64(hi.nonce), teacherPub, eph.pub)
    this.transcript = transcript
    void this.sendHello()
  }

  private async forgetOldRoom(s: Saved) {
    s.roomKey = undefined
    s.roomSalt = undefined
    s.token = undefined
    s.groupId = undefined
    s.exam = undefined
    s.endsAt = undefined
    s.config = undefined
    s.docState = undefined
    s.finished = undefined
    s.answers = {}
    s.eventSeq = 0
    s.recSeq = 0
    s.segment = 0
    s.lastHash = ''
    this.events = []
    this.recQueue = []
    this.recInFlight = 0
    this.welcomed = false
    this.resumed = false
    this.config = null
    this.phase = 'lobby'
    this.team = null
    this.resetDoc()
    this.setIdentity()
    await Promise.all((await idb.keys('outbox')).map((key) => idb.del('outbox', key)))
    await Promise.all((await idb.keys('chunks')).map((key) => idb.del('chunks', key)))
  }

  private onMessage(frame: Uint8Array) {
    let decoded
    try {
      decoded = decodeFrame<TeacherMsg>(frame)
    } catch {
      return
    }
    const { json: msg, bytes } = decoded
    switch (msg.t) {
      case 'refused':
        this.refuse(msg.reason)
        break
      case 'welcome':
        this.onWelcome(msg)
        break
      case 'exam':
        if (this.saved) {
          this.saved.exam = msg.exam
          this.saved.endsAt = msg.endsAt
          if (!this.clockAt) this.saved.clockOffset = msg.now - Date.now()
          void this.persist()
        }
        this.phase = 'running'
        this.syncDoc()
        break
      case 'clock':
        if (this.saved) this.saved.endsAt = msg.endsAt
        break
      case 'time':
        this.onTime(msg.c, msg.s)
        break
      case 'run-result':
        this.onRunResult(msg.result)
        break
      case 'phase':
        this.phase = msg.phase
        if (msg.phase === 'ended') void this.finish(true)
        break
      case 'ack':
        void this.onAck(msg.stream, msg.seq)
        break
      case 'warn':
        this.warning = msg.text
        break
      case 'focus':
        this.focusOn = msg.on
        if (msg.on) void this.sendFrame()
        break
      case 'team':
        this.followTeam(msg.team?.id)
        this.team = msg.team
        this.teamError = null
        if (this.saved) this.saved.groupId = msg.team?.id
        void this.persist()
        break
      case 'team-error':
        this.teamError = msg.reason
        break
      case 'y-update':
        if (bytes) this.applyRemote(bytes)
        break
      case 'y-sync':
        if (bytes) this.sendSealed(encodeBinary({ t: 'y-update' } satisfies StudentMsg, this.doc.diffFor(bytes)))
        break
      case 'y-aware':
        // Vem de um colega, repassado sem interpretar: lixo aqui não pode virar exceção.
        try {
          if (bytes) applyAwarenessUpdate(this.awareness, bytes, REMOTE)
        } catch {
          // Cursor é descartável.
        }
        break
      case 'beacon':
        this.beaconCode = msg.code
        window.setTimeout(() => void this.sendBeaconFrame(msg.code), BEACON_DELAY_MS)
        break
      case 'group-draft':
        if (this.saved) {
          const cur = this.saved.answers[msg.questionId]
          if (!cur || msg.rev >= cur.rev) this.saved.answers[msg.questionId] = { answer: msg.answer, rev: msg.rev }
          void this.persist()
        }
        break
      case 'test-result':
        this.onTestResult(msg.result)
        break
    }
    this.changed()
  }

  // Movido pelo professor com a prova aberta: o documento antigo é da outra equipe e não pode ir junto.
  private followTeam(next?: string) {
    const s = this.saved
    if (!s?.exam || !s.groupId || !next || s.groupId === next) return
    s.docState = undefined
    this.resetDoc()
    this.setIdentity()
  }

  private onWelcome(msg: Extract<TeacherMsg, { t: 'welcome' }>) {
    this.awaitingWelcome = false
    this.welcomed = true
    this.config = msg.config
    this.phase = msg.phase
    const s = this.saved!
    s.config = msg.config
    if (msg.token) s.token = msg.token
    this.followTeam(msg.team?.id)
    this.team = msg.team ?? null
    s.groupId = msg.team?.id
    // Respostas que o professor já tem e que este computador perdeu voltam aqui.
    for (const [id, draft] of Object.entries(msg.drafts ?? {})) {
      const cur = s.answers[id]
      if (!cur || draft.rev > cur.rev) s.answers[id] = draft
    }
    void this.onAck('event', msg.lastEvent)
    void this.onAck('rec', msg.lastRec).then(() => {
      // O documento vai antes das entregas pendentes: o professor corrige a partir dele.
      if (s.exam) this.syncDoc()
      for (const r of this.events) this.send(r.msg)
      for (const [questionId, d] of Object.entries(s.answers)) this.send({ t: 'draft', questionId, answer: d.answer, rev: d.rev })
      this.recInFlight = 0
      void this.pumpRec()
    })
    this.onStatus(this.proctor.status())
    if (this.resumed && s.exam) void this.raise('reload')
    this.resumed = false
    this.startLoops()
    void this.persist()
    // O tempo acabou enquanto este computador estava fora: entrega o que tem.
    if (msg.phase === 'ended' && s.exam && !s.finished) void this.finish(true)
  }

  // Manda tudo o que tem aqui e pede o que falta. Reenviar é inofensivo: o CRDT ignora o repetido.
  private syncDoc() {
    this.sendSealed(encodeBinary({ t: 'y-update' } satisfies StudentMsg, this.doc.encodeState()))
    this.sendSealed(encodeBinary({ t: 'y-sync' } satisfies StudentMsg, this.doc.encodeVector()))
    if (this.team) this.awareness.setLocalStateField('online', true)
  }

  private applyRemote(update: Uint8Array) {
    try {
      this.doc.apply(update, REMOTE)
    } catch {
      this.link?.close()
    }
  }

  // Recorta depois de dar tempo do código novo aparecer na tela.
  private async sendBeaconFrame(code: number) {
    if (!this.grabber || this.beaconCode !== code) return
    const el = document.querySelector('[data-beacon]')
    if (!el) return
    const blob = await this.grabber.cropRegion(el.getBoundingClientRect())
    if (!blob) return
    this.sendSealed(encodeBinary({ t: 'beacon-frame', code } satisfies StudentMsg, new Uint8Array(await blob.arrayBuffer())))
  }

  private startLoops() {
    if (this.timers.length) return
    this.syncClock()
    this.timers.push(
      window.setInterval(() => this.syncClock(), CLOCK_SYNC_MS),
      window.setInterval(() => this.send({ t: 'beat', at: Date.now(), status: this.proctor.status() }), BEAT_MS),
      window.setInterval(() => !this.focusOn && void this.sendFrame(), THUMB_MS),
      window.setInterval(() => this.focusOn && void this.sendFrame(), FOCUS_MS),
    )
  }

  private onStatus(status: StudentStatus) {
    this.status = status
    this.send({ t: 'status', status })
    this.changed()
  }

  // ---- preparação

  async shareScreen() {
    this.screenError = null
    const result = await requestScreen()
    if (!result.ok) {
      this.screenError = result.reason
      if (result.reason === 'not-monitor') void this.raise('share-invalid')
      this.changed()
      return false
    }
    this.stream = result.stream
    this.grabber?.dispose()
    this.grabber = new FrameGrabber(result.stream)
    this.proctor.setStream(result.stream)
    if (!this.proctorStarted) {
      this.proctorStarted = true
      this.proctor.start()
    }
    this.startRecording()
    this.changed()
    return true
  }

  private proctorStarted = false

  async goFullscreen() {
    await enterFullscreen()
    this.onStatus(this.proctor.status())
  }

  checkNetwork = () => this.proctor.checkInternet().then((isolated) => {
    this.onStatus(this.proctor.status())
    return isolated
  })

  armProctor() {
    this.proctor.arm()
  }

  private startRecording() {
    if (!this.stream || !this.config?.recordScreen) return
    this.recorder?.stop()
    this.recorder = new ScreenRecorder(this.stream, this.saved?.segment ?? 0, (part) => void this.enqueuePart(part))
    this.recorder.start()
  }

  // ---- alertas: fila confiável própria, para nunca esperar atrás de um pedaço de vídeo

  private async raise(kind: AlertKind, detail?: string) {
    const s = this.saved
    if (!s) return
    this.chain = this.chain.then(async () => {
      const seq = ++s.eventSeq
      const at = Date.now()
      const hash = await sha256(`${s.lastHash}|${seq}|${kind}|${at}|${detail ?? ''}`)
      s.lastHash = hash
      const event: ProctorEvent = { seq, kind, at, detail, hash }
      await this.pushReliable({ t: 'event', event }, seq)
    })
    await this.chain
  }

  private async pushReliable(msg: StudentMsg, seq: number) {
    const item = { seq, msg }
    this.events.push(item)
    this.send(msg)
    await idb.put('outbox', `e:${String(seq).padStart(9, '0')}`, item)
    await this.persist()
  }

  private async onAck(stream: 'event' | 'rec', seq: number) {
    if (stream === 'event') {
      const done = this.events.filter((e) => e.seq <= seq)
      this.events = this.events.filter((e) => e.seq > seq)
      await Promise.all(done.map((e) => idb.del('outbox', `e:${String(e.seq).padStart(9, '0')}`)))
    } else {
      this.lastRecAck = Math.max(this.lastRecAck, seq)
      const done = this.recQueue.filter((r) => r.seq <= seq)
      this.recQueue = this.recQueue.filter((r) => r.seq > seq)
      this.recInFlight = Math.max(0, this.recInFlight - done.length)
      await Promise.all(
        done.map((r) => Promise.all([idb.del('outbox', `r:${r.key}`), idb.del('chunks', r.key)])),
      )
      void this.pumpRec()
    }
  }

  // ---- gravação: guarda em disco primeiro, envia depois

  private async enqueuePart(part: RecPart) {
    const s = this.saved
    if (!s) return
    const seq = ++s.recSeq
    if (part.segment >= s.segment) s.segment = part.segment + 1
    const key = String(seq).padStart(9, '0')
    const { blob, ...meta } = part
    await idb.put('chunks', key, blob)
    const entry = { seq, key, meta }
    await idb.put('outbox', `r:${key}`, entry)
    this.recQueue.push(entry)
    void this.persist()
    void this.pumpRec()
    this.changed()
  }

  private pumping = false

  private async pumpRec() {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.link && this.welcomed && this.recInFlight < REC_WINDOW) {
        const item = this.recQueue[this.recInFlight]
        if (!item) break
        const blob = await idb.get<Blob>('chunks', item.key)
        if (!blob) {
          // Pedaço perdido no disco: avança para o professor não ficar esperando.
          this.recInFlight++
          continue
        }
        const bytes = new Uint8Array(await blob.arrayBuffer())
        this.recInFlight++
        this.sendSealed(
          encodeBinary(
            {
              t: 'rec',
              seq: item.seq,
              segment: item.meta.segment,
              part: item.meta.part,
              startedAt: item.meta.startedAt,
              last: item.meta.last,
              mime: item.meta.mime,
            } satisfies StudentMsg,
            bytes,
          ),
        )
      }
    } finally {
      this.pumping = false
    }
  }

  private async sendFrame() {
    if (!this.grabber || !this.link) return
    const blob = await this.grabber.grab(this.focusOn ? 1280 : 320, this.focusOn ? 0.7 : 0.5)
    if (!blob || !this.link || this.link.buffered() > 2_000_000) return
    const bytes = new Uint8Array(await blob.arrayBuffer())
    this.sendSealed(encodeBinary({ t: 'frame', at: Date.now(), focus: this.focusOn } satisfies StudentMsg, bytes))
  }

  // ---- respostas

  answerOf(questionId: string): Answer | undefined {
    const q = this.saved?.exam?.questions.find((x) => x.id === questionId)
    if (q?.type === 'code') return this.doc.snapshot(questionId) ?? undefined
    return this.saved?.answers[questionId]?.answer
  }

  setAnswer(questionId: string, answer: Answer) {
    const s = this.saved
    if (!s) return
    const rev = (s.answers[questionId]?.rev ?? 0) + 1
    s.answers[questionId] = { answer, rev }
    void this.persist()
    clearTimeout(this.draftTimers.get(questionId))
    this.draftTimers.set(
      questionId,
      window.setTimeout(() => this.send({ t: 'draft', questionId, answer, rev }), DRAFT_DEBOUNCE),
    )
    this.changed()
  }

  createTeam(name: string) {
    this.teamError = null
    this.send({ t: 'team-create', name })
    this.changed()
  }

  joinTeam(code: string) {
    this.teamError = null
    this.send({ t: 'team-join', code })
    this.changed()
  }

  leaveTeam() {
    this.send({ t: 'team-leave' })
  }

  // ---- teste: quem decide o limite é o professor; o contador aqui é só para mostrar

  runTest(questionId: string) {
    const answer = this.answerOf(questionId)
    if (answer?.type !== 'code' || this.testing || Date.now() < this.nextTestAt) return
    this.testing = true
    this.testReport = null
    this.send({ t: 'test', reqId: randomId(6), questionId, lang: answer.lang, files: answer.files })
    this.changed()
  }

  // ---- rodar: primeiro aqui mesmo em WebAssembly; se não der, na máquina do professor

  async runProgram(questionId: string, stdin: string) {
    const answer = this.answerOf(questionId)
    if (answer?.type !== 'code' || this.running) return
    this.running = true
    this.runOutput = { stdout: '', stderr: '', log: '', where: 'local', state: 'compiling' }
    this.changed()
    try {
      const built = await compile(answer.lang, answer.files)
      if (!built.ok && built.internal) return this.runOnHost(answer, stdin)
      if (!built.ok) {
        this.runOutput = { stdout: '', stderr: '', log: built.log, where: 'local', state: 'compile-error' }
        return
      }
      this.runOutput = { stdout: '', stderr: '', log: built.log, where: 'local', state: 'running' }
      this.changed()
      const job = run(built.wasm, stdin, RUN_LIMITS.timeMs, (stream, text) => {
        if (this.runOutput) this.runOutput[stream] += text
        this.changed()
      })
      this.killRun = job.kill
      const out = await job
      this.runOutput = { stdout: out.stdout, stderr: out.stderr, log: built.log, where: 'local', state: 'done', exitCode: out.exitCode, error: out.error }
    } catch {
      return this.runOnHost(answer, stdin)
    } finally {
      if (this.runOutput?.where === 'local') {
        this.running = false
        this.killRun = null
        this.changed()
      }
    }
  }

  stopRun() {
    this.killRun?.()
  }

  private runOnHost(answer: Extract<Answer, { type: 'code' }>, stdin: string) {
    this.runOutput = { stdout: '', stderr: '', log: '', where: 'host', state: 'running' }
    this.send({ t: 'run', reqId: randomId(6), lang: answer.lang, files: answer.files, stdin })
    this.changed()
  }

  private onRunResult(r: RunReport) {
    this.running = false
    if (r.status === 'limited') this.runOutput = { stdout: '', stderr: '', log: '', where: 'host', state: 'done', error: `Espere ${Math.ceil(r.retryInMs / 1000)} s para rodar de novo` }
    else if (r.status === 'compile-error') this.runOutput = { stdout: '', stderr: '', log: r.log, where: 'host', state: 'compile-error' }
    else this.runOutput = { stdout: r.stdout, stderr: r.stderr, log: r.log, where: 'host', state: 'done', exitCode: r.exitCode, error: r.error }
  }

  // ---- relógio: mede a diferença para o professor como no NTP e fica com a medida de menor atraso

  private syncClock() {
    this.send({ t: 'time-sync', c: performance.now() })
  }

  private onTime(c: number, s: number) {
    const now = performance.now()
    const rtt = now - c
    const stale = now - this.clockAt > 60_000
    if (rtt > this.clockRtt && !stale) return
    this.clockRtt = rtt
    this.clockAt = now
    this.clockBase = s + rtt / 2 - now
    if (this.saved) this.saved.clockOffset = s + rtt / 2 - Date.now()
  }

  // Monotônico depois da primeira medida: mudar a hora do computador não muda nada aqui.
  serverNow() {
    if (this.clockAt) return performance.now() + this.clockBase
    return Date.now() + (this.saved?.clockOffset ?? 0)
  }

  clockIn() {
    this.send({ t: 'clock-in' })
  }

  private onTestResult(result: TestReport) {
    if (result.status === 'queued') {
      this.nextTestAt = Date.now() + TEST_INTERVAL_MS
      return
    }
    this.testing = false
    if (result.status === 'limited') this.nextTestAt = Date.now() + result.retryInMs
    else {
      this.testReport = result
      this.nextTestAt = Date.now() + result.nextInMs
    }
  }

  async submit(questionId: string) {
    const s = this.saved
    const answer = this.answerOf(questionId)
    if (!s || !answer) return
    const seq = ++s.eventSeq
    await this.pushReliable({ t: 'submit', seq, questionId, answer, at: Date.now() }, seq)
    this.changed()
  }

  async finish(_forced = false) {
    const s = this.saved
    if (!s || s.finished) return
    s.finished = true
    this.phase = 'ended'
    for (const q of s.exam?.questions ?? []) await this.submit(q.id)
    const seq = ++s.eventSeq
    await this.pushReliable({ t: 'finish', seq, at: Date.now() }, seq)
    // Para o vigia antes de sair da tela cheia, senão o próprio fim vira alerta.
    this.proctor.stop()
    this.proctorStarted = false
    this.recorder?.stop()
    this.recorder = null
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
    this.changed()
  }

  pendingUploads() {
    return this.recQueue.length + this.events.length
  }

  extended = () => isExtendedDisplay()

  dismissWarning() {
    this.warning = null
    this.changed()
  }

  async clear() {
    this.closing = true
    this.stopCapture()
    this.link?.close()
    this.link = null
    this.timers.forEach(clearInterval)
    this.timers = []
    if (this.saved) this.saved.active = false
    await this.persist()
    this.saved = null
    this.config = null
    this.phase = 'lobby'
    this.refused = null
    this.connectError = null
    this.linkState = 'idle'
    this.welcomed = false
    this.resumed = false
    this.team = null
    this.teamError = null
    this.needsPassword = false
    this.teacherFp = null
    this.beaconCode = null
    this.channel = null
    this.password = ''
    this.resetDoc()
    this.runOutput = null
    this.testReport = null
    this.nextTestAt = 0
    this.savedAt = 0
    this.changed()
  }

  private async persist() {
    if (!this.saved) return
    await idb.put('kv', 'student', this.saved)
    this.savedAt = Date.now()
    this.changed()
  }
}

function bytesToB64(bytes: Uint8Array) {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export const studentSession = new StudentSession()
