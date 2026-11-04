import { describe, expect, test } from 'bun:test'
import { FileOp, FileStatus, decodeFileResponse, encodeFileRequest, FileLink } from './fileLink'

describe('formato do canal de arquivos', () => {
  test('pedido no mesmo formato que o programa lê', () => {
    const frame = encodeFileRequest(7, FileOp.writeAt, 'sala/ç.webm', 300, new Uint8Array([9, 8]))
    const view = new DataView(frame.buffer)
    expect(view.getUint32(0)).toBe(7)
    expect(frame[4]).toBe(FileOp.writeAt)
    expect(view.getBigUint64(5)).toBe(300n)
    const pathLen = view.getUint16(13)
    expect(new TextDecoder().decode(frame.subarray(15, 15 + pathLen))).toBe('sala/ç.webm')
    expect([...frame.subarray(15 + pathLen)]).toEqual([9, 8])
  })

  test('resposta traz id, situação e corpo', () => {
    const frame = new Uint8Array([0, 0, 1, 2, FileStatus.gap, 111, 107])
    const res = decodeFileResponse(frame)
    expect(res.id).toBe(258)
    expect(res.status).toBe(FileStatus.gap)
    expect(new TextDecoder().decode(res.body)).toBe('ok')
  })
})

// Um WebSocket de mentira que responde como o programa, para ver as promessas sem rede.
class FakeSocket {
  static last: FakeSocket
  binaryType = 'arraybuffer'
  readyState = 0
  sent: Uint8Array[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null
  constructor(public url: string) {
    FakeSocket.last = this
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.()
    })
  }
  send(frame: Uint8Array) {
    this.sent.push(frame)
  }
  close() {
    this.readyState = 3
    this.onclose?.()
  }
  reply(id: number, status: number, body = new Uint8Array()) {
    const out = new Uint8Array(5 + body.length)
    new DataView(out.buffer).setUint32(0, id)
    out[4] = status
    out.set(body, 5)
    this.onmessage?.({ data: out.buffer })
  }
}

const connect = () => FileLink.connect('tok', { url: 'ws://x/ws/files', socket: (url) => new FakeSocket(url) as unknown as WebSocket, timeoutMs: 50 })

describe('FileLink', () => {
  test('resolve na resposta certa e rejeita com a situação do programa', async () => {
    const link = await connect()
    const sock = FakeSocket.last
    expect(sock.url).toBe('ws://x/ws/files?token=tok')
    const a = link.replace('sala/a.txt', 'oi')
    const b = link.writeAt('sala/b.webm', 10, new Uint8Array([1]))
    const ids = sock.sent.map((f) => new DataView(f.buffer).getUint32(0))
    sock.reply(ids[1], FileStatus.gap, new TextEncoder().encode('sem começo'))
    sock.reply(ids[0], FileStatus.ok)
    await a
    await expect(b).rejects.toMatchObject({ status: FileStatus.gap })
  })

  test('programa mudo vira erro por tempo, e queda rejeita o que estava pendente', async () => {
    const link = await connect()
    await expect(link.remove('sala/x.txt')).rejects.toMatchObject({ status: 'timeout' })
    const pending = link.replace('sala/y.txt', 'x')
    let closed = false
    link.onclose = () => (closed = true)
    FakeSocket.last.close()
    await expect(pending).rejects.toMatchObject({ status: 'down' })
    expect(closed).toBe(true)
    expect(link.open).toBe(false)
    await expect(link.replace('sala/z.txt', 'x')).rejects.toMatchObject({ status: 'down' })
  })

  test('aviso de pasta do programa chega em oninfo', async () => {
    const link = await connect()
    const seen: unknown[] = []
    link.oninfo = (info) => seen.push(info)
    FakeSocket.last.reply(0, FileStatus.ok, new TextEncoder().encode(JSON.stringify({ t: 'info', root: '/p', free: 5, exists: true })))
    expect(seen).toEqual([{ t: 'info', root: '/p', free: 5, exists: true }])
  })
})
