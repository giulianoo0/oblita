import { describe, expect, test } from 'bun:test'
import { validateExam } from './exam'

const png = 'data:image/png;base64,iVBORw0KGgo='
const exam = (statement: string) => ({ version: 1, title: 'P', durationMin: 10, questions: [{ id: 'q1', type: 'text', title: 'T', statement, points: 1 }] })

describe('imagem no enunciado', () => {
  test('embutida passa', () => {
    expect(validateExam(exam(`Veja: ![grafo](${png})`)).errors).toEqual([])
  })
  test('endereço externo é recusado, porque não abriria sem internet', () => {
    expect(validateExam(exam('![a](https://x.test/a.png)')).errors.length).toBe(1)
  })
  test('svg é recusado, porque pode carregar script', () => {
    expect(validateExam(exam('![a](data:image/svg+xml;base64,AAAA)')).errors.length).toBe(1)
  })
  test('prova grande demais é recusada', () => {
    expect(validateExam(exam(`![a](data:image/png;base64,${'A'.repeat(13 * 1024 * 1024)})`)).errors[0]).toContain('12 MB')
  })
})
