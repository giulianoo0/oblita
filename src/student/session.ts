// Sessão do aluno, fora do React: sobrevive a re-renderização e é restaurada depois de um F5.
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { decodeFrame, deflateFrame, encodeBinary, encodeJson, inflate, inflateFrame } from '../../shared/frames'
import { isOpen, type QuestionClocks } from '../../shared/flow'
import { SEALED_TAG, SecureChannel, deriveRoomKey, fingerprint, fromB64, helloTranscript, newEphemeral, sha256Hex, toB64, tokenProof, verifyHello } from '../../shared/secure'
import type { Exam, Question } from '../../shared/exam'
import {
  MAX_INFLATED_TO_STUDENT,
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
import { compile, run, type CompileResult } from '../compiler/client'
import { BUILD, pinBuild, unpinBuild } from '../lib/offline'
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
  clocks?: QuestionClocks
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
  countdownEnds = 0
  doc = new ExamDoc()
  awareness = new Awareness(this.doc.doc)
  resumed = false
  testing = false
  testReport: Extract<TestReport, { status: 'compile-error' | 'done' }> | null = null
  // Onde está o teste: compilando aqui, na fila do professor (com a posição) ou rodando lá.
  testStage: 'compiling' | 'queued' | null = null
  testPosition: number | null = null
  testNotice: string | null = null
  // Protocolo do professor quando ele fala outro: a página oferece a versão em cache que fala o dele.
  teacherProtocol: number | null = null
  // O disco recusou gravar (cheio ou bloqueado). A prova segue, mas um F5 pode perder o que não saiu.
  diskError = false
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
  // Comprimir e descomprimir são assíncronos: as filas mantêm a ordem dos quadros de cada conexão.
  private outChain: Promise<unknown> = Promise.resolve()
  private inChain: Promise<unknown> = Promise.resolve()
  // Questões retiradas nesta conexão: se voltarem, o professor manda só o id.
  private stash = new Map<string, Question>()
  // Pedaços de gravação que o disco recusou ficam aqui até o professor confirmar, com teto.
  private memChunks = new Map<string, Blob>()
  private memBytes = 0
  private nextSegment = 0
  private pendingTest: string | null = null

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

  questionOpen(questionId: string) {
    return isOpen(this.config?.flow ?? 'free', this.saved?.clocks?.[questionId], this.serverNow())
  }

  questionRemaining(questionId: string) {
    const endsAt = this.saved?.clocks?.[questionId]?.endsAt
    return endsAt ? endsAt - this.serverNow() : null
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
    // Número de segmento pulado não faz mal; repetido sobrescreveria um trecho da gravação.
    saved.segment += 1
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
    const previous = this.saved ?? (await idb.get<Saved>('kv', 'student').catch(() => undefined))
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
    this.outChain = Promise.resolve()
    this.inChain = Promise.resolve()
    this.stash.clear()
    this.linkState = 'online'
    this.connectError = null
    this.changed()
  }

  // A resposta destes pedidos vinha pela conexão que caiu: sem isto os botões ficariam presos.
  private abandonRemoteJobs() {
    if (this.testStage === 'queued') {
      this.testing = false
      this.testStage = null
      this.testPosition = null
      this.pendingTest = null
    }
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
  // Vídeo e imagem já vêm comprimidos: quem manda esses passa `compress = false`.
  private sendSealed(frame: Uint8Array<ArrayBuffer>, compress = true) {
    const link = this.link
    const channel = this.channel
    if (!link || !channel) return
    const packed = compress ? deflateFrame(frame) : Promise.resolve(frame)
    this.outChain = this.outChain
      .then(async () => {
        const sealed = await (await channel).seal(await packed)
        // Cifrado com uma chave que já foi trocada, o quadro não abriria do outro lado.
        if (this.link === link && this.channel === channel) link.send(sealed)
      })
      .catch(() => {
        if (this.link === link) link.close()
      })
  }

  private send(msg: StudentMsg) {
    this.sendSealed(encodeJson(msg))
  }

  private onFrame(frame: Uint8Array) {
    const link = this.link
    if (frame[0] !== SEALED_TAG) return void this.onPlain(frame)
    const channel = this.channel
    if (!channel) return
    this.inChain = this.inChain
      .then(async () => {
        let plain: Uint8Array
        try {
          plain = await (await channel).open(frame)
        } catch {
          return link?.close()
        }
        if (this.link !== link) return
        let opened: Uint8Array
        try {
          opened = await inflateFrame(plain, MAX_INFLATED_TO_STUDENT)
        } catch {
          // Quadro que não abre não derruba nada: é só ignorado.
          return
        }
        if (this.link === link) await this.onMessage(opened)
      })
      .catch((err) => console.error('mensagem do professor ignorada', err))
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
    if (hi.v !== PROTOCOL_VERSION) {
      this.teacherProtocol = Number.isSafeInteger(hi.v) ? hi.v : null
      this.changed()
      return this.welcomed ? undefined : this.refuse('version')
    }
    this.teacherProtocol = null
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
    s.clocks = undefined
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
    this.memChunks.clear()
    this.memBytes = 0
    try {
      await Promise.all((await idb.keys('outbox')).map((key) => idb.del('outbox', key)))
      await Promise.all((await idb.keys('chunks')).map((key) => idb.del('chunks', key)))
    } catch {
      this.diskError = true
    }
  }

  // Mensagem malformada do professor (ou de quem estiver no lugar dele) é ignorada, nunca lança.
  private async onMessage(frame: Uint8Array) {
    let decoded
    try {
      decoded = decodeFrame<TeacherMsg>(frame)
    } catch {
      return
    }
    const { json: msg, bytes } = decoded
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return
    try {
      await this.handle(msg, bytes)
    } catch (err) {
      console.error('mensagem do professor ignorada', msg.t, err)
    }
  }

  private async handle(msg: TeacherMsg, bytes?: Uint8Array) {
    switch (msg.t) {
      case 'refused':
        this.refuse(msg.reason)
        break
      case 'welcome':
        this.onWelcome(msg)
        break
      case 'exam': {
        if (!this.saved || !bytes) return
        const exam = safeExam(JSON.parse(new TextDecoder().decode(await inflate(bytes, MAX_INFLATED_TO_STUDENT))))
        if (!exam) return
        if (!this.saved.exam) void pinBuild(BUILD.id, 'exam')
        this.saved.exam = exam
        this.saved.endsAt = typeof msg.endsAt === 'number' ? msg.endsAt : undefined
        this.saved.clocks = safeClocks(msg.clocks)
        if (!this.clockAt && typeof msg.now === 'number') this.saved.clockOffset = msg.now - Date.now()
        this.stash.clear()
        void this.persist()
        this.phase = 'running'
        this.syncDoc()
        break
      }
      case 'questions':
        this.onQuestions(msg)
        break
      case 'clocks':
        if (!this.saved) return
        this.saved.clocks = safeClocks(msg.clocks)
        void this.persist()
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
      case 'countdown':
        if (Number.isFinite(msg.seconds) && msg.seconds > 0 && msg.seconds <= 10) this.countdownEnds = performance.now() + msg.seconds * 1000
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
  }

  // Liberar e retirar chegam como diferença. Se faltar o que restaurar, reconecta para receber tudo.
  private onQuestions(msg: Extract<TeacherMsg, { t: 'questions' }>) {
    const s = this.saved
    if (!s?.exam) return
    const current = new Map(s.exam.questions.map((q) => [q.id, q]))
    for (const id of Array.isArray(msg.remove) ? msg.remove : []) {
      const q = current.get(id)
      if (!q) continue
      this.stash.set(id, q)
      current.delete(id)
    }
    for (const id of Array.isArray(msg.restore) ? msg.restore : []) {
      const q = this.stash.get(id)
      if (!q) return void this.link?.close()
      current.set(id, q)
    }
    for (const q of Array.isArray(msg.add) ? msg.add : []) if (safeQuestion(q)) current.set(q.id, q)
    const order = Array.isArray(msg.order) ? msg.order.filter((id) => current.has(id)) : [...current.keys()]
    s.exam = { ...s.exam, questions: order.map((id) => current.get(id)!) }
    s.clocks = safeClocks(msg.clocks)
    void this.persist()
    // Questão nova traz o código inicial no documento do professor: pede o que falta.
    if ((msg.add?.length ?? 0) + (msg.restore?.length ?? 0) > 0) this.syncDoc()
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
    // O disco é assíncrono: um F5 logo depois de um evento volta com números velhos. Reusar um número
    // que o professor já viu faria o próximo alerta ser confirmado e descartado.
    if (msg.lastEvent > s.eventSeq) {
      s.eventSeq = msg.lastEvent
      if (msg.lastEventHash) s.lastHash = msg.lastEventHash
    }
    if (msg.lastRec > s.recSeq) s.recSeq = msg.lastRec
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
    try {
      const blob = await this.grabber?.cropRegion(el.getBoundingClientRect())
      if (!blob) return
      this.sendSealed(encodeBinary({ t: 'beacon-frame', code } satisfies StudentMsg, new Uint8Array(await blob.arrayBuffer())), false)
    } catch {
      // Sem tela no meio do recorte: o professor só deixa de receber este selo.
    }
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
    const stream = result.stream
    stream.getVideoTracks()[0]?.addEventListener('ended', () => this.stream === stream && this.onShareEnded())
    if (!this.proctorStarted) {
      this.proctorStarted = true
      this.proctor.start()
    }
    this.startRecording()
    this.changed()
    return true
  }

  private proctorStarted = false

  // A tela caiu: o proctor já mandou o alerta. Aqui só para o que dependia dela, sem travar a prova,
  // e o próximo compartilhamento retoma gravação, miniatura e selo.
  private onShareEnded() {
    if (this.recorder) this.nextSegment = Math.max(this.nextSegment, this.recorder.nextSegment)
    this.recorder?.stop()
    this.recorder = null
    this.grabber?.dispose()
    this.grabber = null
    this.stream = null
    this.onStatus(this.proctor.status())
  }

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
    if (this.recorder) this.nextSegment = Math.max(this.nextSegment, this.recorder.nextSegment)
    this.recorder?.stop()
    this.recorder = new ScreenRecorder(this.stream, Math.max(this.saved?.segment ?? 0, this.nextSegment), (part) => void this.enqueuePart(part))
    void this.recorder.start().catch((err) => console.error('gravador não começou', err))
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
    // Uma falha aqui não pode travar a fila: os próximos alertas continuam saindo.
    this.chain = this.chain.catch((err) => console.error('alerta não registrado', err))
    await this.chain
  }

  private async pushReliable(msg: StudentMsg, seq: number) {
    const item = { seq, msg }
    this.events.push(item)
    this.send(msg)
    // Sem disco o item fica na memória e é reenviado ao reconectar; só um F5 o perderia.
    try {
      await idb.put('outbox', `e:${String(seq).padStart(9, '0')}`, item)
    } catch {
      this.diskError = true
    }
    await this.persist()
  }

  private async onAck(stream: 'event' | 'rec', seq: number) {
    if (stream === 'event') {
      const done = this.events.filter((e) => e.seq <= seq)
      this.events = this.events.filter((e) => e.seq > seq)
      await Promise.all(done.map((e) => idb.del('outbox', `e:${String(e.seq).padStart(9, '0')}`))).catch(() => {})
    } else {
      this.lastRecAck = Math.max(this.lastRecAck, seq)
      const done = this.recQueue.filter((r) => r.seq <= seq)
      this.recQueue = this.recQueue.filter((r) => r.seq > seq)
      this.recInFlight = Math.max(0, this.recInFlight - done.length)
      for (const r of done) this.forgetChunk(r.key)
      await Promise.all(done.map((r) => Promise.all([idb.del('outbox', `r:${r.key}`), idb.del('chunks', r.key)]))).catch(() => {})
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
    const entry = { seq, key, meta }
    try {
      await idb.put('chunks', key, blob)
      await idb.put('outbox', `r:${key}`, entry)
    } catch {
      // Disco cheio ou bloqueado: segura na memória até o professor confirmar. Acima do teto,
      // o pedaço se perde, e o professor vê o buraco na gravação.
      this.diskError = true
      if (this.memBytes + blob.size > MAX_MEM_CHUNKS) return
      this.memChunks.set(key, blob)
      this.memBytes += blob.size
    }
    this.recQueue.push(entry)
    void this.persist()
    void this.pumpRec()
    this.changed()
  }

  private pumping = false

  private forgetChunk(key: string) {
    const blob = this.memChunks.get(key)
    if (!blob) return
    this.memChunks.delete(key)
    this.memBytes -= blob.size
  }

  private async pumpRec() {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.link && this.welcomed && this.recInFlight < REC_WINDOW) {
        const item = this.recQueue[this.recInFlight]
        if (!item) break
        const blob = this.memChunks.get(item.key) ?? (await idb.get<Blob>('chunks', item.key).catch(() => undefined))
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
          false,
        )
      }
    } catch (err) {
      console.error('envio da gravação parou', err)
    } finally {
      this.pumping = false
    }
  }

  private async sendFrame() {
    if (!this.grabber || !this.link) return
    try {
      const blob = await this.grabber.grab(this.focusOn ? 1280 : 320, this.focusOn ? 0.7 : 0.5)
      if (!blob || !this.link || this.link.buffered() > 2_000_000) return
      const bytes = new Uint8Array(await blob.arrayBuffer())
      this.sendSealed(encodeBinary({ t: 'frame', at: Date.now(), focus: this.focusOn } satisfies StudentMsg, bytes), false)
    } catch {
      // Miniatura é descartável.
    }
  }

  // ---- respostas

  answerOf(questionId: string): Answer | undefined {
    const q = this.saved?.exam?.questions.find((x) => x.id === questionId)
    if (q?.type === 'code') return this.doc.snapshot(questionId) ?? undefined
    return this.saved?.answers[questionId]?.answer
  }

  setAnswer(questionId: string, answer: Answer) {
    const s = this.saved
    if (!s || !this.questionOpen(questionId)) return
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

  // Compila aqui, como o Rodar, e manda só o executável: o professor apenas roda. Erro de
  // compilação aparece na hora e não gasta o minuto. Sem compilador aqui, vai o código, como antes.
  async runTest(questionId: string) {
    const answer = this.answerOf(questionId)
    if (answer?.type !== 'code' || this.testing || Date.now() < this.nextTestAt) return
    const reqId = randomId(6)
    this.testing = true
    this.testStage = 'compiling'
    this.testPosition = null
    this.testNotice = null
    this.testReport = null
    this.pendingTest = reqId
    this.changed()
    let built: CompileResult | null = null
    try {
      built = await compile(answer.lang, answer.files)
    } catch {
      built = null
    }
    if (this.pendingTest !== reqId) return
    if (built && !built.ok && !built.internal) {
      this.endTest()
      this.testReport = { reqId, questionId, status: 'compile-error', log: built.log, nextInMs: 0 }
      return this.changed()
    }
    if (!this.link || !this.channel) {
      this.endTest()
      this.testNotice = 'Sem conexão com o professor. Tente de novo quando reconectar.'
      return this.changed()
    }
    this.testStage = 'queued'
    if (built?.ok) this.sendSealed(encodeBinary({ t: 'test-wasm', reqId, questionId, lang: answer.lang } satisfies StudentMsg, built.wasm))
    else this.send({ t: 'test', reqId, questionId, lang: answer.lang, files: answer.files })
    this.changed()
  }

  private endTest() {
    this.testing = false
    this.testStage = null
    this.testPosition = null
    this.pendingTest = null
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
    if (!result || typeof result !== 'object' || (this.pendingTest && result.reqId !== this.pendingTest)) return
    if (result.status === 'queued') {
      if (this.pendingTest) this.testPosition = typeof result.position === 'number' && result.position > 0 ? result.position : null
      return
    }
    this.endTest()
    if (result.status === 'limited') this.nextTestAt = Date.now() + Math.min(TEST_INTERVAL_MS, Math.max(0, result.retryInMs))
    else if (result.status === 'busy') this.testNotice = 'Sua equipe já tem um teste na fila. Espere ele terminar.'
    else if (result.status === 'invalid') this.testReport = { reqId: result.reqId, questionId: result.questionId, status: 'compile-error', log: `${result.log}\n`, nextInMs: 0 }
    else {
      this.testReport = result
      this.nextTestAt = Date.now() + Math.min(TEST_INTERVAL_MS, Math.max(0, result.nextInMs))
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
    this.endTest()
    this.testNotice = null
    this.teacherProtocol = null
    this.memChunks.clear()
    this.memBytes = 0
    this.nextTestAt = 0
    // Saiu da prova: a próxima vez que abrir, abre a versão mais nova.
    void unpinBuild()
    this.savedAt = 0
    this.changed()
  }

  private async persist() {
    if (!this.saved) return
    try {
      await idb.put('kv', 'student', this.saved)
      this.savedAt = Date.now()
      this.diskError = false
    } catch {
      this.diskError = true
    }
    this.changed()
  }
}

const MAX_MEM_CHUNKS = 64 * 1024 * 1024
const QUESTION_TYPES = new Set(['code', 'choice', 'text'])

// O professor é confiável, mas um quadro torto não pode quebrar a tela: só a forma é conferida.
function safeQuestion(q: unknown): q is Question {
  const x = q as Question | null
  return !!x && typeof x === 'object' && typeof x.id === 'string' && QUESTION_TYPES.has(x.type) && typeof x.title === 'string' && typeof x.statement === 'string'
}

function safeExam(raw: unknown): Exam | null {
  const e = raw as Exam | null
  if (!e || typeof e !== 'object' || typeof e.title !== 'string' || !Array.isArray(e.questions)) return null
  return { ...e, questions: e.questions.filter(safeQuestion) }
}

function safeClocks(raw: unknown): QuestionClocks {
  return raw && typeof raw === 'object' ? (raw as QuestionClocks) : {}
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
