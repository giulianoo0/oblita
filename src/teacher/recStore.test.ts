import { describe, expect, test } from 'bun:test'
import { Recordings, type RecDisk, type RecBrowser } from './recStore'
import type { SegmentInfo } from './room'

class FakeDisk implements RecDisk {
  files = new Map<string, Uint8Array>()
  fail = false
  async writeAt(path: string, offset: number, bytes: Uint8Array) {
    if (this.fail) throw new Error('disco cheio')
    const old = this.files.get(path) ?? new Uint8Array()
    if (offset > old.length) throw new Error('buraco')
    const out = new Uint8Array(offset + bytes.length)
    out.set(old.subarray(0, offset))
    out.set(bytes, offset)
    this.files.set(path, out)
  }
}

class FakeBrowser implements RecBrowser {
  parts = new Map<string, Blob>()
  fail = false
  async put(key: string, blob: Blob) {
    if (this.fail) throw new Error('cota do navegador')
    this.parts.set(key, blob)
  }
  async values(prefix: string) {
    return [...this.parts].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v)
  }
  async remove(prefix: string) {
    for (const k of [...this.parts.keys()]) if (k.startsWith(prefix)) this.parts.delete(k)
  }
}

const seg = (): SegmentInfo => ({ segment: 0, startedAt: 1, mime: 'video/webm', parts: 0, size: 0, complete: false })
const bytes = (...b: number[]) => new Uint8Array(b)
const text = async (blob: Blob) => [...new Uint8Array(await blob.arrayBuffer())]

function setup(withDisk = true) {
  const disk = new FakeDisk()
  const browser = new FakeBrowser()
  const rec = new Recordings('sala', { disk: () => (withDisk ? disk : null), browser, pathFor: () => 'Prova/alunos/Ana/gravacao/0000.webm' })
  return { disk, browser, rec }
}

describe('Recordings', () => {
  test('com o programa, cada pedaço é acrescentado ao arquivo do segmento e nada fica no navegador', async () => {
    const { disk, browser, rec } = setup()
    const s = seg()
    expect(await rec.store('aaaa', s, 0, bytes(1, 2))).toBe('disk')
    expect(await rec.store('aaaa', s, 1, bytes(3))).toBe('disk')
    expect([...disk.files.get('Prova/alunos/Ana/gravacao/0000.webm')!]).toEqual([1, 2, 3])
    expect(s.file).toBe('Prova/alunos/Ana/gravacao/0000.webm')
    expect(s.disk).toBe(3)
    expect(browser.parts.size).toBe(0)
  })

  test('disco falhou: o resto do segmento vai para o navegador, e volta ao disco depois', async () => {
    const { disk, browser, rec } = setup()
    const s = seg()
    await rec.store('aaaa', s, 0, bytes(1))
    disk.fail = true
    expect(await rec.store('aaaa', s, 1, bytes(2))).toBe('browser')
    disk.fail = false
    // O disco voltou, mas o arquivo só pode crescer na ordem: o pedaço seguinte também fica no navegador.
    expect(await rec.store('aaaa', s, 2, bytes(3))).toBe('browser')
    expect(s.browserFrom).toBe(1)
    expect(await rec.flush('aaaa', s)).toBe(true)
    expect([...disk.files.get(s.file!)!]).toEqual([1, 2, 3])
    expect(s.disk).toBe(3)
    expect(s.browserFrom).toBeUndefined()
    expect(browser.parts.size).toBe(0)
  })

  test('sem disco e sem navegador, falha sem mexer no segmento', async () => {
    const { disk, browser, rec } = setup()
    const s = seg()
    disk.fail = true
    browser.fail = true
    await expect(rec.store('aaaa', s, 0, bytes(1))).rejects.toThrow()
    expect(s).toEqual(seg())
  })

  test('só navegador: guarda por pedaço e monta o segmento para o player e o zip', async () => {
    const { browser, rec } = setup(false)
    const s = seg()
    expect(await rec.store('aaaa', s, 0, bytes(1))).toBe('browser')
    expect(await rec.store('aaaa', s, 1, bytes(2))).toBe('browser')
    expect(browser.parts.size).toBe(2)
    expect(await text(await rec.blob('aaaa', s))).toEqual([1, 2])
    expect(await rec.flush('aaaa', s)).toBe(false)
  })

  test('segmento que já começou no disco não é montado pela metade no navegador', async () => {
    const { disk, rec } = setup()
    const s = seg()
    await rec.store('aaaa', s, 0, bytes(1))
    disk.fail = true
    await rec.store('aaaa', s, 1, bytes(2))
    expect((await rec.blob('aaaa', s)).size).toBe(0)
  })
})
