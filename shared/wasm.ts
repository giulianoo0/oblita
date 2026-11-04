// O Testar recebe o executável já montado pelo aluno, então o que o nosso clang garantia
// precisa ser conferido aqui, antes de o módulo existir: limite de memória, imports, tamanho.
// Lê só a estrutura das seções; o resto o WebAssembly.compile valida no sandbox.
import { RUN_LIMITS } from './protocol'

const PAGE = 64 * 1024

export const WASM_LIMITS = {
  // C++ com iostream e STL sai com ~650 KB do nosso clang. 8 MB dá folga sem virar depósito.
  maxBytes: 8 * 1024 * 1024,
  maxPages: (RUN_LIMITS.memoryMb * 1024 * 1024) / PAGE,
  maxFunctions: 100_000,
  maxImports: 64,
  maxLocals: 50_000,
  maxTable: 100_000,
} as const

// Exatamente o que o @bjorn3/browser_wasi_shim oferece (há teste conferindo).
export const WASI_FUNCTIONS: ReadonlySet<string> = new Set(
  'args_sizes_get args_get environ_sizes_get environ_get clock_res_get clock_time_get fd_advise fd_allocate fd_close fd_datasync fd_fdstat_get fd_fdstat_set_flags fd_fdstat_set_rights fd_filestat_get fd_filestat_set_size fd_filestat_set_times fd_pread fd_prestat_get fd_prestat_dir_name fd_pwrite fd_read fd_readdir fd_renumber fd_seek fd_sync fd_tell fd_write path_create_directory path_filestat_get path_filestat_set_times path_link path_open path_readlink path_remove_directory path_rename path_symlink path_unlink_file poll_oneoff proc_exit proc_raise sched_yield random_get sock_recv sock_send sock_shutdown sock_accept'.split(' '),
)

// Ordem das seções na especificação; a 12 (contagem de dados) vem antes do código.
const ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 10, 11]

class Bad extends Error {}

class Reader {
  at = 0
  constructor(
    private b: Uint8Array,
    public end = b.length,
  ) {}

  byte() {
    if (this.at >= this.end) throw new Bad('módulo cortado no meio')
    return this.b[this.at++]
  }

  // u32 em no máximo 5 bytes, sem bits sobrando: um LEB128 sem fim não pode prender o laço.
  u32() {
    let result = 0
    for (let i = 0; i < 5; i++) {
      const b = this.byte()
      if (i === 4 && b & 0xf0) throw new Bad('número LEB128 grande demais')
      result += (b & 0x7f) * 2 ** (7 * i)
      if (!(b & 0x80)) return result
    }
    throw new Bad('número LEB128 grande demais')
  }

  // i32 com sinal, só para o deslocamento dos dados.
  s32() {
    let result = 0
    let shift = 0
    for (let i = 0; i < 5; i++) {
      const b = this.byte()
      result |= (b & 0x7f) << shift
      shift += 7
      if (!(b & 0x80)) return shift < 32 && b & 0x40 ? result | (~0 << shift) : result
    }
    throw new Bad('número LEB128 grande demais')
  }

  skip(n: number) {
    if (n > this.end - this.at) throw new Bad('módulo cortado no meio')
    this.at += n
  }

  name() {
    const len = this.u32()
    this.skip(len)
    return new TextDecoder().decode(this.b.subarray(this.at - len, this.at))
  }
}

function limits(r: Reader, what: string) {
  const flags = r.byte()
  // 0x02 é compartilhada (threads) e 0x04 é 64 bits: nada disso sai do nosso compilador.
  if (flags !== 0x00 && flags !== 0x01) throw new Bad(`${what} com formato não suportado`)
  const min = r.u32()
  if (flags === 0x00) throw new Bad(`${what} sem máximo declarado`)
  const max = r.u32()
  if (min > max) throw new Bad(`${what} com mínimo maior que o máximo`)
  return { min, max }
}

export type WasmCheck = { ok: true } | { ok: false; reason: string }

export function checkStudentWasm(bytes: Uint8Array): WasmCheck {
  try {
    check(bytes)
    return { ok: true }
  } catch (err) {
    if (err instanceof Bad) return { ok: false, reason: err.message }
    throw err
  }
}

function check(bytes: Uint8Array) {
  if (bytes.length > WASM_LIMITS.maxBytes) throw new Bad(`O executável passa de ${WASM_LIMITS.maxBytes / 2 ** 20} MB`)
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Bad('Não é um executável WebAssembly')
  if (bytes[4] !== 1 || bytes[5] || bytes[6] || bytes[7]) throw new Bad('Executável WebAssembly de outra versão')
  const r = new Reader(bytes)
  r.at = 8
  let last = -1
  let funcs = 0
  let bodies = -1
  let memories = 0
  let minPages = 0
  const exports = new Map<string, number>()
  while (r.at < bytes.length) {
    const id = r.byte()
    const size = r.u32()
    if (size > bytes.length - r.at) throw new Bad('seção cortada no meio')
    const s = new Reader(bytes, r.at + size)
    s.at = r.at
    r.at += size
    if (id === 0) continue
    const rank = ORDER.indexOf(id)
    if (rank < 0) throw new Bad(`seção desconhecida (${id})`)
    if (rank <= last) throw new Bad('seções repetidas ou fora de ordem')
    last = rank
    switch (id) {
      case 2: {
        const n = s.u32()
        if (n > WASM_LIMITS.maxImports) throw new Bad('imports demais')
        for (let i = 0; i < n; i++) {
          const mod = s.name()
          const field = s.name()
          const kind = s.byte()
          if (mod !== 'wasi_snapshot_preview1' || kind !== 0x00 || !WASI_FUNCTIONS.has(field)) throw new Bad(`O executável pede algo que não existe aqui: ${mod}.${field}`)
          s.u32()
          funcs++
        }
        break
      }
      case 3: {
        const n = s.u32()
        if (funcs + n > WASM_LIMITS.maxFunctions) throw new Bad('funções demais no executável')
        bodies = n
        for (let i = 0; i < n; i++) s.u32()
        break
      }
      case 4: {
        const n = s.u32()
        if (n > 4) throw new Bad('tabelas demais')
        for (let i = 0; i < n; i++) {
          s.byte()
          if (limits(s, 'tabela').max > WASM_LIMITS.maxTable) throw new Bad('tabela grande demais')
        }
        break
      }
      case 5: {
        memories = s.u32()
        if (memories !== 1) throw new Bad('O executável precisa de exatamente uma memória')
        const mem = limits(s, 'memória')
        if (mem.max > WASM_LIMITS.maxPages) throw new Bad(`A memória máxima passa de ${RUN_LIMITS.memoryMb} MB`)
        minPages = mem.min
        break
      }
      case 7: {
        const n = s.u32()
        for (let i = 0; i < n; i++) {
          const field = s.name()
          const kind = s.byte()
          s.u32()
          exports.set(field, kind)
        }
        break
      }
      // Rodaria ao instanciar, antes de o relógio do programa começar a contar.
      case 8:
        throw new Bad('O executável tem seção start')
      case 10: {
        const n = s.u32()
        if (n !== bodies) throw new Bad('número de funções não confere')
        for (let i = 0; i < n; i++) {
          const size = s.u32()
          const end = s.at + size
          if (size > s.end - s.at) throw new Bad('função cortada no meio')
          const groups = s.u32()
          let locals = 0
          for (let g = 0; g < groups; g++) {
            locals += s.u32()
            s.byte()
            if (locals > WASM_LIMITS.maxLocals) throw new Bad('variáveis locais demais numa função')
          }
          if (end < s.at) throw new Bad('função cortada no meio')
          s.at = end
        }
        break
      }
      case 11: {
        const n = s.u32()
        for (let i = 0; i < n; i++) {
          const flags = s.u32()
          if (flags === 1) {
            s.skip(s.u32())
            continue
          }
          if (flags === 2 && s.u32() !== 0) throw new Bad('dados para uma memória que não existe')
          if (flags !== 0 && flags !== 2) throw new Bad('segmento de dados com formato não suportado')
          // Só deslocamento constante: é o que o nosso clang gera, e dá para conferir aqui.
          if (s.byte() !== 0x41) throw new Bad('segmento de dados com deslocamento não suportado')
          const offset = s.s32()
          if (s.byte() !== 0x0b) throw new Bad('segmento de dados com deslocamento não suportado')
          const len = s.u32()
          s.skip(len)
          if (offset < 0 || offset + len > minPages * PAGE) throw new Bad('segmento de dados fora da memória')
        }
        break
      }
      default:
        continue
    }
    if (s.at !== s.end) throw new Bad('seção com tamanho errado')
  }
  if (memories !== 1) throw new Bad('O executável precisa de exatamente uma memória')
  if (exports.get('_start') !== 0x00) throw new Bad('O executável não exporta _start')
  if (exports.get('memory') !== 0x02) throw new Bad('O executável não exporta memory')
}
