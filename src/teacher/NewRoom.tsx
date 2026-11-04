import { ChevronDown, FileJson, ImagePlus, Loader2, Plus, Sparkles, Trash2, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  validateExam,
  validateSolutions,
  type Exam,
  type HiddenTest,
  type Lang,
  type Question,
  type Solution,
  type Solutions,
} from '../../shared/exam'
import type { Flow } from '../../shared/flow'
import { DEFAULT_TEAM_SIZE, type RoomMode, type Timing } from '../../shared/protocol'
import { imageToMarkdown } from '../lib/image'
import { randomId } from '../lib/store'
import { Field, Logo, Pill, Segmented, Switch, browserIssue } from '../ui/kit'
import { Room, activeRoom, registerRoom } from './room'

interface DraftQuestion {
  key: string
  type: Question['type']
  title: string
  statement: string
  points: number
  languages: Lang[]
  sampleIn: string
  sampleOut: string
  options: { id: string; text: string; correct: boolean }[]
  tests: HiddenTest[]
  reference: string
}

const blank = (): DraftQuestion => ({
  key: randomId(4),
  type: 'code',
  title: '',
  statement: '',
  points: 1,
  languages: ['c', 'cpp'],
  sampleIn: '',
  sampleOut: '',
  options: [
    { id: 'a', text: '', correct: true },
    { id: 'b', text: '', correct: false },
  ],
  tests: [],
  reference: '',
})

function draftsToFiles(title: string, durationMin: number, drafts: DraftQuestion[]): { exam: Exam; solutions: Solutions } {
  const questions: Question[] = []
  const solutions: Solution[] = []
  drafts.forEach((d, i) => {
    const base = { id: `q${i + 1}`, title: d.title, statement: d.statement, points: d.points }
    if (d.type === 'code') {
      const samples = d.sampleOut ? [{ stdin: d.sampleIn, stdout: d.sampleOut }] : undefined
      questions.push({ ...base, type: 'code', languages: d.languages, samples })
      if (d.tests.length) solutions.push({ questionId: base.id, type: 'code', reference: { lang: d.languages[0], code: d.reference || '// sem referência' }, tests: d.tests })
    } else if (d.type === 'choice') {
      questions.push({ ...base, type: 'choice', options: d.options.map((o) => ({ id: o.id, text: o.text })), multiple: d.options.filter((o) => o.correct).length > 1 })
      solutions.push({ questionId: base.id, type: 'choice', correct: d.options.filter((o) => o.correct).map((o) => o.id) })
    } else {
      questions.push({ ...base, type: 'text' })
    }
  })
  return { exam: { version: 1, title, durationMin, questions }, solutions: { version: 1, solutions } }
}

const MIN_TEAM = 2
const MAX_TEAM = 10

const teamSizeOf = (raw: string) => {
  const n = Math.round(Number(raw))
  return raw.trim() && Number.isFinite(n) ? Math.min(MAX_TEAM, Math.max(MIN_TEAM, n)) : DEFAULT_TEAM_SIZE
}

export default function NewRoom() {
  const nav = useNavigate()
  const [active, setActive] = useState<Awaited<ReturnType<typeof activeRoom>> | undefined>(undefined)
  const issue = browserIssue()
  const [source, setSource] = useState<'json' | 'build'>('json')
  const [title, setTitle] = useState('')
  const [duration, setDuration] = useState(90)
  const [mode, setMode] = useState<RoomMode>('individual')
  const [flow, setFlow] = useState<Flow>('free')
  const [timing, setTiming] = useState<Timing>('clock-in')
  const [compiler, setCompiler] = useState(true)
  const [isolation, setIsolation] = useState(true)
  const [record, setRecord] = useState(true)
  const [teamSize, setTeamSize] = useState(String(DEFAULT_TEAM_SIZE))
  const [password, setPassword] = useState('')
  const [examFile, setExamFile] = useState<Exam | null>(null)
  const [solFile, setSolFile] = useState<Solutions | null>(null)
  const [drafts, setDrafts] = useState<DraftQuestion[]>([blank()])
  const [errors, setErrors] = useState<string[]>([])
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    let live = true
    activeRoom().then(
      (found) => live && setActive(found),
      () => live && setActive(null),
    )
    return () => {
      live = false
    }
  }, [])

  const loadExam = async (file: File) => {
    try {
      const { exam, errors } = validateExam(JSON.parse(await file.text()))
      setErrors(errors)
      if (exam) {
        setExamFile(exam)
        setTitle((t) => t || exam.title)
        setDuration(exam.durationMin)
        setSolFile(null)
      }
    } catch {
      setErrors(['Esse arquivo não é um JSON válido.'])
    }
  }

  const loadSolutions = async (file: File) => {
    try {
      const { solutions, errors } = validateSolutions(JSON.parse(await file.text()), examFile ?? undefined)
      setErrors(errors)
      if (solutions) setSolFile(solutions)
    } catch {
      setErrors(['Esse arquivo não é um JSON válido.'])
    }
  }

  const create = async () => {
    setErrors([])
    let exam: Exam
    let solutions: Solutions | null
    if (source === 'json') {
      if (!examFile) return setErrors(['Envie o arquivo da prova.'])
      exam = { ...examFile, title: title || examFile.title, durationMin: duration }
      solutions = solFile
    } else {
      const built = draftsToFiles(title, duration, drafts)
      const check = validateExam(built.exam)
      if (check.errors.length) return setErrors(check.errors)
      exam = built.exam
      solutions = built.solutions.solutions.length ? built.solutions : null
    }
    if (!exam.title.trim()) return setErrors(['Dê um título para a prova.'])
    setCreating(true)
    try {
      // Outra aba pode ter aberto uma prova depois que esta tela carregou.
      const open = await activeRoom()
      if (open) return setActive(open)
      // O Argon2id segura a thread por cerca de um segundo: o botão precisa pintar antes.
      await new Promise((resolve) => setTimeout(resolve, 50))
      const roomId = randomId(8)
      const room = await Room.create(
        {
          roomId,
          title: exam.title,
          mode,
          flow,
          timing: flow === 'manual' ? 'global' : timing,
          compiler,
          requireIsolation: isolation,
          recordScreen: record,
          maxTeamSize: mode === 'group' ? teamSizeOf(teamSize) : 1,
          groups: [],
        },
        exam,
        solutions,
        password,
      )
      registerRoom(room)
      nav(`/sala/${roomId}`)
    } catch {
      setErrors(['Não foi possível criar a sala.'])
    } finally {
      setCreating(false)
    }
  }

  const patch = (key: string, p: Partial<DraftQuestion>) => setDrafts((list) => list.map((d) => (d.key === key ? { ...d, ...p } : d)))

  if (active === undefined) return null
  // Uma prova por vez: enquanto houver uma aberta, não existe formulário para criar outra.
  if (active) {
    return (
      <div className="page narrow">
        <div className="page-top">
          <Logo />
        </div>
        <div className="card row">
          <h2 className="grow">{active.title}</h2>
          <Link className="pill primary" to={`/sala/${encodeURIComponent(active.id)}`}>
            Abrir
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="page narrow">
      <div className="page-top">
        <Logo />
      </div>
      <div className="stack">
        {issue && <div className="errbox">{issue}</div>}
        <h1 className="page-title">Nova sala</h1>

        <div className="card stack">
          <Field label="Título">
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Prova 1 de Algoritmos" />
          </Field>
          <div className="row wrap">
            {flow === 'free' && (
              <Field label="Minutos">
                <input className="input num" style={{ width: '7rem' }} type="number" min={1} value={duration} onChange={(e) => setDuration(Math.max(1, Number(e.target.value)))} />
              </Field>
            )}
            <div className="grow">
              <Field label="Senha da sala">
                <input className="input" type="password" autoComplete="new-password" placeholder="Recomendada" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
            </div>
          </div>
          <div className="row wrap" style={{ gap: '1.25rem' }}>
            <div className="field">
              <span>Como é feita</span>
              <Segmented value={mode} onChange={setMode} options={[{ value: 'individual', label: 'Individual' }, { value: 'group', label: 'Em equipe' }]} />
            </div>
            <div className="field">
              <span>Andamento</span>
              <Segmented value={flow} onChange={setFlow} options={[{ value: 'free', label: 'Livre' }, { value: 'manual', label: 'Manual' }]} />
            </div>
            {flow === 'free' && (
              <div className="field">
                <span>Início</span>
                <Segmented value={timing} onChange={setTiming} options={[{ value: 'clock-in', label: 'Cada um no seu tempo' }, { value: 'global', label: 'Todos juntos' }]} />
              </div>
            )}
          </div>
          {mode === 'group' && (
            <div>
              <Field label="Máximo por equipe">
                <input
                  className="input num"
                  style={{ width: '7rem' }}
                  type="number"
                  min={MIN_TEAM}
                  max={MAX_TEAM}
                  value={teamSize}
                  onChange={(e) => setTeamSize(e.target.value)}
                  onBlur={() => setTeamSize(String(teamSizeOf(teamSize)))}
                />
              </Field>
            </div>
          )}
          <div>
            <Switch label="Botão Testar para os alunos" checked={compiler} onChange={setCompiler} />
            <Switch label="Exigir rede sem internet" checked={isolation} onChange={setIsolation} />
            <Switch label="Gravar as telas" checked={record} onChange={setRecord} />
          </div>
        </div>

        <div className="card stack">
          <div className="row">
            <h2 className="grow">Questões</h2>
            <Segmented value={source} onChange={setSource} options={[{ value: 'json', label: 'Arquivo' }, { value: 'build', label: 'Montar aqui' }]} />
          </div>
          {source === 'json' ? (
            <>
              <DropFile label={examFile ? `${examFile.questions.length} questões em "${examFile.title}"` : 'Prova (exam.json)'} onFile={loadExam} done={!!examFile} />
              <DropFile label={solFile ? `Gabarito com ${solFile.solutions.length} respostas` : 'Gabarito (solutions.json), opcional'} onFile={loadSolutions} done={!!solFile} disabled={!examFile} />
              <a className="pill sm" style={{ alignSelf: 'flex-start' }} href="/llms.txt" target="_blank" rel="noreferrer">
                <Sparkles size={14} /> llms.txt
              </a>
            </>
          ) : (
            <>
              {drafts.map((d, i) => (
                <QuestionEditor key={d.key} index={i} draft={d} onChange={(p) => patch(d.key, p)} onRemove={drafts.length > 1 ? () => setDrafts((l) => l.filter((x) => x.key !== d.key)) : undefined} />
              ))}
              <div>
                <Pill onClick={() => setDrafts((l) => [...l, blank()])}>
                  <Plus size={16} /> Questão
                </Pill>
              </div>
            </>
          )}
        </div>

        {errors.length > 0 && <div className="errbox">{errors.join('\n')}</div>}
        <div>
          <Pill tone="brand" size="lg" disabled={creating || !!issue} onClick={() => void create()}>
            {creating && <Loader2 size={18} className="spin" />}
            {creating ? 'Criando sala' : 'Criar sala'}
          </Pill>
        </div>
      </div>
    </div>
  )
}

function DropFile({ label, onFile, done, disabled }: { label: string; onFile: (f: File) => void; done?: boolean; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  return (
    <div
      className={`dropzone${over ? ' over' : ''}`}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      style={disabled ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const file = e.dataTransfer.files[0]
        if (file) onFile(file)
      }}
    >
      {done ? <FileJson size={18} className="ok" /> : <Upload size={18} />}
      <span>{label}</span>
      <input
        ref={input}
        hidden
        type="file"
        accept="application/json,.json"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onFile(file)
          e.target.value = ''
        }}
      />
    </div>
  )
}

function QuestionEditor({ index, draft: d, onChange, onRemove }: { index: number; draft: DraftQuestion; onChange: (p: Partial<DraftQuestion>) => void; onRemove?: () => void }) {
  const [showTests, setShowTests] = useState(false)
  const imageInput = useRef<HTMLInputElement>(null)
  const setOption = (id: string, p: Partial<DraftQuestion['options'][number]>) => onChange({ options: d.options.map((o) => (o.id === id ? { ...o, ...p } : o)) })
  return (
    <div className="q-editor">
      <div className="row wrap">
        <b className="num">{index + 1}</b>
        <div className="grow" />
        <Segmented value={d.type} onChange={(type) => onChange({ type })} options={[{ value: 'code', label: 'Código' }, { value: 'choice', label: 'Múltipla' }, { value: 'text', label: 'Texto' }]} />
        {onRemove && (
          <Pill icon size="sm" aria-label="Remover questão" onClick={onRemove}>
            <Trash2 size={14} />
          </Pill>
        )}
      </div>
      <div className="row">
        <div className="grow">
          <Field label="Título">
            <input className="input" value={d.title} onChange={(e) => onChange({ title: e.target.value })} />
          </Field>
        </div>
        <Field label="Pontos">
          <input className="input num" style={{ width: '5.5rem' }} type="number" min={0.5} step={0.5} value={d.points} onChange={(e) => onChange({ points: Number(e.target.value) })} />
        </Field>
      </div>
      <Field label="Enunciado">
        <textarea className="input" rows={4} value={d.statement} onChange={(e) => onChange({ statement: e.target.value })} />
      </Field>
      <div>
        <input
          ref={imageInput}
          hidden
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={async (e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (!file) return
            const markdown = await imageToMarkdown(file).catch(() => null)
            if (markdown) onChange({ statement: `${d.statement.trimEnd()}\n\n${markdown}\n\n`.trimStart() })
          }}
        />
        <Pill size="sm" onClick={() => imageInput.current?.click()}>
          <ImagePlus size={14} /> Imagem
        </Pill>
      </div>
      {d.type === 'code' && (
        <>
          <div className="field">
            <span>Linguagem</span>
            <Segmented
              value={d.languages.join()}
              onChange={(v) => onChange({ languages: v.split(',') as Lang[] })}
              options={[{ value: 'c,cpp', label: 'C e C++' }, { value: 'c', label: 'C' }, { value: 'cpp', label: 'C++' }]}
            />
          </div>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div className="grow">
              <Field label="Exemplo: entrada">
                <textarea className="input code" value={d.sampleIn} onChange={(e) => onChange({ sampleIn: e.target.value })} />
              </Field>
            </div>
            <div className="grow">
              <Field label="Exemplo: saída">
                <textarea className="input code" value={d.sampleOut} onChange={(e) => onChange({ sampleOut: e.target.value })} />
              </Field>
            </div>
          </div>
          <div>
            <Pill size="sm" onClick={() => setShowTests((v) => !v)} aria-expanded={showTests}>
              <ChevronDown size={14} style={{ transform: showTests ? 'rotate(180deg)' : undefined }} /> Testes ocultos ({d.tests.length})
            </Pill>
          </div>
          {showTests && (
            <div className="stack">
              {d.tests.map((t, i) => (
                <div key={i} className="row" style={{ alignItems: 'flex-start' }}>
                  <textarea className="input code grow" aria-label="Entrada" placeholder="entrada" value={t.stdin} onChange={(e) => onChange({ tests: d.tests.map((x, j) => (j === i ? { ...x, stdin: e.target.value } : x)) })} />
                  <textarea className="input code grow" aria-label="Saída" placeholder="saída" value={t.stdout} onChange={(e) => onChange({ tests: d.tests.map((x, j) => (j === i ? { ...x, stdout: e.target.value } : x)) })} />
                  <input className="input num" aria-label="Pontos" style={{ width: '5rem' }} type="number" min={0} step={0.5} value={t.points} onChange={(e) => onChange({ tests: d.tests.map((x, j) => (j === i ? { ...x, points: Number(e.target.value) } : x)) })} />
                  <Pill icon aria-label="Remover teste" onClick={() => onChange({ tests: d.tests.filter((_, j) => j !== i) })}>
                    <Trash2 size={14} />
                  </Pill>
                </div>
              ))}
              <div>
                <Pill size="sm" onClick={() => onChange({ tests: [...d.tests, { stdin: '', stdout: '', points: 1 }] })}>
                  <Plus size={14} /> Teste
                </Pill>
              </div>
            </div>
          )}
        </>
      )}
      {d.type === 'choice' && (
        <div className="stack">
          {d.options.map((o) => (
            <div key={o.id} className="row">
              <input aria-label="Correta" type="checkbox" checked={o.correct} onChange={(e) => setOption(o.id, { correct: e.target.checked })} />
              <input className="input" aria-label={`Opção ${o.id}`} value={o.text} onChange={(e) => setOption(o.id, { text: e.target.value })} />
              {d.options.length > 2 && (
                <Pill icon aria-label="Remover opção" onClick={() => onChange({ options: d.options.filter((x) => x.id !== o.id) })}>
                  <Trash2 size={14} />
                </Pill>
              )}
            </div>
          ))}
          <div>
            <Pill size="sm" onClick={() => onChange({ options: [...d.options, { id: randomId(2), text: '', correct: false }] })}>
              <Plus size={14} /> Opção
            </Pill>
          </div>
        </div>
      )}
    </div>
  )
}
