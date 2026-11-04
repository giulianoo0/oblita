import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { hashFiles, issueReceipt, parseBody } from '../../shared/receipt'
import { newTeacherIdentity } from '../../shared/secure'
import { roomFolder, roomLayout, type LayoutRoom } from './layout'
import type { Student, Team } from './room'

const exam = {
  version: 1,
  title: 'Prova',
  durationMin: 30,
  questions: [
    { id: 'q1', type: 'code', title: 'Soma', statement: 's', points: 5, languages: ['cpp'] },
    { id: 'q2', type: 'text', title: 'Texto', statement: 't', points: 3 },
  ],
} as LayoutRoom['exam']

function student(clientId: string, name: string, extra: Partial<Student> = {}): Student {
  return {
    clientId,
    name,
    tokenHash: 'SEGREDO',
    examGranted: true,
    peer: null,
    online: false,
    examSent: true,
    status: { screen: true, fullscreen: true, focused: true, isolated: true, extended: false },
    lastBeat: 0,
    signalLost: false,
    alerts: 0,
    lastEvent: 0,
    lastRec: 0,
    chainBroken: false,
    segments: {},
    ...extra,
  }
}

function fakeRoom(students: Student[]): LayoutRoom {
  const teams = new Map<string, Team>()
  const room: LayoutRoom = {
    config: { roomId: 'r', title: 'Prova', mode: 'individual', timing: 'global', compiler: true, requireIsolation: false, recordScreen: true, maxTeamSize: 1, groups: [] } as unknown as LayoutRoom['config'],
    exam,
    students: new Map(students.map((s) => [s.clientId, s])),
    teams,
    alerts: [],
    teamOf: (s) => {
      const key = `s:${s.clientId}`
      if (!teams.has(key)) teams.set(key, { key, answers: {}, submissions: {}, grades: {} })
      return teams.get(key)!
    },
    scoreOf: () => ({ earned: 0, total: 8, pending: 0 }),
    resultsCsv: () => 'nome',
    fingerprint: 'H8A-NRA',
  }
  return room
}

describe('comprovante na exportação', () => {
  const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
  const answers = {
    q1: { type: 'code', lang: 'c', files: { 'main.c': 'int main(){}\n', 'lib/util.h': '#pragma once\n' } },
    q2: { type: 'text', text: 'ação\n' },
  } as const

  async function exported() {
    const receipt = await issueReceipt(await newTeacherIdentity(), { roomId: 'r', title: 'Prova', name: 'Ana', at: 1000, files: await hashFiles(answers) })
    const ana = student('aaaa', 'Ana', { receipts: [receipt] })
    const room = fakeRoom([ana])
    const team = room.teamOf(ana)
    team.submissions.q1 = { answer: answers.q1 as never, at: 1000, by: 'Ana' }
    team.submissions.q2 = { answer: answers.q2, at: 1000, by: 'Ana' }
    const files = new Map(roomLayout(room).flat().flatMap((e) => ('text' in e ? [[e.path, e.text()] as const] : [])))
    return { receipt: parseBody(receipt), files }
  }

  test('cada arquivo exportado confere com o sha256 do comprovante', async () => {
    const { receipt, files } = await exported()
    expect(receipt.files.length).toBe(3)
    for (const [path, hash] of receipt.files) expect(sha(files.get(`alunos/Ana/${path}`)!)).toBe(hash)
  })

  test('o texto do comprovante e o índice saem junto', async () => {
    const { receipt, files } = await exported()
    const text = files.get('alunos/Ana/comprovante.txt')!
    expect(text).toContain(receipt.id)
    expect(text).toContain(receipt.checksum)
    expect(text).toContain('H8A-NRA')
    expect(sha(receipt.files.map(([path, hash]) => `${hash}  ${path}\n`).join(''))).toBe(receipt.checksum)
    const csv = files.get('comprovantes.csv')!
    expect(csv).toContain(receipt.id)
    expect(csv).toContain(receipt.checksum)
    expect(csv).toContain('sim')
  })

  test('sem comprovante, a pasta não ganha o arquivo', () => {
    const room = fakeRoom([student('aaaa', 'Ana')])
    const paths = roomLayout(room).flat().map((e) => e.path)
    expect(paths.some((path) => path.endsWith('comprovante.txt'))).toBe(false)
  })
})

describe('pasta da sala', () => {
  test('título e data, com nome seguro', () => {
    const at = new Date(2026, 10, 4, 14, 30).getTime()
    expect(roomFolder('Prova de C', at)).toBe('Prova de C 2026-11-04 14h30')
    expect(roomFolder('../../CON', at)).toBe('__.._CON 2026-11-04 14h30')
    expect(roomFolder('aux', at)).toBe('_aux 2026-11-04 14h30')
  })
})

describe('estrutura', () => {
  test('mesmos caminhos do zip, com gravação por segmento e texto por arquivo', () => {
    const ana = student('aaaa', 'Ana', {
      enrollment: '1',
      segments: { 0: { segment: 0, startedAt: 1, mime: 'video/webm', parts: 1, size: 3, complete: true }, 1: { segment: 1, startedAt: 2, mime: 'video/mp4', parts: 1, size: 3, complete: false } },
    })
    const room = fakeRoom([ana, student('bbbb', 'Ana', { enrollment: '1' })])
    room.teamOf(ana).answers.q1 = { answer: { type: 'code', lang: 'cpp', files: { 'main.cpp': 'int main(){}' } }, rev: 1 }
    const units = roomLayout(room)
    const paths = units.flat().map((e) => e.path)
    expect(paths).toContain('resumo.csv')
    expect(paths).toContain('prova.json')
    expect(paths).toContain('alunos/Ana (1)/q1/main.cpp')
    expect(paths).toContain('alunos/Ana (1)/q2/sem-resposta.txt')
    expect(paths).toContain('alunos/Ana (1) (2)/alertas.csv')
    const seg = units.flat().find((e) => e.path === 'alunos/Ana (1)/gravacao/0001.mp4')
    expect(seg && 'segment' in seg && seg.segment.clientId).toBe('aaaa')
    expect(paths).toContain('alunos/Ana (1)/gravacao/0000.webm')
    expect(units.length).toBe(3)
    const prova = units[0].find((e) => e.path === 'prova.json')
    // A prova não muda depois de criada: o disco a grava uma vez só, pela identidade do objeto.
    expect(prova && 'stamp' in prova && prova.stamp).toBe(exam)
  })

  test('arquivos de código saem com as subpastas', () => {
    const ana = student('aaaa', 'Ana')
    const room = fakeRoom([ana])
    const files = { 'main.cpp': 'm', 'lib/util.h': 'u', 'lib/io/ler.cpp': 'l', 'Lib/b.h': 'b', 'LIB/util.h': 'U' }
    room.teamOf(ana).answers.q1 = { answer: { type: 'code', lang: 'cpp', files }, rev: 1 }
    const out = new Map(roomLayout(room).flat().flatMap((e) => ('text' in e ? [[e.path, e.text()] as const] : [])))
    expect(out.get('alunos/Ana/q1/main.cpp')).toBe('m')
    expect(out.get('alunos/Ana/q1/lib/util.h')).toBe('u')
    expect(out.get('alunos/Ana/q1/lib/io/ler.cpp')).toBe('l')
    // No Windows Lib e lib são a mesma pasta: tudo cai numa só, sem um arquivo cobrir o outro.
    expect(out.get('alunos/Ana/q1/lib/b.h')).toBe('b')
    expect(out.get('alunos/Ana/q1/lib/util (2).h')).toBe('U')
  })

  test('cada nome do caminho passa pelo sanitizador, e pasta não cobre a nota', () => {
    const ana = student('aaaa', 'Ana')
    const room = fakeRoom([ana])
    const files = { '../../fora.c': 'a', 'con/aux.h': 'b', 'nota.txt/x.c': 'c', 'a//b.c': 'd' }
    room.teamOf(ana).answers.q1 = { answer: { type: 'code', lang: 'cpp', files }, rev: 1 }
    const out = new Map(roomLayout(room).flat().flatMap((e) => ('text' in e ? [[e.path, e.text()] as const] : [])))
    const q1 = [...out.keys()].filter((p) => p.startsWith('alunos/Ana/q1/')).sort()
    expect(q1).toEqual(['alunos/Ana/q1/_/_/fora.c', 'alunos/Ana/q1/_con/_aux.h', 'alunos/Ana/q1/a/_/b.c', 'alunos/Ana/q1/nota (2).txt/x.c', 'alunos/Ana/q1/nota.txt'])
    expect(out.get('alunos/Ana/q1/nota.txt')).toBe('sem nota\n')
  })
})
