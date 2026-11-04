// Execução do programa do aluno, fora do worker para poder ser testada sozinha.
// Sem disco: o WASI só recebe stdin, stdout e stderr em memória, nenhum diretório
// pré-aberto, nenhuma variável de ambiente e só "main" nos argumentos. Abrir arquivo dá erro
// da WASI, que o programa vê como fopen devolvendo NULL.
import { ConsoleStdout, File, OpenFile, WASI } from '@bjorn3/browser_wasi_shim'
import { RUN_LIMITS } from '../../shared/protocol'
import type { RunResponse } from './run.worker'

const MAX_OUTPUT = RUN_LIMITS.outputKb * 1024
// Até aqui cada escrita vira uma mensagem, e quem imprime e depois trava não perde nada. Acima,
// junta em blocos: uma mensagem por byte congelava a página e atrasava o próprio timeout. O preço
// é perder até 50 ms de saída de um programa que imprimiu milhares de vezes e depois travou.
const EAGER_WRITES = 2000
const BATCH_CHARS = 16 * 1024
const BATCH_MS = 50

const STACK_OVERFLOW = 'Estouro de pilha: recursão profunda demais ou variável local grande demais'

interface Exports {
  memory: WebAssembly.Memory
  _start: () => unknown
  fflush?: (file: number) => number
  __stack_pointer?: WebAssembly.Global
}

function describe(err: unknown, exports: Exports | null) {
  const text = String(err)
  if (text.includes('call stack')) return STACK_OVERFLOW
  if (text.includes('memory access out of bounds')) {
    // A pilha fica no começo da memória: estourar leva o ponteiro para abaixo de zero.
    return (exports?.__stack_pointer?.value ?? 0) < 0 ? STACK_OVERFLOW : 'Acesso inválido à memória'
  }
  if (text.includes('unreachable')) return 'Programa abortado'
  if (text.includes('divide by zero') || text.includes('remainder by zero')) return 'Divisão por zero'
  if (text.includes('divide result unrepresentable')) return 'Divisão com estouro: o menor inteiro dividido por -1'
  if (text.includes('null function') || text.includes('signature mismatch') || text.includes('table index')) return 'Chamada de função por um ponteiro inválido'
  if (text.includes('float unrepresentable')) return 'Conversão de float para inteiro fora do limite'
  if (text.includes('Import #')) return 'O programa usa uma função que não existe neste ambiente'
  if (text.includes('CompileError')) return 'O executável é inválido'
  return `Erro de execução: ${text}`
}

export async function execute(wasm: Uint8Array<ArrayBuffer>, stdin: string, post: (msg: RunResponse) => void) {
  let total = 0
  let overLimit = false
  let writes = 0
  let lastPost = 0
  let held: { stream: 'stdout' | 'stderr'; text: string } | null = null
  const release = () => {
    if (held) post({ type: 'out', ...held })
    held = null
    lastPost = performance.now()
  }
  const emit = (stream: 'stdout' | 'stderr', text: string) => {
    if (!text) return
    // Bloco só de um stream, para a ordem entre stdout e stderr continuar a real.
    if (held && held.stream !== stream) release()
    held = { stream, text: (held?.text ?? '') + text }
    if (++writes <= EAGER_WRITES || held.text.length >= BATCH_CHARS || performance.now() - lastPost >= BATCH_MS) release()
  }
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() }
  const sink = (stream: 'stdout' | 'stderr') =>
    // Não usa buffer por linha: um printf sem \n no fim precisa chegar inteiro à correção.
    new ConsoleStdout((bytes: Uint8Array) => {
      const room = MAX_OUTPUT - total
      const part = bytes.length > room ? bytes.subarray(0, room) : bytes
      total += part.length
      emit(stream, decoders[stream].decode(part, { stream: true }))
      if (bytes.length > room) {
        overLimit = true
        throw new Error('output-limit')
      }
    })
  // Bytes de um caractere cortado no fim viram U+FFFD, em vez de sumir.
  const finishOutput = () => {
    emit('stdout', decoders.stdout.decode())
    emit('stderr', decoders.stderr.decode())
    release()
  }
  let exports: Exports | null = null
  try {
    const fds = [new OpenFile(new File(new TextEncoder().encode(stdin))), sink('stdout'), sink('stderr')]
    const wasi = new WASI(['main'], [], fds, { debug: false })
    const { instance } = await WebAssembly.instantiate(wasm, { wasi_snapshot_preview1: wasi.wasiImport })
    exports = instance.exports as unknown as Exports
    const initialStack = exports.__stack_pointer?.value
    post({ type: 'start' })
    try {
      const code = wasi.start(instance as unknown as { exports: { memory: WebAssembly.Memory; _start: () => unknown } })
      finishOutput()
      // Como em POSIX, o processo pai só enxerga os 8 bits baixos.
      post({ type: 'exit', exitCode: code & 255 })
    } catch (err) {
      const error = overLimit ? 'Saída maior que 1 MB' : describe(err, exports)
      // O printf de depuração sem \n antes do crash ainda está no buffer da libc: esvazia daqui,
      // com a pilha de volta ao início. Se o estado do programa não deixar, paciência.
      if (!overLimit) {
        try {
          if (exports.__stack_pointer) exports.__stack_pointer.value = initialStack
          exports.fflush?.(0)
        } catch {}
      }
      finishOutput()
      post({ type: 'exit', exitCode: 139, error })
    }
  } catch (err) {
    post({ type: 'exit', exitCode: 139, error: describe(err, exports) })
  }
}
