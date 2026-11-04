// Mantém o painel ligado ao programa: quando a conexão cai, tenta de novo sozinho, esperando
// cada vez mais (até 15 s) para não martelar um programa fechado. Conectado, só confere de vez em quando.
const IDLE_MS = 1000
const MAX_WAIT_MS = 15_000

export interface KeepOptions {
  // Se vale tentar agora: sem conexão, modo programa, e permissão de rede local já dada.
  wanted: () => Promise<boolean>
  connect: () => Promise<boolean>
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (timer: unknown) => void
}

export function keepConnected(opts: KeepOptions) {
  const schedule = opts.schedule ?? ((fn, ms) => window.setTimeout(fn, ms))
  const cancel = opts.cancel ?? ((t) => window.clearTimeout(t as number))
  let failures = 0
  let stopped = false
  let timer: unknown = null
  const wait = () => (failures ? Math.min(IDLE_MS * 2 ** (failures - 1), MAX_WAIT_MS) : IDLE_MS)
  const step = async () => {
    if (stopped) return
    try {
      if (await opts.wanted()) failures = (await opts.connect()) ? 0 : failures + 1
      else failures = 0
    } catch {
      failures++
    }
    if (!stopped) timer = schedule(step, wait())
  }
  timer = schedule(step, 0)
  return () => {
    stopped = true
    cancel(timer)
  }
}
