import { execute } from './wasi'

export type RunRequest = { wasm: Uint8Array<ArrayBuffer>; stdin: string }
export type RunResponse =
  | { type: 'start' }
  | { type: 'out'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'exit'; exitCode: number; error?: string }

self.onmessage = ({ data }: MessageEvent<RunRequest>) => void execute(data.wasm, data.stdin, (msg) => self.postMessage(msg))
