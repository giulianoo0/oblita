import { Exit, runClang } from '@yowasp/clang'

// Só para medir flags: o worker real não aceita flags de fora, e deve continuar assim.
self.onmessage = async ({ data }: MessageEvent<{ id: number; args: string[]; files: Record<string, string> }>) => {
  const start = performance.now()
  let log = ''
  const dec = new TextDecoder()
  try {
    const out = (await runClang(data.args, data.files, {
      stdout: null,
      stderr: (b) => {
        if (b) log += dec.decode(b, { stream: true })
      },
      fetchProgress: () => {},
    })) as Record<string, Uint8Array<ArrayBuffer>>
    self.postMessage({ id: data.id, ok: true, wasm: out['main.wasm'], log, ms: performance.now() - start })
  } catch (err) {
    self.postMessage({ id: data.id, ok: false, wasm: null, log: err instanceof Exit ? log : log + String(err), ms: performance.now() - start })
  }
}
