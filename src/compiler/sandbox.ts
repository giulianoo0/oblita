// Programa de aluno rodando no professor, em origem opaca: um iframe com sandbox="allow-scripts"
// e sem allow-same-origin cria o worker. Se uma falha no shim da WASI desse JavaScript ao programa,
// lá dentro não há IndexedDB, caches nem OPFS do painel, onde estão o gabarito e as gravações.
//
// O iframe nasce de srcdoc e recebe o código do worker por postMessage: nada é baixado, então
// funciona sem rede, e não depende do service worker (que não controla origem opaca).
import RUN_WORKER_SOURCE from 'virtual:run-worker'
import type { RunPort } from './client'
import type { RunResponse } from './run.worker'

export const SANDBOX_FLAGS = 'allow-scripts'
// Sem connect-src nem img-src: o worker herda esta política e não fala com ninguém.
const CSP = "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; worker-src blob:"
const READY_TIMEOUT = 10_000

// O pai só fala com o iframe, e o iframe só aceita o pai. O código é fixo e não vem do aluno.
const BOOT = `
let url = null
const workers = new Map()
const send = (m) => parent.postMessage(m, '*')
onmessage = (e) => {
  if (e.source !== parent) return
  const m = e.data
  if (m.op === 'init' && !url) {
    url = URL.createObjectURL(new Blob([m.source], { type: 'text/javascript' }))
    send({ op: 'ready' })
  } else if (m.op === 'spawn' && url && !workers.has(m.id)) {
    let w
    try {
      w = new Worker(url)
    } catch (err) {
      return send({ op: 'error', id: m.id, message: String(err) })
    }
    workers.set(m.id, w)
    w.onmessage = (ev) => send({ op: 'msg', id: m.id, data: ev.data })
    w.onerror = (ev) => {
      ev.preventDefault()
      send({ op: 'error', id: m.id, message: String(ev.message || '') })
    }
    w.onmessageerror = () => send({ op: 'error', id: m.id, message: '' })
  } else if (m.op === 'post') {
    workers.get(m.id)?.postMessage(m.data)
  } else if (m.op === 'kill') {
    workers.get(m.id)?.terminate()
    workers.delete(m.id)
  }
}
`

export function sandboxDocument(extra = '') {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><script>${BOOT}${extra}</script>`
}

type Listener = { onmessage: ((m: RunResponse) => void) | null; onerror: ((message: string) => void) | null }

export class Sandbox {
  private frame: HTMLIFrameElement | null = null
  private ready: Promise<Window> | null = null
  private ports = new Map<number, Listener>()
  private nextId = 1

  constructor(
    private source: string,
    private extra = '',
  ) {
    window.addEventListener('message', this.onMessage)
  }

  private open(): Promise<Window> {
    if (this.ready) return this.ready
    const frame = document.createElement('iframe')
    frame.sandbox.value = SANDBOX_FLAGS
    frame.hidden = true
    frame.title = 'Execução isolada'
    frame.srcdoc = sandboxDocument(this.extra)
    this.frame = frame
    this.ready = new Promise<Window>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('O ambiente de execução não abriu')), READY_TIMEOUT)
      frame.addEventListener(
        'load',
        () => {
          const win = frame.contentWindow
          if (!win) return reject(new Error('O ambiente de execução não abriu'))
          this.onReady = () => {
            clearTimeout(timer)
            resolve(win)
          }
          win.postMessage({ op: 'init', source: this.source }, '*')
        },
        { once: true },
      )
    })
    // Não abriu: a próxima execução tenta um iframe novo.
    this.ready.catch(() => this.reset())
    document.body.append(frame)
    return this.ready
  }

  private onReady: (() => void) | null = null

  private onMessage = (e: MessageEvent) => {
    if (!this.frame || e.source !== this.frame.contentWindow) return
    const m = e.data
    if (!m || typeof m !== 'object') return
    if (m.op === 'ready') return this.onReady?.()
    const port = this.ports.get(m.id)
    if (!port) return
    if (m.op === 'msg') port.onmessage?.(m.data)
    else if (m.op === 'error') port.onerror?.(typeof m.message === 'string' ? m.message : '')
  }

  private reset() {
    this.frame?.remove()
    this.frame = null
    this.ready = null
    this.onReady = null
    for (const port of this.ports.values()) port.onerror?.('O ambiente de execução falhou')
    this.ports.clear()
  }

  port(): RunPort {
    const id = this.nextId++
    const port: RunPort = {
      onmessage: null,
      onerror: null,
      post: (data) => void win.then((w) => w.postMessage({ op: 'post', id, data }, '*'), () => {}),
      terminate: () => {
        this.ports.delete(id)
        void win.then((w) => w.postMessage({ op: 'kill', id }, '*'), () => {})
      },
    }
    this.ports.set(id, port)
    const win = this.open()
    win.then(
      (w) => w.postMessage({ op: 'spawn', id }, '*'),
      (err) => port.onerror?.(String(err?.message ?? err)),
    )
    return port
  }

  dispose() {
    window.removeEventListener('message', this.onMessage)
    this.reset()
  }
}

let shared: Sandbox | null = null

export const sandboxPort = (): RunPort => (shared ??= new Sandbox(RUN_WORKER_SOURCE)).port()
