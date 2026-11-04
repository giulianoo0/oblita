// Tudo na rede é binário, inclusive JSON. Assim os três transportes (hub em Rust,
// hub em Elysia e WebRTC) tratam os quadros como bytes opacos e nunca os interpretam.
//
// Quadro: [u8 tag] ...
//   tag 1 (JSON):    [u8 1][utf-8]
//   tag 2 (binário): [u8 2][u32 tamanho do cabeçalho][cabeçalho JSON][bytes]

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
