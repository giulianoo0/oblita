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

// O clang só enxerga esta árvore virtual: os arquivos da resposta e os headers do próprio
// toolchain. Nenhum caminho vem do aluno além dos nomes, que já passaram por validFiles.
export function compilerJob(lang: 'c' | 'cpp', files: Record<string, string>) {
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
  return { tree, args }
}
