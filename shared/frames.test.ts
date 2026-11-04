import { describe, expect, test } from 'bun:test'
import { COMPRESS_MIN, DEFLATE_TAG, decodeFrame, deflate, deflateFrame, encodeBinary, encodeJson, inflate, inflateFrame } from './frames'

const MAX = 1024 * 1024

describe('compressão de quadros', () => {
  test('JSON grande vai comprimido e volta igual', async () => {
    const msg = { t: 'draft', text: 'int main() { return 0; }\n'.repeat(200) }
    const frame = encodeJson(msg)
    const packed = await deflateFrame(frame)
    expect(packed[0]).toBe(DEFLATE_TAG)
    expect(packed.length).toBeLessThan(frame.length / 5)
    const back = await inflateFrame(packed, MAX)
    expect(decodeFrame(back).json).toEqual(msg)
  })

  test('binário com cabeçalho volta com os mesmos bytes', async () => {
    const bytes = new Uint8Array(4000).map((_, i) => i % 7)
    const packed = await deflateFrame(encodeBinary({ t: 'y-update' }, bytes))
    expect(packed[0]).toBe(DEFLATE_TAG)
    const back = decodeFrame(await inflateFrame(packed, MAX))
    expect(back.json).toEqual({ t: 'y-update' })
    expect([...back.bytes!]).toEqual([...bytes])
  })

  test('abaixo do mínimo não comprime', async () => {
    const frame = encodeJson({ t: 'beat', at: 1 })
    expect(frame.length).toBeLessThan(COMPRESS_MIN)
    expect(await deflateFrame(frame)).toBe(frame)
  })

  test('o que não encolhe vai como está', async () => {
    const noise = crypto.getRandomValues(new Uint8Array(8000))
    const frame = encodeBinary({ t: 'frame' }, noise)
    expect(await deflateFrame(frame)).toBe(frame)
  })

  test('quadro sem compressão passa direto', async () => {
    const frame = encodeJson({ t: 'beat' })
    expect(await inflateFrame(frame, MAX)).toBe(frame)
  })

  test('quadro adulterado é recusado', async () => {
    const packed = await deflateFrame(encodeJson({ t: 'x', s: 'abc'.repeat(500) }))
    const bad = packed.slice()
    for (let i = 1; i < bad.length; i++) bad[i] ^= 0x5a
    await expect(inflateFrame(bad, MAX)).rejects.toThrow()
  })

  test('quadro cortado é recusado', async () => {
    const packed = await deflateFrame(encodeJson({ t: 'x', s: 'abcdefgh'.repeat(500) }))
    await expect(inflateFrame(packed.subarray(0, packed.length - 6), MAX)).rejects.toThrow()
  })

  test('bomba de descompressão para no limite', async () => {
    const huge = new Uint8Array(8 * 1024 * 1024)
    const bomb = await deflate(encodeBinary({ t: 'y-update' }, huge))
    const frame = new Uint8Array(bomb.length + 1)
    frame[0] = DEFLATE_TAG
    frame.set(bomb, 1)
    expect(frame.length).toBeLessThan(64 * 1024)
    await expect(inflateFrame(frame, MAX)).rejects.toThrow('grande')
  })

  test('compressão dentro de compressão é recusada', async () => {
    const inner = await deflateFrame(encodeJson({ t: 'x', s: 'z'.repeat(2000) }))
    const twice = await deflate(inner)
    const frame = new Uint8Array(twice.length + 1)
    frame[0] = DEFLATE_TAG
    frame.set(twice, 1)
    await expect(inflateFrame(frame, MAX)).rejects.toThrow()
  })

  test('deflate e inflate soltos, para bytes já guardados comprimidos', async () => {
    const text = new TextEncoder().encode(JSON.stringify({ questions: ['a'.repeat(3000)] }))
    const z = await deflate(text)
    expect([...(await inflate(z, MAX))]).toEqual([...text])
    await expect(inflate(z, 100)).rejects.toThrow('grande')
  })
})
