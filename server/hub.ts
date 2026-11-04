// Hub de rede local: repassa bytes entre os alunos e o painel do professor.
// Não entende provas nem gabarito, então não tem como vazar nada.
// É a mesma implementação de host/ (Rust); esta versão serve para desenvolvimento e testes.
import { Elysia, t } from 'elysia'
import { networkInterfaces } from 'node:os'
import { HubOp, decodeHub, encodeHub } from '../shared/frames'
import { HUB_ORIGINS } from '../shared/protocol'

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i!.address)
}

interface Sock {
  id: string
  close(): unknown
  remoteAddress?: string
  raw: { remoteAddress?: string; sendBinary(data: Uint8Array): unknown }
}

// O send do Elysia serializa Uint8Array como JSON; aqui só passam bytes.
const sendBytes = (sock: Sock, data: Uint8Array) => sock.raw.sendBinary(data)

const MAX_STUDENTS = 512
const asBytes = (m: unknown): Uint8Array | null => {
  if (m instanceof Uint8Array) return m
  if (m instanceof ArrayBuffer) return new Uint8Array(m)
  return null
}

export function createHub(token: string) {
  let host: Sock | null = null
  let nextConn = 1
  const conns = new Map<number, Sock>()
  const bySocket = new Map<string, number>()

  const addr = (ws: Sock) => ws.raw.remoteAddress ?? ws.remoteAddress ?? ''
  const isLoopback = (a: string) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'

  return new Elysia()
    .onRequest(({ request, set }) => {
      set.headers['Access-Control-Allow-Origin'] = request.headers.get('origin') ?? '*'
      set.headers['Access-Control-Allow-Private-Network'] = 'true'
      set.headers['Access-Control-Allow-Local-Network'] = 'true'
      set.headers['Access-Control-Allow-Headers'] = '*'
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: set.headers as HeadersInit })
    })
    .get('/ping', () => ({ app: 'oblita', v: 1, students: conns.size, host: host !== null }))
    // Só quem está na própria máquina do professor, numa página do Oblita, recebe o token.
    .get('/host-token', ({ request, server, set }) => {
      const peer = server?.requestIP(request)?.address ?? ''
      const origin = request.headers.get('origin') ?? ''
      if (!isLoopback(peer) || !HUB_ORIGINS.includes(origin)) {
        set.status = 403
        return { error: 'forbidden' }
      }
      return { token, addresses: lanAddresses() }
    })
    .ws('/ws/host', {
      query: t.Object({ token: t.String() }),
      open(ws) {
        const sock = ws as unknown as Sock
        if (ws.data.query.token !== token || !isLoopback(addr(sock))) return void ws.close()
        host?.close()
        host = sock
        // O painel pode ter recarregado: reapresenta quem já está conectado.
        for (const [conn] of conns) sendBytes(sock, encodeHub(conn, HubOp.open))
      },
      message(ws, message) {
        const sock = ws as unknown as Sock
        if (host?.id !== sock.id) return
        const bytes = asBytes(message)
        if (!bytes || bytes.length < 5) return
        const { conn, op, data } = decodeHub(bytes)
        const target = conns.get(conn)
        if (!target) return
        if (op === HubOp.data) sendBytes(target, data)
        else if (op === HubOp.close) target.close()
      },
      close(ws) {
        if (host?.id === (ws as unknown as Sock).id) host = null
      },
    })
    .ws('/ws/student', {
      open(ws) {
        const sock = ws as unknown as Sock
        if (conns.size >= MAX_STUDENTS) return void ws.close()
        const conn = nextConn++
        conns.set(conn, sock)
        bySocket.set(sock.id, conn)
        if (host) sendBytes(host, encodeHub(conn, HubOp.open))
      },
      message(ws, message) {
        const conn = bySocket.get((ws as unknown as Sock).id)
        const bytes = asBytes(message)
        if (conn !== undefined && bytes && host) sendBytes(host, encodeHub(conn, HubOp.data, bytes))
      },
      close(ws) {
        const id = (ws as unknown as Sock).id
        const conn = bySocket.get(id)
        if (conn === undefined) return
        bySocket.delete(id)
        conns.delete(conn)
        if (host) sendBytes(host, encodeHub(conn, HubOp.close))
      },
    })
}
