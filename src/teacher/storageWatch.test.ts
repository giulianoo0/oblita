import { describe, expect, test } from 'bun:test'
import { RecRate, spaceWarning } from './storageWatch'

const GB = 1024 ** 3

describe('aviso de espaço', () => {
  test('folga grande não avisa', () => {
    expect(spaceWarning(100 * GB, 5_000_000)).toBeNull()
    expect(spaceWarning(null, 5_000_000)).toBeNull()
  })

  test('menos de 2 GB avisa mesmo sem gravação', () => {
    expect(spaceWarning(1.5 * GB, 0)).toMatch(/1,5 GB livres/)
  })

  test('menos de 30 min no ritmo atual avisa com a previsão', () => {
    // 100 alunos a 400 kbps: 5 MB/s, e 6 GB duram uns 20 min.
    expect(spaceWarning(6 * GB, 5_000_000)).toMatch(/cerca de 21 min/)
    expect(spaceWarning(20 * GB, 5_000_000)).toBeNull()
  })

  test('disco cheio vira estado próprio', () => {
    expect(spaceWarning(0, 1000)).toMatch(/cheio/)
  })
})

describe('ritmo de gravação', () => {
  test('média da janela, esquecendo o que passou dela', () => {
    const rate = new RecRate(10_000)
    rate.add(1000, 0)
    rate.add(1000, 5000)
    expect(rate.perSecond(10_000)).toBe(200)
    expect(rate.perSecond(30_000)).toBe(0)
  })
})
