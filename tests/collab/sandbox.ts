// Confere por dentro o sandbox onde o professor roda o programa do aluno: o mesmo iframe, a mesma
// política, e um worker criado do mesmo jeito, só que com código de sondagem no lugar do run.worker.
import { run } from '../../src/compiler/client'
import { Sandbox, sandboxPort } from '../../src/compiler/sandbox'

// Roda igual no documento do iframe e no worker: tenta cada coisa que daria acesso a dados do painel ou ao disco.
const PROBES = `
async function probes(origin) {
  const r = {}
  const tryIt = async (name, fn) => {
    try {
      r[name] = 'ABRIU:' + (await fn())
    } catch (e) {
      r[name] = 'falhou:' + (e && e.name ? e.name : String(e))
    }
  }
  await tryIt('indexedDB', () => new Promise((res, rej) => {
    const q = indexedDB.open('oblita')
    q.onsuccess = () => res([...q.result.objectStoreNames].join(','))
    q.onerror = () => rej(q.error)
  }))
  await tryIt('caches', () => caches.keys().then((k) => k.join(',')))
  await tryIt('opfs', () => navigator.storage.getDirectory().then(() => 'dir'))
  await tryIt('fetch', () => fetch(origin + '/package.json').then((x) => x.status))
  if (typeof importScripts === 'function') await tryIt('importScripts', () => { importScripts(origin + '/public/sw.js'); return 'ok' })
  if (typeof document !== 'undefined') {
    await tryIt('showDirectoryPicker', () => showDirectoryPicker().then(() => 'dir'))
    await tryIt('showOpenFilePicker', () => showOpenFilePicker().then(() => 'arq'))
    await tryIt('localStorage', () => String(localStorage.length))
    await tryIt('cookie', () => document.cookie)
    await tryIt('origem', () => { if (origin === location.origin || String(self.origin) !== 'null') return self.origin; throw new Error('opaca') })
  } else {
    await tryIt('origem', () => { if (String(self.origin) !== 'null') return self.origin; throw new Error('opaca') })
  }
  return r
}
`

const DOC_PROBE = `${PROBES}
addEventListener('message', async (e) => {
  if (e.source !== parent || e.data?.op !== 'probe-doc') return
  parent.postMessage({ op: 'probe-doc-result', result: await probes(e.data.origin) }, '*')
})`

const WORKER_PROBE = `${PROBES}
onmessage = async (e) => postMessage({ type: 'probe', result: await probes(e.data.origin) })`

async function docProbe(sandbox: Sandbox) {
  // Abre o iframe criando uma porta; a sondagem do documento conversa por fora dela.
  const port = sandbox.port()
  await new Promise((r) => setTimeout(r, 300))
  const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Execução isolada"]:last-of-type')!
  const result = new Promise<Record<string, string>>((resolve) => {
    const on = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || e.data?.op !== 'probe-doc-result') return
      removeEventListener('message', on)
      resolve(e.data.result)
    }
    addEventListener('message', on)
  })
  frame.contentWindow!.postMessage({ op: 'probe-doc', origin: location.origin }, '*')
  const out = await result
  port.terminate()
  return { out, sandbox: frame.getAttribute('sandbox') }
}

function workerProbe(sandbox: Sandbox) {
  return new Promise<Record<string, string>>((resolve) => {
    const port = sandbox.port()
    port.onmessage = (m) => {
      port.terminate()
      resolve((m as unknown as { result: Record<string, string> }).result)
    }
    port.onerror = (message) => resolve({ erro: message })
    port.post({ origin: location.origin } as never)
  })
}

// _start com um laço infinito: o relógio tem de matar o worker lá dentro do sandbox.
const LOOP = new Uint8Array([
  0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
  1, 4, 1, 0x60, 0, 0,
  3, 2, 1, 0,
  5, 4, 1, 1, 1, 1,
  7, 0x13, 2, 6, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0, 0, 6, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 2, 0,
  10, 9, 1, 7, 0, 3, 0x40, 0x0c, 0, 0x0b, 0x0b,
])

const bytes = async (path: string) => new Uint8Array(await (await fetch(path)).arrayBuffer())

export async function sandboxChecks() {
  const sandbox = new Sandbox(WORKER_PROBE, DOC_PROBE)
  const doc = await docProbe(sandbox)
  const worker = await workerProbe(sandbox)
  sandbox.dispose()
  // Controle: aqui fora, na origem do painel, o IndexedDB abre.
  const control = await new Promise<string>((res) => {
    const q = indexedDB.open('oblita-sandbox-controle')
    q.onsuccess = () => res('abriu')
    q.onerror = () => res('falhou')
  })
  const soma = await run(await bytes('/shared/fixtures/soma.wasm'), '20 22\n', 5000, undefined, sandboxPort)
  const disco = await run(await bytes('/src/compiler/fixtures/disco.wasm'), '', 5000, undefined, sandboxPort)
  const loop = await run(LOOP, '', 1000, undefined, sandboxPort)
  return { doc, worker, control, soma, disco, loop, frames: document.querySelectorAll('iframe[title="Execução isolada"]').length }
}
