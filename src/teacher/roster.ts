// A turma como o painel lista: uma linha por aluno, com busca, filtros, ordem e CSV.
// Tudo puro: a parede e a tabela usam as mesmas funções, e a URL guarda o que foi escolhido.
import type { Question } from '../../shared/exam'
import type { Group, RoomMode } from '../../shared/protocol'
import type { Student, Team } from './room'
import { normalize, words } from './search'

export type Presence = 'online' | 'offline' | 'noscreen'
export type Cell = { points: number; failed: boolean } | 'pending' | 'manual' | null

export interface RosterRow {
  id: string
  name: string
  enrollment: string
  team: string
  presence: Presence
  finished: boolean
  cells: Cell[]
  answered: boolean[]
  total: number | null
  alerts: number
  last: number
  lastLabel: string
  // Nome, matrícula e equipe, já normalizados para a busca.
  hay: string
  // Tudo o que aparece na linha: igual, a linha não precisa redesenhar.
  sig: string
}

export interface RosterSource {
  exam: { questions: Question[] }
  config: { mode: RoomMode; groups: Group[] }
  students: Map<string, Student>
  teamOf(s: Student): Team
  scoreOf(t: Team): { earned: number }
}

export const PRESENCE_LABEL: Record<Presence, string> = { online: 'online', offline: 'offline', noscreen: 'sem tela' }

function cellOf(team: Team, q: Question): Cell {
  const g = team.grades[q.id]
  if (!g) return null
  if (g.status === 'pending' || g.status === 'running') return 'pending'
  if (g.status === 'manual' && !g.graded) return 'manual'
  return { points: g.points, failed: g.status === 'compile-error' }
}

// O documento da equipe sempre tem o código inicial: só conta como resposta se mudou.
function answeredOf(team: Team, q: Question) {
  if (team.submissions[q.id]) return true
  const a = team.answers[q.id]?.answer
  if (!a) return false
  if (a.type === 'text') return a.text.trim() !== ''
  if (a.type === 'choice') return a.selected.length > 0
  const starter = (q.type === 'code' ? (q.starter?.[a.lang] ?? '') : '').trim()
  return Object.values(a.files).some((text) => text.trim() !== '' && text.trim() !== starter)
}

function presenceOf(s: Student): Presence {
  if (!s.online) return 'offline'
  if (!s.finishedAt && !s.status.screen) return 'noscreen'
  return 'online'
}

// Um formatador só: criar um por chamada aparecia no perfil, 100 linhas a cada segundo.
const clock = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })

export function activityLabel(last: number, now: number) {
  if (!last) return '—'
  const ago = now - last
  if (ago < 60_000) return 'agora'
  if (ago < 3600_000) return `há ${Math.floor(ago / 60_000)} min`
  return clock.format(last)
}

export function buildRows(src: RosterSource, now: number): RosterRow[] {
  const { questions } = src.exam
  const rows: RosterRow[] = []
  for (const s of src.students.values()) {
    const team = src.teamOf(s)
    const teamName = src.config.mode === 'group' && s.groupId ? (src.config.groups.find((g) => g.id === s.groupId)?.name ?? '') : ''
    const cells = questions.map((q) => cellOf(team, q))
    const answered = questions.map((q) => answeredOf(team, q))
    const total = Object.keys(team.grades).length ? src.scoreOf(team).earned : null
    const last = Math.max(s.lastBeat, s.finishedAt ?? 0, s.lastAlert?.at ?? 0)
    const enrollment = s.enrollment ?? ''
    const presence = presenceOf(s)
    const finished = !!s.finishedAt
    const lastLabel = activityLabel(last, now)
    const sig = JSON.stringify([s.name, enrollment, teamName, presence, finished, cells, total, s.alerts, lastLabel])
    rows.push({ id: s.clientId, name: s.name, enrollment, team: teamName, presence, finished, cells, answered, total, alerts: s.alerts, last, lastLabel, hay: normalize(`${s.name} ${enrollment} ${teamName}`), sig })
  }
  return rows
}

// ---- filtros

export const FILTERS = ['online', 'offline', 'noscreen', 'alerts', 'empty', 'graded'] as const
export type Filter = (typeof FILTERS)[number]

export interface RosterQuery {
  text: string
  filters: Filter[]
  // Restringe "sem resposta" e "com nota" a uma questão; sozinha, mostra quem respondeu a ela.
  question: string | null
}

export const EMPTY_QUERY: RosterQuery = { text: '', filters: [], question: null }

const PRESENCE_FILTERS: Filter[] = ['online', 'offline', 'noscreen']
const ANSWER_FILTERS: Filter[] = ['empty', 'graded']

export const isFiltering = (q: RosterQuery) => q.text.trim() !== '' || q.filters.length > 0 || q.question !== null

// Dentro de um grupo (status, resposta) os chips somam; entre grupos, restringem.
export function filterRows(rows: RosterRow[], q: RosterQuery, questionIds: string[]): RosterRow[] {
  const ws = words(q.text)
  const presence = q.filters.filter((f) => PRESENCE_FILTERS.includes(f))
  const answer = q.filters.filter((f) => ANSWER_FILTERS.includes(f))
  const alerts = q.filters.includes('alerts')
  const qi = q.question === null ? -1 : questionIds.indexOf(q.question)
  const graded = (c: Cell) => typeof c === 'object' && c !== null
  return rows.filter((r) => {
    // O id é aleatório: casar no meio dele acharia qualquer número digitado.
    if (!ws.every((w) => r.hay.includes(w) || r.id.startsWith(w))) return false
    if (presence.length && !presence.includes(r.presence)) return false
    if (alerts && r.alerts === 0) return false
    if (qi >= 0 && !answer.length) return r.answered[qi]
    if (!answer.length) return true
    return answer.some((f) => {
      if (f === 'empty') return qi >= 0 ? !r.answered[qi] : !r.answered.some(Boolean)
      return qi >= 0 ? graded(r.cells[qi]) : r.cells.some(graded)
    })
  })
}

// ---- ordem

export type SortKey = 'name' | 'team' | 'presence' | 'total' | 'alerts' | 'last' | `q:${string}`
export interface Sort {
  key: SortKey | string
  dir: 'asc' | 'desc'
}

export const DEFAULT_SORT: Sort = { key: 'name', dir: 'asc' }

const PRESENCE_RANK: Record<Presence, number> = { noscreen: 0, offline: 1, online: 2 }
const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true })

const isKey = (key: string): key is SortKey => ['name', 'team', 'presence', 'total', 'alerts', 'last'].includes(key) || (key.startsWith('q:') && key.length > 2)

function valueOf(r: RosterRow, key: string, questionIds: string[]): string | number | null {
  switch (key) {
    case 'name':
      return r.name
    case 'team':
      return r.team || null
    case 'presence':
      return PRESENCE_RANK[r.presence]
    case 'total':
      return r.total
    case 'alerts':
      return r.alerts
    case 'last':
      return r.last || null
  }
  const c = r.cells[questionIds.indexOf(key.slice(2))]
  return typeof c === 'object' && c !== null ? c.points : null
}

// Vazio fica no fim nos dois sentidos; empate sai pelo nome.
export function sortRows(rows: RosterRow[], sort: Sort, questionIds: string[]): RosterRow[] {
  const sign = sort.dir === 'asc' ? 1 : -1
  const keyed = rows.map((r) => ({ r, v: valueOf(r, sort.key, questionIds) }))
  keyed.sort((a, b) => {
    if (a.v === null || b.v === null) {
      if (a.v !== b.v) return a.v === null ? 1 : -1
    } else {
      const d = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : collator.compare(String(a.v), String(b.v))
      if (d) return d * sign
    }
    return collator.compare(a.r.name, b.r.name) || a.r.id.localeCompare(b.r.id)
  })
  return keyed.map((k) => k.r)
}

export function nextSort(cur: Sort, key: string): Sort {
  if (cur.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
  return { key, dir: key === 'name' || key === 'team' || key === 'presence' ? 'asc' : 'desc' }
}

// ---- URL

export type View = 'wall' | 'results'
export interface RosterState {
  query: RosterQuery
  sort: Sort
  // null: o painel decide pela fase da prova.
  view: View | null
}

const VIEW_PARAM: Record<View, string> = { wall: 'telas', results: 'notas' }
const PARAMS = ['busca', 'filtro', 'questao', 'ordem', 'vista']

export function readQuery(params: URLSearchParams): RosterState {
  const filters = (params.get('filtro') ?? '')
    .split(',')
    .filter((f, i, all): f is Filter => (FILTERS as readonly string[]).includes(f) && all.indexOf(f) === i)
  const ordem = params.get('ordem') ?? ''
  const dot = ordem.lastIndexOf('.')
  const key = ordem.slice(0, dot)
  const dir = ordem.slice(dot + 1)
  const sort: Sort = dot > 0 && isKey(key) && (dir === 'asc' || dir === 'desc') ? { key, dir } : DEFAULT_SORT
  const vista = params.get('vista')
  const view = (Object.keys(VIEW_PARAM) as View[]).find((v) => VIEW_PARAM[v] === vista) ?? null
  return { query: { text: params.get('busca') ?? '', filters, question: params.get('questao') || null }, sort, view }
}

export function writeQuery(params: URLSearchParams, state: RosterState): URLSearchParams {
  const next = new URLSearchParams(params)
  for (const p of PARAMS) next.delete(p)
  const { query, sort, view } = state
  if (query.text.trim()) next.set('busca', query.text)
  if (query.filters.length) next.set('filtro', query.filters.join(','))
  if (query.question) next.set('questao', query.question)
  if (sort.key !== DEFAULT_SORT.key || sort.dir !== DEFAULT_SORT.dir) next.set('ordem', `${sort.key}.${sort.dir}`)
  if (view) next.set('vista', VIEW_PARAM[view])
  return next
}

// ---- CSV

// Fórmula em CSV roda ao abrir no Excel; o nome vem do aluno, então é neutralizado.
const csvCell = (v: unknown) => {
  const text = String(v).replace(/"/g, '""')
  return `"${/^[=+\-@\t\r]/.test(text) ? `'${text}` : text}"`
}

export function rowsCsv(rows: RosterRow[], questions: Question[], mode: RoomMode) {
  const group = mode === 'group'
  const header = ['aluno', 'matricula', ...(group ? ['equipe'] : []), 'status', ...questions.map((q) => q.id), 'total', 'alertas', 'ultima_atividade']
  const lines = rows.map((r) => [
    r.name,
    r.enrollment,
    ...(group ? [r.team] : []),
    PRESENCE_LABEL[r.presence],
    ...r.cells.map((c) => (typeof c === 'object' && c !== null ? c.points : '')),
    r.total ?? '',
    r.alerts,
    r.last ? new Date(r.last).toISOString() : '',
  ])
  return [header, ...lines].map((l) => l.map(csvCell).join(';')).join('\n')
}
