import { ArrowLeft, Check, Circle, Loader2, Send, ShieldAlert, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import type { Question, Solution } from '../../shared/exam'
import type { Answer } from '../../shared/protocol'
import { parseBody } from '../../shared/receipt'
import { formatClock, useObservable } from '../lib/store'
import { Avatar, Logo, Pill, Segmented, useTick } from '../ui/kit'
import { MemberChips, RoomGate, RoomMissing, hhmmss, useRoom, useRoomRuntime } from './Dashboard'
import { alertLabel } from './exportZip'
import Player from './Player'
import type { Grade, Room, Student, Team, TestResult } from './room'
import './dash.css'

const ALERT_LIMIT = 200

export default function StudentDetail() {
  const { roomId = '', clientId = '' } = useParams()
  const room = useRoom(roomId)
  if (room === undefined) return null
  if (!room) return <RoomMissing />
  return (
    <RoomGate room={room}>
      <Detail key={clientId} room={room} clientId={clientId} />
    </RoomGate>
  )
}

function Detail({ room, clientId }: { room: Room; clientId: string }) {
  useObservable(room)
  useRoomRuntime(room)
  const [params] = useSearchParams()
  const [seek, setSeek] = useState<{ at: number } | null>(() => {
    const t = Number(params.get('t'))
    return params.has('t') && Number.isFinite(t) ? { at: t } : null
  })
  const [view, setView] = useState<'live' | 'rec'>(seek ? 'rec' : 'live')

  // Pede ao aluno os quadros maiores só enquanto alguém olha para ele.
  useEffect(() => {
    room.setFocus(clientId)
    return () => room.setFocus(null)
  }, [room, clientId])

  const alertCount = room.alerts.length
  const alerts = useMemo(() => room.alerts.filter((a) => a.clientId === clientId), [room, clientId, alertCount])

  const student = room.students.get(clientId)
  const back = `/sala/${encodeURIComponent(room.config.roomId)}`
  if (!student) {
    return (
      <div className="center-screen">
        <div className="gate">
          <h1>Aluno não encontrado</h1>
          <div>
            <Link className="pill" to={back}>
              Voltar à sala
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const team = room.teamOf(student)
  const frame = room.liveFrame.get(clientId) ?? room.thumbs.get(clientId)

  return (
    <div>
      <header className="dash-top">
        <Link className="pill icon" to={back} aria-label="Voltar à sala">
          <ArrowLeft size={16} />
        </Link>
        <Logo size={1.25} />
        <span className="dash-title">{student.name}</span>
        <StudentClock room={room} student={student} />
        {!room.bus && (
          <Link className="badge danger" to={back}>
            Sala sem conexão
          </Link>
        )}
      </header>
      <div className="detail-page detail">
        <div className="detail-left">
          <div>
            <Segmented
              value={view}
              onChange={(v) => {
                setView(v)
                // Voltar à gravação depois continua do início, não do último alerta clicado.
                if (v === 'live') setSeek(null)
              }}
              options={[
                { value: 'live', label: 'Ao vivo' },
                { value: 'rec', label: 'Gravação' },
              ]}
            />
          </div>
          {view === 'live' ? (
            <div className="player">{frame ? <img src={frame} alt="" draggable={false} /> : <Avatar name={student.name} />}</div>
          ) : (
            <Player room={room} student={student} seekTo={seek} alerts={alerts} />
          )}
        </div>

        <div className="detail-right">
          <Identity room={room} student={student} />
          <WarnCard room={room} student={student} />
          {room.exam.questions.map((q) => (
            <QuestionCard key={q.id} room={room} team={team} question={q} />
          ))}
          <div className="card">
            <div className="row">
              <h2 className="grow">Alertas</h2>
              {alerts.length > 0 && <span className="badge num">{alerts.length}</span>}
            </div>
            {alerts.length > 0 && (
              <div className="alert-list">
                {alerts.slice(0, ALERT_LIMIT).map((a, i) => (
                  <button
                    key={`${a.id}:${alerts.length - i}`}
                    type="button"
                    className={`alert-line${a.severe ? ' severe' : ''}`}
                    onClick={() => {
                      setView('rec')
                      setSeek({ at: a.at })
                    }}
                  >
                    <time className="xs faint num">{hhmmss(a.at)}</time>
                    <span className="kind">{alertLabel(a.kind)}</span>
                    <span className="about">{a.detail}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function StudentClock({ room, student }: { room: Room; student: Student }) {
  useTick(500)
  if (room.phase !== 'running') return null
  const endsAt = room.endsAtOf(student)
  if (!endsAt) return null
  return <span className="dash-clock">{formatClock(endsAt - Date.now())}</span>
}

function Identity({ room, student: s }: { room: Room; student: Student }) {
  const inTeams = room.config.mode === 'group'
  const group = inTeams ? room.config.groups.find((g) => g.id === s.groupId) : undefined
  const members = group ? [...room.students.values()].filter((m) => m.groupId === group.id).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')) : []
  const st = s.status
  const lastReceipt = s.receipts?.at(-1)
  const receipt = lastReceipt ? parseBody(lastReceipt) : null
  const flags: [string, boolean][] = [
    ['Tela', st.screen],
    ['Tela cheia', st.fullscreen],
    ['Na janela', st.focused],
    ['Um monitor', !st.extended],
  ]
  if (room.config.requireIsolation) flags.push(['Sem internet', st.isolated === true])
  return (
    <div className="card">
      <div className="row">
        <Avatar name={s.name} />
        <div className="who grow">
          <b>{s.name}</b>
          {s.enrollment && <span className="small muted">{s.enrollment}</span>}
          {inTeams && <div className="small muted">{group?.name ?? 'Sem equipe'}</div>}
        </div>
      </div>
      <div className="status-list">
        <span className={`badge ${s.online && !s.signalLost ? 'on' : 'off'}`}>
          <i className={`dot ${s.online && !s.signalLost ? 'on' : 'off'}`} />
          {!s.online ? 'Offline' : s.signalLost ? 'Sem sinal' : 'Online'}
        </span>
        {s.online &&
          flags.map(([label, ok]) => (
            <span key={label} className={`badge ${ok ? 'on' : 'off'}`}>
              {ok ? <Check size={12} /> : <X size={12} />} {label}
            </span>
          ))}
        {s.beaconOk !== undefined && (
          <span className={`badge ${s.beaconOk ? 'on' : 'off'}`} title={s.beaconOk ? undefined : 'A tela capturada não mostra a prova'}>
            {s.beaconOk ? <Check size={12} /> : <X size={12} />} {s.beaconOk ? 'Selo' : 'Selo ausente'}
          </span>
        )}
        {s.finishedAt && (
          <span className="badge">
            <Check size={12} /> Entregou {hhmmss(s.finishedAt)}
          </span>
        )}
        {receipt && (
          <span className="badge mono" title={`Comprovante de entrega. Checksum ${receipt.checksum}`}>
            {receipt.id}
          </span>
        )}
        {s.chainBroken && (
          <span className="badge danger" title="A sequência de eventos não fecha: pode ter havido alteração.">
            <ShieldAlert size={12} /> Registro alterado
          </span>
        )}
      </div>
      <MemberChips room={room} members={members} />
    </div>
  )
}

function WarnCard({ room, student }: { room: Room; student: Student }) {
  const [text, setText] = useState('')
  const send = () => {
    const clean = text.trim()
    if (!clean || !student.online) return
    room.warn(student.clientId, clean)
    setText('')
    toast.success('Aviso enviado')
  }
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault()
        send()
      }}
    >
      <div className="row">
        <input className="input" aria-label="Aviso para o aluno" placeholder="Aviso para o aluno" maxLength={200} value={text} onChange={(e) => setText(e.target.value)} />
        <Pill icon type="submit" aria-label="Enviar aviso" disabled={!student.online || !text.trim()}>
          <Send size={16} />
        </Pill>
      </div>
    </form>
  )
}

function QuestionCard({ room, team, question: q }: { room: Room; team: Team; question: Question }) {
  const sub = team.submissions[q.id]
  const answer = sub?.answer ?? team.answers[q.id]?.answer
  const solution = room.solutions?.solutions.find((x) => x.questionId === q.id)
  return (
    <div className="card">
      <div className="row">
        <h2 className="grow">{q.title}</h2>
        <span className="xs muted num">{q.points} pts</span>
      </div>
      {sub ? (
        <span className="xs muted">
          {sub.by === 'rascunho' ? 'Rascunho no fim da prova' : `Entregue por ${sub.by}`} às {hhmmss(sub.at)}
        </span>
      ) : (
        answer && <span className="xs muted">Rascunho</span>
      )}
      <AnswerView question={q} answer={answer} solution={solution} />
      <GradeView room={room} team={team} question={q} solution={solution} />
      <Expected solution={solution} />
    </div>
  )
}

function AnswerView({ question: q, answer, solution }: { question: Question; answer?: Answer; solution?: Solution }) {
  const [picked, setPicked] = useState<string | null>(null)
  if (q.type === 'choice') {
    const selected = answer?.type === 'choice' ? answer.selected : []
    const correct = solution?.type === 'choice' ? solution.correct : null
    return (
      <div className="stack" style={{ gap: '0.25rem' }}>
        {q.options.map((o) => (
          <div key={o.id} className="choice-line">
            {selected.includes(o.id) ? <Check size={14} className={correct && !correct.includes(o.id) ? 'bad' : 'ok'} /> : <Circle size={14} className={correct?.includes(o.id) ? 'ok' : 'faint'} />}
            <span>{o.text}</span>
          </div>
        ))}
      </div>
    )
  }
  if (!answer) return <span className="small faint">Sem resposta</span>
  if (answer.type === 'text') return <pre className="code-view wrap">{answer.text}</pre>
  if (answer.type !== 'code') return <span className="small faint">Resposta em formato inesperado</span>
  const names = Object.keys(answer.files)
  const name = picked && names.includes(picked) ? picked : names[0]
  if (!name) return <span className="small faint">Sem arquivos</span>
  return (
    <>
      {names.length > 1 && (
        <div className="file-tabs" role="tablist">
          {names.map((n) => (
            <button key={n} type="button" role="tab" className="exam-tab" aria-selected={n === name} onClick={() => setPicked(n)}>
              {n}
            </button>
          ))}
        </div>
      )}
      <pre className="code-view">{answer.files[name]}</pre>
    </>
  )
}

function GradeView({ room, team, question: q, solution }: { room: Room; team: Team; question: Question; solution?: Solution }) {
  const g = team.grades[q.id]
  if (!g) return null
  if (g.status === 'pending' || g.status === 'running') {
    return (
      <div className="row small muted">
        <Loader2 size={14} className="spin" /> Corrigindo
      </div>
    )
  }
  if (g.status === 'manual') return <ManualGrade room={room} team={team} question={q} grade={g} />
  const hidden = solution?.type === 'code' ? solution.tests : []
  return (
    <>
      <div className="row">
        <b className="num">
          {g.points} / {g.max}
        </b>
        {g.status === 'compile-error' && <span className="badge danger">Não compilou</span>}
      </div>
      {g.compileLog && <pre className="code-view">{g.compileLog}</pre>}
      {!!g.tests?.length && (
        <div className="test-list">
          {g.tests.map((t) => (
            <TestRow key={t.index} test={t} stdin={hidden[t.index]?.stdin} expected={hidden[t.index]?.stdout} />
          ))}
        </div>
      )}
    </>
  )
}

function TestRow({ test: t, stdin, expected }: { test: TestResult; stdin?: string; expected?: string }) {
  return (
    <details className="test-row">
      <summary className={`badge${t.passed ? '' : ' danger'}`} title={t.timedOut ? 'Tempo esgotado' : undefined}>
        {t.passed ? <Check size={12} className="ok" /> : <X size={12} />} {t.index + 1}
      </summary>
      {stdin !== undefined && <Block label="Entrada" text={stdin} />}
      {expected !== undefined && <Block label="Esperado" text={expected} />}
      <Block label="Saída" text={t.stdout} />
      <Block label="Erros" text={t.stderr} />
    </details>
  )
}

function Block({ label, text }: { label: string; text?: string }) {
  if (!text) return null
  return (
    <>
      <span className="conn-label">{label}</span>
      <pre className="code-view">{text}</pre>
    </>
  )
}

function ManualGrade({ room, team, question: q, grade }: { room: Room; team: Team; question: Question; grade: Grade }) {
  const [value, setValue] = useState(String(grade.points))
  useEffect(() => setValue(String(grade.points)), [grade.points])
  const commit = () => {
    const points = Number(value.replace(',', '.'))
    if (!value.trim() || !Number.isFinite(points)) return setValue(String(grade.points))
    room.setManualGrade(team.key, q.id, points)
  }
  return (
    <div className="row">
      <input
        className="input num points-input"
        aria-label="Pontos"
        inputMode="decimal"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <span className="small muted num">/ {q.points}</span>
      {grade.graded ? <Check size={14} className="ok" aria-label="Corrigida" /> : <span className="badge">Falta corrigir</span>}
    </div>
  )
}

// Gabarito só para os olhos de quem está aqui: nada disso entra em mensagem nenhuma.
function Expected({ solution }: { solution?: Solution }) {
  if (!solution || solution.type === 'choice') return null
  return (
    <details className="expect">
      <summary>Gabarito</summary>
      {solution.type === 'code' ? <pre className="code-view">{solution.reference.code}</pre> : <pre className="code-view wrap">{solution.rubric}</pre>}
    </details>
  )
}
