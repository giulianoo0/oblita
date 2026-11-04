import { describe, expect, test } from 'bun:test'
import { BEACON, BEACON_CODES, beaconCells, decodeBeacon, randomBeaconCode } from './beacon'

const reader = (code: number, black = 0, white = 255) => {
  const cells = beaconCells(code)
  return (col: number, row: number) => (cells[row][col] ? white : black)
}

describe('selo', () => {
  test('todos os códigos fazem ida e volta', () => {
    for (let code = 0; code < BEACON_CODES; code++) expect(decodeBeacon(reader(code))).toBe(code)
  })

  test('tem o tamanho declarado', () => {
    const cells = beaconCells(0)
    expect(cells.length).toBe(BEACON.rows)
    expect(cells[0].length).toBe(BEACON.cols)
  })

  test('aguenta contraste reduzido, como filtro de luz azul', () => {
    for (const code of [0, 1, 341, 682, 1023]) expect(decodeBeacon(reader(code, 40, 190))).toBe(code)
  })

  test('aguenta ruído leve', () => {
    for (const code of [5, 512, 999]) {
      const base = reader(code)
      const noisy = (c: number, r: number) => Math.max(0, Math.min(255, base(c, r) + ((c * 37 + r * 91) % 41) - 20))
      expect(decodeBeacon(noisy)).toBe(code)
    }
  })

  test('tela lisa, sem selo, não decodifica', () => {
    for (const level of [0, 30, 128, 240, 255]) expect(decodeBeacon(() => level)).toBeNull()
  })

  test('cantos invertidos não decodificam', () => {
    const base = reader(77)
    expect(decodeBeacon((c, r) => 255 - base(c, r))).toBeNull()
  })

  test('código aleatório está no intervalo', () => {
    for (let i = 0; i < 200; i++) {
      const code = randomBeaconCode()
      expect(code).toBeGreaterThanOrEqual(0)
      expect(code).toBeLessThan(BEACON_CODES)
    }
  })
})
