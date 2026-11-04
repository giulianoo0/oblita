// Site público: arquivos estáticos e a sinalização do modo "só navegador". Provas e respostas nunca passam aqui.
import { Elysia } from 'elysia'
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker'
import { DurableObject } from 'cloudflare:workers'

interface Env {
  SIGNAL: DurableObjectNamespace<SignalRoom>
  ASSETS: Fetcher
}

const ROOM_CODE = /^[A-Z0-9]{4,12}$/
const MAX_SIGNAL_BYTES = 16 * 1024
const MAX_PEERS = 512

type Attachment = { role: 'host' } | { role: 'peer'; id: string }

// Cada sala é um Durable Object: guarda o professor e faz o aperto de mão dos alunos.
export class SignalRoom extends DurableObject<Env> {
  async fetch(request: Request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('websocket', { status: 426 })
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  private sockets(role: Attachment['role']) {
    return this.ctx.getWebSockets().filter((ws) => (ws.deserializeAttachment() as Attachment | null)?.role === role)
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
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
    if (url.pathname === '/signal') {
      const code = url.searchParams.get('code')?.toUpperCase() ?? ''
      if (!ROOM_CODE.test(code)) return new Response('código inválido', { status: 400 })
      return env.SIGNAL.get(env.SIGNAL.idFromName(code)).fetch(request)
    }
    return app.fetch(request)
  },
} satisfies ExportedHandler<Env>
