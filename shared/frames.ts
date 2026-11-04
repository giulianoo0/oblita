// Tudo na rede é binário, inclusive JSON. Assim os três transportes (hub em Rust,
// hub em Elysia e WebRTC) tratam os quadros como bytes opacos e nunca os interpretam.
//
// Quadro: [u8 tag] ...
//   tag 1 (JSON):    [u8 1][utf-8]
//   tag 2 (binário): [u8 2][u32 tamanho do cabeçalho][cabeçalho JSON][bytes]
//   tag 4 (comprimido): [u8 4][deflate-raw de um quadro tag 1 ou 2]

const enc = new TextEncoder()
const dec = new TextDecoder()

export type Decoded<T> = { json: T; bytes?: Uint8Array }

export function encodeJson(msg: unknown): Uint8Array<ArrayBuffer> {
  const body = enc.encode(JSON.stringify(msg))
  const out = new Uint8Array(body.length + 1)
  out[0] = 1
  out.set(body, 1)
  return out
}

export function encodeBinary(header: unknown, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const head = enc.encode(JSON.stringify(header))
  const out = new Uint8Array(5 + head.length + bytes.length)
  out[0] = 2
  new DataView(out.buffer).setUint32(1, head.length)
  out.set(head, 5)
  out.set(bytes, 5 + head.length)
  return out
}

export function decodeFrame<T>(frame: Uint8Array): Decoded<T> {
  if (frame[0] === 1) return { json: JSON.parse(dec.decode(frame.subarray(1))) }
  if (frame[0] !== 2) throw new Error(`quadro inválido: ${frame[0]}`)
  const headLen = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1)
  return {
    json: JSON.parse(dec.decode(frame.subarray(5, 5 + headLen))),
    bytes: frame.subarray(5 + headLen),
  }
}

// ---- compressão: vai antes da cifra, porque cifrado não comprime mais

export const DEFLATE_TAG = 4
// Abaixo disto o cabeçalho do deflate e o custo de criar o fluxo não compensam.
export const COMPRESS_MIN = 512

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream, max: number) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    // Lê aos pedaços e para no limite: um quadro pequeno pode inflar para gigabytes.
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw new Error('quadro grande demais')
    }
    parts.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

export const deflate = (bytes: Uint8Array<ArrayBuffer>) => pipe(bytes, new CompressionStream('deflate-raw'), Infinity)
export const inflate = (bytes: Uint8Array, max: number) => pipe(bytes.slice(), new DecompressionStream('deflate-raw'), max)

// Comprime só o que encolhe de verdade. Vídeo e imagem já vêm comprimidos: quem envia nem tenta.
export async function deflateFrame(frame: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (frame.length < COMPRESS_MIN || frame[0] === DEFLATE_TAG) return frame
  const body = await deflate(frame)
  if (body.length + 1 >= frame.length) return frame
  const out = new Uint8Array(body.length + 1)
  out[0] = DEFLATE_TAG
  out.set(body, 1)
  return out
}

// Devolve o quadro aberto. Lança se não abrir, se passar de `max` ou se vier comprimido duas vezes.
export async function inflateFrame(frame: Uint8Array, max: number): Promise<Uint8Array<ArrayBuffer>> {
  if (frame[0] !== DEFLATE_TAG) return frame as Uint8Array<ArrayBuffer>
  const inner = await inflate(frame.subarray(1), max)
  if (inner[0] !== 1 && inner[0] !== 2) throw new Error('quadro comprimido inválido')
  return inner
}

// Protocolo do hub, entre o professor e o programa: [u32 conexão][u8 op][dados].
export const HubOp = { open: 0, close: 1, data: 2 } as const

export function encodeHub(conn: number, op: number, data?: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(5 + (data?.length ?? 0))
  const view = new DataView(out.buffer)
  view.setUint32(0, conn)
  out[4] = op
  if (data) out.set(data, 5)
  return out
}

export function decodeHub(frame: Uint8Array) {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  return { conn: view.getUint32(0), op: frame[4], data: frame.subarray(5) }
}
