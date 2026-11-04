import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, Check, ChevronDown, Download, EyeOff, HardDrive, Loader2, Lock, PenLine, Users, WifiOff } from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import type { Group, Phase } from '../../shared/protocol'
import { formatClock, useObservable } from '../lib/store'
import { detectHub } from '../net/bus'
import { Avatar, Logo, Modal, Pill, Popover, PopoverRow, Segmented, Switch, useTick } from '../ui/kit'
import { alertLabel, canStreamToDisk, download, exportRoomZip, safeName } from './exportZip'
import { openRoom, type AlertEntry, type Grade, type Room, type Student, type Team } from './room'
import { keepConnected } from './reconnect'
import { formatBytes } from './storageWatch'
import './dash.css'

const HOST_URL = import.meta.env.VITE_HOST_URL ?? 'https://github.com/giulianoo0/oblita/releases/latest/download/oblita-host.exe'
const ALARM_MS = 3000
const TAB_RETRY_MS = 2000
const FEED_LIMIT = 200
const pop = { type: 'spring', bounce: 0.25, duration: 0.6 } as const
const settle = { type: 'spring', bounce: 0, duration: 0.36 } as const

const PHASE_LABEL: Record<Phase, string> = { lobby: 'Sala aberta', running: 'Em prova', ended: 'Encerrada' }

export const hhmmss = (at: number) => new Date(at).toLocaleTimeString('pt-BR')
export const studentPath = (roomId: string, clientId: string) => `/sala/${encodeURIComponent(roomId)}/aluno/${encodeURIComponent(clientId)}`

// undefined enquanto lê do IndexedDB; null quando a sala não existe.
export function useRoom(roomId: string) {
  const [room, setRoom] = useState<Room | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    setRoom(undefined)
    openRoom(roomId).then(
      (r) => live && setRoom(r),
      () => live && setRoom(null),
    )
    return () => {
      live = false
    }
  }, [roomId])
  return room
}

export function RoomMissing() {
  return (
    <div className="center-screen">
      <div className="gate">
        <h1>Sala não encontrada</h1>
        <div>
          <Link className="pill" to="/">
            Voltar ao início
          </Link>
        </div>
      </div>
    </div>
  )
}

// Painel e detalhe passam por aqui, e na mesma aba a trava continua valendo. Quem perdeu tem uma
// cópia velha da sala: quando a trava solta (a outra aba fechou, ou um F5 ainda não a devolveu),
// recarrega para ler o que está salvo, em vez de assumir com o que tem.
export function RoomGate({ room, children }: { room: Room; children: ReactNode }) {
  const [held, setHeld] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    let lost = false
    let timer = 0
    const attempt = () =>
      void room.holdTab().then((ok) => {
        if (!live) return
        if (ok && lost) return window.location.reload()
        lost = !ok
        setHeld(ok)
        if (!ok) timer = window.setTimeout(attempt, TAB_RETRY_MS)
      })
    attempt()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [room])
  if (held === null) return null
  if (held) return children
  return (
    <div className="center-screen">
      <div className="gate">
        <h1>Esta sala está aberta em outra aba</h1>
      </div>
    </div>
  )
}

// O navegador só libera áudio depois de um gesto, então o contexto nasce no primeiro clique ou tecla.
let audio: AudioContext | null = null
let lastBeep = 0

function armAudio() {
  const arm = () => {
    audio ??= new AudioContext()
    void audio.resume()
  }
  window.addEventListener('pointerdown', arm, { once: true })
  window.addEventListener('keydown', arm, { once: true })
  return () => {
    window.removeEventListener('pointerdown', arm)
    window.removeEventListener('keydown', arm)
  }
}

function beep() {
  const now = Date.now()
  if (!audio || now - lastBeep < 800) return
  lastBeep = now
  const osc = audio.createOscillator()
  const gain = audio.createGain()
  const t = audio.currentTime
  osc.frequency.value = 880
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(0.18, t + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18)
  osc.connect(gain).connect(audio.destination)
  osc.start(t)
  osc.stop(t + 0.2)
}

// Quem escolheu "Só navegador" no cartão de conexão não é puxado de volta para o programa.
const prefersBrowser = new WeakSet<Room>()

const loopbackGranted = async () => {
  try {
    const perm = await navigator.permissions.query({ name: 'loopback-network' as PermissionName })
    return perm.state === 'granted'
  } catch {
    // Navegador sem essa permissão: fica no botão.
    return false
  }
}

async function connectProgram(room: Room) {
  const hub = await detectHub()
  if (!hub) return false
  room.hubAddresses = hub.addresses
  await room.useHub('localhost', hub.token)
  return true
}

// Vale para o painel e para o detalhe: olhar um aluno não pode silenciar os outros.
export function useRoomRuntime(room: Room, onAlarm?: (clientId: string) => void) {
  const alarm = useRef(onAlarm)
  alarm.current = onAlarm

  useEffect(armAudio, [])

  useEffect(() => {
    const handler = (a: AlertEntry) => {
      const text = `${a.name}: ${alertLabel(a.kind)}`
      if (a.severe) {
        toast.error(text)
        beep()
      } else toast(text)
      alarm.current?.(a.clientId)
    }
    room.onAlert = handler
    return () => {
      if (room.onAlert === handler) room.onAlert = null
    }
  }, [room])

  useEffect(() => {
    const handler = (text: string) => toast.error(text, { duration: 10_000 })
    room.onStorage = handler
    return () => {
      if (room.onStorage === handler) room.onStorage = null
    }
  }, [room])

  const running = room.phase === 'running'
  useEffect(() => {
    if (!running) return
    const guard = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [running])

  // Com a permissão já dada não há prompt, então dá para reconectar sem pedir clique: ao abrir,
  // quando o programa cai e volta, e quando o professor abre o programa depois do painel.
  useEffect(
    () =>
      keepConnected({
        wanted: async () => (room.busState === 'none' || room.busState === 'down') && !prefersBrowser.has(room) && (await loopbackGranted()),
        connect: () => connectProgram(room),
      }),
    [room],
  )
}

export default function Dashboard() {
  const { roomId = '' } = useParams()
  const room = useRoom(roomId)
  if (room === undefined) return null
  if (!room) return <RoomMissing />
  return (
    <RoomGate room={room}>
      <DashboardView room={room} />
    </RoomGate>
  )
}

function DashboardView({ room }: { room: Room }) {
  useObservable(room)
  const [alarms, setAlarms] = useState<ReadonlySet<string>>(() => new Set())
  const alarmTimers = useRef(new Map<string, number>())
  const raise = useCallback((clientId: string) => {
    setAlarms((cur) => (cur.has(clientId) ? cur : new Set(cur).add(clientId)))
    clearTimeout(alarmTimers.current.get(clientId))
    alarmTimers.current.set(
      clientId,
      window.setTimeout(() => {
        alarmTimers.current.delete(clientId)
        setAlarms((cur) => {
          const next = new Set(cur)
          next.delete(clientId)
          return next
        })
      }, ALARM_MS),
    )
  }, [])
  useEffect(() => {
    const timers = alarmTimers.current
    return () => timers.forEach((t) => clearTimeout(t))
  }, [])
  useRoomRuntime(room, raise)

  const [picked, setPicked] = useState<'wall' | 'results' | null>(null)
  const view = room.phase === 'lobby' ? 'wall' : (picked ?? (room.phase === 'ended' ? 'results' : 'wall'))
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [exporting, setExporting] = useState(false)

  const total = room.students.size
  let online = 0
  for (const s of room.students.values()) if (s.online) online++

  return (
    <div className="dash">
      <header className="dash-top">
        <Logo size={1.25} />
        <span className="dash-title">{room.config.title}</span>
        <span className="badge">{PHASE_LABEL[room.phase]}</span>
        <RoomClock room={room} />
        <span className="dash-fp">
          <span className="conn-label">Código do professor</span>
          <b>{room.fingerprint}</b>
        </span>
        <span className="badge num" title="Conectados">
          <Users size={12} /> {online}/{total}
        </span>
        <div className="grow" />
        {room.phase !== 'lobby' && (
          <Segmented
            value={view}
            onChange={setPicked}
            options={[
              { value: 'wall', label: 'Telas' },
              { value: 'results', label: 'Notas' },
            ]}
          />
        )}
        {room.phase === 'lobby' && (
          <Pill tone="brand" disabled={!room.bus} title={room.bus ? undefined : 'Conecte a sala primeiro'} onClick={() => room.start()}>
            {room.config.timing === 'global' || room.flow === 'manual' ? 'Começar' : 'Abrir prova'}
          </Pill>
        )}
        {room.phase === 'running' && room.flow === 'free' && <Pill onClick={() => room.extend(5)}>+5 min</Pill>}
        {/* Também na sala ainda aberta: só existe uma prova por vez, e sem isto não haveria como desistir dela. */}
        {room.phase !== 'ended' && (
          <Pill tone="danger" onClick={() => setConfirmEnd(true)}>
            Encerrar
          </Pill>
        )}
        <Pill onClick={() => setExporting(true)}>Exportar</Pill>
      </header>

      <div className="dash-body">
        <main className="dash-main">{view === 'wall' ? <Wall room={room} alarms={alarms} /> : <ResultsTable room={room} />}</main>
        <aside className="dash-side">
          <ConnectionCard room={room} />
          <StorageCard room={room} />
          {room.flow === 'manual' && room.phase !== 'ended' && <ManualPanel room={room} />}
          <div className="card alert-card">
            <div className="row">
              <h2 className="grow">Alertas</h2>
              {room.alerts.length > 0 && <span className="badge num">{room.alerts.length}</span>}
            </div>
            <AlertFeed room={room} count={room.alerts.length} />
          </div>
        </aside>
      </div>

      <Modal open={confirmEnd} title="Encerrar a prova para todos?" onClose={() => setConfirmEnd(false)}>
        <div className="row">
          <div className="grow" />
          <Pill onClick={() => setConfirmEnd(false)}>Cancelar</Pill>
          <Pill
            tone="danger"
            onClick={() => {
              room.end()
              setConfirmEnd(false)
            }}
          >
            Encerrar
          </Pill>
        </div>
      </Modal>
      <ExportModal room={room} open={exporting} onClose={() => setExporting(false)} />
    </div>
  )
}

// Relógio próprio: o Room não avisa a cada segundo, então quem lê o tempo precisa do seu tique.
function RoomClock({ room }: { room: Room }) {
  useTick(500)
  if (room.phase === 'ended') return null
  if (room.flow === 'manual') return <span className="small muted">Manual</span>
  if (room.config.timing === 'clock-in') return <span className="small muted">Cada um no seu tempo</span>
  const ms = room.phase === 'lobby' ? room.exam.durationMin * 60_000 : room.remaining()
  return <span className={`dash-clock${room.phase === 'running' && ms !== null && ms < 300_000 ? ' bad' : ''}`}>{ms === null ? '--:--' : formatClock(ms)}</span>
}

// ---- modo manual

function ManualPanel({ room }: { room: Room }) {
  useTick(1000)
  const [minutes, setMinutes] = useState<Record<string, string>>({})
  const running = room.phase === 'running'
  return (
    <div className="card manual-card">
      <h2>Questões</h2>
      <div className="manual-list">
        {room.exam.questions.map((q, i) => {
          const clock = room.clocks[q.id]
          const live = !!clock && !clock.withdrawn
          const ms = live && clock.endsAt !== null ? clock.endsAt - Date.now() : null
          const open = room.questionOpen(q.id)
          return (
            <div key={q.id} className="manual-item" data-open={open}>
              <div className="row">
                <b className="num">{i + 1}</b>
                <span className="grow manual-title" title={q.title}>{q.title}</span>
                {open && ms !== null && <span className={`mono num small${ms < 60_000 ? ' bad' : ''}`}>{formatClock(ms)}</span>}
                {open && ms === null && <span className="badge">Liberada</span>}
                {live && !open && <span className="badge danger">Tempo esgotado</span>}
                {clock?.withdrawn && <span className="badge">Retirada</span>}
              </div>
              <div className="row">
                {open ? (
                  <>
                    <Pill size="sm" tone="danger" onClick={() => room.withdrawQuestion(q.id)}>Retirar</Pill>
                    {ms !== null && <Pill size="sm" onClick={() => room.addQuestionTime(q.id, 1)}>+1 min</Pill>}
                  </>
                ) : (
                  <>
                    <input
                      className="input num manual-minutes"
                      type="number"
                      min={1}
                      aria-label={`Minutos da questão ${i + 1}`}
                      placeholder="min"
                      value={minutes[q.id] ?? ''}
                      onChange={(e) => setMinutes((m) => ({ ...m, [q.id]: e.target.value }))}
                    />
                    <Pill size="sm" tone="primary" disabled={!running || room.releasing.has(q.id)} title={running ? undefined : 'Comece a prova primeiro'} onClick={() => room.releaseQuestion(q.id, Number(minutes[q.id]) || undefined)}>
                      {room.releasing.has(q.id) ? 'Revelando' : 'Liberar'}
                    </Pill>
                    {live && <Pill size="sm" onClick={() => room.withdrawQuestion(q.id)}>Retirar</Pill>}
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---- conexão

// Vai projetado: o aluno compara com o que aparece na tela dele para notar alguém se passando pelo professor.
function TeacherCode({ room }: { room: Room }) {
  return (
    <div className="stack" style={{ gap: 0 }}>
      <span className="conn-label">Código do professor</span>
      <span className="conn-big">{room.fingerprint}</span>
    </div>
  )
}

function ConnectionCard({ room }: { room: Room }) {
  const [mode, setModeState] = useState<'hub' | 'rtc'>(room.bus?.kind ?? (prefersBrowser.has(room) ? 'rtc' : 'hub'))
  const setMode = (next: 'hub' | 'rtc') => {
    if (next === 'rtc') prefersBrowser.add(room)
    else prefersBrowser.delete(room)
    setModeState(next)
  }
  const [busy, setBusy] = useState(false)
  const [missing, setMissing] = useState(false)
  const [failed, setFailed] = useState(false)
  const state = room.busState
  const connecting = busy || state === 'connecting'

  // A reconexão sozinha mora em useRoomRuntime; aqui só some o aviso quando ela consegue.
  useEffect(() => {
    if (state === 'hub') setMissing(false)
  }, [state])

  const connect = async () => {
    setBusy(true)
    setFailed(false)
    setMissing(false)
    try {
      if (mode === 'hub') setMissing(!(await connectProgram(room)))
      else await room.useBrowser()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const lock = room.hasPassword && (
    <span className="conn-lock" role="img" aria-label="Sala com senha" title="Sala com senha">
      <Lock size={16} />
    </span>
  )

  if (state === 'hub') {
    return (
      <div className="card conn">
        <div className="row">
          <i className="dot on" />
          <h2 className="grow">Programa</h2>
          {lock}
        </div>
        {room.hubAddresses.length ? (
          <div className="stack" style={{ gap: 0 }}>
            <span className="conn-label">IP</span>
            {room.hubAddresses.map((ip) => (
              <span key={ip} className="conn-big">
                {ip}
              </span>
            ))}
          </div>
        ) : (
          <div className="errbox">Este computador não está em nenhuma rede local.</div>
        )}
        <TeacherCode room={room} />
      </div>
    )
  }

  if (state === 'rtc') {
    return (
      <div className="card conn">
        <div className="row">
          <i className="dot on" />
          <h2 className="grow">Só navegador</h2>
          {lock}
        </div>
        <div className="stack" style={{ gap: 0 }}>
          <span className="conn-label">Código</span>
          <span className="conn-big">{room.roomCode}</span>
        </div>
        <TeacherCode room={room} />
        <span className="small warn">Todos precisam entrar antes de cortar a rede, e um F5 sem internet não reconecta.</span>
      </div>
    )
  }

  return (
    <div className="card conn">
      <div className="row wrap">
        <h2 className="grow">Conexão</h2>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'hub', label: 'Programa' },
            { value: 'rtc', label: 'Só navegador' },
          ]}
        />
      </div>
      <TeacherCode room={room} />
      {state === 'down' && room.students.size > 0 && <div className="errbox">Conexão caiu. O trabalho dos alunos segue salvo neles.</div>}
      {failed && <div className="errbox">{mode === 'hub' ? 'O programa recusou o painel.' : 'Sem internet para abrir o código.'}</div>}
      {mode === 'hub' && (
        <div className="stack" style={{ gap: 0 }}>
          <span className="conn-label">IP para os alunos</span>
          <span className="muted">Abra o programa neste computador para ver</span>
        </div>
      )}
      {missing && <div className="errbox">Programa não encontrado neste computador.</div>}
      <div className="row wrap">
        <Pill tone="primary" disabled={connecting} onClick={() => void connect()}>
          {connecting && <Loader2 size={16} className="spin" />}
          {state === 'down' ? 'Reconectar' : missing ? 'Tentar de novo' : mode === 'hub' ? 'Conectar ao programa' : 'Abrir no navegador'}
        </Pill>
        {mode === 'hub' && (
          <a className="pill" href={HOST_URL} rel="noreferrer">
            <Download size={16} /> Baixar
          </a>
        )}
      </div>
    </div>
  )
}

// ---- onde a prova está sendo guardada

function StorageCard({ room }: { room: Room }) {
  const st = room.storage
  const onDisk = st.mode === 'disk'
  const where = onDisk && st.root ? `${st.root}${st.root.includes('\\') ? '\\' : '/'}${st.folder ?? ''}` : null
  return (
    <div className="card conn">
      <div className="row">
        <i className={`dot${st.error ? '' : ' on'}`} />
        <h2 className="grow">Gravação</h2>
        <HardDrive size={16} />
      </div>
      {where ? (
        <div className="stack" style={{ gap: 0 }}>
          <span className="conn-label">Pasta da prova, pelo programa</span>
          <span className="small mono" style={{ wordBreak: 'break-all' }}>{where}</span>
        </div>
      ) : (
        <span className="small muted">Neste navegador. No fim, use Exportar para baixar o zip.</span>
      )}
      {st.free !== null && <span className="small muted">{formatBytes(st.free)} livres</span>}
      {st.warning && <div className="errbox">{st.warning}</div>}
      {st.error && <div className="errbox">{st.error}</div>}
      {st.browserSegments > 0 && onDisk && <span className="small warn">{st.browserSegments} trecho(s) de gravação no navegador, esperando o disco voltar.</span>}
      {st.saved && (
        <span className="small" style={{ color: 'var(--status-success)' }}>
          <Check size={14} /> Tudo salvo em {st.saved}
        </span>
      )}
    </div>
  )
}

// ---- parede de telas

function issueOf(room: Room, s: Student) {
  if (!s.online || s.finishedAt) return null
  const st = s.status
  if (!st.screen) return 'sem tela'
  if (!st.fullscreen) return 'sem tela cheia'
  if (st.extended) return 'dois monitores'
  if (room.config.requireIsolation && st.isolated === false) return 'com internet'
  if (room.config.requireIsolation && st.isolated === null) return 'testando rede'
  return null
}

function Wall({ room, alarms }: { room: Room; alarms: ReadonlySet<string> }) {
  const students = [...room.students.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
  if (!students.length) {
    return (
      <div className="dash-wait">
        <div className="dash-ring" role="status" aria-label="Esperando alunos" />
      </div>
    )
  }
  const movable = room.phase !== 'ended' && room.config.mode === 'group'
  const list = (items: Student[]) => <TileList room={room} students={items} alarms={alarms} movable={movable} />
  if (room.config.mode !== 'group') return list(students)

  const known = new Set(room.config.groups.map((g) => g.id))
  const loose = students.filter((s) => !s.groupId || !known.has(s.groupId))
  return (
    <>
      {room.config.groups.map((g) => {
        const members = students.filter((s) => s.groupId === g.id)
        if (!members.length && room.phase !== 'lobby') return null
        return (
          <section key={g.id}>
            <div className="group-head">
              <span className="team-name">{g.name}</span>
              <span className="team-code" title="Código privado da equipe">
                {room.teamCode(g.id)}
              </span>
              <span className="muted small num">
                {members.length}/{room.config.maxTeamSize}
              </span>
            </div>
            <MemberChips room={room} members={members} />
            {list(members)}
          </section>
        )
      })}
      {loose.length > 0 && (
        <section>
          <div className="group-head">
            <span className="team-name">Sem equipe</span>
            <span className="muted small num">{loose.length}</span>
          </div>
          <MemberChips room={room} members={loose} />
          {list(loose)}
        </section>
      )}
    </>
  )
}

// Pedido explícito do dono: bater o olho e saber quem de cada equipe desfocou. Depois que a pessoa
// entrega ou a equipe encerra, sair da janela é normal e não gera alerta, então não fica vermelho.
function memberState(room: Room, s: Student): { label: string; lost: boolean } | null {
  if (!s.online) return { label: 'offline', lost: false }
  if (s.finishedAt) return { label: 'entregou', lost: false }
  if (room.phase === 'ended' || room.teams.get(room.teamKey(s))?.closed) return null
  if (!s.status.focused) return { label: 'desfocado', lost: true }
  if (s.signalLost) return { label: 'sem sinal', lost: true }
  return null
}

export function MemberChips({ room, members }: { room: Room; members: Student[] }) {
  if (!members.length) return null
  return (
    <div className="team-members">
      {members.map((s) => {
        const state = memberState(room, s)
        const dot = !s.online ? '' : state?.lost ? ' off' : ' on'
        return (
          <Link key={s.clientId} className={`member${state?.lost ? ' lost' : ''}`} to={studentPath(room.config.roomId, s.clientId)}>
            <i className={`dot${dot}`} />
            <span>{s.name}</span>
            {state && <b>{state.label}</b>}
          </Link>
        )
      })}
    </div>
  )
}

function TileList({ room, students, alarms, movable }: { room: Room; students: Student[]; alarms: ReadonlySet<string>; movable: boolean }) {
  // Só muda quando alguém entra ou sai da lista: é o que mantém 40 miniaturas sem medir layout a cada quadro.
  const order = students.map((s) => s.clientId).join()
  return (
    <div className="tiles">
      <AnimatePresence mode="popLayout" initial={false}>
        {students.map((s) => (
          <Tile
            key={s.clientId}
            room={room}
            clientId={s.clientId}
            name={s.name}
            thumb={room.thumbs.get(s.clientId)}
            online={s.online}
            signalLost={s.signalLost}
            alerts={s.alerts}
            beaconMissing={s.beaconOk === false}
            issue={issueOf(room, s)}
            finished={!!s.finishedAt}
            alarm={alarms.has(s.clientId)}
            order={order}
            // Quem já tem a prova carrega o documento da equipe antiga: trocar agora misturaria os dois.
            groups={movable && !s.examGranted && room.config.groups.length ? room.config.groups : undefined}
            groupId={s.groupId}
          />
        ))}
      </AnimatePresence>
    </div>
  )
}

interface TileProps {
  ref?: Ref<HTMLDivElement>
  room: Room
  clientId: string
  name: string
  thumb?: string
  online: boolean
  signalLost: boolean
  alerts: number
  beaconMissing: boolean
  issue: string | null
  finished: boolean
  alarm: boolean
  order: string
  groups?: Group[]
  groupId?: string
}

// Só primitivos nas props: o Student é mutado no lugar, então o memo compara os valores que aparecem.
const Tile = memo(function Tile({ ref, room, clientId, name, thumb, online, signalLost, alerts, beaconMissing, issue, finished, alarm, order, groups, groupId }: TileProps) {
  return (
    <motion.div
      ref={ref}
      className="tile-wrap"
      layout
      layoutDependency={order}
      initial={{ opacity: 0, scale: 0, filter: 'blur(8px)' }}
      animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
      exit={{ opacity: 0, scale: 0.6, filter: 'blur(8px)', transition: settle }}
      transition={pop}
    >
      <Link to={studentPath(room.config.roomId, clientId)} className={`tile${online ? '' : ' offline'}${alarm ? ' alarm' : ''}`}>
        {thumb ? <img src={thumb} alt="" draggable={false} decoding="async" /> : <Avatar name={name} />}
        <div className="tile-corner">
          {signalLost && (
            <span className="chip danger">
              <WifiOff size={11} /> sem sinal
            </span>
          )}
          {beaconMissing && (
            <span className="chip danger" title="A tela capturada não mostra a prova">
              <EyeOff size={11} /> selo ausente
            </span>
          )}
          {issue && <span className="chip">{issue}</span>}
          {finished && (
            <span className="chip">
              <Check size={11} /> entregou
            </span>
          )}
          {alerts > 0 && (
            <span className="chip danger num">
              <AlertTriangle size={11} /> {alerts}
            </span>
          )}
        </div>
        <div className="tile-tag">
          <i className={`dot ${online && !signalLost ? 'on' : 'off'}`} />
          <span>{name}</span>
        </div>
      </Link>
      {groups && (
        <Popover
          className="tile-move"
          label={`Equipe de ${name}`}
          title="Mover para a equipe"
          trigger={
            <>
              <span>{groups.find((g) => g.id === groupId)?.name ?? 'Equipe'}</span>
              <ChevronDown size={11} />
            </>
          }
        >
          {(close) =>
            groups.map((g) => (
              <PopoverRow
                key={g.id}
                label={g.name}
                checked={g.id === groupId}
                onSelect={() => {
                  room.moveToGroup(clientId, g.id)
                  close()
                }}
              />
            ))
          }
        </Popover>
      )}
    </motion.div>
  )
})

// ---- alertas

// `count` é a única coisa que invalida o memo: as miniaturas chegam muito mais rápido que os alertas.
const AlertFeed = memo(function AlertFeed({ room, count }: { room: Room; count: number }) {
  return (
    <div className="alert-feed">
      {room.alerts.slice(0, FEED_LIMIT).map((a, i) => (
        <Link key={`${a.id}:${count - i}`} className={`alert-item${a.severe ? ' severe' : ''}`} to={`${studentPath(room.config.roomId, a.clientId)}?t=${a.at}`}>
          {a.thumb ? <img src={a.thumb} alt="" draggable={false} decoding="async" /> : <span className="alert-noimg" />}
          <span className="alert-text">
            <b>{a.name}</b>
            <span className="kind">{alertLabel(a.kind)}</span>
            {a.detail && <span className="xs faint">{a.detail}</span>}
          </span>
          <time className="xs faint num">{hhmmss(a.at)}</time>
        </Link>
      ))}
    </div>
  )
})

// ---- notas

function teamRows(room: Room) {
  const rows = new Map<string, { team: Team; members: Student[] }>()
  for (const s of room.students.values()) {
    const team = room.teamOf(s)
    const row = rows.get(team.key)
    if (row) row.members.push(s)
    else rows.set(team.key, { team, members: [s] })
  }
  const label = (members: Student[]) => {
    const group = room.config.mode === 'group' && members[0].groupId
    return (group && room.config.groups.find((g) => g.id === group)?.name) || members[0].name
  }
  return [...rows.values()].map((r) => ({ ...r, label: label(r.members) })).sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'))
}

function GradeCell({ grade }: { grade?: Grade }) {
  if (!grade) return <span className="faint">–</span>
  if (grade.status === 'pending' || grade.status === 'running') return <Loader2 size={14} className="spin muted" aria-label="Corrigindo" />
  if (grade.status === 'manual' && !grade.graded) return <PenLine size={14} className="warn" aria-label="Falta corrigir" />
  return (
    <span className={`num${grade.status === 'compile-error' ? ' bad' : ''}`} title={grade.status === 'compile-error' ? 'Não compilou' : undefined}>
      {grade.points}
    </span>
  )
}

// Com tique próprio: a tabela não precisa refazer a cada miniatura que chega.
const ResultsTable = memo(function ResultsTable({ room }: { room: Room }) {
  useTick(1000)
  const nav = useNavigate()
  const rows = teamRows(room)
  if (!rows.length) {
    return (
      <div className="dash-wait">
        <div className="dash-ring" role="status" aria-label="Esperando alunos" />
      </div>
    )
  }
  return (
    <div className="card results-wrap">
      <table className="results">
        <thead>
          <tr>
            <th>{room.config.mode === 'group' ? 'Equipe' : 'Aluno'}</th>
            {room.exam.questions.map((q) => (
              <th key={q.id} title={q.title}>
                {q.id}
              </th>
            ))}
            <th>Total</th>
            <th>Alertas</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ team, members, label }) => {
            const score = room.scoreOf(team)
            const open = () => nav(studentPath(room.config.roomId, members[0].clientId))
            const manual = room.exam.questions.filter((q) => team.grades[q.id]?.status === 'manual' && !team.grades[q.id].graded).length
            const enrollment = room.config.mode !== 'group' ? members[0].enrollment : undefined
            return (
              <tr key={team.key} data-link tabIndex={0} onClick={open} onKeyDown={(e) => e.key === 'Enter' && open()}>
                <td>
                  {label}
                  {enrollment && <small>{enrollment}</small>}
                  {team.key.startsWith('g:') && <small>{members.map((m) => m.name).join(', ')}</small>}
                </td>
                {room.exam.questions.map((q) => (
                  <td key={q.id}>
                    <GradeCell grade={team.grades[q.id]} />
                  </td>
                ))}
                <td className="num">
                  <b>{score.earned}</b> / {score.total}
                </td>
                <td className={`num${members.some((m) => m.alerts) ? ' bad' : ''}`}>{members.reduce((n, m) => n + m.alerts, 0)}</td>
                <td>{manual > 0 && <span className="badge">Corrigir {manual}</span>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
})

// ---- exportar

function ExportModal({ room, open, onClose }: { room: Room; open: boolean; onClose: () => void }) {
  const streamable = canStreamToDisk()
  const [video, setVideo] = useState(streamable)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const exporting = progress !== null

  const run = async () => {
    setProgress({ done: 0, total: 1 })
    try {
      await exportRoomZip(room, { video: video && streamable, onProgress: (done, total) => setProgress({ done, total }) })
      toast.success('Exportado')
      onClose()
    } catch (err) {
      // Fechar o seletor de arquivo é só desistir.
      if ((err as Error).name !== 'AbortError') toast.error('Não foi possível exportar')
    } finally {
      setProgress(null)
    }
  }

  const csv = () => download(new Blob(['﻿' + room.resultsCsv() + '\n'], { type: 'text/csv;charset=utf-8' }), `${safeName(room.config.title)}.csv`)

  return (
    <Modal open={open} title="Exportar" onClose={() => !exporting && onClose()}>
      <div className={streamable ? undefined : 'dash-off'}>
        <Switch label="Incluir gravações" checked={video && streamable} onChange={setVideo} />
      </div>
      {!streamable && <span className="small warn">Este navegador não grava direto em disco, então o zip vai sem vídeo.</span>}
      {room.storage.mode === 'disk' && <span className="small muted">Com o programa, a pasta da prova já tem tudo, inclusive as gravações. O zip leva só o que ficou no navegador.</span>}
      {progress && (
        <div className="dash-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
          <i style={{ width: `${Math.min(100, (progress.done / Math.max(1, progress.total)) * 100)}%` }} />
        </div>
      )}
      <div className="row wrap">
        <Pill tone="primary" disabled={exporting} onClick={() => void run()}>
          {exporting && <Loader2 size={16} className="spin" />}
          Baixar zip
        </Pill>
        <Pill disabled={exporting} onClick={csv}>
          Baixar resumo CSV
        </Pill>
      </div>
    </Modal>
  )
}
