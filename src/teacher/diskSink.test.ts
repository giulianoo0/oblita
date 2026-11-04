import { describe, expect, test } from 'bun:test'
import { DiskMirror, type MirrorLink } from './diskSink'
import type { LayoutEntry } from './layout'

class FakeLink implements MirrorLink {
  files = new Map<string, string>()
  ops: string[] = []
  failing = new Set<string>()
  async replace(path: string, data: string | Uint8Array) {
    this.ops.push(`w ${path}`)
    if (this.failing.has(path)) throw new Error('aberto no Excel')
    this.files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
  }
  async remove(path: string) {
    this.ops.push(`rm ${path}`)
    this.files.delete(path)
  }
}

const text = (path: string, content: string, stamp?: unknown): LayoutEntry => ({ path, text: () => content, stamp })

function memory() {
  let saved: string[] = []
  return { load: async () => saved, save: async (paths: string[]) => void (saved = paths), get: () => saved }
}

describe('DiskMirror', () => {
  test('grava tudo dentro da pasta da sala, e depois só o que mudou', async () => {
    let layout: LayoutEntry[][] = [[text('resumo.csv', 'a'), text('prova.json', 'P', 'exame')], [text('alunos/Ana/q1/sem-resposta.txt', '')]]
    const link = new FakeLink()
    const mirror = new DiskMirror('Prova 2026', () => layout, memory())
    expect(await mirror.sync(link)).toEqual({ failed: [] })
    expect([...link.files.keys()].sort()).toEqual(['Prova 2026/alunos/Ana/q1/sem-resposta.txt', 'Prova 2026/prova.json', 'Prova 2026/resumo.csv'])
    link.ops = []
    await mirror.sync(link)
    expect(link.ops).toEqual([])
    layout = [[text('resumo.csv', 'b'), text('prova.json', 'nunca recalculado', 'exame')], [text('alunos/Ana/q1/main.cpp', 'int main')]]
    await mirror.sync(link)
    expect(link.ops.sort()).toEqual(['rm Prova 2026/alunos/Ana/q1/sem-resposta.txt', 'w Prova 2026/alunos/Ana/q1/main.cpp', 'w Prova 2026/resumo.csv'])
    expect(link.files.get('Prova 2026/prova.json')).toBe('P')
  })

  test('arquivo que falhou volta na próxima vez, e os outros seguem', async () => {
    const link = new FakeLink()
    link.failing.add('Prova/resumo.csv')
    const mirror = new DiskMirror('Prova', () => [[text('resumo.csv', 'a'), text('prova.json', 'P')]], memory())
    expect(await mirror.sync(link)).toEqual({ failed: ['Prova/resumo.csv'] })
    expect(link.files.has('Prova/prova.json')).toBe(true)
    link.failing.clear()
    link.ops = []
    expect(await mirror.sync(link)).toEqual({ failed: [] })
    expect(link.ops).toEqual(['w Prova/resumo.csv'])
  })

  test('depois de um F5, o que sobrou de antes ainda é apagado', async () => {
    const store = memory()
    const link = new FakeLink()
    await new DiskMirror('P', () => [[text('alunos/Ana/q1/sem-resposta.txt', '')]], store).sync(link)
    const reloaded = new DiskMirror('P', () => [[text('alunos/Ana/q1/main.cpp', 'x')]], store)
    await reloaded.sync(link)
    expect([...link.files.keys()]).toEqual(['P/alunos/Ana/q1/main.cpp'])
  })

  test('pasta trocada no programa: regrava tudo na nova', async () => {
    const link = new FakeLink()
    const mirror = new DiskMirror('P', () => [[text('resumo.csv', 'a')]], memory())
    await mirror.sync(link)
    mirror.reset()
    link.ops = []
    await mirror.sync(link)
    expect(link.ops).toEqual(['w P/resumo.csv'])
  })

  test('caminho do vídeo vem da última estrutura calculada', async () => {
    const seg = { segment: 3, startedAt: 1, mime: 'video/webm', parts: 0, size: 0, complete: false }
    const mirror = new DiskMirror('P', () => [[{ path: 'alunos/Ana/gravacao/0003.webm', segment: { clientId: 'aaaa', info: seg } }]], memory())
    expect(mirror.pathFor('aaaa', seg)).toBe('P/alunos/Ana/gravacao/0003.webm')
    expect(mirror.pathFor('zzzz', seg)).toBeNull()
  })
})
