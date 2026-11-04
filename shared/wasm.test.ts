import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { WASI } from '@bjorn3/browser_wasi_shim'
import { WASI_FUNCTIONS, WASM_LIMITS, checkStudentWasm } from './wasm'

// ---- montador mínimo de módulos, para fabricar os casos maliciosos byte a byte

const enc = new TextEncoder()
const leb = (n: number) => {
  const out: number[] = []
  do {
    let b = n & 0x7f
    n = Math.floor(n / 128)
    if (n) b |= 0x80
    out.push(b)
  } while (n)
  return out
}
const name = (s: string) => [...leb(enc.encode(s).length), ...enc.encode(s)]
const vec = (items: number[][]) => [...leb(items.length), ...items.flat()]
const section = (id: number, body: number[]) => [id, ...leb(body.length), ...body]
const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
const I32 = 0x7f

const TYPES = section(1, vec([[0x60, 0, 0], [0x60, 4, I32, I32, I32, I32, 1, I32]]))
const fdWrite = [...name('wasi_snapshot_preview1'), ...name('fd_write'), 0x00, 1]
const memLimits = (flags: number, min: number, max?: number) => [flags, ...leb(min), ...(max === undefined ? [] : leb(max))]

interface Parts {
  imports?: number[][]
  memories?: number[][]
  tables?: number[][]
  exports?: number[][]
  start?: boolean
  data?: number[][]
  locals?: number[][]
}

const EXPORTS = [
  [...name('_start'), 0x00, 1],
  [...name('memory'), 0x02, 0],
]

function build(p: Parts = {}) {
  const imports = p.imports ?? [fdWrite]
  const funcIndex = imports.length
  return new Uint8Array([
    ...HEADER,
    ...TYPES,
    ...section(2, vec(imports)),
    ...section(3, vec([[0]])),
    ...(p.tables ? section(4, vec(p.tables)) : []),
    ...section(5, vec(p.memories ?? [memLimits(1, 1, 2)])),
    ...section(7, vec(p.exports ?? EXPORTS.map((e, i) => (i === 0 ? [...name('_start'), 0x00, funcIndex] : e)))),
    ...(p.start ? section(8, leb(funcIndex)) : []),
    ...section(10, vec([[...((b: number[]) => [...leb(b.length), ...b])([...vec(p.locals ?? []), 0x0b])]])),
    ...(p.data ? section(11, vec(p.data)) : []),
  ])
}

const reason = (bytes: Uint8Array) => {
  const r = checkStudentWasm(bytes)
  return r.ok ? null : r.reason
}

describe('validação do executável enviado pelo aluno', () => {
  test('o montador gera um módulo válido, e ele passa', () => {
    const ok = build()
    expect(WebAssembly.validate(ok)).toBe(true)
    expect(checkStudentWasm(ok)).toEqual({ ok: true })
  })

  test('saída real do clang em C passa', () => {
    expect(checkStudentWasm(new Uint8Array(readFileSync(new URL('./fixtures/soma.wasm', import.meta.url))))).toEqual({ ok: true })
  })

  test('saída real do clang em C++ com STL passa', () => {
    expect(checkStudentWasm(new Uint8Array(gunzipSync(readFileSync(new URL('./fixtures/contagem.wasm.gz', import.meta.url)))))).toEqual({ ok: true })
  })

  test('a lista de funções da WASI é exatamente a que o shim oferece', () => {
    expect([...WASI_FUNCTIONS].sort()).toEqual(Object.keys(new WASI([], [], []).wasiImport).sort())
  })

  test('cabeçalho errado', () => {
    expect(reason(new Uint8Array([0, 0x61, 0x73, 0x6e, 1, 0, 0, 0]))).toMatch(/WebAssembly/)
    expect(reason(new Uint8Array([0, 0x61, 0x73, 0x6d, 2, 0, 0, 0]))).toMatch(/versão/)
    expect(reason(new Uint8Array([0, 0x61]))).toMatch(/WebAssembly/)
  })

  test('arquivo grande demais', () => {
    const big = new Uint8Array(WASM_LIMITS.maxBytes + 1)
    big.set(build())
    expect(reason(big)).toMatch(/MB/)
  })

  test('memória sem máximo', () => {
    expect(reason(build({ memories: [memLimits(0, 1)] }))).toMatch(/máximo/)
  })

  test('memória com máximo de 4 GB', () => {
    expect(reason(build({ memories: [memLimits(1, 1, 65536)] }))).toMatch(/256 MB/)
  })

  test('memória mínima maior que a máxima', () => {
    expect(reason(build({ memories: [memLimits(1, 10, 2)] }))).not.toBeNull()
  })

  test('memória de 64 bits', () => {
    expect(reason(build({ memories: [memLimits(0x05, 1, 2)] }))).not.toBeNull()
  })

  test('memória compartilhada (threads)', () => {
    expect(reason(build({ memories: [memLimits(0x03, 1, 2)] }))).not.toBeNull()
  })

  test('duas memórias, ou nenhuma', () => {
    expect(reason(build({ memories: [memLimits(1, 1, 2), memLimits(1, 1, 2)] }))).toMatch(/memória/)
    expect(reason(build({ memories: [] }))).toMatch(/memória/)
  })

  test('import fora da WASI', () => {
    expect(reason(build({ imports: [[...name('env'), ...name('qualquer'), 0x00, 1]] }))).toMatch(/env\.qualquer/)
  })

  test('função da WASI que o shim não oferece', () => {
    expect(reason(build({ imports: [[...name('wasi_snapshot_preview1'), ...name('thread_spawn'), 0x00, 1]] }))).toMatch(/thread_spawn/)
  })

  test('memória importada', () => {
    expect(reason(build({ imports: [fdWrite, [...name('wasi_snapshot_preview1'), ...name('memory'), 0x02, ...memLimits(1, 1, 2)]] }))).not.toBeNull()
  })

  test('tabela, global ou tag importadas', () => {
    expect(reason(build({ imports: [[...name('wasi_snapshot_preview1'), ...name('t'), 0x01, 0x70, ...memLimits(1, 1, 2)]] }))).not.toBeNull()
    expect(reason(build({ imports: [[...name('wasi_snapshot_preview1'), ...name('g'), 0x03, I32, 0]] }))).not.toBeNull()
  })

  test('tabela sem máximo ou enorme', () => {
    expect(reason(build({ tables: [[0x70, ...memLimits(0, 1)]] }))).toMatch(/tabela/)
    expect(reason(build({ tables: [[0x70, ...memLimits(1, 1, 10_000_000)]] }))).toMatch(/tabela/)
    expect(reason(build({ tables: [[0x70, ...memLimits(1, 1, 100)]] }))).toBeNull()
  })

  test('sem _start ou sem memory exportada', () => {
    expect(reason(build({ exports: [[...name('memory'), 0x02, 0]] }))).toMatch(/_start/)
    expect(reason(build({ exports: [[...name('_start'), 0x00, 1]] }))).toMatch(/memory/)
  })

  test('seção start, que rodaria antes do relógio começar', () => {
    expect(reason(build({ start: true }))).toMatch(/start/)
  })

  test('dados fora da memória mínima', () => {
    const seg = (offset: number, len: number) => [0x00, 0x41, ...sleb(offset), 0x0b, ...leb(len), ...new Array(len).fill(1)]
    expect(reason(build({ data: [seg(0, 16)] }))).toBeNull()
    expect(reason(build({ data: [seg(65536 - 4, 16)] }))).toMatch(/dados/)
    expect(reason(build({ data: [seg(-8, 4)] }))).toMatch(/dados/)
  })

  test('locais demais numa função', () => {
    expect(reason(build({ locals: [[...leb(1_000_000_000), I32]] }))).toMatch(/locais/)
  })

  test('seção cortada', () => {
    const ok = build()
    expect(reason(ok.subarray(0, ok.length - 3))).not.toBeNull()
    const lie = new Uint8Array([...HEADER, 1, ...leb(5000), 0x01])
    expect(reason(lie)).toMatch(/cortad/)
  })

  test('LEB128 gigante', () => {
    expect(reason(new Uint8Array([...HEADER, 1, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]))).toMatch(/LEB/)
    expect(reason(new Uint8Array([...HEADER, 1, 0xff, 0xff, 0xff, 0xff, 0x7f]))).toMatch(/LEB|cortad/)
  })

  test('seções repetidas ou fora de ordem', () => {
    const ok = build()
    const dup = new Uint8Array([...HEADER, ...TYPES, ...TYPES])
    expect(reason(dup)).toMatch(/ordem/)
    expect(reason(ok)).toBeNull()
    expect(reason(new Uint8Array([...HEADER, ...section(5, vec([memLimits(1, 1, 2)])), ...TYPES]))).toMatch(/ordem/)
    expect(reason(new Uint8Array([...HEADER, ...section(42, [])]))).toMatch(/seção/)
  })

  test('funções demais', () => {
    const many = new Uint8Array([...HEADER, ...TYPES, ...section(3, [...leb(WASM_LIMITS.maxFunctions + 1)])])
    expect(reason(many)).toMatch(/funções/)
  })
})

function sleb(n: number) {
  const out: number[] = []
  for (;;) {
    const b = n & 0x7f
    n >>= 7
    if ((n === 0 && !(b & 0x40)) || (n === -1 && b & 0x40)) {
      out.push(b)
      return out
    }
    out.push(b | 0x80)
  }
}
