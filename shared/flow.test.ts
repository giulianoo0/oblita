import { describe, expect, test } from 'bun:test'
import type { Exam } from './exam'
import { addTime, expiredQuestions, isOpen, isVisible, release, visibleExam, withdraw } from './flow'

const SECRET = 'enunciado-secreto'
const exam: Exam = {
  version: 1,
  title: 'P',
  durationMin: 30,
  questions: [
    { id: 'q1', type: 'code', title: 'Um', statement: `${SECRET}-1`, points: 1, languages: ['c'], starter: { c: 'inicial-secreto' }, samples: [{ stdin: 'e', stdout: 's' }] },
    { id: 'q2', type: 'text', title: 'Dois', statement: `${SECRET}-2`, points: 2 },
  ],
}

describe('livre', () => {
  test('tudo visível e aberto, sem relógio por questão', () => {
    expect(visibleExam(exam, 'free', {}).questions.map((q) => q.id)).toEqual(['q1', 'q2'])
    expect(isOpen('free', undefined, 1e12)).toBe(true)
  })
})

describe('manual', () => {
  test('nada sai antes de liberar: nem título, nem enunciado, nem código inicial', () => {
    const text = JSON.stringify(visibleExam(exam, 'manual', {}))
    for (const leak of [SECRET, 'inicial-secreto', 'Um', 'Dois']) expect(text).not.toContain(leak)
    expect(isOpen('manual', undefined, 0)).toBe(false)
  })

  test('libera só a escolhida', () => {
    const clocks = release({}, 'q2', 1000)
    const sent = visibleExam(exam, 'manual', clocks)
    expect(sent.questions.map((q) => q.id)).toEqual(['q2'])
    expect(JSON.stringify(sent)).not.toContain(`${SECRET}-1`)
  })

  test('liberar no instante zero também vale', () => {
    expect(isVisible('manual', release({}, 'q1', 0).q1)).toBe(true)
  })

  test('sem tempo definido não expira', () => {
    const clocks = release({}, 'q1', 0)
    expect(clocks.q1.endsAt).toBeNull()
    expect(expiredQuestions(clocks, 1e12)).toEqual([])
    expect(isOpen('manual', clocks.q1, 1e12)).toBe(true)
  })

  test('com tempo: fecha na hora e entra na lista para congelar, mas continua visível', () => {
    const clocks = release({}, 'q1', 0, 5)
    const end = 5 * 60_000
    expect(isOpen('manual', clocks.q1, end - 1)).toBe(true)
    expect(isOpen('manual', clocks.q1, end)).toBe(false)
    expect(isVisible('manual', clocks.q1)).toBe(true)
    expect(expiredQuestions(clocks, end - 1)).toEqual([])
    expect(expiredQuestions(clocks, end)).toEqual(['q1'])
    expect(expiredQuestions({ q1: { ...clocks.q1, closed: true } }, end)).toEqual([])
  })

  test('retirar some da tela, e liberar de novo volta', () => {
    const gone = withdraw(release({}, 'q1', 1000, 5), 'q1')
    expect(isVisible('manual', gone.q1)).toBe(false)
    expect(isOpen('manual', gone.q1, 1500)).toBe(false)
    expect(visibleExam(exam, 'manual', gone).questions).toEqual([])
    const back = release(gone, 'q1', 2000)
    expect(isVisible('manual', back.q1)).toBe(true)
    expect(isOpen('manual', back.q1, 1e12)).toBe(true)
    expect(back.q1.releasedAt).toBe(1000)
  })

  test('retirar o que nunca foi liberado não muda nada', () => {
    expect(withdraw({}, 'q1')).toEqual({})
  })

  test('somar tempo reabre, contando de agora se já tinha acabado', () => {
    const clocks = release({}, 'q1', 0, 1)
    expect(addTime(clocks, 'q1', 2, 500000).q1.endsAt).toBe(500000 + 120000)
    expect(addTime(clocks, 'q1', 2, 1000).q1.endsAt).toBe(60000 + 120000)
    expect(addTime({ q1: { ...clocks.q1, closed: true } }, 'q1', 2, 500000).q1.closed).toBe(false)
    expect(addTime(release({}, 'q1', 0), 'q1', 2, 1).q1.endsAt).toBeNull()
    expect(addTime({}, 'q1', 2, 1)).toEqual({})
  })
})
