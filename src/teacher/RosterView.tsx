import { ArrowDown, ArrowUp, Check, ChevronDown, Download, Loader2, PenLine, Search, X } from 'lucide-react'
import { memo, startTransition, useCallback, useEffect, useRef, useState, type Dispatch, type KeyboardEvent, type SetStateAction } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Pill, Popover, PopoverRow, Segmented, useTick } from '../ui/kit'
import { download, safeName } from './exportZip'
import type { Room } from './room'
import { buildRows, buildTeamRows, EMPTY_QUERY, filterRows, isFiltering, nextSort, PRESENCE_LABEL, readQuery, rowsCsv, sortRows, writeQuery, type Cell, type Filter, type Presence, type RosterQuery, type RosterRow, type RosterState, type Sort } from './roster'
import { highlight, settleEcho } from './search'

const URL_WRITE_MS = 250

export const FILTER_LABEL: Record<Filter, string> = { online: 'Online', offline: 'Offline', noscreen: 'Sem tela', alerts: 'Com alertas', empty: 'Sem resposta', graded: 'Com nota' }

export const studentPath = (roomId: string, clientId: string) => `/sala/${encodeURIComponent(roomId)}/aluno/${encodeURIComponent(clientId)}`
export const teamPath = (roomId: string, groupId: string) => `/sala/${encodeURIComponent(roomId)}/equipe/${encodeURIComponent(groupId)}`

// As linhas da tabela como o professor escolheu ver: por aluno ou, em equipe, por equipe.
export const rowsFor = (room: Room, byTeam: boolean, now: number) => (byTeam && room.config.mode === 'group' ? buildTeamRows(room, now) : buildRows(room, now))
const points = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 })
const fmt = (n: number) => points.format(n)

// Lê a URL uma vez e escreve de volta com atraso: com o estado só na URL, cada letra seria uma navegação.
export function useRosterState() {
  const [params, setParams] = useSearchParams()
  const [state, setState] = useState<RosterState>(() => readQuery(params))
  const write = useRef(setParams)
  write.current = setParams
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const t = setTimeout(() => write.current((p) => writeQuery(p, state), { replace: true }), URL_WRITE_MS)
    return () => clearTimeout(t)
  }, [state])
  return [state, setState] as const
}

export function Marked({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return text
  return highlight(text, query).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : p.text))
}

const editable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

// O texto do campo é local e a busca vai em transição: digitar nunca espera a parede nem a tabela.
function SearchField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  const sent = useRef<string[]>([])
  useEffect(() => {
    const r = settleEcho(sent.current, value)
    sent.current = r.pending
    if (r.external) setText(value)
  }, [value])

  const change = (v: string) => {
    setText(v)
    sent.current.push(v)
    startTransition(() => onChange(v))
  }

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const el = ref.current
      if (!el) return
      const k = (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k'
      if (!k && (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || editable(e.target))) return
      e.preventDefault()
      el.focus()
      el.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') return
    if (text) change('')
    else e.currentTarget.blur()
  }

  return (
    <div className="search">
      <Search size={16} aria-hidden="true" />
      <input
        ref={ref}
        className="input"
        type="search"
        aria-label="Buscar aluno"
        aria-keyshortcuts="/ Control+K Meta+K"
        placeholder="Nome, matrícula ou equipe"
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(e) => change(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {text ? (
        <button type="button" className="search-clear" aria-label="Limpar busca" onClick={() => (change(''), ref.current?.focus())}>
          <X size={14} />
        </button>
      ) : (
        <kbd className="search-key" aria-hidden="true">
          /
        </kbd>
      )}
    </div>
  )
}

interface BarProps {
  room: Room
  rows: RosterRow[]
  shown: number
  state: RosterState
  setState: Dispatch<SetStateAction<RosterState>>
  csv: boolean
}

export function RosterBar({ room, rows, shown, state, setState, csv }: BarProps) {
  const { query } = state
  const questions = room.exam.questions
  const ids = questions.map((q) => q.id)
  const setQuery = useCallback((patch: Partial<RosterQuery>) => setState((s) => ({ ...s, query: { ...s.query, ...patch } })), [setState])
  const onText = useCallback((text: string) => setQuery({ text }), [setQuery])
  const toggle = (f: Filter) => setQuery({ filters: query.filters.includes(f) ? query.filters.filter((x) => x !== f) : [...query.filters, f] })
  const count = (f: Filter) => filterRows(rows, { ...EMPTY_QUERY, filters: [f], question: query.question }, ids).length
  const picked = questions.find((q) => q.id === query.question)

  const exportCsv = () => {
    const byTeam = state.byTeam && room.config.mode === 'group'
    const visible = sortRows(filterRows(rowsFor(room, byTeam, Date.now()), query, ids), state.sort, ids)
    download(new Blob(['﻿' + rowsCsv(visible, questions, room.config.mode, byTeam) + '\n'], { type: 'text/csv;charset=utf-8' }), `${safeName(room.config.title)} notas${byTeam ? ' por equipe' : ''}.csv`)
  }

  return (
    <div className="roster-bar" role="search">
      <SearchField value={query.text} onChange={onText} />
      <div className="fchips" role="group" aria-label="Filtros">
        {(['online', 'offline', 'noscreen', 'alerts', 'empty', 'graded'] as Filter[]).map((f) => (
          <button key={f} type="button" className="fchip" aria-pressed={query.filters.includes(f)} onClick={() => toggle(f)}>
            {f === 'online' && <i className="dot on" />}
            {f === 'offline' && <i className="dot" />}
            {f === 'noscreen' && <i className="dot off" />}
            {FILTER_LABEL[f]}
            <span className="num">{count(f)}</span>
          </button>
        ))}
        {questions.length > 0 && (
          <Popover
            className="fchip"
            label={picked ? `Questão ${picked.id}` : 'Filtrar por questão'}
            title="Questão"
            trigger={
              <>
                <span className="fchip-q" data-on={!!picked || undefined}>
                  {picked ? picked.id : 'Questão'}
                </span>
                <ChevronDown size={12} />
              </>
            }
          >
            {(close) => [
              <PopoverRow key="" label="Todas as questões" checked={!picked} onSelect={() => (setQuery({ question: null }), close())} />,
              ...questions.map((q) => (
                <PopoverRow key={q.id} label={`${q.id} · ${q.title}`} hint={`${fmt(q.points)} pts`} checked={q.id === picked?.id} onSelect={() => (setQuery({ question: q.id }), close())} />
              )),
            ]}
          </Popover>
        )}
      </div>
      <div className="grow" />
      {csv && room.config.mode === 'group' && (
        <Segmented
          label="Agrupar notas"
          value={state.byTeam ? 'team' : 'student'}
          onChange={(v) => setState((s) => ({ ...s, byTeam: v === 'team' }))}
          options={[
            { value: 'student', label: 'Alunos' },
            { value: 'team', label: 'Equipes' },
          ]}
        />
      )}
      {isFiltering(query) && (
        <Pill size="sm" onClick={() => setState((s) => ({ ...s, query: EMPTY_QUERY }))}>
          Limpar
        </Pill>
      )}
      <span className="roster-count num" aria-live="polite">
        <b>{shown}</b> de {rows.length}
      </span>
      {csv && (
        <Pill size="sm" disabled={!shown} onClick={exportCsv} title="Baixar a tabela como está, com busca e ordem">
          <Download size={14} /> CSV
        </Pill>
      )}
    </div>
  )
}

// ---- estados vazios

export function Waiting() {
  return (
    <div className="dash-empty" role="status">
      <div className="dash-ring" aria-hidden="true" />
      <b>Esperando alunos</b>
      <span>Eles aparecem aqui assim que entram com o endereço do cartão Conexão, ao lado.</span>
    </div>
  )
}

export function NoMatch({ query, onClear }: { query: RosterQuery; onClear: () => void }) {
  const parts = [...query.filters.map((f) => FILTER_LABEL[f].toLowerCase()), ...(query.question ? [`questão ${query.question}`] : [])]
  const text = query.text.trim()
  return (
    <div className="dash-empty" role="status">
      <b>Ninguém encontrado</b>
      <span>
        {text && `Nenhum nome, matrícula ou equipe tem “${text}”${parts.length ? ' com os filtros escolhidos' : ''}. `}
        {!text && `Nenhum aluno com ${parts.join(' e ')} agora. `}
        {text ? 'Confira a grafia ou tire um filtro.' : 'Tire um filtro para ver mais.'}
      </span>
      <Pill size="sm" onClick={onClear}>
        Limpar busca e filtros
      </Pill>
    </div>
  )
}

// ---- tabela

const Nil = () => <span className="nil">—</span>

function GradeCell({ cell }: { cell: Cell }) {
  if (cell === null) return <Nil />
  if (cell === 'pending') return <Loader2 size={14} className="spin muted" aria-label="Corrigindo" />
  if (cell === 'manual') return <PenLine size={14} className="warn" aria-label="Falta corrigir" />
  return (
    <span className={cell.failed ? 'bad' : undefined} title={cell.failed ? 'Não compilou' : undefined}>
      {fmt(cell.points)}
    </span>
  )
}

function Status({ presence, finished }: { presence: Presence; finished: boolean }) {
  return (
    <span className={`st st-${presence}`}>
      <i className={`dot${presence === 'online' ? ' on' : presence === 'noscreen' ? ' off' : ''}`} />
      {PRESENCE_LABEL[presence]}
      {finished && (
        <span className="st-done" role="img" aria-label="entregou" title="Entregou">
          <Check size={13} />
        </span>
      )}
    </span>
  )
}

interface RowProps {
  row: RosterRow
  text: string
  group: boolean
  onOpen: (id: string) => void
}

// O Student muda no lugar a cada batida; a assinatura diz se algo que aparece mudou.
const Row = memo(
  function Row({ row, text, group, onOpen }: RowProps) {
    const open = () => onOpen(row.id)
    return (
      <tr tabIndex={0} data-link onClick={open} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open())}>
        <th scope="row">
          <Marked text={row.name} query={text} />
          {row.members !== undefined && <span className="badge num r-members">{row.members}</span>}
          {row.enrollment && (
            <small className="num">
              <Marked text={row.enrollment} query={text} />
            </small>
          )}
        </th>
        {group && <td>{row.team ? <Marked text={row.team} query={text} /> : <Nil />}</td>}
        <td>
          <Status presence={row.presence} finished={row.finished} />
        </td>
        {row.cells.map((c, i) => (
          <td key={i} className="n">
            <GradeCell cell={c} />
          </td>
        ))}
        <td className="n r-total">{row.total === null ? <Nil /> : fmt(row.total)}</td>
        <td className={`n${row.alerts ? ' bad' : ' muted'}`}>{row.alerts}</td>
        <td className="n muted">{row.lastLabel}</td>
      </tr>
    )
  },
  (a, b) => a.row.sig === b.row.sig && a.text === b.text && a.group === b.group && a.onOpen === b.onOpen,
)

function SortHead({ k, label, sub, title, num, sort, onSort }: { k: string; label: string; sub?: string; title?: string; num?: boolean; sort: Sort; onSort: (k: string) => void }) {
  const active = sort.key === k
  const Arrow = active && sort.dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <th scope="col" className={num ? 'n' : undefined} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button type="button" className="th-sort" data-active={active || undefined} title={title} onClick={() => onSort(k)}>
        <span>{label}</span>
        {sub && <small className="num">{sub}</small>}
        <Arrow size={12} aria-hidden="true" />
      </button>
    </th>
  )
}

// Em rem. O nome fica com o que sobrar, a partir do mínimo.
const COL = { name: 11, team: 9, status: 7.5, grade: 4.5, total: 5.5, alerts: 5.5, last: 7 }

interface TableProps {
  room: Room
  query: RosterQuery
  sort: Sort
  byTeam: boolean
  setState: Dispatch<SetStateAction<RosterState>>
}

// Com tique próprio: a tabela não precisa refazer a cada miniatura que chega.
export const ResultsTable = memo(function ResultsTable({ room, query, sort, byTeam: wantTeams, setState }: TableProps) {
  useTick(1000)
  const nav = useNavigate()
  const roomId = room.config.roomId
  const byTeam = wantTeams && room.config.mode === 'group'
  const onOpen = useCallback((id: string) => nav(byTeam && room.config.groups.some((g) => g.id === id) ? teamPath(roomId, id) : studentPath(roomId, id)), [nav, room, roomId, byTeam])
  const onSort = useCallback((k: string) => setState((s) => ({ ...s, sort: nextSort(s.sort, k) })), [setState])
  const onClear = useCallback(() => setState((s) => ({ ...s, query: EMPTY_QUERY })), [setState])

  const questions = room.exam.questions
  const ids = questions.map((q) => q.id)
  const all = rowsFor(room, byTeam, Date.now())
  if (!all.length) return <Waiting />
  const rows = sortRows(filterRows(all, query, ids), sort, ids)
  if (!rows.length) return <NoMatch query={query} onClear={onClear} />
  const group = room.config.mode === 'group' && !byTeam
  const max = questions.reduce((n, q) => n + q.points, 0)
  const head = { sort, onSort }
  // Larguras fixas: filtrar ou alguém entregar não pode empurrar as colunas.
  const width = COL.name + (group ? COL.team : 0) + COL.status + COL.grade * questions.length + COL.total + COL.alerts + COL.last
  return (
    <div className="card results-wrap">
      <table className="results" style={{ minWidth: `${width}rem` }}>
        <colgroup>
          <col />
          {group && <col style={{ width: `${COL.team}rem` }} />}
          <col style={{ width: `${COL.status}rem` }} />
          {questions.map((q) => (
            <col key={q.id} style={{ width: `${COL.grade}rem` }} />
          ))}
          <col style={{ width: `${COL.total}rem` }} />
          <col style={{ width: `${COL.alerts}rem` }} />
          <col style={{ width: `${COL.last}rem` }} />
        </colgroup>
        <thead>
          <tr>
            <SortHead k="name" label={byTeam ? 'Equipe' : 'Aluno'} {...head} />
            {group && <SortHead k="team" label="Equipe" {...head} />}
            <SortHead k="presence" label="Status" {...head} />
            {questions.map((q) => (
              <SortHead key={q.id} k={`q:${q.id}`} label={q.id} sub={fmt(q.points)} title={q.title} num {...head} />
            ))}
            <SortHead k="total" label="Total" sub={fmt(max)} num {...head} />
            <SortHead k="alerts" label="Alertas" num {...head} />
            <SortHead k="last" label="Atividade" title="Última atividade" num {...head} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Row key={r.id} row={r} text={query.text} group={group} onOpen={onOpen} />
          ))}
        </tbody>
      </table>
    </div>
  )
})
