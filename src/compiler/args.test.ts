// Usa o clang de verdade: o primeiro caso carrega o compilador e leva alguns segundos.
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { commands } from '@yowasp/clang'
import { validFiles } from '../../shared/protocol'
import { compilerJob } from './args'

async function build(lang: 'c' | 'cpp', files: Record<string, string>) {
  const { tree, args } = compilerJob(lang, files)
  let log = ''
  try {
    const out = (await commands[lang === 'c' ? 'clang' : 'clang++'](args, tree, { stdout: null, stderr: (b) => b && (log += new TextDecoder().decode(b)) })) as Record<string, Uint8Array>
    return { ok: !!out['main.wasm'], log }
  } catch {
    return { ok: false, log }
  }
}

const SECRET = existsSync('/etc/passwd') ? '/etc/passwd' : 'C:/Windows/win.ini'

describe('o compilador só enxerga os arquivos da resposta', () => {
  test('controle: compila um programa normal', async () => {
    expect((await build('c', { 'main.c': '#include <stdio.h>\nint main(void) { puts("oi"); return 0; }\n' })).ok).toBe(true)
  }, 60_000)

  test('include de caminho absoluto da máquina não lê nada', async () => {
    expect(existsSync(SECRET)).toBe(true)
    const r = await build('c', { 'main.c': `#include "${SECRET}"\nint main(void) { return 0; }\n` })
    expect(r.ok).toBe(false)
    expect(r.log).toMatch(/not found/)
    expect(r.log).not.toMatch(/root:|\[fonts\]/)
  }, 60_000)

  test('include subindo pastas não sai da árvore virtual', async () => {
    const r = await build('cpp', { 'main.cpp': '#include "../../../../../../etc/passwd"\nint main() {}\n' })
    expect(r.ok).toBe(false)
    expect(r.log).toMatch(/not found/)
  }, 60_000)

  test('#embed de arquivo da máquina não lê nada', async () => {
    const r = await build('c', { 'main.c': `const char x[] = {\n#embed "${SECRET}"\n};\nint main(void) { return x[0]; }\n` })
    expect(r.ok).toBe(false)
    expect(r.log).not.toMatch(/root:/)
  }, 60_000)

  test('include de outro arquivo da própria resposta funciona', async () => {
    const r = await build('c', { 'main.c': '#include "util.h"\nint main(void) { return dois() - 2; }\n', 'util.h': 'static int dois(void) { return 2; }\n' })
    expect(r.ok).toBe(true)
  }, 60_000)

  test('nomes de arquivo não aceitam pasta nem subir pasta', () => {
    for (const name of ['../x.c', '/etc/x.c', 'a/b.c', 'a\\b.c', '..', '.c', 'C:x.c', 'x.c\0', 'x.txt']) expect(validFiles({ [name]: '' })).toBe(false)
    expect(validFiles({ 'main.c': '', 'util.h': '' })).toBe(true)
  })
})
