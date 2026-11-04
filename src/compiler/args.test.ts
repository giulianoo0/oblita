// Usa o clang de verdade: o primeiro caso carrega o compilador e leva alguns segundos.
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { commands } from '@yowasp/clang'
import { validFiles } from '../../shared/protocol'
import { compilerJob } from './args'
import { execute } from './wasi'
import type { RunResponse } from './run.worker'

async function build(lang: 'c' | 'cpp', files: Record<string, string>) {
  const { tree, args } = compilerJob(lang, files)
  let log = ''
  try {
    const out = (await commands[lang === 'c' ? 'clang' : 'clang++'](args, tree, { stdout: null, stderr: (b) => b && (log += new TextDecoder().decode(b)) })) as Record<string, Uint8Array>
    return { ok: !!out['main.wasm'], log, wasm: out['main.wasm'] as Uint8Array<ArrayBuffer> | undefined }
  } catch {
    return { ok: false, log }
  }
}

async function stdout(wasm: Uint8Array<ArrayBuffer>) {
  const out: RunResponse[] = []
  await execute(wasm, '', (m) => out.push(m))
  return out.map((m) => (m.type === 'out' && m.stream === 'stdout' ? m.text : '')).join('')
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

  test('projeto com subpasta compila, linka e roda', async () => {
    for (const lang of ['c', 'cpp'] as const) {
      const ext = lang === 'c' ? 'c' : 'cpp'
      const r = await build(lang, {
        [`main.${ext}`]: '#include <stdio.h>\n#include "lib/util.h"\nint main(void) { printf("%d\\n", dobro(21)); return 0; }\n',
        'lib/util.h': '#pragma once\nint dobro(int x);\n',
        [`lib/util.${ext}`]: '#include "util.h"\nint dobro(int x) { return 2 * x; }\n',
      })
      expect(r.log).toBe('')
      expect(await stdout(r.wasm!)).toBe('42\n')
    }
  }, 120_000)

  test('include subindo pastas a partir de subpasta não sai da árvore virtual', async () => {
    const r = await build('c', { 'main.c': 'int main(void) { return 0; }\n', 'lib/x.c': '#include "../../../../etc/passwd"\n' })
    expect(r.ok).toBe(false)
    expect(r.log).toMatch(/not found/)
    expect(r.log).not.toMatch(/root:/)
  }, 60_000)

  test('caminhos aceitam subpasta, e nunca sair da árvore', () => {
    expect(validFiles({ 'main.c': '', 'lib/util.h': '', 'lib/io/ler.c': '' })).toBe(true)
    for (const name of ['../x.c', '/etc/x.c', 'a//b.c', 'a/./b.c', 'a/../b.c', './a.c', 'a/b.c/', 'a\\b.c', '..', '.c', 'C:x.c', 'C:/x.c', 'x.c\0', 'x.txt', 'lib/x.txt', 'con/x.c', 'lib/aux.h', 'lib./x.c', '.git/x.c', 'a/b/c/d/x.c', `${'a'.repeat(48)}/${'b'.repeat(48)}/${'c'.repeat(30)}.c`])
      expect(validFiles({ [name]: '' })).toBe(false)
  })

  test('arquivo e pasta com o mesmo nome não convivem', () => {
    expect(validFiles({ 'a.c': '', 'a.c/x.h': '' })).toBe(false)
    expect(validFiles({ 'Lib/x.h': '', 'lib/y.h': '' })).toBe(true)
  })
})
