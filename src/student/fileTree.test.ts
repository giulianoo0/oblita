import { describe, expect, test } from 'bun:test'
import { fileKind, filesInside, visibleRows } from './fileTree'

const rows = (files: string[], folders: string[] = [], collapsed: string[] = []) =>
  visibleRows(files, folders, new Set(collapsed)).map((r) => `${'  '.repeat(r.depth)}${r.kind === 'folder' ? `${r.name}/` : r.name}`)

describe('árvore de arquivos', () => {
  test('pastas primeiro, depois arquivos, em ordem alfabética', () => {
    expect(rows(['main.c', 'b.h', 'A.c', 'lib/util.h', 'lib/io/ler.c', 'lib/a.c', 'zeta/x.h', 'item10.c', 'item2.c'])).toEqual([
      'lib/',
      '  io/',
      '    ler.c',
      '  a.c',
      '  util.h',
      'zeta/',
      '  x.h',
      'A.c',
      'b.h',
      'item2.c',
      'item10.c',
      'main.c',
    ])
  })

  test('pasta vazia aparece, inclusive as de cima dela', () => {
    expect(rows(['main.c'], ['a/b'])).toEqual(['a/', '  b/', 'main.c'])
  })

  test('pasta recolhida esconde o que está dentro', () => {
    expect(rows(['main.c', 'lib/util.h', 'lib/io/ler.c'], [], ['lib/io'])).toEqual(['lib/', '  io/', '  util.h', 'main.c'])
    expect(rows(['main.c', 'lib/util.h', 'lib/io/ler.c'], [], ['lib'])).toEqual(['lib/', 'main.c'])
  })

  test('cada linha sabe o caminho inteiro', () => {
    const r = visibleRows(['lib/io/ler.c'], [], new Set())
    expect(r.map((x) => x.path)).toEqual(['lib', 'lib/io', 'lib/io/ler.c'])
  })

  test('arquivos dentro de uma pasta, sem pegar a vizinha de nome parecido', () => {
    expect(filesInside(['lib/a.c', 'lib/io/b.c', 'lib2/c.c', 'main.c'], 'lib')).toEqual(['lib/a.c', 'lib/io/b.c'])
  })

  test('tipo do arquivo pela extensão', () => {
    expect(['a.c', 'a.cpp', 'a.cc', 'a.h', 'lib/a.hpp', 'a.txt'].map(fileKind)).toEqual(['c', 'cpp', 'cpp', 'h', 'h', 'other'])
  })
})
