import type { Lang } from '../../shared/exam'
import { RUN_LIMITS } from '../../shared/protocol'
import CompileWorker from './compile.worker?worker'
import RunWorker from './run.worker?worker'
import type { CompileRequest, CompileResponse } from './compile.worker'
import type { RunRequest, RunResponse } from './run.worker'

export type CompileResult =
  | { ok: true; wasm: Uint8Array<ArrayBuffer>; log: string; ms: number }
  | { ok: false; log: string; ms: number; internal?: boolean }

const COMPILE_TIMEOUT = 60_000
const RUN_BOOT_TIMEOUT = 30_000
// Teto do que um worker de execução pode mandar de volta: o dele já para em 1 MB, este é para
// um worker que não obedeça.
const MAX_OUTPUT_CHARS = RUN_LIMITS.outputKb * 1024 * 2

// ---- compilação: um worker por vaga. O aluno usa uma; o professor abre mais para a correção.

interface Slot {
  worker: Worker | null
  busy: boolean
  current?: (r: CompileResult, kill?: boolean) => void
  onData?: (data: CompileResponse) => void
}

interface CompileJob {
  lang: Lang
  files: Record<string, string>
  onProgress?: (p: number) => void
  resolve: (r: CompileResult) => void
}

const slots: Slot[] = [{ worker: null, busy: false }]
const waiting: CompileJob[] = []
let nextId = 1

// Cada worker carrega o clang inteiro (centenas de MB com C++), então o número vem de quem chama.
export function setCompilePool(size: number) {
  const n = Math.max(1, Math.floor(size))
  while (slots.length < n) slots.push({ worker: null, busy: false })
  // Vagas a mais só somem quando livres; as ocupadas terminam o que estão fazendo.
  for (let i = slots.length - 1; i >= n; i--) {
    if (slots[i].busy) continue
    slots[i].worker?.terminate()
    slots.splice(i, 1)
  }
  dispatch()
}

function dispatch() {
  for (const slot of slots) {
    if (slot.busy) continue
    const job = waiting.shift()
    if (!job) return
    slot.busy = true
    runCompile(slot, job)
  }
}

function runCompile(slot: Slot, job: CompileJob) {
  const id = nextId++
  let done = false
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const finish = (r: CompileResult, kill = false) => {
    if (done) return
    done = true
    clearTimeout(watchdog)
    if (kill) {
      slot.worker?.terminate()
      slot.worker = null
    }
    slot.busy = false
    job.resolve(r)
    dispatch()
  }
  // Um template recursivo de propósito não pode travar a fila da turma inteira.
  const arm = () => {
    clearTimeout(watchdog)
    watchdog = setTimeout(() => finish({ ok: false, log: `A compilação passou de ${COMPILE_TIMEOUT / 1000} s`, ms: COMPILE_TIMEOUT }, true), COMPILE_TIMEOUT)
  }
  arm()
  try {
    if (!slot.worker) {
      const worker = new CompileWorker()
      slot.worker = worker
      // Falha ao carregar o script do worker chega como Event, sem message.
      const fail = (e: Event) => {
        if (slot.worker !== worker) return
        // Morto mesmo parado: a próxima compilação abre outro.
        slot.worker = null
        worker.terminate()
        slot.current?.({ ok: false, log: (e as ErrorEvent).message || 'O worker do compilador falhou', ms: 0, internal: true }, true)
      }
      worker.onerror = fail
      worker.onmessageerror = fail
      worker.onmessage = ({ data }: MessageEvent<CompileResponse>) => slot.onData?.(data)
    }
    slot.current = finish
    slot.onData = (data) => {
      if (data.id !== id) return
      // O primeiro uso baixa 105 MB. Em rede lenta isso passa de 60 s, e matar o worker no
      // meio faria o aluno recomeçar do zero para sempre: enquanto há progresso, não conta.
      if ('progress' in data) {
        arm()
        return job.onProgress?.(data.progress)
      }
      finish(data)
    }
    slot.worker.postMessage({ id, lang: job.lang, files: job.files } satisfies CompileRequest)
  } catch (err) {
    finish({ ok: false, log: String(err), ms: 0, internal: true }, true)
  }
}

export function compile(lang: Lang, files: Record<string, string>, onProgress?: (p: number) => void): Promise<CompileResult> {
  return new Promise((resolve) => {
    waiting.push({ lang, files, onProgress, resolve })
    dispatch()
  })
}

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  error?: string
}

// Onde o programa roda: um worker comum, ou um dentro do sandbox de origem opaca (sandbox.ts).
export interface RunPort {
  post(msg: RunRequest): void
  onmessage: ((msg: RunResponse) => void) | null
  onerror: ((message: string) => void) | null
  terminate(): void
}

export function workerPort(): RunPort {
  const w = new RunWorker()
  const port: RunPort = { post: (msg) => w.postMessage(msg), onmessage: null, onerror: null, terminate: () => w.terminate() }
  w.onmessage = ({ data }: MessageEvent<RunResponse>) => port.onmessage?.(data)
  // Falha ao carregar o script do worker chega como Event, sem message.
  w.onerror = (e) => port.onerror?.(e.message || '')
  w.onmessageerror = () => port.onerror?.('')
  return port
}

// Cada execução tem um worker próprio: encerrá-lo é o único jeito de parar um laço infinito.
export function run(
  wasm: Uint8Array<ArrayBuffer>,
  stdin: string,
  timeoutMs: number,
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void,
  spawn: () => RunPort = workerPort,
): Promise<RunResult> & { kill: () => void } {
  let stdout = ''
  let stderr = ''
  let finish: (r: RunResult) => void = () => {}
  const promise = new Promise<RunResult>((resolve) => {
    finish = resolve
  }) as Promise<RunResult> & { kill: () => void }
  let ended = false
  let port: RunPort | null = null
  const end = (r: Partial<RunResult>) => {
    if (ended) return
    ended = true
    clearTimeout(timer)
    port?.terminate()
    finish({ stdout, stderr, exitCode: -1, timedOut: false, ...r })
  }
  // O limite só conta do início do programa: carregar o worker numa máquina ocupada, logo depois
  // de compilar, já levou mais de 5 s e reprovaria um programa correto. Compilar o módulo também
  // fica antes do início, e este relógio de carga cobre um módulo feito para demorar a compilar.
  let timer = setTimeout(() => end({ error: 'O programa não pôde ser iniciado' }), RUN_BOOT_TIMEOUT + timeoutMs)
  promise.kill = () => end({ error: 'Interrompido' })
  try {
    port = spawn()
  } catch {
    end({ error: 'O programa não pôde ser iniciado' })
    return promise
  }
  // O que volta do worker é tratado como vindo de fora: no sandbox, ele é do aluno.
  port.onmessage = (data) => {
    if (ended || !data || typeof data !== 'object') return
    if (data.type === 'start') {
      clearTimeout(timer)
      timer = setTimeout(() => end({ timedOut: true, exitCode: -1, error: `Passou de ${timeoutMs / 1000} s` }), timeoutMs)
    } else if (data.type === 'out') {
      if (typeof data.text !== 'string') return
      if (data.stream === 'stdout') stdout += data.text
      else stderr += data.text
      if (stdout.length + stderr.length > MAX_OUTPUT_CHARS) return end({ exitCode: 139, error: 'Saída maior que 1 MB' })
      onOutput?.(data.stream === 'stdout' ? 'stdout' : 'stderr', data.text)
    } else if (data.type === 'exit') {
      end({ exitCode: Number.isSafeInteger(data.exitCode) ? data.exitCode : 139, error: typeof data.error === 'string' ? data.error.slice(0, 500) : undefined })
    }
  }
  port.onerror = (message) => end({ error: message || 'O programa não pôde ser iniciado' })
  port.post({ wasm, stdin })
  return promise
}

// Marcadores do editor a partir das mensagens do compilador.
export function parseDiagnostics(log: string) {
  const out: { file: string; line: number; column: number; severity: 'error' | 'warning' | 'note'; message: string }[] = []
  for (const row of log.split('\n')) {
    const m = row.match(/^([^:\s]+):(\d+):(\d+): (error|warning|note|fatal error): (.*)$/)
    // Em erro dentro de header incluído o clang escreve "./util.h": o editor conhece "util.h".
    if (m) out.push({ file: m[1].replace(/^\.\//, ''), line: +m[2], column: +m[3], severity: m[4] === 'fatal error' ? 'error' : (m[4] as 'error' | 'warning' | 'note'), message: m[5] })
  }
  return out
}
