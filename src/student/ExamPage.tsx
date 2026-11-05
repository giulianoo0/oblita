import { ArrowRight, Check, Copy, Download, HardDrive, Lock, LoaderCircle, Maximize, MonitorOff, MonitorUp, RefreshCw, Send, WifiOff, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import type { ChoiceQuestion, Question, TextQuestion } from '../../shared/exam'
import { parseBody, receiptText } from '../../shared/receipt'
import { switchBuild, versionFix, type VersionFix } from '../lib/offline'
import { formatClock, useObservable } from '../lib/store'
import { parseAddress, servedByHost, type ConnectError } from '../net/link'
import { BuildVersion } from '../ui/BuildVersion'
import { DiaTextReveal } from '../ui/DiaTextReveal'
import { useHideSiteHeader } from '../ui/SiteHeader'
import { Field, Markdown, Modal, Pill, Segmented, browserIssue, useTick } from '../ui/kit'
// Importado direto, não sob demanda: o editor precisa já estar carregado antes de a internet ser cortada.
import { Beacon } from './Beacon'
import { BlockLayout, LayoutMenu, useBlockLayout } from './BlockLayout'
import { toggleCollapse } from './blocks'
import { CodeWorkspace, PeerDots, useInternalClipboard, usePeers } from './CodeWorkspace'
import { BLOCK_LIMITS, BLOCK_TITLES, CODE_LAYOUT, OTHER_LAYOUT, layoutKey } from './examLayout'
import './exam.css'
import { internalClipboard } from './proctor'
import { defaultStarter, studentSession as session } from './session'

// O Dia reveal do título dura 1500 ms; um respiro, e ele voa para o lugar dele no enunciado.
const TITLE_HOLD_MS = 1750
const MORPH_MS = 650

const CONNECT_ERROR: Record<ConnectError, string> = {
  'bad-address': 'Esse endereço não é válido. Confira o IP que o professor mostrou.',
  permission: 'O navegador bloqueou a rede local. Permita "Acesso à rede local" nas configurações do site e tente de novo.',
  unreachable: 'O computador do professor não respondeu. Confira o IP e se vocês estão na mesma rede.',
  'no-host': 'O professor ainda não abriu o painel da sala.',
  'no-room': 'Não existe sala com esse código.',
  'no-signal': 'Sem internet para usar o código da sala. Entre pelo IP do professor.',
  'lan-failed': 'Não deu para conectar direto ao computador do professor. Entre pelo IP dele.',
}

const REFUSED: Record<string, string> = {
  'password-required': 'Esta sala tem senha. Digite para entrar',
  password: 'Senha incorreta',
  identity: 'Esta vaga já está em uso por outro computador',
  version: 'Sua página está em outra versão que a do professor.',
  ended: 'Esta prova já terminou.',
  full: 'A sala está cheia',
}

const TEAM_ERROR: Record<string, string> = {
  code: 'Código não encontrado',
  full: 'Equipe cheia',
  started: 'Esta equipe já terminou',
  name: 'Dê um nome',
}

const durationLabel = (min: number) => {
  const h = Math.floor(min / 60)
  if (!h) return `${min} min`
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`
}

// O logotipo do kit é um link para o início, e sair desta página no meio da prova não pode ser um clique.
const Brand = () => (
  <span className="logo" aria-label="oblita">
    oblita<i>_</i>
  </span>
)

type Fix = 'extended' | 'screen' | 'fullscreen' | 'network'

// Na prova, a tela que caiu não bloqueia: vira um aviso fixo (ShareNotice). Antes dela, é obrigatória.
function nextFix(inExam = false): Fix | null {
  const st = session.status
  if (st.extended || session.extended()) return 'extended'
  if (!st.screen && !inExam) return 'screen'
  if (!st.fullscreen) return 'fullscreen'
  if (session.config?.requireIsolation && st.isolated !== true) return 'network'
  return null
}

let restoring: Promise<unknown> | null = null
// Trocar de versão recarrega a página de propósito: o aviso de sair não pode atrapalhar.
let leaving = false

export default function ExamPage() {
  const s = useObservable(session)
  const [booted, setBooted] = useState(false)

  useEffect(() => {
    // O StrictMode roda isto duas vezes, e restaurar duas vezes abriria duas conexões.
    restoring ??= s.saved ? Promise.resolve() : s.restore().catch(() => false)
    void restoring.then(() => setBooted(true))
  }, [s])

  const finished = !!s.saved?.finished
  const ready = s.ready
  useEffect(() => {
    if (ready && !finished) s.armProctor()
  }, [s, ready, finished])

  const guarding = !!s.saved?.exam && s.saved.active && (!finished || s.pendingUploads() > 0)
  useEffect(() => {
    if (!guarding) return
    const warn = (e: BeforeUnloadEvent) => {
      if (!leaving) e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [guarding])

  if (!booted) return null

  return (
    <>
      {s.warning && (
        <div className="toast-bar" role="alert">
          <span>{s.warning}</span>
          <button type="button" aria-label="Fechar aviso" onClick={() => s.dismissWarning()}>
            <X size={14} />
          </button>
        </div>
      )}
      <Stage />
    </>
  )
}

function Stage() {
  const s = session
  if (s.refused === 'impostor') return <ImpostorStep />
  if (s.refused || !s.saved) return <ConnectStep />
  if (s.saved.finished || s.phase === 'ended') return <DoneStep />
  if (s.exam) return <ExamRoom />
  if (!s.config) return s.resumed ? <ReconnectStep /> : <ConnectStep />
  return <SetupFlow />
}

function GateSteps({ current }: { current: number }) {
  const config = session.config
  const total = 4 + (config?.mode === 'group' ? 1 : 0) + (config?.requireIsolation ? 1 : 0)
  return (
    <div className="gate-steps" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={i <= current ? 'done' : ''} />
      ))}
    </div>
  )
}

// O último IP digitado neste computador: numa sala, quase sempre é o mesmo de novo.
function lastIp() {
  try {
    return localStorage.getItem('oblita-last-ip') ?? ''
  } catch {
    return ''
  }
}

// Entrar na prova em dois passos: onde é a prova (IP ou código), e quem é o aluno. A página inicial
// usa este mesmo formulário dentro do card, e `onJoined` leva para a prova quando o professor aceita.
export function JoinForm({ onJoined }: { onJoined?: () => void }) {
  const s = useObservable(session)
  const issue = browserIssue()
  const saved = s.saved
  const [params] = useSearchParams()
  const ipParam = params.get('ip')?.trim() ?? ''
  // Aberto pelo programa do professor já se sabe onde é a prova: sobra só o passo do nome.
  const hosted = servedByHost()
  const [mode, setMode] = useState<'ip' | 'code'>(!hosted && saved?.via.kind === 'rtc' ? 'code' : 'ip')
  const [address, setAddress] = useState(hosted ? location.host : saved?.via.kind === 'hub' ? saved.via.address : ipParam || lastIp())
  const [code, setCode] = useState(saved?.via.kind === 'rtc' ? saved.via.code : '')
  const [name, setName] = useState(saved?.name ?? '')
  const [enrollment, setEnrollment] = useState(saved?.enrollment ?? '')
  const [password, setPassword] = useState('')
  const [asked, setAsked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [badPlace, setBadPlace] = useState(false)
  // Quem já tem o lugar (voltou recusado, ou veio com o IP na URL) começa no segundo passo.
  const [step, setStep] = useState<0 | 1>(saved || ipParam || hosted ? 1 : 0)
  const [measure, height] = useHeight()

  // A sala é quem diz se tem senha. O campo fica depois de aparecer, senão some enquanto tenta de novo.
  if (!asked && (s.needsPassword || s.refused === 'password')) setAsked(true)

  const joined = !!s.config && !s.refused
  useEffect(() => {
    if (joined) onJoined?.()
  }, [joined, onJoined])

  const room = code.trim().toUpperCase()
  const place = mode === 'code' ? room : address.trim()
  const complete = !!name.trim() && !!place && (!asked || !!password)
  // Do clique até o professor responder há a conexão e o Argon2id, que leva um instante.
  const entering = busy || (!!saved && s.linkState === 'online' && !s.refused)

  const next = () => {
    if (!place) return
    if (mode === 'ip' && !parseAddress(place)) return setBadPlace(true)
    setStep(1)
  }

  // Precisa partir do clique: é ele que permite ao navegador perguntar sobre a rede local.
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (step === 0) return next()
    if (!complete || busy) return
    setBusy(true)
    try {
      if (mode === 'ip') {
        try {
          localStorage.setItem('oblita-last-ip', place)
        } catch {
          // O último IP é só conveniência.
        }
      }
      const via = mode === 'ip' ? ({ kind: 'hub', address: place } as const) : ({ kind: 'rtc', code: room } as const)
      await s.begin(via, mode === 'code' ? room : '', name, enrollment, undefined, password)
    } finally {
      setBusy(false)
    }
  }

  const error = s.refused ? (REFUSED[s.refused] ?? 'O professor recusou a conexão.') : s.connectError ? CONNECT_ERROR[s.connectError] : null
  const [switched] = useState(readSwitched)

  if (issue) return <div className="errbox" role="alert">{issue}</div>

  return (
    <form className="join" onSubmit={submit}>
      {!hosted && (
        <div className="join-progress" aria-hidden="true">
          <i className="done" />
          <i className={step === 1 ? 'done' : ''} />
        </div>
      )}
      <motion.div className="join-viewport" initial={false} animate={{ height }} transition={HEIGHT}>
      <div ref={measure}>
      <AnimatePresence mode="wait" initial={false}>
        {step === 0 ? (
          <motion.div key="place" className="join-step" {...STEP_MOTION}>
            <h2>Onde é a prova?</h2>
            <Segmented
              label="Como entrar"
              value={mode}
              onChange={(m) => {
                setMode(m)
                setBadPlace(false)
              }}
              options={[
                { value: 'ip', label: 'IP do professor' },
                { value: 'code', label: 'Código da sala' },
              ]}
            />
            <div className="join-inline">
              {mode === 'ip' ? (
                <input key="ip" className="input join-big mono" autoFocus inputMode="decimal" autoComplete="off" spellCheck={false} aria-label="IP do professor" aria-invalid={badPlace} placeholder="192.168.0.10" value={address} onChange={(e) => (setAddress(e.target.value), setBadPlace(false))} />
              ) : (
                <input key="code" className="input join-big mono" autoFocus autoComplete="off" spellCheck={false} aria-label="Código da sala" placeholder="ABC234" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
              )}
              <Pill type="submit" tone="primary" size="lg" disabled={!place} aria-label="Continuar">
                <ArrowRight size={18} />
              </Pill>
            </div>
            {badPlace && <div className="bad small" role="alert">Esse IP não parece certo. Confira no quadro.</div>}
          </motion.div>
        ) : (
          <motion.div key="who" className="join-step" {...STEP_MOTION}>
            {!hosted && (
              <button type="button" className="join-place" onClick={() => setStep(0)} disabled={entering} title="Trocar">
                <span className="mono">{place}</span>
                <span className="muted">trocar</span>
              </button>
            )}
            <h2>Quem é você?</h2>
            <div className="join-row">
              <input className="input join-big" autoFocus autoComplete="off" maxLength={60} aria-label="Nome" placeholder="Seu nome" value={name} onChange={(e) => setName(e.target.value)} />
              <input className="input join-big" autoComplete="off" maxLength={30} aria-label="Matrícula (opcional)" placeholder="Matrícula" value={enrollment} onChange={(e) => setEnrollment(e.target.value)} />
            </div>
            {asked && <input className="input join-big" type="password" autoFocus autoComplete="off" aria-label="Senha da sala" placeholder="Senha da sala" value={password} onChange={(e) => setPassword(e.target.value)} />}
            {switched && !error && <div className="infobox" role="status">Esta página voltou para a versão {switched}, a mesma do professor. Entre de novo.</div>}
            {error && <div className="errbox" role="alert">{error}</div>}
            {s.refused === 'version' && s.teacherProtocol !== null && <VersionFixBox protocol={s.teacherProtocol} auto />}
            <Pill type="submit" tone="primary" size="lg" disabled={!complete || busy}>
              {entering && <LoaderCircle size={16} className="spin" />}
              {entering ? 'Entrando…' : 'Entrar'}
            </Pill>
          </motion.div>
        )}
      </AnimatePresence>
      </div>
      </motion.div>
    </form>
  )
}

// A troca de passo é um fade no lugar, e a caixa acompanha a altura do passo novo.
const STEP_MOTION = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.16, 1, 0.3, 1] } },
  exit: { opacity: 0, transition: { duration: 0.1 } },
} as const
const HEIGHT = { type: 'spring', bounce: 0, duration: 0.38 } as const

// Altura do conteúdo, para animar a caixa até ela. 'auto' até a primeira medida, então nada pula ao abrir.
function useHeight() {
  const [height, setHeight] = useState<number | 'auto'>('auto')
  const ro = useRef<ResizeObserver | null>(null)
  const measure = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect()
    if (!el) return
    ro.current = new ResizeObserver(([entry]) => setHeight(entry.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight))
    ro.current.observe(el)
  }, [])
  return [measure, height] as const
}

function ConnectStep() {
  return (
    <div className="center-screen">
      <div className="gate">
        <JoinForm />
      </div>
    </div>
  )
}

function readSwitched() {
  try {
    const raw = sessionStorage.getItem('oblita-switched')
    sessionStorage.removeItem('oblita-switched')
    return raw ? (JSON.parse(raw).to as string) : null
  } catch {
    return null
  }
}

// O professor fala outro protocolo. Se houver em cache uma versão que fale o dele, a página passa a
// usá-la (sozinha antes da prova; com um clique durante ela, porque recarrega). Senão, diz quem atualiza.
function VersionFixBox({ protocol, auto }: { protocol: number; auto?: boolean }) {
  const [fix, setFix] = useState<VersionFix | null>(null)
  const [switching, setSwitching] = useState(false)
  useEffect(() => {
    let alive = true
    void versionFix(protocol).then((f) => {
      if (!alive) return
      setFix(f)
      if (auto && f.kind === 'switch') go(f)
    })
    return () => {
      alive = false
    }
  }, [protocol, auto])
  const go = (f: VersionFix) => {
    if (f.kind !== 'switch') return
    setSwitching(true)
    leaving = true
    void switchBuild(f.build).then((ok) => {
      if (ok) return
      leaving = false
      setSwitching(false)
    })
  }
  if (!fix) return null
  if (fix.kind === 'update') return <div className="infobox">O professor está numa versão mais nova. Abra esta página com internet uma vez para atualizar.</div>
  if (fix.kind === 'teacher-old') return <div className="infobox">O professor está numa versão mais antiga, que esta página não tem guardada. Peça para ele atualizar o painel.</div>
  return (
    <div className="infobox row">
      <span className="grow">{switching ? `Trocando para a versão ${fix.build.build}…` : `Há uma versão guardada que fala com o professor: ${fix.build.build}.`}</span>
      {!switching && (
        <Pill size="sm" tone="primary" onClick={() => go(fix)}>
          <RefreshCw size={14} /> Usar
        </Pill>
      )}
    </div>
  )
}

// Outra chave respondendo pelo professor: tentar de novo daqui entregaria a prova a quem está no meio.
function ImpostorStep() {
  const navigate = useNavigate()
  const leave = async () => {
    await session.clear()
    navigate('/')
  }
  return (
    <div className="center-screen">
      <div className="gate" role="alertdialog" aria-modal="true" aria-label="Identidade do professor">
        <Brand />
        <div className="errbox" role="alert">A identidade do professor mudou. Chame o professor antes de continuar.</div>
        <Pill size="lg" onClick={() => void leave()}>Voltar ao início</Pill>
      </div>
    </div>
  )
}

function TeacherCode() {
  const fp = session.teacherFp
  if (!fp) return null
  return (
    <div className="fp-card">
      <span className="small muted">Código do professor</span>
      <code className="fp-code">{fp}</code>
      <span className="small muted">Confira com o código no quadro. Se for diferente, chame o professor.</span>
    </div>
  )
}

function ReconnectStep() {
  const s = session
  return (
    <div className="center-screen">
      <div className="gate">
        <Brand />
        <h1>Reconectando ao professor</h1>
        {s.connectError && <div className="errbox" role="alert">{CONNECT_ERROR[s.connectError]}</div>}
        <Pill onClick={() => void s.clear()}>Entrar em outra sala</Pill>
      </div>
    </div>
  )
}

function LinkChip({ inline }: { inline?: boolean }) {
  const state = session.linkState
  if (state === 'online') return null
  return (
    <span className={inline ? 'badge' : 'badge link-chip'} role="status">
      <WifiOff size={12} /> Reconectando
    </span>
  )
}

function SetupFlow() {
  useTick(1000)
  const s = session
  const config = s.config!
  const grouped = config.mode === 'group'
  const needsTeam = grouped && !s.team
  const fix = needsTeam ? null : nextFix()

  const base = 1 + (grouped ? 1 : 0)
  let step = needsTeam ? 1 : base
  if (fix === 'fullscreen') step = base + 1
  else if (fix === 'network') step = base + 2
  else if (!fix && !needsTeam) step = base + 2 + (config.requireIsolation ? 1 : 0)

  return (
    <div className="center-screen">
      <LinkChip />
      <div className="gate" key={fix ?? (needsTeam ? 'team' : 'wait')}>
        <Brand />
        <GateSteps current={step} />
        {grouped && s.team && <TeamCard />}
        {needsTeam ? <TeamStep /> : fix ? <FixStep fix={fix} /> : <WaitStep />}
      </div>
    </div>
  )
}

function TeamStep() {
  const s = session
  const [mode, setMode] = useState<'create' | 'join'>('create')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const error = s.teamError

  useEffect(() => {
    if (error) setBusy(false)
  }, [error])

  useEffect(() => {
    if (!busy) return
    // Se a resposta não vier, o botão volta para o aluno tentar de novo.
    const t = setTimeout(() => setBusy(false), 5000)
    return () => clearTimeout(t)
  }, [busy])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    if (mode === 'create') s.createTeam(name.trim())
    else s.joinTeam(code.trim())
  }

  return (
    <form className="stack" style={{ gap: '1rem' }} onSubmit={submit}>
      <h1>Sua equipe</h1>
      <p className="muted small gate-lead">
        {s.config?.maxTeamSize ? `Equipes de até ${s.config.maxTeamSize} pessoas. ` : ''}Uma pessoa cria e passa o código; os colegas entram com ele.
      </p>
      <Segmented
        stretch
        label="Criar ou entrar"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'create', label: 'Criar equipe' },
          { value: 'join', label: 'Entrar com código' },
        ]}
      />
      {mode === 'create' ? (
        <Field label="Nome da equipe" hint="Você recebe um código para passar aos colegas.">
          <input className="input" autoFocus autoComplete="off" maxLength={40} placeholder="Os Ponteiros" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      ) : (
        <Field label="Código da equipe" hint="Peça para quem criou a equipe.">
          <input data-paste-ok className="input mono team-code-input" autoFocus autoComplete="off" spellCheck={false} maxLength={12} placeholder="K7QX2M" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </Field>
      )}
      {error && <div className="errbox" role="alert">{TEAM_ERROR[error] ?? 'Não deu certo. Tente de novo'}</div>}
      <Pill type="submit" tone="primary" size="lg" disabled={busy || (mode === 'join' && !code.trim())}>
        {busy && <LoaderCircle size={16} className="spin" />}
        {mode === 'create' ? 'Criar' : 'Entrar'}
      </Pill>
    </form>
  )
}

function TeamMembers() {
  return (
    <>
      {session.team?.members.map((m) => (
        <span key={m.clientId} className="member" title={m.name}>
          <i className={m.focused ? 'dot on' : 'dot'} />
          <span>{m.name}</span>
        </span>
      ))}
    </>
  )
}

function TeamCard() {
  const s = session
  const team = s.team!
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  const copy = async () => {
    // O vigia já pode estar armado na sala de espera, e colar isto aqui não é colar de fora.
    internalClipboard.value = team.code
    await navigator.clipboard.writeText(team.code)
    setCopied(true)
  }

  return (
    <div className="team-card">
      <div className="row">
        <b className="grow team-name" title={team.name}>{team.name}</b>
        <span className="small muted num">{team.members.length}/{team.max}</span>
      </div>
      <div className="row">
        <code className="team-code grow">{team.code}</code>
        <Pill icon aria-label="Copiar código" title="Copiar código" onClick={() => void copy().catch(() => {})}>
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </Pill>
      </div>
      <span className="small muted">Passe este código para os colegas entrarem.</span>
      <div className="team-members">
        <TeamMembers />
      </div>
      <Pill size="sm" className="team-leave" onClick={() => s.leaveTeam()}>Sair da equipe</Pill>
    </div>
  )
}

function FixStep({ fix, again }: { fix: Fix; again?: boolean }) {
  const s = session
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (fix !== 'network') return
    const check = () => void s.checkNetwork()
    check()
    const t = setInterval(check, 3000)
    return () => clearInterval(t)
  }, [fix, s])

  if (fix === 'extended') {
    return (
      <>
        <h1>Desconecte o segundo monitor</h1>
        <div className="errbox" role="alert">A prova só continua com um monitor ligado.</div>
      </>
    )
  }

  if (fix === 'screen') {
    const share = async () => {
      setBusy(true)
      try {
        await s.shareScreen()
      } finally {
        setBusy(false)
      }
    }
    return (
      <>
        <h1>{again ? 'A tela parou de ser compartilhada' : 'Compartilhe a tela inteira'}</h1>
        {s.screenError === 'unsupported' && <div className="errbox" role="alert">Use Chrome ou Edge atualizado neste computador.</div>}
        {s.screenError && s.screenError !== 'unsupported' && <div className="errbox" role="alert">Escolha "Tela inteira" e compartilhe de novo.</div>}
        <Pill tone="primary" size="lg" disabled={busy} onClick={() => void share()}>
          <MonitorUp size={16} /> Compartilhar tela
        </Pill>
      </>
    )
  }

  if (fix === 'fullscreen') {
    // Clique separado: o de compartilhar a tela já gastou a permissão que o navegador dá por clique.
    const enter = () => {
      setFailed(false)
      s.goFullscreen().catch(() => setFailed(true))
    }
    return (
      <>
        <h1>{again ? 'Você saiu da tela cheia' : 'Entre em tela cheia'}</h1>
        {failed && <div className="errbox" role="alert">O navegador não abriu a tela cheia. Clique de novo.</div>}
        <Pill tone="primary" size="lg" onClick={enter}>
          <Maximize size={16} /> Entrar em tela cheia
        </Pill>
      </>
    )
  }

  return (
    <>
      <h1>{again ? 'A internet voltou' : 'Bloqueie a internet'}</h1>
      <p>A internet precisa ficar bloqueada, e a rede do professor, ligada.</p>
      <div className="row muted small" role="status">
        <LoaderCircle size={14} className="spin" /> Verificando
      </div>
    </>
  )
}

function WaitStep() {
  const s = session
  const config = s.config!
  const [clocking, setClocking] = useState(false)

  useEffect(() => {
    if (!clocking) return
    // Se a resposta não vier, o botão volta para o aluno tentar de novo.
    const t = setTimeout(() => setClocking(false), 5000)
    return () => clearTimeout(t)
  }, [clocking])

  if (s.phase === 'running' && config.timing === 'clock-in') {
    return (
      <>
        <h1>{config.title}</h1>
        <div className="clock-duration">{durationLabel(config.durationMin)}</div>
        <TeacherCode />
        <Pill
          tone="brand"
          size="lg"
          className="clock-in"
          disabled={clocking}
          onClick={() => {
            setClocking(true)
            s.clockIn()
          }}
        >
          {clocking && <LoaderCircle size={18} className="spin" />}
          {config.mode === 'group' ? 'Começar com a equipe' : 'Bater ponto e começar'}
        </Pill>
      </>
    )
  }

  return (
    <>
      <div className="breathing" aria-hidden="true" />
      <h1 style={{ textAlign: 'center' }}>Aguardando o professor começar</h1>
      <div className="muted" style={{ textAlign: 'center' }}>{config.title}</div>
      <TeacherCode />
    </>
  )
}

function Clock({ questionId }: { questionId?: string }) {
  useTick(500)
  const manual = session.config?.flow === 'manual'
  const ms = manual ? (questionId ? session.questionRemaining(questionId) : null) : session.remaining()
  // No manual, questão sem tempo definido não tem relógio nenhum para mostrar.
  if (manual && ms === null) return null
  const low = ms !== null && ms < 5 * 60_000
  return <span className={low ? 'exam-clock low' : 'exam-clock'} role="timer">{ms === null ? '--:--' : formatClock(ms)}</span>
}

function SaveState() {
  const at = session.savedAt
  if (!at) return null
  return (
    <span className="row small muted" title={`Salvo às ${new Date(at).toLocaleTimeString('pt-BR')}`}>
      <Check size={14} /> Salvo
    </span>
  )
}

// Código nasce com o que o professor semeou; só conta como respondido quando sai disso.
function answered(q: Question) {
  const answer = session.answerOf(q.id)
  if (!answer) return false
  if (answer.type === 'choice') return answer.selected.length > 0
  if (answer.type === 'text') return !!answer.text
  if (q.type !== 'code') return false
  const starter = (q.starter?.[answer.lang] ?? defaultStarter(answer.lang)).replace(/\r\n?/g, '\n')
  const names = Object.keys(answer.files)
  return names.length !== 1 || answer.files[names[0]] !== starter
}

function ExamRoom() {
  const s = session
  useHideSiteHeader()
  const exam = s.exam!
  const [questionId, setQuestionId] = useState(exam.questions[0]?.id)
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  const question = exam.questions.find((q) => q.id === questionId) ?? exam.questions[0]
  const manual = s.config?.flow === 'manual'
  const peers = usePeers(s.awareness)
  // Questão de código publica o arquivo pelo editor; as outras só dizem a questão.
  const questionKey = question?.id
  const codeQuestion = question?.type === 'code'
  useEffect(() => {
    if (questionKey && !codeQuestion) s.awareness.setLocalStateField('where', { q: questionKey, file: null })
  }, [s, questionKey, codeQuestion])
  useInternalClipboard()
  // A edição fecha sozinha quando o tempo da questão acaba, sem esperar mensagem nenhuma.
  useTick(manual ? 1000 : 3_600_000)

  // A revelação fica guardada por questão: o enunciado só varre uma vez, e ao chegar.
  const [revealing, setRevealing] = useState<Question | null>(null)
  const [revealedId, setRevealedId] = useState<string | null>(null)
  const seen = useRef(new Set(exam.questions.map((q) => q.id)))
  useEffect(() => {
    if (!manual) return
    const now = new Set(exam.questions.map((q) => q.id))
    const fresh = exam.questions.find((q) => !seen.current.has(q.id))
    if ([...seen.current].some((id) => !now.has(id))) toast('O professor retirou uma questão')
    seen.current = now
    if (!fresh) return
    setQuestionId(fresh.id)
    setRevealedId(fresh.id)
    setRevealing(fresh)
  }, [exam, manual])

  // Cada prova guarda um layout para questões de código e outro para as demais.
  const kind = codeQuestion ? 'code' : 'other'
  const blocks = useBlockLayout(layoutKey(s.saved?.roomCode ?? 'sala', kind), kind === 'code' ? CODE_LAYOUT : OTHER_LAYOUT)
  // O título revelado voa até o enunciado: ele precisa estar aberto para ter onde pousar.
  const statementClosed = blocks.layout.collapsed.includes('statement')
  useEffect(() => {
    if (revealing && statementClosed) blocks.apply(toggleCollapse(blocks.layout, 'statement'))
  }, [revealing, statementClosed, blocks])

  const statement = question && (
    <>
      <Statement question={question} reveal={!revealing && revealedId === question.id} landing={revealing?.id === question.id} />
      {s.handed.has(question.id) ? (
        <div className="badge" style={{ margin: '0 1.125rem 0.75rem', alignSelf: 'flex-start' }}>
          <Check size={12} /> Entregue
        </div>
      ) : (
        !s.questionOpen(question.id) && <div className="badge danger" style={{ margin: '0 1.125rem 0.75rem', alignSelf: 'flex-start' }}>Tempo esgotado</div>
      )}
      {s.config?.mode === 'group' && <GroupBar />}
    </>
  )

  const locked = !!nextFix(true)
  const hand = async () => {
    setSending(true)
    try {
      if (manual && question) await s.handQuestion(question.id)
      else await s.finish()
    } finally {
      setSending(false)
      setConfirming(false)
    }
  }

  return (
    <>
      <div className="exam" inert={locked}>
        <header className="exam-top">
          <Brand />
          <span className="exam-title" title={exam.title}>{exam.title}</span>
          <LinkChip inline />
          <i className={s.linkState === 'online' ? 'dot on' : 'dot off'} title={s.linkState === 'online' ? 'Conectado ao professor' : 'Sem conexão com o professor'} />
          {s.teacherFp && <span className="badge fp-chip" title="Código do professor" aria-label={`Código do professor: ${s.teacherFp}`}>{s.teacherFp}</span>}
          <SaveState />
          <BuildVersion />
          <Clock questionId={question?.id} />
          {question && (
            <Pill tone="brand" disabled={manual && !s.questionOpen(question.id)} onClick={() => setConfirming(true)}>
              <Send size={16} /> {manual ? 'Entregar questão' : 'Entregar'}
            </Pill>
          )}
        </header>
        {!question && (
          <div className="center-screen">
            <div className="gate">
              <div className="breathing" aria-hidden="true" />
              <h1 style={{ textAlign: 'center' }}>Aguardando o professor liberar uma questão</h1>
            </div>
          </div>
        )}
        {question && <div className="exam-body">
          {/* As abas ficam fora dos blocos: com o enunciado recolhido, ainda dá para trocar de questão. */}
          <div className="exam-bar">
            <div className="exam-tabs" role="tablist" aria-label="Questões">
              {exam.questions.map((q, i) => (
                <button key={q.id} type="button" className="exam-tab" role="tab" aria-selected={q.id === question.id} title={q.title} onClick={() => setQuestionId(q.id)}>
                  {i + 1}
                  {answered(q) && <i className="dot" />}
                  <PeerDots peers={peers.filter((p) => p.q === q.id)} />
                </button>
              ))}
            </div>
            <LayoutMenu api={blocks} titles={BLOCK_TITLES} />
          </div>
          {question.type === 'code' ? (
            <CodeWorkspace question={question} layout={blocks} statement={statement} />
          ) : (
            <BlockLayout
              api={blocks}
              limits={BLOCK_LIMITS}
              blocks={[
                { id: 'statement', title: BLOCK_TITLES.statement, body: statement },
                { id: 'answer', title: BLOCK_TITLES.answer, body: question.type === 'choice' ? <ChoiceAnswer question={question} /> : <TextAnswer question={question} /> },
              ]}
            />
          )}
        </div>}
      </div>
      <Modal open={confirming} title={`${manual ? 'Entregar esta questão' : 'Entregar a prova'}${s.config?.mode === 'group' ? ' pela equipe toda' : ''}?`} onClose={() => setConfirming(false)}>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Pill onClick={() => setConfirming(false)}>Continuar a prova</Pill>
          <Pill tone="brand" disabled={sending} onClick={() => void hand()}>
            {sending && <LoaderCircle size={16} className="spin" />}
            Entregar
          </Pill>
        </div>
      </Modal>
      <ExamNotices />
      {manual && <RevealOverlay question={revealing} onDone={() => setRevealing(null)} />}
      {locked && <LockOverlay />}
      {/* Fora de .exam: ela some enquanto a prova está bloqueada, e o selo precisa continuar na tela. */}
      <Beacon code={s.beaconCode} />
    </>
  )
}

// Quem está de fora da contagem (chegou depois) não vê nada disto: a questão só aparece.
function RevealOverlay({ question, onDone }: { question: Question | null; onDone: () => void }) {
  useTick(100)
  const left = Math.ceil((session.countdownEnds - performance.now()) / 1000)
  if (left > 0) {
    return (
      <div className="reveal-overlay" role="timer" aria-live="polite" aria-label={`Começa em ${left}`}>
        <RollingDigit value={String(left)} />
      </div>
    )
  }
  if (!question) return null
  return <RevealTitle key={question.id} question={question} onDone={onDone} />
}

// O mesmo dígito da tela de manutenção do juntos: o novo sobe de baixo com mola, o velho sai para cima.
function RollingDigit({ value }: { value: string }) {
  const [shown, setShown] = useState([{ value, key: 0, out: false }])
  const last = shown[shown.length - 1]
  if (last.value !== value) setShown([...shown.filter((d) => !d.out).map((d) => ({ ...d, out: true })), { value, key: last.key + 1, out: false }])
  return (
    <div className="roll-digit" aria-hidden="true">
      {shown.map((d) => (
        <span key={d.key} className={d.out ? 'out' : d.key ? 'in' : undefined} onAnimationEnd={d.out ? () => setShown((list) => list.filter((x) => x.key !== d.key)) : undefined}>
          {d.value}
        </span>
      ))}
    </div>
  )
}

// O título nasce grande no centro com o Dia reveal e, ao terminar, voa e encolhe até o título do enunciado.
function RevealTitle({ question, onDone }: { question: Question; onDone: () => void }) {
  const title = useRef<HTMLHeadingElement>(null)
  const [morph, setMorph] = useState<{ x: number; y: number; scale: number } | null>(null)
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    const hold = setTimeout(() => {
      const from = title.current?.getBoundingClientRect()
      const to = document.querySelector('.exam-statement h2')?.getBoundingClientRect()
      if (!from || !to || !from.width) return done.current()
      const fromSize = parseFloat(getComputedStyle(title.current!).fontSize)
      const toSize = parseFloat(getComputedStyle(document.querySelector('.exam-statement h2')!).fontSize)
      setMorph({ x: to.left - from.left, y: to.top - from.top, scale: toSize / fromSize })
    }, TITLE_HOLD_MS)
    const end = setTimeout(() => done.current(), TITLE_HOLD_MS + MORPH_MS)
    return () => {
      clearTimeout(hold)
      clearTimeout(end)
    }
  }, [])
  return (
    <div className={`reveal-overlay${morph ? ' leaving' : ''}`}>
      <h1
        ref={title}
        className="reveal-title"
        style={morph ? { transform: `translate(${morph.x}px, ${morph.y}px) scale(${morph.scale})` } : undefined}
      >
        <DiaTextReveal text={question.title} />
      </h1>
    </div>
  )
}

// `landing`: o título ainda está voando da revelação até aqui, e só aparece quando chega.
function Statement({ question, reveal, landing }: { question: Question; reveal?: boolean; landing?: boolean }) {
  return (
    <div className="exam-statement" role="tabpanel">
      <h2 style={landing ? { visibility: 'hidden' } : undefined}>{question.title}</h2>
      <div className="small muted">{question.points === 1 ? '1 ponto' : `${question.points} pontos`}</div>
      <Markdown key={`${question.id}-${reveal ? 'r' : 'n'}`} text={question.statement} reveal={reveal} />
      {question.type === 'code' &&
        question.samples?.map((sample, i) => (
          <div key={i} className="sample">
            <div className="small muted">Exemplo {i + 1}: entrada</div>
            <pre>{sample.stdin}</pre>
            <div className="small muted" style={{ marginTop: '0.375rem' }}>Exemplo {i + 1}: saída</div>
            <pre>{sample.stdout}</pre>
          </div>
        ))}
    </div>
  )
}

function GroupBar() {
  const team = session.team
  if (!team) return null
  return (
    <div className="exam-group">
      <b>{team.name}</b>
      <TeamMembers />
    </div>
  )
}

function ChoiceAnswer({ question }: { question: ChoiceQuestion }) {
  const s = session
  const answer = s.answerOf(question.id)
  const selected = answer?.type === 'choice' ? answer.selected : []
  const toggle = (id: string) => {
    const next = question.multiple ? (selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]) : [id]
    s.setAnswer(question.id, { type: 'choice', selected: next })
  }
  return (
    <div className="answer-area" role={question.multiple ? 'group' : 'radiogroup'} aria-label="Opções" inert={!s.questionOpen(question.id)}>
      {question.options.map((option) => (
        <button key={option.id} type="button" className="option" role={question.multiple ? 'checkbox' : 'radio'} aria-checked={selected.includes(option.id)} onClick={() => toggle(option.id)}>
          <i />
          <span>{option.text}</span>
        </button>
      ))}
    </div>
  )
}

function TextAnswer({ question }: { question: TextQuestion }) {
  const s = session
  const answer = s.answerOf(question.id)
  return (
    <div className="answer-area">
      <textarea className="input" aria-label="Sua resposta" spellCheck={false} readOnly={!s.questionOpen(question.id)} value={answer?.type === 'text' ? answer.text : ''} onChange={(e) => s.setAnswer(question.id, { type: 'text', text: e.target.value })} />
    </div>
  )
}

// Avisos que não travam nada: a prova segue editável por baixo deles.
function ExamNotices() {
  const s = session
  const [busy, setBusy] = useState(false)
  const share = async () => {
    setBusy(true)
    try {
      await s.shareScreen()
    } finally {
      setBusy(false)
    }
  }
  const items = []
  if (!s.status.screen) {
    items.push(
      <div key="screen" className="exam-notice" role="alert">
        <MonitorOff size={16} />
        <span className="grow">{s.screenError ? 'Escolha "Tela inteira" e compartilhe de novo.' : 'A tela parou de ser compartilhada. O professor foi avisado.'}</span>
        <Pill size="sm" tone="primary" disabled={busy} onClick={() => void share()}>
          <MonitorUp size={14} /> Compartilhar de novo
        </Pill>
      </div>,
    )
  }
  if (s.diskError) {
    items.push(
      <div key="disk" className="exam-notice" role="alert">
        <HardDrive size={16} />
        <span className="grow">O disco deste computador não está gravando. A prova continua, mas não recarregue a página.</span>
      </div>,
    )
  }
  if (s.teacherProtocol !== null) {
    items.push(
      <div key="version" className="exam-notice" role="alert">
        <span className="grow">O professor mudou de versão e esta página não conecta mais com ele.</span>
        <VersionFixBox protocol={s.teacherProtocol} />
      </div>,
    )
  }
  if (!items.length) return null
  return <div className="exam-notices">{items}</div>
}

function LockOverlay() {
  useTick(1000)
  const fix = nextFix(true)
  return (
    <div className="lock-screen" role="alertdialog" aria-modal="true" aria-label="Prova bloqueada">
      <div className="gate" key={fix ?? 'none'}>
        <span className="badge danger" style={{ alignSelf: 'flex-start' }}>
          <Lock size={12} /> Prova bloqueada
        </span>
        {fix ? <FixStep fix={fix} again /> : <h1>Aguarde um instante</h1>}
      </div>
    </div>
  )
}

function DeliveryReceipt() {
  const s = session
  const receipt = s.saved?.receipt
  const fp = s.teacherFp
  if (s.receiptInvalid) return <div className="errbox" role="alert">O comprovante recebido não tem a assinatura do professor. Avise o professor.</div>
  if (!receipt || !fp) {
    return (
      <p className="row muted" style={{ gap: '0.5rem' }}>
        <LoaderCircle size={16} className="spin" /> Esperando o comprovante do professor…
      </p>
    )
  }
  const body = parseBody(receipt)
  const differs = s.saved?.receiptDiff ?? []
  const save = () => {
    const url = URL.createObjectURL(new Blob([receiptText(receipt, fp)], { type: 'text/plain;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `comprovante-${body.id}.txt`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 30000)
  }
  return (
    <div className="receipt" aria-label="Comprovante de entrega">
      <span className="conn-label">ID da entrega</span>
      <b className="receipt-id mono">{body.id}</b>
      <span className="conn-label">Checksum (SHA-256)</span>
      <span className="receipt-hash mono small">{body.checksum}</span>
      <span className="small muted">
        Recebido em {new Date(body.at).toLocaleString('pt-BR')}, assinado pelo código do professor <span className="mono">{fp}</span>.
      </span>
      {differs.length > 0 && (
        <div className="errbox" role="alert">
          O que o professor recebeu em {differs.join(', ')} é diferente do que está nesta tela. Avise o professor agora.
        </div>
      )}
      {body.team && <span className="small muted">Se a equipe mudar algo até o fim da prova, um novo comprovante substitui este.</span>}
      <Pill onClick={save}>
        <Download size={16} /> Baixar comprovante
      </Pill>
      <span className="small muted">Baixe ou anote antes de sair: é a sua prova de que entregou.</span>
    </div>
  )
}

function DoneStep() {
  useTick(1000)
  const s = session
  const navigate = useNavigate()
  const pending = s.pendingUploads()
  const [canLeave, setCanLeave] = useState(false)

  // O último pedaço da gravação chega um pouco depois de parar: um zero passageiro não libera a saída.
  useEffect(() => {
    if (pending > 0) return setCanLeave(false)
    const t = setTimeout(() => setCanLeave(true), 2000)
    return () => clearTimeout(t)
  }, [pending])

  const leave = async () => {
    await s.clear()
    navigate('/')
  }

  return (
    <div className="center-screen">
      <LinkChip />
      <div className="gate">
        <Brand />
        {canLeave ? (
          <>
            <h1>Prova entregue</h1>
            <DeliveryReceipt />
            <Pill tone="primary" size="lg" onClick={() => void leave()}>
              Sair
            </Pill>
          </>
        ) : (
          <>
            <h1 className="num">Enviando {pending}</h1>
            <p>Não feche esta página até chegar a zero.</p>
            <DeliveryReceipt />
          </>
        )}
      </div>
    </div>
  )
}
