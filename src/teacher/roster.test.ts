import { describe, expect, test } from 'bun:test'
import type { Exam } from '../../shared/exam'
import type { Student, Team } from './room'
import { activityLabel, buildRows, filterRows, nextSort, readQuery, rowsCsv, sortRows, writeQuery, type RosterQuery, type RosterSource } from './roster'

const exam: Exam = {
  version: 1,
  title: 'Prova',
  durationMin: 30,
  questions: [
    { id: 'q1', type: 'code', title: 'Soma', statement: 's', points: 5, languages: ['cpp'], starter: { cpp: 'int main() {}\n' } },
    { id: 'q2', type: 'text', title: 'Texto', statement: 't', points: 3 },
  ],
}

const NOW = 1_000_000_000

function student(clientId: string, name: string, extra: Partial<Student> = {}): Student {
  return {
    clientId,
    name,
    tokenHash: 'x',
    examGranted: true,
    peer: null,
    online: true,
    examSent: true,
    status: { screen: true, fullscreen: true, focused: true, isolated: true, extended: false },
    lastBeat: NOW,
    signalLost: false,
    alerts: 0,
    lastEvent: 0,
    lastRec: 0,
    chainBroken: false,
    segments: {},
    ...extra,
  }
}

function source(students: Student[], mode: 'individual' | 'group' = 'individual'): RosterSource & { teams: Map<string, Team> } {
  const teams = new Map<string, Team>()
  const keyOf = (s: Student) => (mode === 'group' && s.groupId ? `g:${s.groupId}` : `s:${s.clientId}`)
  return {
    teams,
    exam,
    config: { mode, groups: [{ id: 'az', name: 'Equipe Azul' }] },
    students: new Map(students.map((s) => [s.clientId, s])),
    teamOf: (s) => {
      const key = keyOf(s)
      if (!teams.has(key)) teams.set(key, { key, answers: {}, submissions: {}, grades: {} })
      return teams.get(key)!
    },
    scoreOf: (t) => ({ earned: Object.values(t.grades).reduce((n, g) => n + g.points, 0), total: 8, pending: 0 }),
  }
}

const query = (q: Partial<RosterQuery> = {}): RosterQuery => ({ text: '', filters: [], question: null, ...q })

describe('linhas', () => {
  test('status, notas por questão, total e equipe', () => {
    const src = source(
      [
        student('a1', 'Ana', { groupId: 'az', enrollment: '2023001' }),
        student('b2', 'Bruno', { online: false }),
        student('c3', 'Caio', { status: { screen: false, fullscreen: false, focused: true, isolated: true, extended: false } }),
      ],
      'group',
    )
    const ana = src.teamOf(src.students.get('a1')!)
    ana.grades.q1 = { questionId: 'q1', status: 'done', points: 4, max: 5 }
    ana.grades.q2 = { questionId: 'q2', status: 'manual', points: 0, max: 3 }
    const [a, b, c] = buildRows(src, NOW)
    expect(a).toMatchObject({ id: 'a1', name: 'Ana', enrollment: '2023001', team: 'Equipe Azul', presence: 'online', total: 4 })
    expect(a.cells).toEqual([{ points: 4, failed: false }, 'manual'])
    expect(b.presence).toBe('offline')
    expect(b.cells).toEqual([null, null])
    expect(b.total).toBeNull()
    expect(c.presence).toBe('noscreen')
  })

  test('quem entregou e parou de compartilhar não conta como sem tela', () => {
    const src = source([student('a', 'Ana', { finishedAt: NOW, status: { screen: false, fullscreen: false, focused: false, isolated: true, extended: false } })])
    expect(buildRows(src, NOW)[0]).toMatchObject({ presence: 'online', finished: true })
  })

  test('resposta: código igual ao inicial não conta, texto em branco também não', () => {
    const s = student('a', 'Ana')
    const src = source([s])
    const team = src.teamOf(s)
    team.answers.q1 = { answer: { type: 'code', lang: 'cpp', files: { 'main.cpp': 'int main() {}\n' } }, rev: 1 }
    team.answers.q2 = { answer: { type: 'text', text: '  ' }, rev: 1 }
    expect(buildRows(src, NOW)[0].answered).toEqual([false, false])
    team.answers.q1 = { answer: { type: 'code', lang: 'cpp', files: { 'main.cpp': 'int main() { return 1; }\n' } }, rev: 2 }
    team.submissions.q2 = { answer: { type: 'text', text: '' }, at: NOW, by: 'Ana' }
    expect(buildRows(src, NOW)[0].answered).toEqual([true, true])
  })

  test('última atividade é o mais recente entre batida, entrega e alerta', () => {
    const s = student('a', 'Ana', { lastBeat: NOW - 90_000, finishedAt: NOW - 60_000 })
    const row = buildRows(source([s]), NOW)[0]
    expect(row.last).toBe(NOW - 60_000)
    expect(row.lastLabel).toBe('há 1 min')
  })

  test('a assinatura muda só quando algo visível muda', () => {
    const s = student('a', 'Ana')
    const src = source([s])
    const first = buildRows(src, NOW)[0].sig
    s.lastBeat = NOW + 2000
    expect(buildRows(src, NOW + 2000)[0].sig).toBe(first)
    s.alerts = 1
    expect(buildRows(src, NOW + 2000)[0].sig).not.toBe(first)
  })
})

describe('filtros', () => {
  const src = source(
    [
      student('a1', 'Júlia Souza', { groupId: 'az', enrollment: '2023001', alerts: 2 }),
      student('b2', 'Bruno', { online: false }),
      student('c3', 'Caio', { status: { screen: false, fullscreen: false, focused: true, isolated: true, extended: false } }),
    ],
    'group',
  )
  const julia = src.teamOf(src.students.get('a1')!)
  julia.grades.q1 = { questionId: 'q1', status: 'done', points: 5, max: 5 }
  julia.answers.q1 = { answer: { type: 'code', lang: 'cpp', files: { 'main.cpp': 'feito' } }, rev: 1 }
  src.teamOf(src.students.get('c3')!).answers.q2 = { answer: { type: 'text', text: 'oi' }, rev: 1 }
  const rows = buildRows(src, NOW)
  const ids = (q: Partial<RosterQuery>) => filterRows(rows, query(q), ['q1', 'q2']).map((r) => r.id)

  test('texto por nome, matrícula, id e equipe, sem acento', () => {
    expect(ids({ text: 'julia' })).toEqual(['a1'])
    expect(ids({ text: '2023' })).toEqual(['a1'])
    expect(ids({ text: 'b2' })).toEqual(['b2'])
    expect(ids({ text: 'azul' })).toEqual(['a1'])
  })

  test('status somam entre si; os outros grupos restringem', () => {
    expect(ids({ filters: ['online', 'offline'] })).toEqual(['a1', 'b2'])
    expect(ids({ filters: ['noscreen'] })).toEqual(['c3'])
    expect(ids({ filters: ['online', 'alerts'] })).toEqual(['a1'])
    expect(ids({ filters: ['offline', 'alerts'] })).toEqual([])
  })

  test('sem resposta e com nota olham a prova inteira', () => {
    expect(ids({ filters: ['empty'] })).toEqual(['b2'])
    expect(ids({ filters: ['graded'] })).toEqual(['a1'])
  })

  test('com questão escolhida, sem resposta e com nota olham só ela; sozinha, quem respondeu', () => {
    expect(ids({ question: 'q2' })).toEqual(['c3'])
    expect(ids({ question: 'q2', filters: ['empty'] })).toEqual(['a1', 'b2'])
    expect(ids({ question: 'q1', filters: ['graded'] })).toEqual(['a1'])
    expect(ids({ question: 'q2', filters: ['graded'] })).toEqual([])
  })

  test('questão que não existe na prova é ignorada', () => {
    expect(ids({ question: 'zz' })).toEqual(['a1', 'b2', 'c3'])
  })
})

describe('ordem', () => {
  const src = source([student('a', 'Bia', { alerts: 1 }), student('b', 'ana', { alerts: 3, online: false }), student('c', 'Caio', { alerts: 3 })])
  src.teamOf(src.students.get('a')!).grades.q1 = { questionId: 'q1', status: 'done', points: 2, max: 5 }
  src.teamOf(src.students.get('c')!).grades.q1 = { questionId: 'q1', status: 'done', points: 5, max: 5 }
  const rows = buildRows(src, NOW)
  const names = (key: string, dir: 'asc' | 'desc') => sortRows(rows, { key, dir }, ['q1', 'q2']).map((r) => r.name)

  test('nome em ordem alfabética do português, sem diferenciar maiúscula', () => {
    expect(names('name', 'asc')).toEqual(['ana', 'Bia', 'Caio'])
    expect(names('name', 'desc')).toEqual(['Caio', 'Bia', 'ana'])
  })

  test('número desempata pelo nome', () => {
    expect(names('alerts', 'desc')).toEqual(['ana', 'Caio', 'Bia'])
  })

  test('questão pela posição dela na prova', () => {
    expect(sortRows(rows, { key: 'q:q1', dir: 'desc' }, ['q0', 'q1']).map((r) => r.name)).toEqual(['ana', 'Bia', 'Caio'])
  })

  test('vazio fica sempre no fim', () => {
    expect(names('q:q1', 'desc')).toEqual(['Caio', 'Bia', 'ana'])
    expect(names('q:q1', 'asc')).toEqual(['Bia', 'Caio', 'ana'])
    expect(names('total', 'asc')).toEqual(['Bia', 'Caio', 'ana'])
  })

  test('status: problema primeiro', () => {
    expect(names('presence', 'asc')).toEqual(['ana', 'Bia', 'Caio'])
  })

  test('clicar de novo inverte; coluna nova começa no sentido dela', () => {
    expect(nextSort({ key: 'name', dir: 'asc' }, 'name')).toEqual({ key: 'name', dir: 'desc' })
    expect(nextSort({ key: 'name', dir: 'asc' }, 'total')).toEqual({ key: 'total', dir: 'desc' })
    expect(nextSort({ key: 'total', dir: 'desc' }, 'team')).toEqual({ key: 'team', dir: 'asc' })
  })
})

describe('URL', () => {
  test('ida e volta, sem perder outros parâmetros', () => {
    const params = writeQuery(new URLSearchParams('demo=100'), {
      query: query({ text: 'júlia', filters: ['online', 'alerts'], question: 'q1' }),
      sort: { key: 'q:q1', dir: 'desc' },
      view: 'results',
    })
    expect(params.get('demo')).toBe('100')
    expect(readQuery(params)).toEqual({
      query: { text: 'júlia', filters: ['online', 'alerts'], question: 'q1' },
      sort: { key: 'q:q1', dir: 'desc' },
      view: 'results',
    })
  })

  test('o padrão não aparece na URL', () => {
    const params = writeQuery(new URLSearchParams('busca=x&filtro=online'), { query: query(), sort: { key: 'name', dir: 'asc' }, view: null })
    expect(params.toString()).toBe('')
  })

  test('lixo na URL vira o padrão', () => {
    expect(readQuery(new URLSearchParams('filtro=nada,online&ordem=x.y&vista=zz'))).toEqual({
      query: { text: '', filters: ['online'], question: null },
      sort: { key: 'name', dir: 'asc' },
      view: null,
    })
  })
})

describe('CSV', () => {
  test('linhas como estão na tela, com fórmula neutralizada e vazio em branco', () => {
    const src = source([student('a', '=SOMA(1)', { enrollment: '9', alerts: 1, lastBeat: Date.UTC(2026, 10, 4, 12) })])
    src.teamOf(src.students.get('a')!).grades.q1 = { questionId: 'q1', status: 'done', points: 5, max: 5 }
    const csv = rowsCsv(buildRows(src, NOW), exam.questions, 'individual')
    expect(csv.split('\n')).toEqual([
      '"aluno";"matricula";"status";"q1";"q2";"total";"alertas";"ultima_atividade"',
      `"'=SOMA(1)";"9";"online";"5";"";"5";"1";"2026-11-04T12:00:00.000Z"`,
    ])
  })

  test('em equipe leva a coluna da equipe', () => {
    const src = source([student('a', 'Ana', { groupId: 'az' })], 'group')
    expect(rowsCsv(buildRows(src, NOW), exam.questions, 'group').split('\n')[0]).toStartWith('"aluno";"matricula";"equipe";"status"')
  })
})

describe('última atividade', () => {
  test('agora, minutos, e a hora depois de uma hora', () => {
    expect(activityLabel(0, NOW)).toBe('—')
    expect(activityLabel(NOW - 20_000, NOW)).toBe('agora')
    expect(activityLabel(NOW - 5 * 60_000, NOW)).toBe('há 5 min')
    expect(activityLabel(NOW - 2 * 3600_000, NOW)).toMatch(/^\d\d:\d\d$/)
  })
})
