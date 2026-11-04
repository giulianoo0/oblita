import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { execute } from './wasi'
import type { RunResponse } from './run.worker'

async function exec(file: string, stdin = '') {
  const wasm = new Uint8Array(readFileSync(new URL(file, import.meta.url)))
  const out: RunResponse[] = []
  await execute(wasm, stdin, (m) => out.push(m))
  const text = (s: 'stdout' | 'stderr') => out.map((m) => (m.type === 'out' && m.stream === s ? m.text : '')).join('')
  return { stdout: text('stdout'), stderr: text('stderr'), exit: out.find((m) => m.type === 'exit') }
}

describe('execução do programa do aluno', () => {
  test('roda e lê a entrada', async () => {
    const r = await exec('../../shared/fixtures/soma.wasm', '2 3\n')
    expect(r.stdout).toBe('5\n')
    expect(r.exit).toEqual({ type: 'exit', exitCode: 0 })
  })

  // Fonte em fixtures/disco.c: tenta ler, listar, criar e apagar arquivos da máquina.
  test('sem disco: nenhum arquivo abre, e o programa roda até o fim', async () => {
    const r = await exec('./fixtures/disco.wasm')
    expect(r.stdout).toBe(
      ['passwd:falhou', 'winini:falhou', 'raiz:falhou', 'ponto:falhou', 'escrita:falhou', 'open:falhou', 'fd3:falhou', 'unlink:falhou', 'argc:1 env:vazio', 'fim', ''].join('\n'),
    )
    expect(r.exit).toEqual({ type: 'exit', exitCode: 0 })
  })

  test('executável inválido vira erro, sem exceção', async () => {
    const r = await exec('./fixtures/disco.c')
    expect(r.exit?.type).toBe('exit')
    expect((r.exit as { error?: string }).error).toBe('O executável é inválido')
  })
})
