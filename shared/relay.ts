// Sala online: o mesmo papel do programa do professor (repassar bytes entre o painel e os alunos),
// só que na nuvem, para quem não está na mesma rede. Fala o protocolo do hub (shared/frames.ts):
// o painel recebe [conn][op][dados]; o aluno só vê os próprios bytes. Tudo que passa já vem
// cifrado de ponta a ponta, então o relay não lê prova, resposta nem gravação.
//
// Sem dependência do Cloudflare: o Durable Object (worker/index.ts) e o servidor de teste
// (server/) usam esta mesma lógica, com o estado de cada socket guardado na etiqueta dele.
import { HubOp, decodeHub, encodeHub } from './frames'

export type RelayTag = { role: 'relay-host' } | { role: 'relay-student'; conn: number }

export interface RelaySock {
  tag(): RelayTag | null
  setTag(tag: RelayTag): void
  send(data: Uint8Array): void
  close(code: number, reason: string): void
}

export interface RelayStore {
  // Hash do segredo do primeiro painel que abriu a sala. Só ele volta a ser o painel dela.
  secretHash(): string | undefined
  setSecretHash(hash: string): void
  nextConn(): number
}

export const RELAY_MAX_STUDENTS = 512
// Fechamentos com significado para o cliente.
export const RELAY_CLOSE = { replaced: 4001 } as const
export const RELAY_SECRET = /^[A-Za-z0-9_-]{32,128}$/

export async function hashSecret(secret: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`oblita-relay|${secret}`))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export class RelayCore {
  constructor(
    private all: () => RelaySock[],
    private store: RelayStore,
  ) {}

  private host() {
    return this.all().find((s) => s.tag()?.role === 'relay-host') ?? null
  }

  private students() {
    return this.all().filter((s) => s.tag()?.role === 'relay-student')
  }

  status() {
    return { relay: this.store.secretHash() !== undefined, host: this.host() !== null, students: this.students().length }
  }

  // Antes de aceitar o socket: quem não é o dono nem chega a abrir.
  async authorizeHost(secret: string) {
    if (!RELAY_SECRET.test(secret)) return false
    const hash = await hashSecret(secret)
    const known = this.store.secretHash()
    if (known === undefined) this.store.setSecretHash(hash)
    return known === undefined || known === hash
  }

  canJoin() {
    return this.store.secretHash() !== undefined && this.students().length < RELAY_MAX_STUDENTS
  }

  openHost(sock: RelaySock) {
    // O painel pode ter recarregado ou aberto em outra aba: o novo assume.
    for (const old of this.all()) if (old !== sock && old.tag()?.role === 'relay-host') old.close(RELAY_CLOSE.replaced, 'outro painel')
    sock.setTag({ role: 'relay-host' })
    for (const s of this.students()) {
      const tag = s.tag()
      if (tag?.role === 'relay-student') sock.send(encodeHub(tag.conn, HubOp.open))
    }
  }

  openStudent(sock: RelaySock) {
    const conn = this.store.nextConn()
    sock.setTag({ role: 'relay-student', conn })
    this.host()?.send(encodeHub(conn, HubOp.open))
  }

  message(sock: RelaySock, bytes: Uint8Array) {
    const tag = sock.tag()
    if (!tag) return
    if (tag.role === 'relay-student') {
      this.host()?.send(encodeHub(tag.conn, HubOp.data, bytes))
      return
    }
    if (bytes.length < 5) return
    const { conn, op, data } = decodeHub(bytes)
    const target = this.students().find((s) => {
      const t = s.tag()
      return t?.role === 'relay-student' && t.conn === conn
    })
    if (!target) return
    if (op === HubOp.data) target.send(data)
    else if (op === HubOp.close) target.close(1000, 'professor fechou')
  }

  closed(sock: RelaySock) {
    const tag = sock.tag()
    if (tag?.role === 'relay-student') this.host()?.send(encodeHub(tag.conn, HubOp.close))
  }
}
