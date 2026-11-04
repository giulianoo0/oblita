// Dureza do validador de wasm (shared/wasm.ts). A bateria estrutural completa (imports proibidos,
// memória sem máximo/compartilhada/64-bit/>256MB, seções malformadas, LEB gigante, start, funções/
// locais demais, dados fora da memória, etc.) vive em shared/wasm.test.ts e é rodada à parte por
// "bun test shared/wasm.test.ts". Aqui provamos o que falta: o validador NÃO executa o programa,
// então laço infinito/recursão/saída gigante são limites de runtime (worker no sandbox), e NENHUM
// cabeçalho malicioso com contagens enormes consegue prender o parser.
import { checkStudentWasm } from './net.mjs'

const results = []
function check(name, expected, observed, pass) {
  results.push({ name, expected, observed, pass })
  console.log(`${pass ? 'PASSOU' : 'FALHOU'} | ${name}\n   esperado: ${expected}\n   observado: ${observed}`)
}

const enc = new TextEncoder()
const leb = (n) => {
  const out = []
  do {
    let b = n & 0x7f
    n = Math.floor(n / 128)
    if (n) b |= 0x80
    out.push(b)
  } while (n)
  return out
}
const name = (s) => [...leb(enc.encode(s).length), ...enc.encode(s)]
const vec = (items) => [...leb(items.length), ...items.flat()]
const section = (id, body) => [id, ...leb(body.length), ...body]
const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
const I32 = 0x7f
const TYPES = section(1, vec([[0x60, 0, 0]]))
const fdWrite = [...name('wasi_snapshot_preview1'), ...name('fd_write'), 0x00, 0]
const memSec = section(5, vec([[0x01, 1, 2]]))
const EXPORTS = section(7, vec([[...name('_start'), 0x00, 1], [...name('memory'), 0x02, 0]]))

// _start com o corpo que quisermos (default: vazio -> end)
function build(bodyOps = [0x0b]) {
  const code = section(10, vec([[...leb(1 + bodyOps.length), 0x00, ...bodyOps]]))
  return new Uint8Array([...HEADER, ...TYPES, ...section(2, vec([fdWrite])), ...section(3, vec([[0]])), ...memSec, ...EXPORTS, ...code])
}

function timed(fn) {
  const t0 = performance.now()
  const r = fn()
  return { r, ms: performance.now() - t0 }
}

// 1. Módulo válido passa
{
  const ok = build()
  check('módulo mínimo válido passa e WebAssembly aceita', 'ok e válido', `ok=${JSON.stringify(checkStudentWasm(ok))} wasmValid=${WebAssembly.validate(ok)}`, checkStudentWasm(ok).ok && WebAssembly.validate(ok))
}

// 2. Laço infinito: block + loop + br 0 + end + end. Passa a validação (estrutural), rapidíssimo.
{
  // _start: loop(void) { br 0 } end  => 0x03 0x40 (loop, blocktype void) 0x0c 0x00 (br 0) 0x0b (end loop) 0x0b (end func)
  const loopOps = [0x03, 0x40, 0x0c, 0x00, 0x0b, 0x0b]
  const { r, ms } = timed(() => checkStudentWasm(build(loopOps)))
  check('programa com laço infinito', 'validador aceita a ESTRUTURA sem executar, em <50ms (laço é limite de runtime)', `ok=${r.ok} ${ms.toFixed(2)}ms`, r.ok && ms < 50)
}

// 3. Cabeçalho mentindo contagem de funções enorme não prende o parser
{
  const many = new Uint8Array([...HEADER, ...TYPES, ...section(3, [...leb(1_000_000_000)])])
  const { r, ms } = timed(() => checkStudentWasm(many))
  check('seção 3 declara 1e9 funções', 'rejeitado sem laço (teto antes de iterar), <50ms', `reason="${r.reason}" ${ms.toFixed(2)}ms`, !r.ok && ms < 50)
}

// 4. Contagem de exports enorme com seção minúscula: corta rápido, não itera 1e9 vezes
{
  const bomb = new Uint8Array([...HEADER, ...TYPES, ...section(2, vec([fdWrite])), ...section(3, vec([[0]])), ...memSec, ...section(7, [...leb(1_000_000_000), 0x01])])
  const { r, ms } = timed(() => checkStudentWasm(bomb))
  check('seção de exports declara 1e9 entradas', 'cortado pelo tamanho da seção, <50ms, sem travar', `reason="${r.reason}" ${ms.toFixed(2)}ms`, !r.ok && ms < 50)
}

// 5. Tamanho de seção mentido (maior que o arquivo) é recusado
{
  const lie = new Uint8Array([...HEADER, 1, ...leb(5_000_000), 0x01])
  const { r, ms } = timed(() => checkStudentWasm(lie))
  check('seção com tamanho mentido (5 MB num arquivo de bytes)', 'recusado como cortado, <50ms', `reason="${r.reason}" ${ms.toFixed(2)}ms`, !r.ok && ms < 50)
}

// 6. Recursão/saída gigante também são runtime: módulo que só chama a si mesmo passa a validação
{
  // _start: call 1 (a própria) end — estrutura válida; a recursão só explode ao rodar no worker.
  const recOps = [0x10, 0x01, 0x0b]
  const { r, ms } = timed(() => checkStudentWasm(build(recOps)))
  check('programa recursivo (estouraria a pilha ao rodar)', 'validador aceita estrutura, <50ms (pilha é limite de runtime)', `ok=${r.ok} ${ms.toFixed(2)}ms`, r.ok && ms < 50)
}

// 7. Módulo de 8 MB + 1 byte é recusado por tamanho sem parsear
{
  const big = new Uint8Array(8 * 1024 * 1024 + 1)
  big.set(build())
  const { r, ms } = timed(() => checkStudentWasm(big))
  check('executável acima de 8 MB', 'recusado por tamanho, <50ms', `reason="${r.reason}" ${ms.toFixed(2)}ms`, !r.ok && ms < 50)
}

const failed = results.filter((r) => !r.pass)
console.log(`\n=== WASM VALIDADOR (extras): ${results.length - failed.length}/${results.length} passaram ===`)
console.log('Bateria estrutural completa: ver "bun test shared/wasm.test.ts".')
if (failed.length) console.log('FALHARAM:', failed.map((f) => f.name).join('; '))
process.exit(failed.length ? 1 : 0)
