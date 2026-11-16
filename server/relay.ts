// Dublê da sala online (worker/index.ts) para desenvolvimento e teste, com a mesma lógica.
import { Elysia } from 'elysia'
import { RelayCore, type RelaySock, type RelayTag } from '../shared/relay'

interface Sock {
  id: string
  close(code?: number, reason?: string): unknown
  raw: { sendBinary(data: Uint8Array): unknown }
  data: { query: Record<string, string | undefined> }
}

const asBytes = (m: unknown): Uint8Array | null => {
  if (m instanceof Uint8Array) return m
  if (m instanceof ArrayBuffer) return new Uint8Array(m)
  return null
}

export function createRelay() {
  const rooms = new Map<string, { core: RelayCore; socks: Map<string, RelaySock>; secret?: string; conn: number }>()
  const tags = new Map<string, RelayTag>()
  const roomOf = new Map<string, string>()

  const room = (code: string) => {
    let r = rooms.get(code)
    if (!r) {
      const socks = new Map<string, RelaySock>()
      const created: { core: RelayCore; socks: Map<string, RelaySock>; secret?: string; conn: number } = { socks, conn: 0, core: null as unknown as RelayCore }
      created.core = new RelayCore(() => [...socks.values()], {
        secretHash: () => created.secret,
        setSecretHash: (h) => (created.secret = h),
        nextConn: () => ++created.conn,
      })
      rooms.set(code, created)
      r = created
    }
    return r
  }

  const wrap = (ws: Sock): RelaySock => ({
    tag: () => tags.get(ws.id) ?? null,
    setTag: (t) => tags.set(ws.id, t),
    send: (d) => ws.raw.sendBinary(d),
    close: (code, reason) => ws.close(code, reason),
  })

  const codeOf = (q: Record<string, string | undefined>) => (q.code ?? '').toUpperCase()

  return new Elysia()
    .get('/relay', ({ query, set }) => {
      set.headers['Cache-Control'] = 'no-store'
      const r = rooms.get(codeOf(query))
      return r ? r.core.status() : { relay: false, host: false, students: 0 }
    })
    .ws('/relay', {
      async open(ws) {
        const sock = ws as unknown as Sock
        const code = codeOf(sock.data.query)
        const r = room(code)
        const asHost = sock.data.query.role === 'host'
        // No dublê a recusa vem logo depois de abrir; no Workers, antes.
        if (asHost ? !(await r.core.authorizeHost(sock.data.query.secret ?? '')) : !r.core.canJoin()) return void sock.close(4003, 'recusado')
        const wrapped = wrap(sock)
        r.socks.set(sock.id, wrapped)
        roomOf.set(sock.id, code)
        if (asHost) r.core.openHost(wrapped)
        else r.core.openStudent(wrapped)
      },
      message(ws, message) {
        const sock = ws as unknown as Sock
        const r = rooms.get(roomOf.get(sock.id) ?? '')
        const bytes = asBytes(message)
        if (r && bytes) r.core.message(r.socks.get(sock.id)!, bytes)
      },
      close(ws) {
        const sock = ws as unknown as Sock
        const r = rooms.get(roomOf.get(sock.id) ?? '')
        const wrapped = r?.socks.get(sock.id)
        if (r && wrapped) {
          r.socks.delete(sock.id)
          r.core.closed(wrapped)
        }
        tags.delete(sock.id)
        roomOf.delete(sock.id)
      },
    })
}
