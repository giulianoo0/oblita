// Exporta o resultado da sala em .zip, por pessoa ou grupo, gravando direto em disco.
// O zip é "store" (sem compressão) porque quase tudo em volume é vídeo já comprimido,
// e usa ZIP64 porque uma turma inteira com gravação passa fácil de 4 GB.
// A estrutura de pastas é a de layout.ts, a mesma que o programa grava na pasta da prova.
import { idb } from '../lib/idb'
import { roomLayout, safeName } from './layout'
import type { Room } from './room'

export { alertLabel, safeName } from './layout'

const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(crc: number, bytes: Uint8Array) {
  let c = ~crc >>> 0
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

export interface Sink {
  write(bytes: Uint8Array): Promise<void>
  close(): Promise<void>
  abort?(): Promise<void>
}

const enc = new TextEncoder()
const VERSION_ZIP64 = 45
const FLAG_UTF8 = 0x0800

// Hora local em formato DOS. Data zerada é inválida, e há extrator que reclama.
function dosStamp(d: Date) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

export class ZipWriter {
  private offset = 0
  private entries: { name: Uint8Array; crc: number; size: number; offset: number }[] = []
  private stamp = dosStamp(new Date())

  constructor(private sink: Sink) {}

  private async put(bytes: Uint8Array) {
    await this.sink.write(bytes)
    this.offset += bytes.length
  }

  async add(path: string, content: string | Blob | Uint8Array) {
    const blob = content instanceof Blob ? content : new Blob([typeof content === 'string' ? enc.encode(content) : (content as Uint8Array<ArrayBuffer>)])
    // O CRC vai no cabeçalho local, então o arquivo é lido uma vez antes de ser escrito.
    let crc = 0
    for await (const chunk of chunks(blob)) crc = crc32(crc, chunk)
    const name = enc.encode(path)
    const offset = this.offset
    const zip64Extra = new Uint8Array(20)
    const ev = new DataView(zip64Extra.buffer)
    ev.setUint16(0, 1, true)
    ev.setUint16(2, 16, true)
    ev.setBigUint64(4, BigInt(blob.size), true)
    ev.setBigUint64(12, BigInt(blob.size), true)
    const head = new Uint8Array(30)
    const h = new DataView(head.buffer)
    h.setUint32(0, 0x04034b50, true)
    h.setUint16(4, VERSION_ZIP64, true)
    h.setUint16(6, FLAG_UTF8, true)
    h.setUint16(10, this.stamp.time, true)
    h.setUint16(12, this.stamp.date, true)
    h.setUint32(14, crc, true)
    h.setUint32(18, 0xffffffff, true)
    h.setUint32(22, 0xffffffff, true)
    h.setUint16(26, name.length, true)
    h.setUint16(28, zip64Extra.length, true)
    await this.put(head)
    await this.put(name)
    await this.put(zip64Extra)
    for await (const chunk of chunks(blob)) await this.put(chunk)
    this.entries.push({ name, crc, size: blob.size, offset })
  }

  async finish() {
    const dirStart = this.offset
    for (const e of this.entries) {
      const extra = new Uint8Array(28)
      const ev = new DataView(extra.buffer)
      ev.setUint16(0, 1, true)
      ev.setUint16(2, 24, true)
      ev.setBigUint64(4, BigInt(e.size), true)
      ev.setBigUint64(12, BigInt(e.size), true)
      ev.setBigUint64(20, BigInt(e.offset), true)
      const head = new Uint8Array(46)
      const h = new DataView(head.buffer)
      h.setUint32(0, 0x02014b50, true)
      h.setUint16(4, VERSION_ZIP64, true)
      h.setUint16(6, VERSION_ZIP64, true)
      h.setUint16(8, FLAG_UTF8, true)
      h.setUint16(12, this.stamp.time, true)
      h.setUint16(14, this.stamp.date, true)
      h.setUint32(16, e.crc, true)
      h.setUint32(20, 0xffffffff, true)
      h.setUint32(24, 0xffffffff, true)
      h.setUint16(28, e.name.length, true)
      h.setUint16(30, extra.length, true)
      h.setUint32(42, 0xffffffff, true)
      await this.put(head)
      await this.put(e.name)
      await this.put(extra)
    }
    const dirSize = this.offset - dirStart
    const dirEnd = this.offset
    const z = new Uint8Array(56 + 20 + 22)
    const d = new DataView(z.buffer)
    d.setUint32(0, 0x06064b50, true)
    d.setBigUint64(4, 44n, true)
    d.setUint16(12, VERSION_ZIP64, true)
    d.setUint16(14, VERSION_ZIP64, true)
    d.setBigUint64(24, BigInt(this.entries.length), true)
    d.setBigUint64(32, BigInt(this.entries.length), true)
    d.setBigUint64(40, BigInt(dirSize), true)
    d.setBigUint64(48, BigInt(dirStart), true)
    d.setUint32(56, 0x07064b50, true)
    d.setBigUint64(64, BigInt(dirEnd), true)
    d.setUint32(72, 1, true)
    d.setUint32(76, 0x06054b50, true)
    d.setUint16(84, 0xffff, true)
    d.setUint16(86, 0xffff, true)
    d.setUint32(88, 0xffffffff, true)
    d.setUint32(92, 0xffffffff, true)
    await this.put(z)
    await this.sink.close()
  }
}

async function* chunks(blob: Blob) {
  const reader = blob.stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    yield value
  }
}

export interface ExportOptions {
  video: boolean
  onProgress?: (done: number, total: number) => void
}

// Só lê o que é público da sala: token, chave e códigos de equipe nunca passam por aqui.
export async function writeRoomZip(room: Room, sink: Sink, opts: ExportOptions) {
  const zip = new ZipWriter(sink)
  const [root, ...units] = roomLayout(room)
  const add = async (entry: (typeof root)[number]) => {
    if ('text' in entry) return zip.add(entry.path, entry.text())
    if (!opts.video) return
    const blob = await room.segmentBlob(entry.segment.clientId, entry.segment.info)
    if (blob.size) await zip.add(entry.path, blob)
  }
  for (const entry of root) await add(entry)
  let done = 0
  for (const unit of units) {
    for (const entry of unit) await add(entry)
    opts.onProgress?.(++done, units.length)
  }
  await zip.finish()
}

// Sem a API de salvar em disco, o zip inteiro precisaria caber na memória: aí vai sem vídeo.
export const canStreamToDisk = () => 'showSaveFilePicker' in window

export async function exportRoomZip(room: Room, opts: ExportOptions) {
  const fileName = `${safeName(room.config.title)}.zip`
  if (canStreamToDisk()) {
    const handle = await (window as unknown as { showSaveFilePicker: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker({
      suggestedName: fileName,
      types: [{ description: 'Zip', accept: { 'application/zip': ['.zip'] } }],
    })
    const stream = await handle.createWritable()
    try {
      await writeRoomZip(room, { write: async (b) => stream.write(b as Uint8Array<ArrayBuffer>), close: () => stream.close() }, opts)
    } catch (err) {
      // Sem isto fica um arquivo temporário pela metade ao lado do destino.
      await stream.abort().catch(() => {})
      throw err
    }
    return
  }
  const parts: Uint8Array<ArrayBuffer>[] = []
  await writeRoomZip(room, { write: async (b) => void parts.push(b.slice()), close: async () => {} }, { ...opts, video: false })
  download(new Blob(parts, { type: 'application/zip' }), fileName)
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

export const hasVideo = async (room: Room) =>
  (await idb.keys('chunks', idb.prefix(`${room.config.roomId}/`))).length > 0
