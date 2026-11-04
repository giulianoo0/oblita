// O hub em Elysia é o dublê do programa em Rust: tem de seguir o mesmo contrato de bytes.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { HubOp, decodeHub, encodeHub } from '../shared/frames'
import { createHub } from '../server/hub'

const TOKEN = 'token-de-teste'
const PORT = 17787
const http = `http://127.0.0.1:${PORT}`
const ws = `ws://127.0.0.1:${PORT}`
let app: ReturnType<typeof createHub>

function open(url: string): Promise<{ sock: WebSocket; frames: Uint8Array[]; next: () => Promise<Uint8Array> }> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url)
    sock.binaryType = 'arraybuffer'
    const frames: Uint8Array[] = []
    const waiters: ((f: Uint8Array) => void)[] = []
    sock.onmessage = (e) => {
      const f = new Uint8Array(e.data as ArrayBuffer)
      const w = waiters.shift()
      if (w) w(f)
      else frames.push(f)
    }
    sock.onerror = () => reject(new Error('falhou ao abrir'))
    sock.onopen = () =>
      resolve({
        sock,
        frames,
        next: () => {
          const f = frames.shift()
          return f ? Promise.resolve(f) : new Promise((r) => waiters.push(r))
        },
      })
  })
}

const closed = (s: WebSocket) => new Promise<void>((r) => (s.readyState === WebSocket.CLOSED ? r() : (s.onclose = () => r())))

beforeAll(() => {
  app = createHub(TOKEN).listen({ hostname: '127.0.0.1', port: PORT })
})
afterAll(() => {
  app.stop()
})

describe('hub', () => {
  test('/ping responde com os cabeçalhos de rede local', async () => {
    const res = await fetch(`${http}/ping`, { headers: { origin: 'https://oblita.giuli.dev' } })
    expect(await res.json()).toMatchObject({ app: 'oblita', v: 1 })
    expect(res.headers.get('access-control-allow-private-network')).toBe('true')
    expect(res.headers.get('access-control-allow-local-network')).toBe('true')
    expect(res.headers.get('access-control-allow-origin')).toBe('https://oblita.giuli.dev')
  })

  test('preflight responde 204', async () => {
    const res = await fetch(`${http}/ping`, { method: 'OPTIONS', headers: { origin: 'https://oblita.giuli.dev' } })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-local-network')).toBe('true')
  })

  test('/host-token exige origem permitida', async () => {
    expect((await fetch(`${http}/host-token`, { headers: { origin: 'https://malicioso.example' } })).status).toBe(403)
    expect((await fetch(`${http}/host-token`)).status).toBe(403)
    const ok = await fetch(`${http}/host-token`, { headers: { origin: 'https://oblita.giuli.dev' } })
    expect(ok.status).toBe(200)
    expect((await ok.json()).token).toBe(TOKEN)
  })

  test('painel com token errado é recusado', async () => {
    const bad = await open(`${ws}/ws/host?token=errado`)
    await closed(bad.sock)
    expect(bad.sock.readyState).toBe(WebSocket.CLOSED)
  })

  test('repassa bytes nos dois sentidos, e o aluno sobrevive ao painel recarregar', async () => {
    const host = await open(`${ws}/ws/host?token=${TOKEN}`)
    const student = await open(`${ws}/ws/student`)
    const opened = decodeHub(await host.next())
    expect(opened.op).toBe(HubOp.open)

    student.sock.send(new Uint8Array([1, 2, 3]))
    const data = decodeHub(await host.next())
    expect(data.op).toBe(HubOp.data)
    expect(data.conn).toBe(opened.conn)
    expect([...data.data]).toEqual([1, 2, 3])

    host.sock.send(encodeHub(opened.conn, HubOp.data, new Uint8Array([9, 8])))
    expect([...(await student.next())]).toEqual([9, 8])

    // O painel cai e volta: o aluno continua, e é reapresentado.
    host.sock.close()
    await closed(host.sock)
    expect(student.sock.readyState).toBe(WebSocket.OPEN)
    const again = await open(`${ws}/ws/host?token=${TOKEN}`)
    const reopened = decodeHub(await again.next())
    expect(reopened.op).toBe(HubOp.open)
    expect(reopened.conn).toBe(opened.conn)

    // Painel derruba um aluno.
    again.sock.send(encodeHub(opened.conn, HubOp.close))
    await closed(student.sock)
    const bye = decodeHub(await again.next())
    expect(bye.op).toBe(HubOp.close)
    again.sock.close()
  })

  test('um segundo painel substitui o primeiro', async () => {
    const first = await open(`${ws}/ws/host?token=${TOKEN}`)
    const second = await open(`${ws}/ws/host?token=${TOKEN}`)
    await closed(first.sock)
    expect(second.sock.readyState).toBe(WebSocket.OPEN)
    second.sock.close()
  })

  test('quadro curto ou conexão desconhecida não derruba nada', async () => {
    const host = await open(`${ws}/ws/host?token=${TOKEN}`)
    host.sock.send(new Uint8Array([1, 2]))
    host.sock.send(encodeHub(999999, HubOp.data, new Uint8Array([1])))
    const student = await open(`${ws}/ws/student`)
    expect(decodeHub(await host.next()).op).toBe(HubOp.open)
    student.sock.close()
    host.sock.close()
  })
})
