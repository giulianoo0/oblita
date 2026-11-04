import { describe, expect, test } from 'bun:test'
import { commands } from '@yowasp/clang'
import { compilerJob } from './args'
import { parseDiagnostics } from './diagnostics'

async function errorFiles(files: Record<string, string>) {
  const { tree, args } = compilerJob('c', files)
  let log = ''
  try {
    await commands.clang(args, tree, { stdout: null, stderr: (b) => b && (log += new TextDecoder().decode(b)) })
  } catch {}
  return parseDiagnostics(log).filter((d) => d.severity === 'error').map((d) => d.file)
}

const line = (file: string) => `${file}:3:5: error: x`

describe('mensagens do compilador', () => {
  test('o caminho volta no formato da lista de arquivos', () => {
    const log = [line('./util.h'), line('./lib/./util.h'), line('lib/util.h'), line('main.c')].join('\n')
    expect(parseDiagnostics(log).map((d) => d.file)).toEqual(['util.h', 'lib/util.h', 'lib/util.h', 'main.c'])
  })

  // O clang para no primeiro arquivo com erro: um caso por arquivo que inclui.
  test('erro em header de subpasta aponta para o arquivo certo, incluído de qualquer lugar', async () => {
    const header = { 'lib/util.h': 'int x = ;\n' }
    expect(await errorFiles({ 'main.c': '#include "lib/util.h"\nint main(void) { return 0; }\n', ...header })).toEqual(['lib/util.h'])
    expect(await errorFiles({ 'main.c': 'int main(void) { return 0; }\n', 'lib/ler.c': '#include "util.h"\n', ...header })).toEqual(['lib/util.h'])
  }, 60_000)
})
