import { describe, expect, test } from 'bun:test'
import { ExamDoc } from '../collab/examDoc'
import { RoomStore, type KV, type RoomState } from './roomStore'
import type { Student } from './room'

// Guarda em memória e conta o que cada salvamento escreveu, chave por chave.
class MemoryKV implements KV {
  data = new Map<string, unknown>()
  writes: string[][] = []
  fail = false
  async get<T>(key: string) {
    return structuredClone(this.data.get(key)) as T | undefined
  }
  async putMany(entries: [string, unknown][]) {
    if (this.fail) throw new Error('disco cheio')
    this.writes.push(entries.map(([k]) => k))
    for (const [k, v] of entries) this.data.set(k, structuredClone(v))
  }
  async entries(prefix: string) {
    return [...this.data].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)] as [string, unknown])
  }
  get last() {
    return this.writes.at(-1) ?? []
  }
}

const student = (clientId: string, extra: Partial<Student> = {}): Student => ({
  clientId,
  name: clientId,
  tokenHash: 'h',
  examGranted: false,
  peer: 'p1',
  online: true,
  examSent: false,
  status: { screen: true, fullscreen: true, focused: true, isolated: null, extended: false },
  lastBeat: 1,
  signalLost: false,
  alerts: 0,
  lastEvent: 0,
  lastRec: 0,
  chainBroken: false,
  segments: {},
  ...extra,
})

function state(): RoomState {
  return {
    config: { roomId: 'r1', title: 'Prova' } as RoomState['config'],
    exam: { version: 1, title: 'Prova', durationMin: 30, questions: [], big: 'x'.repeat(1000) } as unknown as RoomState['exam'],
    solutions: null,
    phase: 'lobby',
    endsAt: null,
    roomCode: 'ABC123',
    roomKey: 'chave',
    salt: 'sal',
    hasPassword: false,
    teamCodes: [],
    identity: { publicRaw: 'pub' } as unknown as RoomState['identity'],
    clocks: {},
    createdAt: 5,
    students: [student('a')],
    teams: [{ key: 's:a', answers: {}, submissions: {}, grades: {} }],
    alerts: [],
  }
}

describe('RoomStore', () => {
  test('o estático vai uma vez; depois só o que mudou', async () => {
    const kv = new MemoryKV()
    const store = new RoomStore('r1', kv)
    const s = state()
    const docs = new Map<string, ExamDoc>()
    await store.save(s, docs)
    expect(kv.last.sort()).toEqual(['room:r1', 'room:r1:alerts', 'room:r1:students', 'room:r1:teams'])
    await store.save(s, docs)
    expect(kv.writes.length).toBe(1)
    // Batimento e conexão mudam o tempo todo e não valem nada depois de um F5: não contam como mudança.
    s.students[0].lastBeat = 99
    s.students[0].online = false
    await store.save(s, docs)
    expect(kv.writes.length).toBe(1)
    s.students[0].lastRec = 3
    await store.save(s, docs)
    expect(kv.last).toEqual(['room:r1:students'])
    s.phase = 'running'
    await store.save(s, docs)
    expect(kv.last).toEqual(['room:r1'])
  })

  test('documento de equipe só é gravado quando muda, em binário', async () => {
    const kv = new MemoryKV()
    const store = new RoomStore('r1', kv)
    const s = state()
    const a = new ExamDoc()
    const b = new ExamDoc()
    a.seed('q1', 'cpp', 'main.cpp', 'int main() {}')
    const docs = new Map([
      ['s:a', a],
      ['s:b', b],
    ])
    await store.save(s, docs)
    expect(kv.last).toContain('room:r1:doc:s:a')
    expect(kv.last).toContain('room:r1:doc:s:b')
    await store.save(s, docs)
    expect(kv.writes.length).toBe(1)
    a.files('q1').get('main.cpp')!.insert(0, '// ')
    await store.save(s, docs)
    expect(kv.last).toEqual(['room:r1:doc:s:a'])
    expect(kv.data.get('room:r1:doc:s:a')).toBeInstanceOf(Uint8Array)
  })

  test('volta do disco igual, com o documento pronto para o docOf', async () => {
    const kv = new MemoryKV()
    const s = state()
    const doc = new ExamDoc()
    doc.seed('q1', 'cpp', 'main.cpp', 'abc')
    await new RoomStore('r1', kv).save(s, new Map([['s:a', doc]]))
    const loaded = await new RoomStore('r1', kv).load()
    expect(loaded?.students[0].clientId).toBe('a')
    expect(loaded?.phase).toBe('lobby')
    const back = new ExamDoc()
    back.apply(Uint8Array.from(atob(loaded!.teams[0].doc!), (c) => c.charCodeAt(0)))
    expect(back.snapshot('q1')?.files['main.cpp']).toBe('abc')
  })

  test('sala salva no formato antigo carrega e migra no primeiro salvamento', async () => {
    const kv = new MemoryKV()
    const doc = new ExamDoc()
    doc.seed('q1', 'cpp', 'main.cpp', 'antigo')
    const b64 = btoa(String.fromCharCode(...doc.encodeState()))
    const { students, teams, alerts, ...rest } = state()
    kv.data.set('room:r1', { ...rest, students, teams: [{ ...teams[0], doc: b64 }], alerts })
    const store = new RoomStore('r1', kv)
    const loaded = await store.load()
    expect(loaded?.students.map((x) => x.clientId)).toEqual(['a'])
    expect(loaded?.teams[0].doc).toBe(b64)
    await store.save(loaded!, new Map())
    // Tudo numa escrita só: ou a sala está no formato novo inteira, ou no antigo inteira.
    expect(kv.writes.length).toBe(1)
    expect(kv.last).toContain('room:r1:doc:s:a')
    const again = await new RoomStore('r1', kv).load()
    expect(again?.teams[0].doc).toBe(b64)
    expect((kv.data.get('room:r1') as { students?: unknown }).students).toBeUndefined()
  })

  test('falha ao gravar não marca como salvo: a próxima vez tenta de novo', async () => {
    const kv = new MemoryKV()
    const store = new RoomStore('r1', kv)
    const s = state()
    kv.fail = true
    await expect(store.save(s, new Map())).rejects.toThrow('disco cheio')
    kv.fail = false
    await store.save(s, new Map())
    expect(kv.last.sort()).toEqual(['room:r1', 'room:r1:alerts', 'room:r1:students', 'room:r1:teams'])
  })
})
