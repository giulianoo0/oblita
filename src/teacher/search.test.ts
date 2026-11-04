import { describe, expect, test } from 'bun:test'
import { highlight, normalize, settleEcho, words } from './search'

describe('normalize', () => {
  test('tira acento e maiúscula', () => {
    expect(normalize('João ÁVILA Çé')).toBe('joao avila ce')
  })
})

describe('words', () => {
  test('palavras da busca, normalizadas, sem vazias', () => {
    expect(words('  AZUL  Júl ')).toEqual(['azul', 'jul'])
    expect(words('   ')).toEqual([])
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

describe('eco do campo de busca', () => {
  test('valor que o campo mandou volta atrasado e não apaga o que já foi digitado', () => {
    expect(settleEcho(['b', 'be', 'bea', 'beat'], 'bea')).toEqual({ pending: ['beat'], external: false })
  })

  test('transição que pula valores intermediários também é eco', () => {
    expect(settleEcho(['a', 'ab', 'abc'], 'abc')).toEqual({ pending: [], external: false })
  })

  test('valor que o campo nunca mandou veio de fora (limpar), e o campo segue ele', () => {
    expect(settleEcho(['an', 'ana'], '')).toEqual({ pending: [], external: true })
  })

  test('apagar tudo e digitar de novo: o vazio atrasado ainda é eco', () => {
    expect(settleEcho(['a', '', 'x'], '')).toEqual({ pending: ['x'], external: false })
  })
})
