// Selo visual: um código desenhado na tela e lido de volta na captura real, pelo professor.
export const BEACON = { cols: 7, rows: 2, cellVw: 1 } as const

const DATA_BITS = 10
export const BEACON_CODES = 1 << DATA_BITS

// Quatro cantos fixos permitem medir o preto e o branco da própria imagem,
// o que absorve brilho, perfil de cor e o filtro de luz azul do sistema.
const CORNERS: Record<string, boolean> = { '0,0': false, '6,0': true, '0,1': true, '6,1': false }

const isCorner = (col: number, row: number) => `${col},${row}` in CORNERS

export function beaconCells(code: number): boolean[][] {
  let bit = 0
  return Array.from({ length: BEACON.rows }, (_, row) =>
    Array.from({ length: BEACON.cols }, (_, col) => (isCorner(col, row) ? CORNERS[`${col},${row}`] : ((code >> bit++) & 1) === 1)),
  )
}

// read devolve a luminância (0 a 255) no centro da célula.
export function decodeBeacon(read: (col: number, row: number) => number): number | null {
  const dark = [read(0, 0), read(6, 1)]
  const light = [read(6, 0), read(0, 1)]
  const low = Math.max(...dark)
  const high = Math.min(...light)
  if (high - low < 64) return null
  const threshold = (low + high) / 2
  let code = 0
  let bit = 0
  for (let row = 0; row < BEACON.rows; row++) {
    for (let col = 0; col < BEACON.cols; col++) {
      if (isCorner(col, row)) continue
      if (read(col, row) > threshold) code |= 1 << bit
      bit++
    }
  }
  return code
}

export function randomBeaconCode() {
  return crypto.getRandomValues(new Uint16Array(1))[0] % BEACON_CODES
}
