import { describe, expect, test } from 'bun:test'
import { highlight, matchesText, normalize } from './search'

describe('normalize', () => {
  test('tira acento e maiúscula', () => {
    expect(normalize('João ÁVILA Çé')).toBe('joao avila ce')
  })
})

describe('matchesText', () => {
  test('cada palavra precisa aparecer em algum lugar, sem acento e sem maiúscula', () => {
    const hay = normalize('Júlia Souza 2023001 Equipe Azul')
    expect(matchesText(hay, 'julia')).toBe(true)
    expect(matchesText(hay, 'AZUL  júl')).toBe(true)
    expect(matchesText(hay, 'julia verde')).toBe(false)
  })

  test('busca vazia casa com todos', () => {
    expect(matchesText('qualquer', '   ')).toBe(true)
  })
})

describe('highlight', () => {
  test('marca o trecho no texto original, mesmo com acento', () => {
    expect(highlight('Júlia Souza', 'juli')).toEqual([
      { text: 'Júli', hit: true },
      { text: 'a Souza', hit: false },
    ])
  })

  test('marca cada palavra e junta trechos que se encostam', () => {
    expect(highlight('Ana Ana', 'an na')).toEqual([
      { text: 'Ana', hit: true },
      { text: ' ', hit: false },
      { text: 'Ana', hit: true },
    ])
  })

  test('sem busca ou sem achado, devolve o texto inteiro', () => {
    expect(highlight('Ana', '')).toEqual([{ text: 'Ana', hit: false }])
    expect(highlight('Ana', 'zé')).toEqual([{ text: 'Ana', hit: false }])
  })

  test('letra decomposta na entrada não desalinha o recorte', () => {
    const decomposed = 'José Lima'
    expect(highlight(decomposed, 'lima')).toEqual([
      { text: 'José ', hit: false },
      { text: 'Lima', hit: true },
    ])
  })
})
