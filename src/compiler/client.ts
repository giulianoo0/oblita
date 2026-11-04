import type { Lang } from '../../shared/exam'
import CompileWorker from './compile.worker?worker'
import RunWorker from './run.worker?worker'
import type { CompileRequest, CompileResponse } from './compile.worker'
import type { RunRequest, RunResponse } from './run.worker'

export type CompileResult =
  | { ok: true; wasm: Uint8Array<ArrayBuffer>; log: string; ms: number }
  | { ok: false; log: string; ms: number; internal?: boolean }

const COMPILE_TIMEOUT = 60_000
const RUN_BOOT_TIMEOUT = 30_000

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (r: CompileResult) => void; onProgress?: (p: number) => void }>()
let queue: Promise<unknown> = Promise.resolve()

function getWorker() {
  if (worker) return worker
  worker = new CompileWorker()
  worker.onmessage = ({ data }: MessageEvent<CompileResponse>) => {
    const entry = pending.get(data.id)
    if (!entry) return
    if ('progress' in data) return entry.onProgress?.(data.progress)
    pending.delete(data.id)
    entry.resolve(data)
  }
  // Falha ao carregar o script do worker chega como Event, sem message.
  const fail = (e: Event) => {
    const log = (e as ErrorEvent).message || 'O worker do compilador falhou'
    for (const p of pending.values()) p.resolve({ ok: false, log, ms: 0, internal: true })
    pending.clear()
    worker?.terminate()
    worker = null
  }
  worker.onerror = fail
  worker.onmessageerror = fail
  return worker
}

// O compilador é pesado e tem um único worker, então as compilações entram em fila.
export function compile(lang: Lang, files: Record<string, string>, onProgress?: (p: number) => void): Promise<CompileResult> {
  const job = queue.then(
    () =>
      new Promise<CompileResult>((resolve) => {
        const id = nextId++
        // Um template recursivo de propósito não pode travar a fila da turma inteira.
        let watchdog: ReturnType<typeof setTimeout> | undefined
        const arm = () => {
          clearTimeout(watchdog)
          watchdog = setTimeout(() => {
            pending.delete(id)
            worker?.terminate()
            worker = null
            resolve({ ok: false, log: `A compilação passou de ${COMPILE_TIMEOUT / 1000} s`, ms: COMPILE_TIMEOUT })
          }, COMPILE_TIMEOUT)
        }
        arm()
        pending.set(id, {
          resolve: (r) => {
            clearTimeout(watchdog)
            resolve(r)
          },
          // O primeiro uso baixa 105 MB. Em rede lenta isso passa de 60 s, e matar o worker no
          // meio faria o aluno recomeçar do zero para sempre: enquanto há progresso, não conta.
          onProgress: (p) => {
            arm()
            onProgress?.(p)
          },
        })
        try {
          getWorker().postMessage({ id, lang, files } satisfies CompileRequest)
        } catch (err) {
          pending.delete(id)
          clearTimeout(watchdog)
          resolve({ ok: false, log: String(err), ms: 0, internal: true })
        }
      }),
  )
  queue = job.catch(() => {})
  return job
}

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  error?: string
}

// Cada execução tem um worker próprio: encerrá-lo é o único jeito de parar um laço infinito.
export function run(wasm: Uint8Array<ArrayBuffer>, stdin: string, timeoutMs: number, onOutput?: (stream: 'stdout' | 'stderr', text: string) => void): Promise<RunResult> & { kill: () => void } {
  const w = new RunWorker()
  let stdout = ''
  let stderr = ''
  let finish: (r: RunResult) => void = () => {}
  const promise = new Promise<RunResult>((resolve) => {
    finish = resolve
  }) as Promise<RunResult> & { kill: () => void }
  let ended = false
  const end = (r: Partial<RunResult>) => {
    if (ended) return
    ended = true
    clearTimeout(timer)
    w.terminate()
    finish({ stdout, stderr, exitCode: -1, timedOut: false, ...r })
  }
  // O limite só conta do início do programa: carregar o worker numa máquina ocupada, logo depois
  // de compilar, já levou mais de 5 s e reprovaria um programa correto.
  let timer = setTimeout(() => end({ error: 'O programa não pôde ser iniciado' }), RUN_BOOT_TIMEOUT + timeoutMs)
  promise.kill = () => end({ error: 'Interrompido' })
  w.onmessage = ({ data }: MessageEvent<RunResponse>) => {
    if (ended) return
    if (data.type === 'start') {
      clearTimeout(timer)
      timer = setTimeout(() => end({ timedOut: true, exitCode: -1, error: `Passou de ${timeoutMs / 1000} s` }), timeoutMs)
    } else if (data.type === 'out') {
      if (data.stream === 'stdout') stdout += data.text
      else stderr += data.text
      onOutput?.(data.stream, data.text)
    } else {
      end({ exitCode: data.exitCode, error: data.error })
    }
  }
  // Falha ao carregar o script do worker chega como Event, sem message.
  w.onerror = (e) => end({ error: e.message || 'O programa não pôde ser iniciado' })
  w.onmessageerror = () => end({ error: 'O programa não pôde ser iniciado' })
  w.postMessage({ wasm, stdin } satisfies RunRequest)
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
