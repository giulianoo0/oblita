// Sobe e derruba o hub real, lê token, e mede RSS/CPU do processo pelo /proc (Linux).
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(here, '..', '..')
export const EXE = join(ROOT, 'host', 'target', 'release', 'oblita-host')
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function until(what, check, ms = 15000, step = 50) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await sleep(step)
  }
  throw new Error(`tempo esgotado: ${what}`)
}

export class Hub {
  constructor(opts = {}) {
    this.port = opts.port ?? 7787
    this.folder = opts.folder ?? '/tmp/oblita-prova'
    this.log = ''
  }

  async start() {
    this.proc = spawn(EXE, ['--pasta', this.folder, '--porta', String(this.port)], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.proc.stdout.on('data', (d) => (this.log += d))
    this.proc.stderr.on('data', (d) => (this.log += d))
    await until('hub abrir a porta', () => this.log.includes('tudo certo'))
    return this
  }

  get pid() {
    return this.proc.pid
  }

  base() {
    return `ws://127.0.0.1:${this.port}`
  }

  http() {
    return `http://127.0.0.1:${this.port}`
  }

  async token() {
    const res = await fetch(`${this.http()}/host-token`, { headers: { origin: 'https://oblita.giuli.dev' } })
    return (await res.json()).token
  }

  async ping() {
    return (await (await fetch(`${this.http()}/ping`)).json())
  }

  // RSS em bytes, pelo /proc/<pid>/statm (páginas de 4 KiB).
  rss() {
    try {
      const statm = readFileSync(`/proc/${this.pid}/statm`, 'utf8').split(' ')
      return Number(statm[1]) * 4096
    } catch {
      return 0
    }
  }

  // Tempo de CPU acumulado (utime+stime) em segundos.
  cpuSeconds() {
    try {
      const stat = readFileSync(`/proc/${this.pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const utime = Number(fields[11])
      const stime = Number(fields[12])
      const hz = 100
      return (utime + stime) / hz
    } catch {
      return 0
    }
  }

  alive() {
    return this.proc.exitCode === null
  }

  kill(sig = 'SIGKILL') {
    try {
      this.proc.kill(sig)
    } catch {}
  }
}

export function mib(n) {
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`
}

// Conexão WebSocket crua sobre TCP: escolhe o IP de origem, pode pausar a leitura e mandar
// cabeçalhos devagar (slowloris). Máscara zero mantém o quadro igual aos bytes.
export function rawConnect(port, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: opts.host ?? '127.0.0.1', port, localAddress: opts.localAddress })
    let upgraded = false
    let head = ''
    let received = 0
    const done = new Promise((r) => socket.once('close', () => r()))
    socket.on('error', (e) => {
      if (!upgraded) reject(e)
    })
    socket.once('connect', () => {
      if (opts.noUpgrade) return resolve({ socket, closed: done, raw: true })
      const headers = opts.headers ?? {}
      let req = `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n`
      for (const [k, v] of Object.entries(headers)) req += `${k}: ${v}\r\n`
      socket.write(req + '\r\n')
    })
    socket.on('data', (chunk) => {
      received += chunk.length
      if (upgraded) return
      head += chunk.toString('latin1')
      if (!head.includes('\r\n\r\n')) return
      const status = Number(head.split(' ')[1])
      if (status !== 101) {
        socket.destroy()
        return resolve({ socket, closed: done, status, failed: true })
      }
      upgraded = true
      if (opts.paused) socket.pause()
      resolve({
        socket,
        closed: done,
        status: 101,
        received: () => received,
        send: (d) => socket.write(wsFrame(d)),
        destroy: () => socket.destroy(),
      })
    })
  })
}

function wsFrame(data) {
  const n = data.length
  const head = n < 126 ? [0x82, 0x80 | n] : n < 65536 ? [0x82, 0x80 | 126, n >> 8, n & 255] : [0x82, 0x80 | 127, 0, 0, 0, 0, (n / 2 ** 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]
  const out = new Uint8Array(head.length + 4 + n)
  out.set(head)
  out.set(data, head.length + 4)
  return out
}
