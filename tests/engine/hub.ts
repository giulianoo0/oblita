// O hub real, com gravação dos bytes que ele toca. Uso: bun tests/engine/hub.ts <porta> <controle> <token>
import { createHub } from '../../server/hub'

const port = Number(process.argv[2] ?? 7787)
const control = Number(process.argv[3] ?? 7790)
const token = process.argv[4] ?? 'token-de-teste'

type Dir = 'up' | 'down'
let frames: { dir: Dir; bytes: Buffer }[] = []

const record = (dir: Dir, data: unknown) => {
  if (typeof data === 'string') frames.push({ dir, bytes: Buffer.from(data) })
  else if (data instanceof ArrayBuffer) frames.push({ dir, bytes: Buffer.from(data.slice(0)) })
  else if (ArrayBuffer.isView(data)) frames.push({ dir, bytes: Buffer.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) })
}

type Handlers = { message: (s: unknown, m: unknown) => unknown; open?: (s: unknown) => unknown }
type Sender = { sendBinary: (d: Uint8Array) => unknown }

// Capturar na rede veria o que o cliente manda mascarado pelo WebSocket, e a busca nunca acharia nada.
// Por isso a gravação fica nos pontos em que os bytes já estão crus: ao receber e ao enviar.
const serve = Bun.serve
const bun = Bun as unknown as { serve: unknown }
let patched = false
bun.serve = (options: { websocket?: Handlers }) => {
  const ws = options.websocket
  if (ws) {
    const { message, open } = ws
    ws.message = (sock, data) => {
      record('up', data)
      return message(sock, data)
    }
    ws.open = (sock) => {
      if (!patched) {
        patched = true
        const proto = Object.getPrototypeOf(sock) as Sender
        const send = proto.sendBinary
        proto.sendBinary = function (this: Sender, data: Uint8Array) {
          record('down', data)
          return send.call(this, data)
        }
      }
      return open?.(sock)
    }
  }
  return serve(options as never)
}

createHub(token).listen({ hostname: '0.0.0.0', port })
bun.serve = serve

Bun.serve({
  hostname: '127.0.0.1',
  port: control,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/reset') {
      frames = []
      return Response.json({ ok: true })
    }
    if (url.pathname === '/search') {
      const { needles } = (await req.json()) as { needles: string[] }
      const hits: Record<string, { up: number; down: number }> = {}
      for (const needle of needles) {
        const hit = { up: 0, down: 0 }
        const raw = Buffer.from(needle)
        for (const f of frames) if (f.bytes.includes(raw)) hit[f.dir]++
        hits[needle] = hit
      }
      const sum = (d: Dir) => frames.reduce((n, f) => n + (f.dir === d ? f.bytes.length : 0), 0)
      return Response.json({ hits, frames: frames.length, up: sum('up'), down: sum('down') })
    }
    return new Response('ok')
  },
})

console.log(`hub ${port} controle ${control}`)
