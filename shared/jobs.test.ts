import { describe, expect, test } from 'bun:test'
import { JobQueue } from './jobs'

function deferred() {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

// Um trabalho que só termina quando o teste manda, e registra quando começou.
function job(log: string[], name: string) {
  const d = deferred()
  return {
    done: d,
    run: () => {
      log.push(name)
      return d.promise
    },
  }
}

describe('fila de testes e correção', () => {
  test('um teste pendente por equipe: o segundo é recusado, rodando ou esperando', async () => {
    const log: string[] = []
    const q = new JobQueue({ running: 1, compiling: 1 })
    const a = job(log, 'a1')
    const blocker = job(log, 'x')
    expect(q.push({ lane: 'test', key: 'x', compile: false, run: blocker.run }).ok).toBe(true)
    expect(q.push({ lane: 'test', key: 'a', compile: false, run: a.run })).toEqual({ ok: true, position: 1 })
    expect(q.push({ lane: 'test', key: 'a', compile: false, run: job(log, 'a2').run })).toEqual({ ok: false, reason: 'busy' })
    blocker.done.resolve()
    await tick()
    expect(log).toEqual(['x', 'a1'])
    expect(q.push({ lane: 'test', key: 'a', compile: false, run: job(log, 'a3').run }).ok).toBe(false)
    a.done.resolve()
    await tick()
    expect(q.push({ lane: 'test', key: 'a', compile: false, run: job(log, 'a4').run }).ok).toBe(true)
    await tick()
    expect(log).toEqual(['x', 'a1', 'a4'])
  })

  test('correção final passa na frente dos testes que esperam', async () => {
    const log: string[] = []
    const q = new JobQueue({ running: 1, compiling: 1 })
    const first = job(log, 't1')
    q.push({ lane: 'test', key: 't1', compile: false, run: first.run })
    q.push({ lane: 'test', key: 't2', compile: false, run: job(log, 't2').run })
    q.push({ lane: 'grade', compile: true, run: job(log, 'g1').run })
    first.done.resolve()
    await tick()
    expect(log).toEqual(['t1', 'g1'])
  })

  test('respeita o limite de execuções simultâneas', async () => {
    const log: string[] = []
    const q = new JobQueue({ running: 2, compiling: 2 })
    const jobs = ['a', 'b', 'c'].map((k) => job(log, k))
    jobs.forEach((j, i) => q.push({ lane: 'test', key: String(i), compile: false, run: j.run }))
    await tick()
    expect(log).toEqual(['a', 'b'])
    jobs[1].done.resolve()
    await tick()
    expect(log).toEqual(['a', 'b', 'c'])
  })

  test('compilação tem limite próprio, e o executável pronto passa na frente', async () => {
    const log: string[] = []
    const q = new JobQueue({ running: 3, compiling: 1 })
    const g1 = job(log, 'g1')
    q.push({ lane: 'grade', compile: true, run: g1.run })
    q.push({ lane: 'grade', compile: true, run: job(log, 'g2').run })
    q.push({ lane: 'test', key: 'w', compile: false, run: job(log, 'wasm').run })
    await tick()
    expect(log).toEqual(['g1', 'wasm'])
    g1.done.resolve()
    await tick()
    expect(log).toEqual(['g1', 'wasm', 'g2'])
  })

  test('avisa a posição de cada um, e zero quando começa', async () => {
    const seen: [string, number][] = []
    const log: string[] = []
    const q = new JobQueue({ running: 1, compiling: 1 }, (key, position) => seen.push([key, position]))
    const a = job(log, 'a')
    const b = job(log, 'b')
    q.push({ lane: 'test', key: 'a', compile: false, run: a.run })
    q.push({ lane: 'test', key: 'b', compile: false, run: b.run })
    q.push({ lane: 'test', key: 'c', compile: false, run: job(log, 'c').run })
    expect(q.position('b')).toBe(1)
    expect(q.position('c')).toBe(2)
    seen.length = 0
    a.done.resolve()
    await tick()
    expect(seen).toEqual([
      ['b', 0],
      ['c', 1],
    ])
    expect(q.position('c')).toBe(1)
    expect(q.position('a')).toBeNull()
  })

  test('um trabalho que falha libera a vaga', async () => {
    const log: string[] = []
    const q = new JobQueue({ running: 1, compiling: 1 })
    const bad = job(log, 'bad')
    q.push({ lane: 'test', key: 'a', compile: false, run: bad.run })
    q.push({ lane: 'test', key: 'b', compile: false, run: job(log, 'b').run })
    bad.done.reject(new Error('morreu'))
    await tick()
    await tick()
    expect(log).toEqual(['bad', 'b'])
    expect(q.push({ lane: 'test', key: 'a', compile: false, run: job(log, 'a2').run }).ok).toBe(true)
  })

  test('um trabalho que lança na hora também libera a vaga', async () => {
    const log: string[] = []
    const q = new JobQueue({ running: 1, compiling: 1 })
    q.push({ lane: 'test', key: 'a', compile: false, run: () => { throw new Error('na hora') } })
    q.push({ lane: 'test', key: 'b', compile: false, run: job(log, 'b').run })
    await tick()
    expect(log).toEqual(['b'])
  })
})
