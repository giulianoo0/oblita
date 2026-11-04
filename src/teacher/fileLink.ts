// Canal de arquivos com o programa do professor: só escreve, dentro da pasta que o professor
// escolheu no programa. Formato em host/src/files_ws.rs; mudou um, mude o outro.
//   pedido:   [u32 id][u8 op][u64 offset][u16 tamanho do caminho][caminho][corpo]
//   resposta: [u32 id][u8 situação][corpo]; o id 0 é aviso do programa, como a troca de pasta.
export const FileOp = { writeAt: 1, replace: 2, remove: 4, info: 6, done: 7 } as const
export const FileStatus = { ok: 0, invalid: 1, noSpace: 2, denied: 3, notFound: 4, gap: 5, noRoot: 6, busy: 7, io: 8, limit: 9 } as const

const enc = new TextEncoder()
const dec = new TextDecoder()
const TIMEOUT_MS = 20_000

export function encodeFileRequest(id: number, op: number, path: string, offset = 0, body?: Uint8Array): Uint8Array<ArrayBuffer> {
  const name = enc.encode(path)
  const out = new Uint8Array(15 + name.length + (body?.length ?? 0))
  const view = new DataView(out.buffer)
  view.setUint32(0, id)
  out[4] = op
  view.setBigUint64(5, BigInt(offset))
  view.setUint16(13, name.length)
  out.set(name, 15)
  if (body) out.set(body, 15 + name.length)
  return out
}

export function decodeFileResponse(frame: Uint8Array) {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  return { id: view.getUint32(0), status: frame[4], body: frame.subarray(5) }
}

export interface DiskInfo {
  root: string
  free: number | null
  exists: boolean
}

export class FileError extends Error {
  constructor(
    readonly status: number | 'timeout' | 'down',
    message: string,
  ) {
    super(message)
  }
}

export interface LinkOptions {
  url: string
  socket?: (url: string) => WebSocket
  timeoutMs?: number
}

type Pending = { resolve: (body: Uint8Array) => void; reject: (e: FileError) => void; timer: ReturnType<typeof setTimeout> }

export class FileLink {
  oninfo: (info: DiskInfo) => void = () => {}
  onclose: () => void = () => {}
  private nextId = 1
  private pending = new Map<number, Pending>()
  private closed = false

  private constructor(
    private ws: WebSocket,
    private timeoutMs: number,
  ) {}

  static connect(token: string, opts: LinkOptions): Promise<FileLink> {
    return new Promise((resolve, reject) => {
      const url = `${opts.url}?token=${encodeURIComponent(token)}`
      const ws = opts.socket ? opts.socket(url) : new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      const link = new FileLink(ws, opts.timeoutMs ?? TIMEOUT_MS)
      let opened = false
      ws.onopen = () => {
        opened = true
        resolve(link)
      }
      ws.onerror = () => {
        if (!opened) reject(new FileError('down', 'o programa recusou a gravação'))
      }
      ws.onclose = () => {
        if (!opened) reject(new FileError('down', 'o programa recusou a gravação'))
        else link.shut()
      }
      ws.onmessage = (e) => link.onMessage(new Uint8Array(e.data as ArrayBuffer))
    })
  }

  get open() {
    return !this.closed && this.ws.readyState === 1
  }

  private shut() {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new FileError('down', 'o programa fechou'))
    }
    this.pending.clear()
    this.onclose()
  }

  private onMessage(frame: Uint8Array) {
    if (frame.length < 5) return
    const { id, status, body } = decodeFileResponse(frame)
    if (id === 0) {
      try {
        this.oninfo(JSON.parse(dec.decode(body)) as DiskInfo)
      } catch {
        // Aviso ilegível não derruba nada.
      }
      return
    }
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    if (status === FileStatus.ok) p.resolve(body)
    else p.reject(new FileError(status, dec.decode(body)))
  }

  private request(op: number, path: string, offset = 0, body?: Uint8Array): Promise<Uint8Array> {
    if (!this.open) return Promise.reject(new FileError('down', 'programa desconectado'))
    const id = this.nextId++
    if (this.nextId > 0xfffffff0) this.nextId = 1
    return new Promise((resolve, reject) => {
      // Sem resposta, o pedaço vai para o navegador; se o disco escrever depois, repetir no mesmo ponto não duplica.
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new FileError('timeout', 'o programa não respondeu'))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.ws.send(encodeFileRequest(id, op, path, offset, body))
      } catch {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new FileError('down', 'programa desconectado'))
      }
    })
  }

  async writeAt(path: string, offset: number, bytes: Uint8Array) {
    await this.request(FileOp.writeAt, path, offset, bytes)
  }

  async replace(path: string, data: string | Uint8Array) {
    await this.request(FileOp.replace, path, 0, typeof data === 'string' ? enc.encode(data) : data)
  }

  async remove(path: string) {
    await this.request(FileOp.remove, path)
  }

  async info(): Promise<DiskInfo> {
    return JSON.parse(dec.decode(await this.request(FileOp.info, ''))) as DiskInfo
  }

  async done(roomDir: string): Promise<string> {
    return (JSON.parse(dec.decode(await this.request(FileOp.done, roomDir))) as { path: string }).path
  }

  close() {
    this.ws.close()
    this.shut()
  }
}
