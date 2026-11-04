// Sobe o site e o hub, e deixa derrubar o hub no meio da prova, como quem fecha o programa.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { killTree, sleep } from './cdp.mjs'

const portFree = (port) =>
  new Promise((res) => {
    const srv = createServer()
    srv.once('error', () => res(false))
    srv.listen(port, '0.0.0.0', () => srv.close(() => res(true)))
  })

// Só faixa privada: o endereço de VPN (100.x) não conta como rede local para o navegador.
export function lanIp() {
  const all = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address)
  return all.find((a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)) ?? null
}

export class Servers {
  constructor(root) {
    this.root = root
    this.bun = join(root, 'node_modules', 'bun', 'bin', 'bun.exe')
    this.site = null
    this.hub = null
    this.log = ''
  }

  spawn(args, env = {}) {
    const p = spawn(this.bun, args, { cwd: this.root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    p.stdout.on('data', (d) => (this.log += d))
    p.stderr.on('data', (d) => (this.log += d))
    return p
  }

  async waitUp(url, ms = 15000) {
    const start = Date.now()
    while (Date.now() - start < ms) {
      try {
        if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return
      } catch {}
      await sleep(100)
    }
    throw new Error(`não subiu: ${url}\n${this.log.slice(-800)}`)
  }

  async start() {
    // O hub só entrega o token às origens conhecidas, e fora da 3000 só resta a 5173.
    this.sitePort = (await portFree(3000)) ? 3000 : (await portFree(5173)) ? 5173 : null
    if (!this.sitePort) throw new Error('portas 3000 e 5173 ocupadas: o hub recusaria o painel em qualquer outra')
    this.origin = `http://localhost:${this.sitePort}`
    this.hubPort = 7787
    this.combined = this.sitePort === 3000 && (await portFree(7787))
    if (this.combined) {
      await this.startCombined()
      return this
    }
    if (!(await portFree(7787))) {
      this.hubPort = 17787
      for (let p = 17787; p < 17800; p++) {
        if (await portFree(p)) {
          this.hubPort = p
          break
        }
      }
    }
    this.site = this.spawn(['server/index.ts'], { PORT: String(this.sitePort) })
    await this.waitUp(`${this.origin}/healthz`)
    await this.startHub()
    return this
  }

  async startCombined() {
    this.site = this.spawn(['server/index.ts', '--hub'])
    await this.waitUp(`${this.origin}/healthz`)
    await this.waitUp(`http://127.0.0.1:${this.hubPort}/ping`)
  }

  get altHub() {
    return this.hubPort !== 7787
  }

  async startHub() {
    if (this.combined) return this.startCombined()
    this.hub = this.spawn(['e2e/helpers/hub.ts', String(this.hubPort)])
    await this.waitUp(`http://127.0.0.1:${this.hubPort}/ping`)
  }

  // Na forma combinada o site cai junto, o que é ainda mais duro: as páginas vêm do service worker.
  async killHub() {
    if (this.combined) {
      killTree(this.site)
      this.site = null
    } else {
      killTree(this.hub)
      this.hub = null
    }
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`http://127.0.0.1:${this.hubPort}/ping`, { signal: AbortSignal.timeout(300) })
        await sleep(100)
      } catch {
        return
      }
    }
    throw new Error('o hub não caiu')
  }

  stop() {
    killTree(this.site)
    killTree(this.hub)
    this.site = this.hub = null
  }
}
