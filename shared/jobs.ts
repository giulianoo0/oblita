// Fila de trabalho do professor: correção final e testes dos alunos disputam as mesmas máquinas.
// A correção sempre passa na frente. Cada equipe tem no máximo um teste pendente, e quem
// já mandou o executável pronto não espera atrás de quem ainda precisa compilar.

export type Lane = 'grade' | 'test'

export interface JobSpec {
  lane: Lane
  // Só na fila de testes: a equipe dona do pedido.
  key?: string
  compile: boolean
  run: () => Promise<void>
}

export type PushResult = { ok: true; position: number } | { ok: false; reason: 'busy' }

type Entry = JobSpec

export class JobQueue {
  private waiting: Record<Lane, Entry[]> = { grade: [], test: [] }
  private keys = new Set<string>()
  private running = 0
  private compiling = 0
  private reported = new Map<string, number>()

  constructor(
    private limits: { running: number; compiling: number },
    // Posição na fila de testes de quem mudou; 0 é "começou agora".
    private onPosition?: (key: string, position: number) => void,
  ) {}

  push(spec: JobSpec): PushResult {
    if (spec.key !== undefined) {
      if (this.keys.has(spec.key)) return { ok: false, reason: 'busy' }
      this.keys.add(spec.key)
    }
    this.waiting[spec.lane].push({ ...spec })
    if (spec.key !== undefined) this.reported.set(spec.key, this.waiting.test.length)
    this.pump()
    return { ok: true, position: spec.key !== undefined ? (this.position(spec.key) ?? 0) : 0 }
  }

  // 1 é o próximo; 0 já está rodando; null não está na fila.
  position(key: string): number | null {
    if (!this.keys.has(key)) return null
    const i = this.waiting.test.findIndex((e) => e.key === key)
    return i < 0 ? 0 : i + 1
  }

  get pending() {
    return this.waiting.grade.length + this.waiting.test.length + this.running
  }

  private next(): { lane: Lane; index: number } | null {
    for (const lane of ['grade', 'test'] as const) {
      const index = this.waiting[lane].findIndex((e) => !e.compile || this.compiling < this.limits.compiling)
      if (index >= 0) return { lane, index }
    }
    return null
  }

  private pump() {
    let moved = false
    while (this.running < this.limits.running) {
      const pick = this.next()
      if (!pick) break
      const [entry] = this.waiting[pick.lane].splice(pick.index, 1)
      moved ||= pick.lane === 'test'
      this.start(entry)
    }
    if (moved) this.report()
  }

  private start(entry: Entry) {
    this.running++
    if (entry.compile) this.compiling++
    const done = () => {
      this.running--
      if (entry.compile) this.compiling--
      if (entry.key !== undefined) {
        this.keys.delete(entry.key)
        this.reported.delete(entry.key)
      }
      this.pump()
    }
    let job: Promise<void>
    try {
      job = entry.run()
    } catch (err) {
      job = Promise.reject(err)
    }
    // Um trabalho que falha não pode prender a vaga, nem derrubar a fila.
    void job.catch((err) => console.error('trabalho da fila falhou', err)).finally(done)
  }

  private report() {
    for (const [key, before] of this.reported) {
      const now = this.position(key)
      if (now === null || now === before) continue
      this.reported.set(key, now)
      this.onPosition?.(key, now)
    }
  }
}
