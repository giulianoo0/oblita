// Site público: arquivos estáticos, a sinalização do modo "só navegador" e o relay da sala online.
// O relay só repassa bytes já cifrados de ponta a ponta: provas e respostas nunca ficam legíveis aqui.
import { Elysia } from 'elysia'
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker'
import { DurableObject } from 'cloudflare:workers'
import { RelayCore, type RelaySock, type RelayTag } from '../shared/relay'

interface Env {
  SIGNAL: DurableObjectNamespace<SignalRoom>
  ASSETS: Fetcher
}

const ROOM_CODE = /^[A-Z0-9]{4,12}$/
const MAX_SIGNAL_BYTES = 16 * 1024
const MAX_PEERS = 512

type Attachment = { role: 'host' } | { role: 'peer'; id: string } | RelayTag

// Sala online esquecida: some depois deste tempo sem o painel conectado.
const RELAY_TTL_MS = 14 * 24 * 3600 * 1000

// Cada sala é um Durable Object: guarda o professor e faz o aperto de mão dos alunos,
// ou, na sala online, repassa os bytes entre o painel e os alunos.
export class SignalRoom extends DurableObject<Env> {
  private relay = new RelayCore(
    () => this.ctx.getWebSockets().map((ws) => this.wrap(ws)),
    {
      secretHash: () => this.ctx.storage.kv.get<string>('secret'),
      setSecretHash: (hash) => this.ctx.storage.kv.put('secret', hash),
      nextConn: () => {
        const next = (this.ctx.storage.kv.get<number>('conn') ?? 0) + 1
        this.ctx.storage.kv.put('conn', next)
        return next
      },
    },
  )

  private wrap(ws: WebSocket): RelaySock {
    return {
      tag: () => {
        const a = ws.deserializeAttachment() as Attachment | null
        return a && (a.role === 'relay-host' || a.role === 'relay-student') ? a : null
      },
      setTag: (tag) => ws.serializeAttachment(tag),
      send: (data) => {
        try {
          ws.send(data)
        } catch {
          // Socket fechando: o close dele avisa o resto.
        }
      },
      close: (code, reason) => {
        try {
          ws.close(code, reason)
        } catch {
          // Já fechado.
        }
      },
    }
  }

  async fetch(request: Request) {
    const url = new URL(request.url)
    if (url.pathname === '/relay' && request.headers.get('Upgrade') !== 'websocket') {
      return Response.json(this.relay.status(), { headers: { 'Cache-Control': 'no-store' } })
    }
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('websocket', { status: 426 })
    const asHost = url.searchParams.get('role') === 'host'
    if (url.pathname === '/relay') {
      if (asHost && !(await this.relay.authorizeHost(url.searchParams.get('secret') ?? ''))) return new Response('sala de outro professor', { status: 403 })
      if (!asHost && !this.relay.canJoin()) return new Response('sala fechada ou cheia', { status: 404 })
    }
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    if (url.pathname === '/relay') {
      const sock = this.wrap(server)
      if (asHost) {
        this.relay.openHost(sock)
        await this.ctx.storage.setAlarm(Date.now() + RELAY_TTL_MS)
      } else this.relay.openStudent(sock)
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  async alarm() {
    if (this.relay.status().host) return this.ctx.storage.setAlarm(Date.now() + RELAY_TTL_MS)
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, 'sala expirou')
    await this.ctx.storage.deleteAll()
  }

  private sockets(role: 'host' | 'peer') {
    return this.ctx.getWebSockets().filter((ws) => (ws.deserializeAttachment() as Attachment | null)?.role === role)
  }

  async webSocketClose(ws: WebSocket) {
    this.relay.closed(this.wrap(ws))
  }

  async webSocketError(ws: WebSocket) {
    this.relay.closed(this.wrap(ws))
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const relayTag = this.wrap(ws).tag()
    if (relayTag) {
      if (typeof raw !== 'string') this.relay.message(this.wrap(ws), new Uint8Array(raw))
      return
    }
    if (typeof raw !== 'string' || raw.length > MAX_SIGNAL_BYTES) return ws.close(1009, 'grande demais')
    let msg: { t?: string; code?: string; to?: string; sdp?: string }
    try {
      msg = JSON.parse(raw)
    } catch {
      return ws.close(1007, 'json')
    }
    const send = (target: WebSocket, value: unknown) => target.send(JSON.stringify(value))
    if (msg.t === 'create') {
      if (this.sockets('host').some((h) => h !== ws)) return send(ws, { t: 'taken' })
      ws.serializeAttachment({ role: 'host' } satisfies Attachment)
      return send(ws, { t: 'created', code: msg.code })
    }
    if (msg.t === 'join') {
      const host = this.sockets('host')[0]
      if (!host || this.sockets('peer').length >= MAX_PEERS) return send(ws, { t: 'no-room' })
      const id = crypto.randomUUID()
      ws.serializeAttachment({ role: 'peer', id } satisfies Attachment)
      return send(host, { t: 'peer', peer: id, sdp: msg.sdp })
    }
    if (msg.t === 'answer' && (ws.deserializeAttachment() as Attachment | null)?.role === 'host') {
      const peer = this.sockets('peer').find((p) => (p.deserializeAttachment() as { id: string }).id === msg.to)
      if (peer) send(peer, { t: 'answer', sdp: msg.sdp })
    }
  }
}

const app = new Elysia({ adapter: CloudflareAdapter })
  .get('/healthz', ({ set }) => {
    set.headers['Cache-Control'] = 'no-store'
    set.headers['Access-Control-Allow-Origin'] = '*'
    return 'ok'
  })
  .compile()

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    if (url.pathname === '/signal' || url.pathname === '/relay') {
      const code = url.searchParams.get('code')?.toUpperCase() ?? ''
      if (!ROOM_CODE.test(code)) return new Response('código inválido', { status: 400 })
      return env.SIGNAL.get(env.SIGNAL.idFromName(code)).fetch(request)
    }
    return app.fetch(request)
  },
} satisfies ExportedHandler<Env>
