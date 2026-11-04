// Onde a sala fica salva no navegador, em chaves separadas para o salvamento de 1 s não regravar tudo.
//   room:<id>            o que quase não muda: configuração, prova, gabarito, identidade, chave
//   room:<id>:students   alunos, sem o que só vale com a aba aberta (conexão, batimento)
//   room:<id>:teams      equipes, sem o documento
//   room:<id>:alerts     alertas
//   room:<id>:doc:<key>  documento Yjs de cada equipe, em binário, só quando muda
// Cada salvamento é uma transação só: um F5 no meio nunca deixa a sala meio nova, meio velha.
// A prova e o gabarito não mudam depois de criados, então não entram na conferência do estático.
import type { ExamDoc } from '../collab/examDoc'
import type { Exam, Solutions } from '../../shared/exam'
import type { Phase, RoomConfig } from '../../shared/protocol'
import type { QuestionClocks } from '../../shared/flow'
import type { TeacherIdentity } from '../../shared/secure'
import type { AlertEntry, Student, Team } from './room'

export interface KV {
  get<T>(key: string): Promise<T | undefined>
  putMany(entries: [string, unknown][]): Promise<void>
  entries(prefix: string): Promise<[string, unknown][]>
}

export interface RoomState {
  config: RoomConfig
  exam: Exam
  solutions: Solutions | null
  phase: Phase
  endsAt: number | null
  roomCode: string
  roomKey: string
  salt: string
  hasPassword: boolean
  teamCodes: [string, string][]
  identity: TeacherIdentity
  clocks?: QuestionClocks
  createdAt: number
  students: Student[]
  teams: Team[]
  alerts: AlertEntry[]
}

type Static = Omit<RoomState, 'students' | 'teams' | 'alerts'> & { v: 2 }
// O formato de antes desta divisão: tudo numa chave, com o documento em base64 dentro da equipe.
type Legacy = RoomState & { v?: undefined }

const MAX_ALERTS_SAVED = 2000
const OFF = { screen: false, fullscreen: false, focused: false, isolated: null, extended: false }

// btoa com spread estoura a pilha em documentos grandes.
export function toB64Large(bytes: Uint8Array) {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

const fromB64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

export class RoomStore {
  private last = new Map<string, string>()
  private dirty = new Set<string>()
  private watched = new WeakSet<ExamDoc>()
  // Documentos que já estão no formato novo; os do formato antigo migram no primeiro salvamento.
  private stored = new Set<string>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private roomId: string,
    private kv: KV,
  ) {}

  private key(part?: string) {
    return part ? `room:${this.roomId}:${part}` : `room:${this.roomId}`
  }

  // Em fila: dois salvamentos ao mesmo tempo marcariam como salvo o que o outro ainda não gravou.
  save(state: RoomState, docs: Map<string, ExamDoc>): Promise<void> {
    const run = this.queue.then(() => this.write(state, docs))
    this.queue = run.catch(() => {})
    return run
  }

  private async write(state: RoomState, docs: Map<string, ExamDoc>) {
    const { students, teams, alerts, ...rest } = state
    const pending: [string, unknown, string?][] = []
    const changed = (key: string, value: unknown, fingerprint: string) => {
      if (this.last.get(key) !== fingerprint) pending.push([key, value, fingerprint])
    }
    const fixed: Static = { ...rest, v: 2 }
    changed(this.key(), fixed, JSON.stringify([rest.config, rest.phase, rest.endsAt, rest.clocks, rest.teamCodes, rest.hasPassword]))
    const lean = students.map((s) => ({ ...s, peer: null, online: false, signalLost: false, lastBeat: 0, status: OFF }))
    changed(this.key('students'), lean, JSON.stringify(lean))
    const bare = teams.map(({ doc: _doc, ...t }) => t)
    changed(this.key('teams'), bare, JSON.stringify(bare))
    const kept = alerts.slice(0, MAX_ALERTS_SAVED).map((a) => ({ ...a, thumb: undefined }))
    changed(this.key('alerts'), kept, JSON.stringify(kept))

    const docKeys: string[] = []
    for (const [teamKey, doc] of docs) {
      if (!this.watched.has(doc)) {
        this.watched.add(doc)
        doc.doc.on('update', () => this.dirty.add(teamKey))
        this.dirty.add(teamKey)
      }
      if (this.dirty.has(teamKey)) {
        this.dirty.delete(teamKey)
        docKeys.push(teamKey)
        pending.push([this.key(`doc:${teamKey}`), doc.encodeState()])
      }
    }
    for (const t of teams) {
      if (t.doc && !docs.has(t.key) && !this.stored.has(t.key)) {
        docKeys.push(t.key)
        pending.push([this.key(`doc:${t.key}`), fromB64(t.doc)])
      }
    }
    if (!pending.length) return
    try {
      await this.kv.putMany(pending.map(([k, v]) => [k, v]))
    } catch (err) {
      for (const key of docKeys) if (docs.has(key)) this.dirty.add(key)
      throw err
    }
    for (const [key, , fingerprint] of pending) if (fingerprint !== undefined) this.last.set(key, fingerprint)
    for (const key of docKeys) this.stored.add(key)
  }

  // Devolve a equipe com o documento em base64, como o docOf espera.
  async load(): Promise<RoomState | null> {
    const head = await this.kv.get<Static | Legacy>(this.key())
    if (!head) return null
    if (head.v !== 2) return head as Legacy
    const { v: _v, ...rest } = head
    const [students, teams, alerts, docs] = await Promise.all([
      this.kv.get<Student[]>(this.key('students')),
      this.kv.get<Team[]>(this.key('teams')),
      this.kv.get<AlertEntry[]>(this.key('alerts')),
      this.kv.entries(this.key('doc:')),
    ])
    const prefix = this.key('doc:')
    const byKey = new Map(docs.map(([k, v]) => [k.slice(prefix.length), v as Uint8Array]))
    for (const key of byKey.keys()) this.stored.add(key)
    return {
      ...rest,
      students: students ?? [],
      teams: (teams ?? []).map((t) => {
        const doc = byKey.get(t.key)
        return doc ? { ...t, doc: toB64Large(doc) } : t
      }),
      alerts: alerts ?? [],
    }
  }
}
