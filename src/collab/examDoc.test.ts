import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { ExamDoc } from './examDoc'

const Q = 'q1'

// Dois integrantes a partir do que o professor semeou.
function team() {
  const teacher = new ExamDoc()
  teacher.seed(Q, 'cpp', 'main.cpp', 'int main() {}\n')
  const a = new ExamDoc()
  const b = new ExamDoc()
  a.apply(teacher.encodeState())
  b.apply(teacher.encodeState())
  return { teacher, a, b, sync: () => {
    a.apply(b.diffFor(a.encodeVector()))
    b.apply(a.diffFor(b.encodeVector()))
  } }
}

const text = (d: ExamDoc, name = 'main.cpp') => d.files(Q).get(name)!

describe('ExamDoc', () => {
  test('semear de novo não duplica', () => {
    const d = new ExamDoc()
    d.seed(Q, 'c', 'main.c', 'x')
    d.seed(Q, 'c', 'main.c', 'x')
    expect(d.snapshot(Q)).toEqual({ type: 'code', lang: 'c', files: { 'main.c': 'x' } })
  })

  test('edições simultâneas convergem sem perder nada', () => {
    const { a, b, sync } = team()
    text(a).insert(0, '// a\n')
    text(b).insert(text(b).length, '// b\n')
    sync()
    expect(text(a).toString()).toBe(text(b).toString())
    expect(text(a).toString()).toContain('// a')
    expect(text(a).toString()).toContain('// b')
  })

  test('desfazer só apaga o que a própria pessoa fez', () => {
    const { a, b, sync } = team()
    const origin = {}
    const undo = new Y.UndoManager(text(a), { trackedOrigins: new Set([origin]) })
    a.doc.transact(() => text(a).insert(0, '// meu\n'), origin)
    sync()
    text(b).insert(text(b).length, '// colega\n')
    sync()
    undo.undo()
    sync()
    expect(text(b).toString()).not.toContain('// meu')
    expect(text(b).toString()).toContain('// colega')
    undo.redo()
    sync()
    expect(text(b).toString()).toContain('// meu')
  })

  test('quem ficou sem rede mescla ao voltar', () => {
    const { a, b, sync } = team()
    for (let i = 0; i < 50; i++) text(a).insert(0, `a${i}\n`)
    for (let i = 0; i < 50; i++) text(b).insert(0, `b${i}\n`)
    sync()
    expect(text(a).toString()).toBe(text(b).toString())
    expect(text(a).toString().split('\n').length).toBe(102)
  })

  test('arquivos são compartilhados, e renomear mantém o texto', () => {
    const { a, b, sync } = team()
    a.addFile(Q, 'util.h', '#pragma once\n')
    sync()
    b.renameFile(Q, 'util.h', 'lib.h')
    sync()
    expect(a.snapshot(Q)?.files).toEqual({ 'main.cpp': 'int main() {}\n', 'lib.h': '#pragma once\n' })
    a.removeFile(Q, 'lib.h')
    sync()
    expect(Object.keys(b.snapshot(Q)!.files)).toEqual(['main.cpp'])
  })

  test('pasta vazia criada por um aparece no outro', () => {
    const { a, b, sync } = team()
    a.addFolder(Q, 'lib')
    a.addFolder(Q, 'lib/io')
    sync()
    expect(b.folders(Q)).toEqual(['lib', 'lib/io'])
  })

  test('renomear pasta leva os arquivos e subpastas, com o texto', () => {
    const { a, b, sync } = team()
    a.addFolder(Q, 'lib/vazia')
    a.addFile(Q, 'lib/util.h', '#pragma once\n')
    a.addFile(Q, 'lib/io/ler.cpp', 'ler')
    a.addFile(Q, 'libx.cpp', 'fora')
    sync()
    b.renameFolder(Q, 'lib', 'src')
    sync()
    expect(a.snapshot(Q)?.files).toEqual({ 'main.cpp': 'int main() {}\n', 'src/util.h': '#pragma once\n', 'src/io/ler.cpp': 'ler', 'libx.cpp': 'fora' })
    expect(a.folders(Q)).toEqual(['src/vazia'])
  })

  test('apagar pasta apaga o que está dentro, e só isso', () => {
    const { a, b, sync } = team()
    a.addFolder(Q, 'lib/vazia')
    a.addFile(Q, 'lib/util.h', 'x')
    a.addFile(Q, 'lib/io/ler.cpp', 'y')
    a.addFile(Q, 'lib2/z.h', 'z')
    sync()
    b.removeFolder(Q, 'lib')
    sync()
    expect(Object.keys(a.snapshot(Q)!.files).sort()).toEqual(['lib2/z.h', 'main.cpp'])
    expect(a.folders(Q)).toEqual([])
  })

  test('pasta com nome inválido no mapa é ignorada', () => {
    const d = new ExamDoc()
    d.seed(Q, 'cpp', 'main.cpp', 'ok')
    d.addFolder(Q, 'ok')
    ;(d.doc.getMap(`dirs:${Q}`) as Y.Map<unknown>).set('../fora', true)
    ;(d.doc.getMap(`dirs:${Q}`) as Y.Map<unknown>).set('a//b', true)
    expect(d.folders(Q)).toEqual(['ok'])
  })

  test('entrada adulterada no mapa é ignorada, sem derrubar nada', () => {
    const d = new ExamDoc()
    d.seed(Q, 'cpp', 'main.cpp', 'ok')
    ;(d.doc.getMap(`files:${Q}`) as Y.Map<unknown>).set('ruim.cpp', null)
    ;(d.doc.getMap(`files:${Q}`) as Y.Map<unknown>).set('ruim2.cpp', 42)
    expect(d.snapshot(Q)?.files).toEqual({ 'main.cpp': 'ok' })
  })

  test('linguagem desconhecida não vira resposta', () => {
    const d = new ExamDoc()
    d.seed(Q, 'cpp', 'main.cpp', 'ok')
    d.doc.getMap<string>(`meta:${Q}`).set('lang', 'rust')
    expect(d.snapshot(Q)).toBeNull()
  })

  test('estado salvo restaura depois de um F5', () => {
    const { a } = team()
    text(a).insert(0, 'salvo')
    const restored = new ExamDoc()
    restored.apply(a.encodeState())
    expect(text(restored).toString().startsWith('salvo')).toBe(true)
  })

  test('update inválido lança e não corrompe o documento', () => {
    const { a } = team()
    const before = text(a).toString()
    expect(() => a.apply(new Uint8Array([255, 1, 2, 3, 4]))).toThrow()
    expect(text(a).toString()).toBe(before)
  })
})
