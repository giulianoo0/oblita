// Motor da sala, no navegador do professor. O gabarito só existe aqui: nenhuma mensagem
// enviada ao aluno é construída a partir de `solutions`, e a prova só sai por examForStudent.
import { BEACON, decodeBeacon, randomBeaconCode } from '../../shared/beacon'
import { checkOutput, defaultStarter, mainFile, type CodeQuestion, type Exam, type HiddenTest, type Solutions } from '../../shared/exam'
import { decodeFrame, encodeBinary, encodeJson } from '../../shared/frames'
import {
  ALERT_LABEL,
  ALERT_SEVERE,
  REVEAL_COUNTDOWN_SECONDS,
  MAX_Y_UPDATE_BYTES,
  HOST_RUN_INTERVAL_MS,
  PROTOCOL_VERSION,
  RUN_LIMITS,
  TEST_INTERVAL_MS,
  validFiles,
  type RunReport,
  type TestReport,
  type AlertKind,
  type Answer,
  type Phase,
  type ProctorEvent,
  type RoomConfig,
  type StudentMsg,
  type StudentStatus,
  type TeacherMsg,
  type TeacherPlain,
  type TeamInfo,
} from '../../shared/protocol'
import { RateLimiter, isAllowed } from '../../shared/policy'
import { SecureChannel, deriveRoomKey, fingerprint, helloTranscript, newTeacherIdentity, signHello, verifyTokenProof, type TeacherIdentity, fromB64, newEphemeral, randomBytes, sha256Hex, toB64, type Ephemeral } from '../../shared/secure'
import { idb, requestPersistence } from '../lib/idb'
import { Observable, randomId } from '../lib/store'
import { addTime, expiredQuestions, isOpen, isVisible, release, visibleExam, withdraw, type Flow, type QuestionClocks } from '../../shared/flow'
import { ExamDoc } from '../collab/examDoc'
import { connectHubBus, connectRtcBus, type Bus } from '../net/bus'
import { compile, run } from '../compiler/client'

const SIGNAL_LOST_MS = 6000
const ALERT_THUMBS_KEPT = 300

interface PeerLink {
  eph: Ephemeral
  nonce: Uint8Array<ArrayBuffer>
  channel: Promise<SecureChannel> | null
  authed: boolean
  limiter: RateLimiter
  transcript: Uint8Array<ArrayBuffer>
}

interface BeaconState {
  codes: number[]
  fails: number
  sinceAt: number
  gotFrame: boolean
  everOk: boolean
}

const BEACON_INTERVAL_MS = 3000
const BEACON_KEEP = 3
const BEACON_FAILS = 2
const BEACON_GRACE_MS = 15_000
const DEDUPE_MS = 3000
const MAX_DOC_BYTES = 4 * 1024 * 1024
const MAX_BEACON_BYTES = 256 * 1024

const SAVE_EVERY_MS = 1000
const MAX_ALERTS_PER_STUDENT = 500
const MAX_REC_BYTES_PER_STUDENT = 2 * 1024 * 1024 * 1024
const MAX_BEACON_PIXELS = 4_000_000

const ACTIVE_KEY = 'active-room'
const MAX_STUDENTS = 512

export interface AlertEntry {
  id: string
  clientId: string
  name: string
  kind: AlertKind
  at: number
  detail?: string
  severe: boolean
  thumb?: string
}

export interface TestResult {
  index: number
  passed: boolean
  points: number
  timedOut?: boolean
  stdout?: string
  stderr?: string
}

export interface Grade {
  questionId: string
  status: 'pending' | 'running' | 'done' | 'compile-error' | 'manual'
  points: number
  max: number
  tests?: TestResult[]
  compileLog?: string
  at?: number
  // status 'manual' sozinho não diz se o professor já corrigiu.
  graded?: boolean
}

export interface Team {
  key: string
  clockInAt?: number
  endsAt?: number
  closed?: boolean
  doc?: string
  answers: Record<string, { answer: Answer; rev: number }>
  submissions: Record<string, { answer: Answer; at: number; by: string }>
  grades: Record<string, Grade>
}

export interface SegmentInfo {
  segment: number
  startedAt: number
  mime: string
  parts: number
  size: number
  complete: boolean
}

export interface Student {
  clientId: string
  name: string
  enrollment?: string
  tokenHash: string
  examGranted: boolean
  groupId?: string
  peer: string | null
  online: boolean
  examSent: boolean
  status: StudentStatus
  lastBeat: number
  signalLost: boolean
  alerts: number
  lastAlert?: AlertEntry
  finishedAt?: number
  lastEvent: number
  lastRec: number
  lastHash?: string
  chainBroken: boolean
  beaconOk?: boolean
  segments: Record<number, SegmentInfo>
}

interface Snapshot {
  config: RoomConfig
  exam: Exam
  solutions: Solutions | null
  phase: Phase
  endsAt: number | null
  roomCode: string
  roomKey: string
  salt: string
  hasPassword: boolean
  teamCodes: [string, string][]
  identity: TeacherIdentity
  clocks?: QuestionClocks
  students: Student[]
  teams: Team[]
  alerts: AlertEntry[]
  createdAt: number
  via?: { kind: 'hub' } | { kind: 'rtc' }
}

const noStatus = (): StudentStatus => ({ screen: false, fullscreen: false, focused: false, isolated: null, extended: false })

export class Room extends Observable {
  config!: RoomConfig
  exam!: Exam
  solutions: Solutions | null = null
  phase: Phase = 'lobby'
  endsAt: number | null = null
  roomCode = ''
  createdAt = 0
  students = new Map<string, Student>()
  teams = new Map<string, Team>()
  alerts: AlertEntry[] = []
  thumbs = new Map<string, string>()
  liveFrame = new Map<string, string>()

  bus: Bus | null = null
  busState: 'none' | 'connecting' | 'hub' | 'rtc' | 'down' = 'none'
  hubAddresses: string[] = []
  onAlert: ((a: AlertEntry) => void) | null = null

  private peers = new Map<string, string>()
  private links = new Map<string, PeerLink>()
  private roomKey = new Uint8Array(0) as Uint8Array<ArrayBuffer>
  private identity!: TeacherIdentity
  fingerprint = ''
  private queuedGrades = new Set<string>()
  private recChains = new Map<string, Promise<unknown>>()
  private eventChains = new Map<string, Promise<unknown>>()
  // Relógio de cada questão no modo manual. É da sala: liberar e retirar vale para todos juntos.
  clocks: QuestionClocks = {}
  // Em contagem: o conteúdo só sai do professor quando ela acaba, então nada pode ser lido antes.
  releasing = new Set<string>()
  private chainUnknown = new Set<string>()
  private salt = ''
  hasPassword = false
  private tabLockRelease: (() => void) | null = null
  private tabHold: Promise<boolean> | null = null
  private docs = new Map<string, ExamDoc>()
  private extractTimers = new Map<string, number>()
  private teamCodes = new Map<string, string>()
  private beacons = new Map<string, BeaconState>()
  private lastSeen = new Map<string, number>()
  private fromStatus = new Map<string, number>()
  private timers: number[] = []
  private saveTimer = 0
  private dueAcks = new Set<Student>()
  private gradeQueue: (() => Promise<void>)[] = []
  private gradeRunning = 0
  private focused: string | null = null
  private lastTest = new Map<string, number>()
  private lastRun = new Map<string, number>()
  private lastThumb = new Map<string, Blob>()

  static async create(config: RoomConfig, exam: Exam, solutions: Solutions | null, password = ''): Promise<Room> {
    const room = new Room()
    room.config = config
    room.exam = exam
    room.solutions = solutions
    room.createdAt = Date.now()
    room.roomCode = makeRoomCode()
    const salt = randomBytes(16)
    room.salt = toB64(salt)
    room.hasPassword = password.length > 0
    room.identity = await newTeacherIdentity()
    room.fingerprint = await fingerprint(room.identity.publicRaw)
    // Só a chave derivada fica salva: a senha em si não existe em disco nem na rede.
    room.roomKey = (await deriveRoomKey(room.roomCode, password, salt)) as Uint8Array<ArrayBuffer>
    await requestPersistence()
    await room.save()
    await idb.put('kv', ACTIVE_KEY, config.roomId)
    const index = (await idb.get<string[]>('kv', 'rooms')) ?? []
    await idb.put('kv', 'rooms', [config.roomId, ...index.filter((r) => r !== config.roomId)])
    return room
  }

  static async load(roomId: string): Promise<Room | null> {
    const snap = await idb.get<Snapshot>('kv', `room:${roomId}`)
    if (!snap) return null
    const room = new Room()
    room.config = snap.config
    room.exam = snap.exam
    room.solutions = snap.solutions
    room.config.flow ??= 'free'
    room.clocks = snap.clocks ?? {}
    room.phase = snap.phase
    room.endsAt = snap.endsAt
    room.roomCode = snap.roomCode
    room.createdAt = snap.createdAt
    room.roomKey = fromB64(snap.roomKey)
    room.salt = snap.salt
    room.hasPassword = snap.hasPassword
    room.identity = snap.identity
    room.fingerprint = await fingerprint(snap.identity.publicRaw)
    room.teamCodes = new Map(snap.teamCodes)
    // Os endereços blob: das miniaturas morrem com a aba.
    room.alerts = snap.alerts.map((a) => ({ ...a, thumb: undefined }))
    for (const s of snap.students) room.chainUnknown.add(s.clientId)
    for (const s of snap.students)
      room.students.set(s.clientId, { ...s, peer: null, online: false, signalLost: false, status: noStatus() })
    for (const t of snap.teams) room.teams.set(t.key, t)
    return room
  }

  // Correção interrompida por recarregar a página volta para a fila.
  resumeGrades() {
    for (const team of this.teams.values()) {
      for (const [questionId, grade] of Object.entries(team.grades)) {
        if ((grade.status === 'pending' || grade.status === 'running') && team.submissions[questionId]) this.enqueueGrade(team, questionId)
      }
    }
  }

  get startedAt() {
    return this.endsAt ? this.endsAt - this.exam.durationMin * 60_000 : null
  }

  remaining() {
    return this.endsAt ? this.endsAt - Date.now() : null
  }

  private save() {
    const snap: Snapshot = {
      config: this.config,
      exam: this.exam,
      solutions: this.solutions,
      phase: this.phase,
      endsAt: this.endsAt,
      roomCode: this.roomCode,
      roomKey: toB64(this.roomKey),
      salt: this.salt,
      hasPassword: this.hasPassword,
      teamCodes: [...this.teamCodes],
      identity: this.identity,
      clocks: this.clocks,
      createdAt: this.createdAt,
      students: [...this.students.values()],
      teams: [...this.teams.values()].map((t) => {
        const doc = this.docs.get(t.key)
        return doc ? { ...t, doc: toB64Large(doc.encodeState()) } : t
      }),
      alerts: this.alerts.slice(0, 2000),
    }
    return idb.put('kv', `room:${this.config.roomId}`, snap)
  }

  private touch() {
    // Ritmo fixo: com tráfego contínuo, adiar a cada mensagem nunca salvaria.
    if (!this.saveTimer) {
      this.saveTimer = window.setTimeout(() => {
        this.saveTimer = 0
        void this.saveAndAck()
      }, SAVE_EVERY_MS)
    }
    this.changed()
  }

  // O aluno apaga do disco o que foi confirmado. Confirmar antes de salvar faria um F5 no painel perder alertas e entregas.
  private async saveAndAck() {
    const due = [...this.dueAcks].map((s) => ({ s, event: s.lastEvent, rec: s.lastRec }))
    this.dueAcks.clear()
    await this.save().catch((err) => console.error('falha ao salvar a sala', err))
    for (const { s, event, rec } of due) {
      this.sendToStudent(s, { t: 'ack', stream: 'event', seq: event })
      this.sendToStudent(s, { t: 'ack', stream: 'rec', seq: rec })
    }
  }

  private ackWhenSaved(s: Student) {
    this.dueAcks.add(s)
    this.touch()
  }

  // ---- conexão

  async useHub(address: string, token: string) {
    this.busState = 'connecting'
    this.changed()
    try {
      this.attachBus(await connectHubBus(address, token))
      this.busState = 'hub'
    } catch (err) {
      this.busState = 'down'
      throw err
    } finally {
      this.changed()
    }
  }

  async useBrowser() {
    this.busState = 'connecting'
    this.changed()
    try {
      this.attachBus(await connectRtcBus(this.roomCode))
      this.busState = 'rtc'
      void this.save()
    } catch (err) {
      this.busState = 'down'
      throw err
    } finally {
      this.changed()
    }
  }

  private attachBus(bus: Bus) {
    this.bus?.close()
    this.bus = bus
    bus.onopen = (peer) => void this.startHandshake(peer)
    bus.onframe = (peer, frame) => this.onFrame(peer, frame)
    bus.onpeerclose = (peer) => this.onPeerClose(peer)
    bus.ondown = () => {
      if (this.bus !== bus) return
      this.bus = null
      this.busState = 'down'
      for (const s of this.students.values()) {
        s.online = false
        s.peer = null
      }
      this.peers.clear()
      this.links.clear()
      this.changed()
    }
  }

  // O relógio roda mesmo sem conexão: uma sala recarregada ainda encerra na hora certa.
  startTimers() {
    if (this.timers.length) return
    this.timers.push(
      window.setInterval(() => this.checkSignals(), 1000),
      window.setInterval(() => this.checkClock(), 1000),
      window.setInterval(() => this.tickBeacons(), BEACON_INTERVAL_MS),
    )
  }

  dispose() {
    this.timers.forEach(clearInterval)
    this.timers = []
    // Um salvamento atrasado desta instância escreveria por cima da que vier depois.
    clearTimeout(this.saveTimer)
    this.saveTimer = 0
    this.bus?.close()
    this.bus = null
    this.tabLockRelease?.()
    this.tabLockRelease = null
    this.tabHold = null
    void this.save()
  }

  // Duas abas na mesma sala brigariam pelos alunos e pelo gabarito: só uma fica com ela.
  // A promessa é guardada porque painel e detalhe pedem na mesma aba, e o StrictMode pede duas vezes:
  // um segundo pedido simultâneo perderia para o primeiro. O relógio só nasce aqui porque a aba
  // sem a trava tem uma cópia velha da sala, que não pode encerrar a prova nem salvar por cima.
  holdTab(): Promise<boolean> {
    this.tabHold ??= new Promise<boolean>((resolve) => {
      void navigator.locks.request(`oblita-room-${this.config.roomId}`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false)
          return
        }
        this.startTimers()
        this.resumeGrades()
        resolve(true)
        return new Promise<void>((release) => (this.tabLockRelease = release))
      })
    }).then((held) => {
      if (!held) this.tabHold = null
      return held
    })
    return this.tabHold
  }

  private sendTo(peer: string, msg: TeacherMsg) {
    const frame = encodeJson(msg)
    const channel = this.links.get(peer)?.channel
    if (!channel) return
    void channel.then((c) => c.seal(frame)).then((sealed) => this.bus?.send(peer, sealed), () => this.bus?.drop(peer))
  }

  // ---- aperto de mão: em claro só passam as chaves públicas

  private async startHandshake(peer: string) {
    const eph = await newEphemeral()
    const nonce = randomBytes(16)
    const pub = toB64(eph.pub)
    const nonceB64 = toB64(nonce)
    const transcript = helloTranscript(this.roomCode, this.salt, nonceB64, pub)
    const sig = await signHello(this.identity, transcript)
    this.links.set(peer, { eph, nonce, channel: null, authed: false, limiter: new RateLimiter(), transcript })
    this.bus?.send(peer, encodeJson({ t: 'hi', v: PROTOCOL_VERSION, salt: this.salt, nonce: nonceB64, pub, password: this.hasPassword, code: this.roomCode, signPub: this.identity.publicRaw, sig } satisfies TeacherPlain))
  }

  private onKey(peer: string, link: PeerLink, frame: Uint8Array) {
    // Depois de o painel recarregar, ainda chegam quadros do canal anterior: não são erro de ninguém.
    if (frame[0] !== 1) return
    try {
      const { json } = decodeFrame<{ t?: string; pub?: string }>(frame)
      if (json.t !== 'key' || typeof json.pub !== 'string' || json.pub.length > 128) throw new Error('chave inválida')
      const pub = fromB64(json.pub)
      link.channel = SecureChannel.create('teacher', link.eph, pub, this.roomKey, link.nonce, link.eph.pub, pub)
      link.channel.catch(() => this.bus?.drop(peer))
    } catch {
      this.bus?.drop(peer)
    }
  }

  private onBadFrame(peer: string, link: PeerLink) {
    // Sem autenticar, quadro que não abre é código ou senha errados.
    if (!link.authed) this.bus?.send(peer, encodeJson({ t: 'refused', reason: 'password' } satisfies TeacherPlain))
    this.links.delete(peer)
    setTimeout(() => this.bus?.drop(peer), 200)
  }

  private sendToStudent(s: Student, msg: TeacherMsg) {
    if (s.peer) this.sendTo(s.peer, msg)
  }

  // ---- mensagens

  private onFrame(peer: string, frame: Uint8Array) {
    const link = this.links.get(peer)
    if (!link) return
    if (!link.channel) return this.onKey(peer, link, frame)
    void link.channel
      .then((c) => c.open(frame))
      .then(
        (plain) => {
          if (this.links.get(peer) !== link) return
          try {
            this.onPlain(peer, link, plain)
          } catch (err) {
            console.error('mensagem de aluno rejeitada', err)
            this.bus?.drop(peer)
          }
        },
        () => this.links.get(peer) === link && this.onBadFrame(peer, link),
      )
  }

  private onPlain(peer: string, link: PeerLink, frame: Uint8Array) {
    let decoded
    try {
      decoded = decodeFrame<StudentMsg>(frame)
    } catch {
      return this.bus?.drop(peer)
    }
    const { json: msg, bytes } = decoded
    if (!link.authed) {
      if (msg?.t === 'hello') void this.onHello(peer, link, msg)
      return
    }
    const clientId = this.peers.get(peer)
    const s = clientId ? this.students.get(clientId) : undefined
    if (!s || typeof msg?.t !== 'string') return
    if (!link.limiter.allow(msg.t)) {
      // Miniatura pode cair; o resto faz parte de um fluxo confiável, que precisa reconectar.
      if (msg.t !== 'frame') this.bus?.drop(peer)
      return
    }
    const allowed = isAllowed(msg.t, {
      phase: this.phase,
      mode: this.config.mode,
      examSent: s.examGranted,
      closed: !!this.teamOf(s).closed,
      hasGroup: !!s.groupId,
      testsEnabled: this.config.compiler,
      finished: !!s.finishedAt,
    })
    if (!allowed) {
      // Entrega fora de hora é descartada, mas o número avança para o aluno não ficar preso.
      if ((msg.t === 'submit' || msg.t === 'finish') && typeof msg.seq === 'number') this.accept(s, msg.seq)
      return
    }
    switch (msg.t) {
      case 'status':
        this.applyStatus(s, msg.status)
        break
      case 'beat':
        s.lastBeat = Date.now()
        s.signalLost = false
        this.applyStatus(s, msg.status)
        break
      case 'event':
        this.onEvent(s, msg.event)
        break
      case 'draft':
        if (this.validAnswer(msg.questionId, msg.answer) && this.questionOpen(msg.questionId)) this.onDraft(s, msg.questionId, msg.answer, msg.rev)
        break
      case 'submit':
        // O número entra mesmo se a resposta for lixo, senão o fluxo do aluno trava aqui.
        if (this.accept(s, msg.seq) && this.validAnswer(msg.questionId, msg.answer) && this.questionOpen(msg.questionId)) {
          const team = this.teamOf(s)
          // O código vem do documento da equipe, que já está em ordem neste mesmo canal.
          const answer = msg.answer.type === 'code' ? (this.docOf(team).snapshot(msg.questionId) ?? msg.answer) : msg.answer
          team.submissions[msg.questionId] = { answer, at: Date.now(), by: s.name }
          this.enqueueGrade(team, msg.questionId)
          this.touch()
        }
        break
      case 'finish':
        if (this.accept(s, msg.seq)) {
          s.finishedAt = Date.now()
          this.touch()
        }
        break
      case 'team-create':
        this.onTeamCreate(s, msg.name)
        break
      case 'team-join':
        this.onTeamJoin(s, msg.code)
        break
      case 'team-leave':
        this.leaveTeam(s)
        this.sendToStudent(s, { t: 'team', team: null })
        this.touch()
        break
      case 'y-sync':
        if (bytes) this.onYSync(s, bytes)
        break
      case 'y-update':
        if (bytes) this.onYUpdate(peer, s, bytes)
        break
      case 'y-aware':
        if (bytes && bytes.length <= 64 * 1024) this.relayToTeam(s, encodeBinary({ t: 'y-aware' } satisfies TeacherMsg, bytes))
        break
      case 'beacon-frame':
        if (bytes && bytes.length <= MAX_BEACON_BYTES) void this.onBeaconFrame(s, bytes)
        break
      case 'test':
        this.onTest(s, msg)
        break
      case 'run':
        this.onRun(s, msg)
        break
      case 'clock-in':
        this.onClockIn(s)
        break
      case 'time-sync':
        this.sendToStudent(s, { t: 'time', c: msg.c, s: Date.now() })
        break
      case 'frame':
        if (bytes) this.onThumb(s, bytes, msg.focus)
        break
      case 'rec':
        if (bytes) void this.onRec(peer, s, msg, bytes)
        break
    }
  }

  // O painel e o exportador desenham a resposta: um formato inesperado de um cliente adulterado
  // derrubaria a tela do professor. Só confere a forma, para nunca perder a resposta de um aluno honesto.
  private validAnswer(questionId: string, a: Answer) {
    if (!this.exam.questions.some((q) => q.id === questionId)) return false
    if (a?.type === 'text') return typeof a.text === 'string' && a.text.length <= 256 * 1024
    if (a?.type === 'choice') return Array.isArray(a.selected) && a.selected.every((x) => typeof x === 'string')
    return a?.type === 'code' && (a.lang === 'c' || a.lang === 'cpp') && validFiles(a.files)
  }

  // Fluxo confiável: entra só o próximo número. O resto o aluno reenvia ao reconectar.
  private accept(s: Student, seq: number) {
    if (!Number.isSafeInteger(seq)) return false
    if (seq <= s.lastEvent) {
      this.ackWhenSaved(s)
      return false
    }
    // Número pulado: este painel recarregou antes de salvar, e o aluno já apagou o que foi confirmado.
    // Recusar travaria o fluxo para sempre; a cadeia de hash fica registrando o buraco.
    s.lastEvent = seq
    this.ackWhenSaved(s)
    return true
  }

  private async onHello(peer: string, link: PeerLink, msg: Extract<StudentMsg, { t: 'hello' }>) {
    if (msg.v !== PROTOCOL_VERSION) return this.sendTo(peer, { t: 'refused', reason: 'version' })
    if (typeof msg.clientId !== 'string' || !/^[0-9a-f]{16,64}$/.test(msg.clientId)) return this.bus?.drop(peer)
    if (typeof msg.name !== 'string' || !msg.name.trim()) return this.bus?.drop(peer)
    let s = this.students.get(msg.clientId)
    if (!s && this.phase === 'ended') return this.sendTo(peer, { t: 'refused', reason: 'ended' })
    if (!s && this.students.size >= MAX_STUDENTS) return this.sendTo(peer, { t: 'refused', reason: 'full' })
    // O clientId é público para o grupo. Quem prova ser o aluno é o token, entregue só a ele.
    if (s && !(await this.validProof(s, link, msg.proof))) return this.sendTo(peer, { t: 'refused', reason: 'identity' })
    const issued = s ? undefined : randomId(32)
    const tokenHash = issued ? await sha256Hex(issued) : ''
    if (this.links.get(peer) !== link) return
    s = this.students.get(msg.clientId) ?? s
    link.authed = true
    if (!s) {
      s = {
        clientId: msg.clientId,
        name: msg.name.trim().slice(0, 60),
        enrollment: typeof msg.enrollment === 'string' ? msg.enrollment.trim().slice(0, 30) || undefined : undefined,
        tokenHash,
        examGranted: false,
        peer,
        online: true,
        examSent: false,
        status: noStatus(),
        lastBeat: Date.now(),
        signalLost: false,
        alerts: 0,
        lastEvent: 0,
        lastRec: 0,
        chainBroken: false,
        segments: {},
      }
      this.students.set(s.clientId, s)
    } else {
      // Mesmo aluno em outra conexão: a antiga cai para não ter dois falando por ele.
      if (s.peer && s.peer !== peer) {
        this.peers.delete(s.peer)
        this.bus?.drop(s.peer)
      }
      s.peer = peer
      s.online = true
      s.lastBeat = Date.now()
      s.signalLost = false
      s.examSent = false
    }
    this.peers.set(peer, s.clientId)
    const team = this.teamOf(s)
    this.sendTo(peer, {
      t: 'welcome',
      config: {
        title: this.config.title,
        mode: this.config.mode,
        flow: this.flow,
        timing: this.config.timing,
        durationMin: this.exam.durationMin,
        compiler: this.config.compiler,
        requireIsolation: this.config.requireIsolation,
        recordScreen: this.config.recordScreen,
        maxTeamSize: this.config.maxTeamSize,
      },
      token: issued,
      phase: team.closed ? 'ended' : this.phase,
      lastEvent: s.lastEvent,
      lastEventHash: s.lastHash,
      lastRec: s.lastRec,
      team: this.teamInfo(s.groupId),
      drafts: this.phase === 'lobby' ? undefined : nonCodeAnswers(team),
    })
    this.broadcastGroup(s.groupId)
    if (this.focused === s.clientId) this.sendTo(peer, { t: 'focus', on: true })
    this.maybeSendExam(s)
    this.touch()
  }

  private async validProof(s: Student, link: PeerLink, proof: unknown) {
    if (typeof proof !== 'string') return false
    try {
      return await verifyTokenProof(s.tokenHash, proof, link.transcript)
    } catch {
      return false
    }
  }

  private onPeerClose(peer: string) {
    const clientId = this.peers.get(peer)
    this.peers.delete(peer)
    this.links.delete(peer)
    const s = clientId ? this.students.get(clientId) : undefined
    if (!s || s.peer !== peer) return
    s.peer = null
    s.online = false
    if (this.phase === 'running' && !s.finishedAt) this.pushAlert(s, 'disconnected')
    this.broadcastGroup(s.groupId)
    this.touch()
  }

  private ready(s: Student) {
    const st = s.status
    return st.screen && st.fullscreen && !st.extended && (!this.config.requireIsolation || st.isolated === true)
  }

  get flow(): Flow {
    return this.config.flow ?? 'free'
  }

  questionOpen(questionId: string) {
    return isOpen(this.flow, this.clocks[questionId], Date.now())
  }

  // O horário de fim de cada um. No clock-in é por pessoa ou grupo; o do grupo vale para todos.
  // No manual não existe: acaba quando o professor encerra.
  endsAtOf(s: Student) {
    if (this.flow === 'manual') return null
    if (this.config.timing === 'global') return this.endsAt
    return this.teamOf(s).endsAt ?? null
  }

  private onClockIn(s: Student) {
    if (this.config.timing !== 'clock-in' || this.phase !== 'running' || !this.ready(s)) return
    if (this.config.mode === 'group' && !s.groupId) return
    const team = this.teamOf(s)
    if (!team.endsAt) {
      team.clockInAt = Date.now()
      team.endsAt = team.clockInAt + this.exam.durationMin * 60_000
    }
    this.maybeSendExam(s)
    this.touch()
  }

  // A prova só sai para quem já está sob vigilância. Quem não está pronto segue esperando.
  private maybeSendExam(s: Student) {
    const endsAt = this.endsAtOf(s)
    if (this.phase !== 'running' || s.examSent || !s.peer || s.finishedAt) return
    if (!endsAt && this.flow !== 'manual') return
    if (this.config.mode === 'group' && !s.groupId) return
    if (this.teamOf(s).closed || !this.ready(s)) return
    s.examSent = true
    s.examGranted = true
    const peer = s.peer
    this.seedDoc(this.teamOf(s))
    // Salva antes de soltar: um F5 sem o código inicial em disco semearia de novo, e o texto duplicaria no aluno.
    const send = () => {
      if (s.peer === peer && s.examSent) this.sendExam(s)
    }
    void this.save().then(send, send)
  }

  private sendExam(s: Student) {
    if (s.peer) this.sendTo(s.peer, { t: 'exam', exam: visibleExam(this.exam, this.flow, this.clocks), endsAt: this.endsAtOf(s), clocks: this.clocks, now: Date.now() })
  }

  // Salva o código inicial antes de soltar, pelo mesmo motivo de maybeSendExam.
  private broadcastExam() {
    for (const team of this.teams.values()) {
      if ([...this.students.values()].some((s) => s.examGranted && this.teamKey(s) === team.key)) this.seedDoc(team)
    }
    const send = () => {
      for (const s of this.students.values()) if (s.examSent) this.sendExam(s)
    }
    void this.save().then(send, send)
    this.touch()
  }

  // ---- modo manual: o professor libera e retira cada questão

  releaseQuestion(questionId: string, minutes?: number) {
    if (this.phase !== 'running' || this.flow !== 'manual' || !this.exam.questions.some((q) => q.id === questionId)) return
    if (this.releasing.has(questionId)) return
    this.releasing.add(questionId)
    for (const s of this.students.values()) if (s.examSent) this.sendToStudent(s, { t: 'countdown', seconds: REVEAL_COUNTDOWN_SECONDS })
    this.changed()
    window.setTimeout(() => {
      this.releasing.delete(questionId)
      if (this.phase !== 'running') return this.changed()
      // O tempo da questão começa aqui, na revelação, e não no clique.
      this.clocks = release(this.clocks, questionId, Date.now(), minutes)
      this.broadcastExam()
    }, REVEAL_COUNTDOWN_SECONDS * 1000)
  }

  withdrawQuestion(questionId: string) {
    if (this.flow !== 'manual' || !this.clocks[questionId]) return
    if (!this.clocks[questionId].closed) this.freezeQuestion(questionId)
    this.clocks = withdraw(this.clocks, questionId)
    this.broadcastExam()
  }

  addQuestionTime(questionId: string, minutes: number) {
    if (this.flow !== 'manual') return
    this.clocks = addTime(this.clocks, questionId, minutes, Date.now())
    this.broadcastExam()
  }

  // A resposta que vale é a deste instante. O documento segue aceitando atualizações, porque o CRDT
  // não separa por questão, mas nada do que vier depois entra na entrega.
  private freezeQuestion(questionId: string) {
    for (const team of this.teams.values()) {
      try {
        this.extractAnswers(team)
      } catch (err) {
        console.error('falha ao extrair respostas', team.key, err)
      }
      const draft = team.answers[questionId]
      if (!draft) continue
      team.submissions[questionId] = { answer: draft.answer, at: Date.now(), by: team.submissions[questionId]?.by ?? 'rascunho' }
      this.enqueueGrade(team, questionId)
    }
  }

  private closeTeam(team: Team) {
    if (team.closed) return
    team.closed = true
    // Documento adulterado de uma equipe não pode impedir as outras de encerrar.
    try {
      this.extractAnswers(team)
    } catch (err) {
      console.error('falha ao extrair respostas', team.key, err)
    }
    for (const [questionId, draft] of Object.entries(team.answers)) {
      // O código vale como está no fim: quem entregou antes não congela o que os colegas fizeram depois.
      // A exceção é a questão fechada no modo manual, que já tem a versão congelada dela.
      if (!team.submissions[questionId] || (draft.answer.type === 'code' && !this.clocks[questionId]?.closed)) {
        team.submissions[questionId] = { answer: draft.answer, at: Date.now(), by: team.submissions[questionId]?.by ?? 'rascunho' }
        this.enqueueGrade(team, questionId)
      }
    }
    for (const s of this.students.values()) {
      if (this.teamKey(s) === team.key) this.sendToStudent(s, { t: 'phase', phase: 'ended' })
    }
  }

  private onEvent(s: Student, event: ProctorEvent) {
    if (!event || !Object.hasOwn(ALERT_LABEL, event.kind)) {
      // O número avança mesmo com lixo, senão o fluxo daquele aluno trava aqui.
      if (event) this.accept(s, event.seq)
      return
    }
    if (!this.accept(s, event.seq)) return
    const prev = this.eventChains.get(s.clientId) ?? Promise.resolve()
    const check = prev.then(async () => {
      // Este painel recarregou e pode ter salvo um hash mais antigo: não é adulteração de ninguém.
      const anchored = !this.chainUnknown.delete(s.clientId)
      if (anchored && !(await verifyChain(s.lastHash, event))) s.chainBroken = true
      s.lastHash = event.hash
    })
    this.eventChains.set(s.clientId, check.catch(() => {}))
    // O estado sai na hora e o evento espera o hash, então a transição quase sempre já virou alerta.
    const key = `${s.clientId}:${event.kind}`
    const derived = this.fromStatus.get(key)
    this.fromStatus.delete(key)
    if (!derived || Date.now() - derived >= DEDUPE_MS) {
      this.lastSeen.set(key, Date.now())
      this.pushAlert(s, event.kind, Date.now(), typeof event.detail === 'string' ? event.detail.slice(0, 300) : undefined)
    }
    this.touch()
  }

  private pushAlert(s: Student, kind: AlertKind, at = Date.now(), detail?: string) {
    // A miniatura corrente é revogada ao chegar a próxima: o alerta precisa de um endereço só dele.
    s.alerts++
    // Quem dispara alerta em rajada só infla o próprio contador, sem empurrar os colegas para fora da lista.
    if (s.alerts > MAX_ALERTS_PER_STUDENT) return
    const thumb = this.lastThumb.get(s.clientId)
    const entry: AlertEntry = {
      id: `${s.clientId}:${at}:${kind}`,
      clientId: s.clientId,
      name: s.name,
      kind,
      at,
      detail,
      severe: ALERT_SEVERE.has(kind),
      thumb: thumb && URL.createObjectURL(thumb),
    }
    this.alerts.unshift(entry)
    const old = this.alerts[ALERT_THUMBS_KEPT]
    if (old?.thumb) {
      URL.revokeObjectURL(old.thumb)
      old.thumb = undefined
    }
    s.lastAlert = entry
    this.onAlert?.(entry)
  }

  private checkSignals() {
    const now = Date.now()
    for (const s of this.students.values()) {
      if (!s.online || s.signalLost) continue
      if (now - s.lastBeat > SIGNAL_LOST_MS) {
        s.signalLost = true
        if (this.phase === 'running' && !s.finishedAt) this.pushAlert(s, 'signal-lost')
        this.touch()
      }
    }
  }

  private checkClock() {
    if (this.phase !== 'running') return
    const now = Date.now()
    if (this.flow === 'manual') {
      const expired = expiredQuestions(this.clocks, now)
      for (const id of expired) {
        this.freezeQuestion(id)
        this.clocks = { ...this.clocks, [id]: { ...this.clocks[id], closed: true } }
      }
      if (expired.length) this.broadcastExam()
      return
    }
    if (this.config.timing === 'global') {
      if (this.endsAt && now >= this.endsAt) this.end()
      return
    }
    for (const team of this.teams.values()) {
      if (team.endsAt && now >= team.endsAt && !team.closed) {
        this.closeTeam(team)
        this.touch()
      }
    }
  }

  private onThumb(s: Student, bytes: Uint8Array, focus: boolean) {
    const blob = new Blob([bytes.slice()], { type: 'image/jpeg' })
    this.lastThumb.set(s.clientId, blob)
    const swap = (map: Map<string, string>) => {
      const old = map.get(s.clientId)
      if (old) setTimeout(() => URL.revokeObjectURL(old), 3000)
      map.set(s.clientId, URL.createObjectURL(blob))
    }
    swap(this.thumbs)
    if (focus) swap(this.liveFrame)
    this.changed()
  }

  private onRec(peer: string, s: Student, msg: Extract<StudentMsg, { t: 'rec' }>, bytes: Uint8Array) {
    const prev = this.recChains.get(s.clientId) ?? Promise.resolve()
    const copy = bytes.slice()
    const job = prev.then(() => this.storeRec(peer, s, msg, copy))
    this.recChains.set(s.clientId, job.catch((err) => console.error('falha ao gravar pedaço', err)))
  }

  private async storeRec(peer: string, s: Student, msg: Extract<StudentMsg, { t: 'rec' }>, bytes: Uint8Array<ArrayBuffer>) {
    // `segment` vira chave de objeto e nome de arquivo: "__proto__" ou "../x" não podem chegar lá.
    if (!isIndex(msg.segment) || !isIndex(msg.part) || !Number.isSafeInteger(msg.seq)) return this.bus?.drop(peer)
    if (typeof msg.mime !== 'string' || !/^video\/[a-z0-9.+;=, -]{1,80}$/i.test(msg.mime)) return this.bus?.drop(peer)
    if (msg.seq <= s.lastRec) return this.ackWhenSaved(s)
    const used = Object.values(s.segments).reduce((n, x) => n + x.size, 0)
    // Sala sem gravação ou aluno acima da cota: confirma e descarta, para não encher o disco nem travar o fluxo.
    if (!this.config.recordScreen || used + bytes.length > MAX_REC_BYTES_PER_STUDENT) {
      s.lastRec = msg.seq
      return this.ackWhenSaved(s)
    }
    const seg = (s.segments[msg.segment] ??= {
      segment: msg.segment,
      startedAt: typeof msg.startedAt === 'number' ? msg.startedAt : Date.now(),
      mime: msg.mime,
      parts: 0,
      size: 0,
      complete: false,
    })
    await idb.put('chunks', partKey(this.config.roomId, s.clientId, msg.segment, msg.part), new Blob([bytes], { type: msg.mime }))
    s.lastRec = msg.seq
    seg.parts = Math.max(seg.parts, msg.part + 1)
    seg.size += bytes.length
    if (msg.last) seg.complete = true
    this.ackWhenSaved(s)
  }

  async segmentBlob(clientId: string, segment: SegmentInfo): Promise<Blob> {
    const parts = await idb.values<Blob>('chunks', idb.prefix(`${this.config.roomId}/${clientId}/${pad(segment.segment)}/`))
    return new Blob(parts, { type: segment.mime })
  }

  // ---- grupo

  teamKey(s: Student) {
    return this.config.mode === 'group' && s.groupId ? `g:${s.groupId}` : `s:${s.clientId}`
  }

  teamOf(s: Student): Team {
    const key = this.teamKey(s)
    let team = this.teams.get(key)
    if (!team) {
      team = { key, answers: {}, submissions: {}, grades: {} }
      this.teams.set(key, team)
    }
    return team
  }

  // Só para os olhos do professor: nunca entra em mensagem, em config nem no zip.
  teamCode(groupId: string) {
    return this.teamCodes.get(groupId)
  }

  private groupMembers(groupId: string) {
    return [...this.students.values()].filter((s) => s.groupId === groupId)
  }

  private teamInfo(groupId?: string): TeamInfo | undefined {
    const group = groupId && this.config.groups.find((g) => g.id === groupId)
    if (!group) return undefined
    return {
      id: group.id,
      name: group.name,
      code: this.teamCodes.get(group.id) ?? '',
      max: this.config.maxTeamSize,
      members: this.groupMembers(group.id).map((m) => ({ clientId: m.clientId, name: m.name, focused: m.online && m.status.focused })),
    }
  }

  private broadcastGroup(groupId?: string) {
    if (!groupId) return
    const team = this.teamInfo(groupId)
    if (team) for (const m of this.groupMembers(groupId)) this.sendToStudent(m, { t: 'team', team })
  }

  private onTeamCreate(s: Student, rawName: unknown) {
    const name = typeof rawName === 'string' ? rawName.trim().slice(0, 40) : ''
    if (!name) return this.sendToStudent(s, { t: 'team-error', reason: 'name' })
    const id = randomId(4)
    let code = makeRoomCode()
    while ([...this.teamCodes.values()].includes(code)) code = makeRoomCode()
    this.config.groups = [...this.config.groups, { id, name }]
    this.teamCodes.set(id, code)
    s.groupId = id
    this.broadcastGroup(id)
    this.maybeSendExam(s)
    this.touch()
  }

  private onTeamJoin(s: Student, rawCode: unknown) {
    const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : ''
    const id = [...this.teamCodes].find(([, c]) => c === code)?.[0]
    if (!id) return this.sendToStudent(s, { t: 'team-error', reason: 'code' })
    if (this.teams.get(`g:${id}`)?.closed) return this.sendToStudent(s, { t: 'team-error', reason: 'started' })
    if (this.groupMembers(id).length >= this.config.maxTeamSize) return this.sendToStudent(s, { t: 'team-error', reason: 'full' })
    s.groupId = id
    this.broadcastGroup(id)
    this.maybeSendExam(s)
    this.touch()
  }

  // Equipe vazia que nunca começou some junto com o código, para não acumular salas fantasmas.
  private leaveTeam(s: Student) {
    const id = s.groupId
    if (!id) return
    s.groupId = undefined
    // A entrada em `teams` nasce no primeiro batimento, então ela sozinha não diz que a equipe começou.
    const key = `g:${id}`
    const team = this.teams.get(key)
    if (!this.groupMembers(id).length && !this.docs.has(key) && !team?.doc && !team?.endsAt) {
      this.config.groups = this.config.groups.filter((g) => g.id !== id)
      this.teamCodes.delete(id)
      this.teams.delete(key)
    } else {
      this.broadcastGroup(id)
    }
  }

  private onDraft(s: Student, questionId: string, answer: Answer, rev: number) {
    // Código anda pelo documento da equipe; rascunho aqui é só para múltipla escolha e texto.
    if (answer.type === 'code' || typeof rev !== 'number') return
    const team = this.teamOf(s)
    const cur = team.answers[questionId]
    if (cur && rev < cur.rev) return
    team.answers[questionId] = { answer, rev }
    if (s.groupId && this.config.mode === 'group') {
      for (const m of this.groupMembers(s.groupId)) {
        if (m.clientId !== s.clientId) this.sendToStudent(m, { t: 'group-draft', questionId, answer, rev, by: s.name })
      }
    }
    this.touch()
  }

  // ---- documento colaborativo

  docOf(team: Team) {
    let doc = this.docs.get(team.key)
    if (!doc) {
      doc = new ExamDoc()
      if (team.doc) doc.apply(fromB64Large(team.doc), 'load')
      this.docs.set(team.key, doc)
    }
    return doc
  }

  private seedDoc(team: Team) {
    const doc = this.docOf(team)
    for (const q of this.exam.questions) {
      // O código inicial também é conteúdo da questão: só entra no documento quando ela é liberada.
      if (q.type !== 'code' || !isVisible(this.flow, this.clocks[q.id])) continue
      const lang = q.languages[0]
      doc.seed(q.id, lang, mainFile(lang), q.starter?.[lang] ?? defaultStarter(lang))
    }
    this.extractAnswers(team)
  }

  private sendBinaryTo(peer: string, frame: Uint8Array<ArrayBuffer>) {
    const channel = this.links.get(peer)?.channel
    if (!channel) return
    void channel.then((c) => c.seal(frame)).then((sealed) => this.bus?.send(peer, sealed), () => this.bus?.drop(peer))
  }

  private relayToTeam(s: Student, frame: Uint8Array<ArrayBuffer>) {
    if (!s.groupId) return
    for (const m of this.groupMembers(s.groupId)) {
      // Quem ainda não está pronto não recebe a prova nem o que a equipe escreve: ao liberar, sincroniza tudo.
      if (m.clientId !== s.clientId && m.peer && m.examSent) this.sendBinaryTo(m.peer, frame)
    }
  }

  private onYSync(s: Student, vector: Uint8Array) {
    if (!s.peer) return
    const doc = this.docOf(this.teamOf(s))
    try {
      this.sendBinaryTo(s.peer, encodeBinary({ t: 'y-update' } satisfies TeacherMsg, doc.diffFor(vector)))
      this.sendBinaryTo(s.peer, encodeBinary({ t: 'y-sync' } satisfies TeacherMsg, doc.encodeVector()))
    } catch {
      if (s.peer) this.bus?.drop(s.peer)
    }
  }

  private onYUpdate(peer: string, s: Student, update: Uint8Array) {
    if (update.length > MAX_Y_UPDATE_BYTES) return this.bus?.drop(peer)
    const team = this.teamOf(s)
    const doc = this.docOf(team)
    if (doc.encodeState().length + update.length > MAX_DOC_BYTES) return this.bus?.drop(peer)
    try {
      doc.apply(update, s.clientId)
    } catch {
      return this.bus?.drop(peer)
    }
    this.relayToTeam(s, encodeBinary({ t: 'y-update' } satisfies TeacherMsg, update))
    if (!this.extractTimers.has(team.key)) {
      this.extractTimers.set(
        team.key,
        window.setTimeout(() => {
          this.extractTimers.delete(team.key)
          this.extractAnswers(team)
          this.touch()
        }, 500),
      )
    }
  }

  // O que o painel mostra, corrige e exporta sai do documento, sempre validado.
  private extractAnswers(team: Team) {
    const doc = this.docs.get(team.key)
    if (!doc) return
    for (const q of this.exam.questions) {
      if (q.type !== 'code' || this.clocks[q.id]?.closed) continue
      const answer = doc.snapshot(q.id)
      if (!answer || !validFiles(answer.files)) continue
      team.answers[q.id] = { answer, rev: (team.answers[q.id]?.rev ?? 0) + 1 }
    }
  }

  // ---- estado: o batimento repete tudo, e a transição é detectada aqui, mesmo sem o evento

  private applyStatus(s: Student, raw: StudentStatus) {
    if (!raw || typeof raw !== 'object') return
    const next: StudentStatus = {
      screen: raw.screen === true,
      fullscreen: raw.fullscreen === true,
      focused: raw.focused === true,
      isolated: raw.isolated === true ? true : raw.isolated === false ? false : null,
      extended: raw.extended === true,
    }
    const prev = s.status
    const changed = (Object.keys(next) as (keyof StudentStatus)[]).some((k) => next[k] !== prev[k])
    s.status = next
    if (s.examGranted && this.phase === 'running' && !s.finishedAt) {
      if (prev.focused && !next.focused) this.alertOnce(s, 'focus-lost')
      if (prev.fullscreen && !next.fullscreen) this.alertOnce(s, 'fullscreen-exit')
      if (prev.screen && !next.screen) this.alertOnce(s, 'share-ended')
      if (!prev.extended && next.extended) this.alertOnce(s, 'multi-monitor')
      if (prev.isolated === true && next.isolated === false) this.alertOnce(s, 'internet-back')
    }
    if (!changed) return
    if (s.status.focused !== prev.focused) this.broadcastGroup(s.groupId)
    this.maybeSendExam(s)
    this.touch()
  }

  private alertOnce(s: Student, kind: AlertKind, detail?: string) {
    const key = `${s.clientId}:${kind}`
    const now = Date.now()
    if (now - (this.lastSeen.get(key) ?? 0) < DEDUPE_MS) return
    this.lastSeen.set(key, now)
    this.fromStatus.set(key, now)
    this.pushAlert(s, kind, now, detail)
  }

  // ---- selo visual: confere na captura da tela o que o estado afirma

  private tickBeacons() {
    if (this.phase !== 'running') return
    const now = Date.now()
    for (const s of this.students.values()) {
      if (!s.peer || !s.examSent || s.finishedAt || this.teamOf(s).closed) {
        this.beacons.delete(s.clientId)
        continue
      }
      let state = this.beacons.get(s.clientId)
      if (!state) {
        state = { codes: [], fails: 0, sinceAt: now, gotFrame: true, everOk: false }
        this.beacons.set(s.clientId, state)
      }
      if (!state.gotFrame) this.beaconResult(s, state, false)
      state.gotFrame = false
      const code = randomBeaconCode()
      state.codes = [...state.codes, code].slice(-BEACON_KEEP)
      this.sendToStudent(s, { t: 'beacon', code })
    }
  }

  private async onBeaconFrame(s: Student, bytes: Uint8Array) {
    const state = this.beacons.get(s.clientId)
    if (!state) return
    state.gotFrame = true
    let code: number | null = null
    try {
      code = await readBeaconImage(bytes)
    } catch {
      code = null
    }
    this.beaconResult(s, state, code !== null && state.codes.includes(code))
  }

  private beaconResult(s: Student, state: BeaconState, ok: boolean) {
    const was = s.beaconOk
    if (ok) {
      state.fails = 0
      state.everOk = true
      s.beaconOk = true
    } else if (this.ready(s)) {
      // Fora de tela cheia o aluno já está bloqueado e já gerou alerta: aqui só importa a divergência.
      state.fails++
      const grace = !state.everOk && Date.now() - state.sinceAt < BEACON_GRACE_MS
      if (state.fails >= BEACON_FAILS && !grace) {
        if (s.beaconOk !== false) this.pushAlert(s, 'beacon-missing')
        s.beaconOk = false
      }
    }
    if (was !== s.beaconOk) this.touch()
  }

  // ---- controle do professor

  start() {
    if (this.phase !== 'lobby') return
    this.phase = 'running'
    if (this.flow === 'free' && this.config.timing === 'global') this.endsAt = Date.now() + this.exam.durationMin * 60_000
    for (const s of this.students.values()) {
      this.sendToStudent(s, { t: 'phase', phase: 'running' })
      this.maybeSendExam(s)
    }
    this.touch()
  }

  end() {
    if (this.phase === 'ended') return
    this.phase = 'ended'
    for (const s of this.students.values()) this.sendToStudent(s, { t: 'phase', phase: 'ended' })
    for (const team of this.teams.values()) this.closeTeam(team)
    void idb.del('kv', ACTIVE_KEY)
    void this.save()
    this.changed()
  }

  extend(minutes: number) {
    const extra = minutes * 60_000
    if (this.endsAt) this.endsAt += extra
    for (const team of this.teams.values()) if (team.endsAt && !team.closed) team.endsAt += extra
    for (const s of this.students.values()) {
      const endsAt = this.endsAtOf(s)
      if (endsAt) this.sendToStudent(s, { t: 'clock', endsAt, now: Date.now() })
    }
    this.touch()
  }

  warn(clientId: string, text: string) {
    const s = this.students.get(clientId)
    if (s) this.sendToStudent(s, { t: 'warn', text })
  }

  setFocus(clientId: string | null) {
    if (this.focused && this.focused !== clientId) {
      const prev = this.students.get(this.focused)
      if (prev) this.sendToStudent(prev, { t: 'focus', on: false })
    }
    this.focused = clientId
    if (clientId) {
      const s = this.students.get(clientId)
      if (s) this.sendToStudent(s, { t: 'focus', on: true })
    }
  }

  moveToGroup(clientId: string, groupId: string) {
    const s = this.students.get(clientId)
    if (!s || s.groupId === groupId || !this.config.groups.some((g) => g.id === groupId)) return
    const endsAt = this.endsAtOf(s)
    this.leaveTeam(s)
    s.groupId = groupId
    if (s.examGranted) {
      // Troca de documento e de relógio: a prova é reenviada, e o aluno sincroniza com a equipe nova.
      const team = this.teamOf(s)
      if (this.config.timing === 'clock-in' && !team.endsAt && endsAt) {
        team.clockInAt = Date.now()
        team.endsAt = endsAt
      }
      s.examSent = false
    }
    this.broadcastGroup(groupId)
    this.maybeSendExam(s)
    this.touch()
  }

  setManualGrade(teamKey: string, questionId: string, points: number) {
    const team = this.teams.get(teamKey)
    const q = this.exam.questions.find((q) => q.id === questionId)
    if (!team || !q) return
    const clamped = Math.max(0, Math.min(points, q.points)) || 0
    team.grades[questionId] = { questionId, status: 'manual', points: clamped, max: q.points, at: Date.now(), graded: true }
    this.touch()
  }

  // ---- rodar quando o WebAssembly do aluno não está disponível: usa os mesmos limites explícitos

  private onRun(s: Student, msg: Extract<StudentMsg, { t: 'run' }>) {
    const { reqId } = msg
    if (this.phase !== 'running' || !s.examSent) return
    const report = (result: RunReport) => this.sendToStudent(s, { t: 'run-result', result })
    // Sem resposta o botão do aluno ficaria preso.
    if (!validFiles(msg.files) || (msg.lang !== 'c' && msg.lang !== 'cpp') || typeof msg.stdin !== 'string') return report({ reqId, status: 'compile-error', log: 'Arquivos fora do limite' })
    const key = this.teamKey(s)
    const wait = (this.lastRun.get(key) ?? 0) + HOST_RUN_INTERVAL_MS - Date.now()
    if (wait > 0) return report({ reqId, status: 'limited', retryInMs: wait })
    this.lastRun.set(key, Date.now())
    this.gradeQueue.push(async () => {
      const built = await compile(msg.lang, msg.files)
      if (!built.ok) return report({ reqId, status: 'compile-error', log: built.log.slice(0, 8000) })
      const out = await run(built.wasm, msg.stdin.slice(0, 256 * 1024), RUN_LIMITS.timeMs)
      report({
        reqId,
        status: 'done',
        log: built.log.slice(0, 8000),
        stdout: out.stdout.slice(0, RUN_LIMITS.outputKb * 1024),
        stderr: out.stderr.slice(0, 16 * 1024),
        exitCode: out.exitCode,
        timedOut: out.timedOut,
        error: out.error,
      })
    })
    this.pumpGrades()
  }

  // ---- teste pedido pelo aluno: roda aqui, no máximo uma vez por minuto para cada pessoa ou grupo

  private onTest(s: Student, msg: Extract<StudentMsg, { t: 'test' }>) {
    const { reqId, questionId } = msg
    const report = (result: TestReport) => this.sendToStudent(s, { t: 'test-result', result })
    const q = this.exam.questions.find((q) => q.id === questionId)
    if (this.phase !== 'running' || !this.config.compiler || q?.type !== 'code' || !s.examSent) return
    // Sem resposta o botão do aluno ficaria preso. Não gasta o minuto dele.
    if (!q.languages.includes(msg.lang) || !validFiles(msg.files)) return report({ reqId, questionId, status: 'compile-error', log: 'Arquivos fora do limite', nextInMs: 0 })
    if (!this.questionOpen(questionId)) return report({ reqId, questionId, status: 'compile-error', log: 'Esta questão está fechada', nextInMs: 0 })
    const key = this.teamKey(s)
    const wait = (this.lastTest.get(key) ?? 0) + TEST_INTERVAL_MS - Date.now()
    if (wait > 0) return report({ reqId, questionId, status: 'limited', retryInMs: wait })
    this.lastTest.set(key, Date.now())
    report({ reqId, questionId, status: 'queued' })
    this.gradeQueue.push(() => this.runStudentTest(s, msg, q, report))
    this.pumpGrades()
  }

  private async runStudentTest(_s: Student, msg: Extract<StudentMsg, { t: 'test' }>, q: CodeQuestion, report: (r: TestReport) => void) {
    const { reqId, questionId } = msg
    const nextInMs = () => Math.max(0, TEST_INTERVAL_MS - (Date.now() - (this.lastTest.get(this.teamKey(_s)) ?? 0)))
    const built = await compile(msg.lang, msg.files)
    if (!built.ok) return report({ reqId, questionId, status: 'compile-error', log: built.log.slice(0, 8000), nextInMs: nextInMs() })
    const samples: Extract<TestReport, { status: 'done' }>['samples'] = []
    for (const sample of q.samples ?? []) {
      const out = await run(built.wasm, sample.stdin, 2000)
      samples.push({
        passed: !out.timedOut && out.exitCode === 0 && checkOutput(sample.stdout, out.stdout),
        stdin: sample.stdin,
        expected: sample.stdout,
        stdout: out.stdout.slice(0, 4000),
        stderr: out.stderr.slice(0, 2000),
        error: out.error,
      })
    }
    const solution = this.solutions?.solutions.find((x) => x.questionId === questionId)
    const tests = solution?.type === 'code' ? solution.tests : []
    let passed = 0
    for (const test of tests) {
      const out = await run(built.wasm, test.stdin, test.timeoutMs ?? 2000)
      if (!out.timedOut && out.exitCode === 0 && checkOutput(test.stdout, out.stdout, test.checker)) passed++
    }
    report({ reqId, questionId, status: 'done', log: built.log.slice(0, 8000), samples, hidden: { passed, total: tests.length }, nextInMs: nextInMs() })
  }

  // ---- correção: roda aqui, no navegador do professor, com os testes ocultos

  private enqueueGrade(team: Team, questionId: string) {
    const q = this.exam.questions.find((q) => q.id === questionId)
    if (!q) return
    team.grades[questionId] = { questionId, status: 'pending', points: 0, max: q.points }
    const key = `${team.key}/${questionId}`
    if (this.queuedGrades.has(key)) return
    this.queuedGrades.add(key)
    this.gradeQueue.push(() => {
      this.queuedGrades.delete(key)
      return this.grade(team, questionId)
    })
    this.pumpGrades()
  }

  private pumpGrades() {
    const limit = Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2))
    while (this.gradeRunning < limit && this.gradeQueue.length) {
      const job = this.gradeQueue.shift()!
      this.gradeRunning++
      void job().finally(() => {
        this.gradeRunning--
        this.pumpGrades()
      })
    }
  }

  private async grade(team: Team, questionId: string) {
    const q = this.exam.questions.find((q) => q.id === questionId)
    const sub = team.submissions[questionId]
    if (!q || !sub) return
    const solution = this.solutions?.solutions.find((s) => s.questionId === questionId)
    const grade: Grade = { questionId, status: 'running', points: 0, max: q.points, at: Date.now() }
    team.grades[questionId] = grade
    this.changed()

    if (!solution || solution.type === 'text' || sub.answer.type === 'text') {
      grade.status = 'manual'
    } else if (solution.type === 'choice' && sub.answer.type === 'choice') {
      const want = [...solution.correct].sort().join()
      const got = [...sub.answer.selected].sort().join()
      grade.points = want === got ? q.points : 0
      grade.status = 'done'
    } else if (solution.type === 'code' && sub.answer.type === 'code') {
      try {
        await this.gradeCode(grade, solution.tests, sub.answer)
      } catch (err) {
        grade.status = 'compile-error'
        grade.compileLog = String(err)
      }
    } else {
      // Tipo de resposta diferente da questão só vem de cliente adulterado. Fica com o professor.
      grade.status = 'manual'
    }
    this.touch()
  }

  private async gradeCode(grade: Grade, tests: HiddenTest[], answer: Extract<Answer, { type: 'code' }>) {
    const built = await compile(answer.lang, answer.files)
    if (!built.ok) {
      grade.status = 'compile-error'
      grade.compileLog = built.log
      return
    }
    const results: TestResult[] = []
    for (const [index, test] of tests.entries()) {
      const out = await run(built.wasm, test.stdin, test.timeoutMs ?? 2000)
      const passed = !out.timedOut && out.exitCode === 0 && checkOutput(test.stdout, out.stdout, test.checker)
      results.push({
        index,
        passed,
        points: passed ? test.points : 0,
        timedOut: out.timedOut,
        stdout: out.stdout.slice(0, 2000),
        stderr: out.stderr.slice(0, 2000),
      })
      grade.tests = [...results]
      grade.points = results.reduce((n, r) => n + r.points, 0)
      this.changed()
    }
    grade.status = 'done'
  }

  scoreOf(team: Team) {
    let earned = 0
    let pending = 0
    for (const q of this.exam.questions) {
      const g = team.grades[q.id]
      if (g) earned += g.points
      if (!g ? !team.closed : g.status === 'pending' || g.status === 'running' || (g.status === 'manual' && !g.graded)) pending++
    }
    const total = this.exam.questions.reduce((n, q) => n + q.points, 0)
    return { earned, total, pending }
  }

  resultsCsv() {
    const header = ['nome', 'matricula', 'grupo', ...this.exam.questions.map((q) => q.id), 'total', 'alertas', 'entregou']
    const rows = [...this.students.values()].map((s) => {
      const team = this.teamOf(s)
      const group = this.config.groups.find((g) => g.id === s.groupId)?.name ?? ''
      return [
        s.name,
        s.enrollment ?? '',
        group,
        ...this.exam.questions.map((q) => team.grades[q.id]?.points ?? 0),
        this.scoreOf(team).earned,
        s.alerts,
        s.finishedAt ? new Date(s.finishedAt).toISOString() : '',
      ]
    })
    return [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\n')
  }
}

const pad = (n: number) => String(n).padStart(6, '0')
const isIndex = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0
const partKey = (room: string, client: string, segment: number, part: number) => `${room}/${client}/${pad(segment)}/${pad(part)}`
// Fórmula em CSV roda ao abrir no Excel; o nome vem do aluno, então é neutralizado.
const csvCell = (v: unknown) => {
  const text = String(v).replace(/"/g, '""')
  return `"${/^[=+\-@\t\r]/.test(text) ? `'${text}` : text}"`
}

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => alphabet[b % alphabet.length]).join('')
}

async function verifyChain(prev: string | undefined, e: ProctorEvent) {
  const text = `${prev ?? ''}|${e.seq}|${e.kind}|${e.at}|${e.detail ?? ''}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  return hash === e.hash
}

const openRooms = new Map<string, Room>()

export async function openRoom(roomId: string) {
  const live = openRooms.get(roomId)
  if (live) return live
  const room = await Room.load(roomId)
  if (room) openRooms.set(roomId, room)
  return room
}

export function registerRoom(room: Room) {
  openRooms.set(room.config.roomId, room)
}

export const listRooms = async () => {
  const ids = (await idb.get<string[]>('kv', 'rooms')) ?? []
  const snaps = await Promise.all(ids.map((id) => idb.get<Snapshot>('kv', `room:${id}`)))
  return snaps.filter((s): s is Snapshot => !!s)
}

// Uma prova por vez nesta máquina: devolve a que ainda está aberta, se houver.
export async function activeRoom() {
  const id = await idb.get<string>('kv', ACTIVE_KEY)
  if (!id) return null
  const snap = await idb.get<Snapshot>('kv', `room:${id}`)
  if (snap && snap.phase !== 'ended') return { id, title: snap.config.title, phase: snap.phase }
  await idb.del('kv', ACTIVE_KEY)
  return null
}

// btoa com spread estoura a pilha em documentos grandes.
function toB64Large(bytes: Uint8Array) {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

const fromB64Large = (text: string) => fromB64(text)

const nonCodeAnswers = (team: Team) =>
  Object.fromEntries(Object.entries(team.answers).filter(([, d]) => d.answer.type !== 'code'))

async function readBeaconImage(bytes: Uint8Array) {
  const image = await createImageBitmap(new Blob([bytes.slice()], { type: 'image/png' }))
  const { width, height } = image
  // Um PNG pequeno pode declarar dimensões enormes.
  if (width * height > MAX_BEACON_PIXELS) {
    image.close()
    return null
  }
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(image, 0, 0)
  image.close()
  const { data } = ctx.getImageData(0, 0, width, height)
  return decodeBeacon((col, row) => {
    const x = Math.floor(((col + 0.5) / BEACON.cols) * width)
    const y = Math.floor(((row + 0.5) / BEACON.rows) * height)
    const i = (y * width + x) * 4
    return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
  })
}
