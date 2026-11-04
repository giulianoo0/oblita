import { commands, Exit } from '@yowasp/clang'
import { RUN_LIMITS } from '../../shared/protocol'

// Este build do compilador não tem exceções de C++. Com estes símbolos, código com try/catch
// compila normalmente, e só um throw executado de verdade encerra o programa, com mensagem clara.
// São fracos para o aluno poder definir os seus sem dar símbolo duplicado.
const RUNTIME = `#include <stdio.h>
#include <stdlib.h>
extern "C" {
__attribute__((weak)) void* __cxa_allocate_exception(unsigned long n) { return malloc(n ? n : 1); }
__attribute__((weak)) void __cxa_throw(void*, void*, void (*)(void*)) { fputs("erro: exceções de C++ não são suportadas aqui, o throw encerra o programa\\n", stderr); abort(); }
}
`

export type CompileRequest = { id: number; lang: 'c' | 'cpp'; files: Record<string, string> }
export type CompileResponse =
  | { id: number; ok: true; wasm: Uint8Array<ArrayBuffer>; log: string; ms: number }
  | { id: number; ok: false; log: string; ms: number; internal?: boolean }
  | { id: number; progress: number }

const post = (msg: CompileResponse, transfer: Transferable[] = []) => self.postMessage(msg, { transfer })

// Sem main reconhecível (nenhuma, ou void main) o linker não reclama: a libc tem um __main_void
// que chama um __main_argc_argv fraco, e o programa morreria só ao rodar. Só esse importa os argumentos.
function lacksMain(wasm: Uint8Array<ArrayBuffer>) {
  const mod = new WebAssembly.Module(wasm)
  return !WebAssembly.Module.exports(mod).some((e) => e.name === '__main_argc_argv') && WebAssembly.Module.imports(mod).some((i) => i.name === 'args_sizes_get')
}

self.onmessage = async ({ data }: MessageEvent<CompileRequest>) => {
  const { id, lang, files } = data
  const start = performance.now()
  const tree: Record<string, string> = { ...files }
  const inputs = Object.keys(files).filter((n) => (lang === 'c' ? n.endsWith('.c') : /\.(c|cc|cpp)$/.test(n)))
  if (lang === 'cpp') {
    let runtime = 'oblita_rt.cpp'
    while (runtime in tree) runtime = `_${runtime}`
    tree[runtime] = RUNTIME
    inputs.push(runtime)
  }
  const memory = RUN_LIMITS.memoryMb * 1024 * 1024
  const args = [
    // Dialeto GNU, o padrão do gcc: no modo estrito somem M_PI, strdup, usleep.
    lang === 'c' ? '-std=gnu17' : '-std=gnu++20',
    '-O1',
    // O sistema de arquivos virtual recopia o arquivo a cada escrita, e o objeto wasm grava os
    // zeros de cada global: int v[4000000] levava 18 s. Com LTO o objeto é bitcode, sem os zeros.
    '-flto',
    '-Wl,--lto-O1',
    '-Wall',
    '-fno-color-diagnostics',
    // A WASI não tem estes, a libc só os oferece com emulação explícita.
    '-D_WASI_EMULATED_PROCESS_CLOCKS',
    '-D_WASI_EMULATED_SIGNAL',
    '-D_WASI_EMULATED_GETPID',
    // Igual ao g++ com vários arquivos: .c em projeto C++ vira C++, sem o aviso de depreciação.
    ...(lang === 'cpp' ? ['-x', 'c++'] : []),
    ...inputs,
    '-o',
    'main.wasm',
    '-lm',
    // Sem esta, printf("%Lf") e cout de long double abortam em tempo de execução.
    '-lc-printscan-long-double',
    '-lwasi-emulated-process-clocks',
    '-lwasi-emulated-signal',
    '-lwasi-emulated-getpid',
    '-Wl,-z,stack-size=8388608',
    // Limite duro: o programa não consegue pedir mais memória que isto.
    `-Wl,--max-memory=${memory - (memory % 65536)}`,
    // O run.worker usa estes para salvar a saída e reconhecer estouro de pilha depois de um crash.
    '-Wl,--export=fflush',
    '-Wl,--export=__stack_pointer',
    '-Wl,--export-if-defined=__main_argc_argv',
  ]
  let log = ''
  const decoder = new TextDecoder()
  const ms = () => performance.now() - start
  try {
    const out = (await commands[lang === 'c' ? 'clang' : 'clang++'](args, tree, {
      stdout: null,
      stderr: (bytes) => {
        if (bytes) log += decoder.decode(bytes, { stream: true })
      },
      fetchProgress: ({ doneLength, totalLength }) => post({ id, progress: doneLength / totalLength }),
    })) as Record<string, Uint8Array<ArrayBuffer>>
    log += decoder.decode()
    const wasm = out['main.wasm']
    if (lacksMain(wasm)) post({ id, ok: false, log: `${log}erro: o programa precisa de uma função main no formato int main() ou int main(int argc, char **argv)\n`, ms: ms(), internal: false })
    else post({ id, ok: true, wasm, log, ms: ms() }, [wasm.buffer])
  } catch (err) {
    log += decoder.decode()
    const text = String(err)
    if (err instanceof Exit) post({ id, ok: false, log, ms: ms(), internal: false })
    // A pilha de um worker é curta para o clang. O código é a causa, e o host falharia igual.
    else if (text.includes('call stack')) post({ id, ok: false, log: `${log}erro: código aninhado demais para o compilador do navegador (recursão de templates, expressão ou blocos muito profundos)\n`, ms: ms(), internal: false })
    else post({ id, ok: false, log: `${log}erro interno do compilador: ${text}\n`, ms: ms(), internal: true })
  }
}
