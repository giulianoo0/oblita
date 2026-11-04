import { commands, Exit, runLLVM } from '@yowasp/clang'
import { compilerJob } from './args'

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
  const { tree, args } = compilerJob(lang, files)
  let log = ''
  const decoder = new TextDecoder()
  const ms = () => performance.now() - start
  try {
    // O clang ignora fetchProgress ao carregar por conta própria: sem esta busca explícita o
    // progresso nunca chega à interface nem ao watchdog. Depois da primeira vez não faz nada.
    await runLLVM(undefined, {}, { fetchProgress: ({ doneLength, totalLength }) => post({ id, progress: doneLength / totalLength }) })
    const out = (await commands[lang === 'c' ? 'clang' : 'clang++'](args, tree, {
      stdout: null,
      stderr: (bytes) => {
        if (bytes) log += decoder.decode(bytes, { stream: true })
      },
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
