// O mesmo contrato de e2e/hub.test.ts, agora contra o .exe de verdade, mais o que só existe nele:
// limites de memória, de conexões por IP e de silêncio.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { HubOp, decodeHub, encodeHub } from '../shared/frames'
import { HUB_ORIGINS, HUB_PORT } from '../shared/protocol'

const EXE = join(import.meta.dir, '../host/target/release/oblita-host.exe')
const present = existsSync(EXE)
if (!present) console.warn(`hub-rust: testes pulados, ${EXE} não existe. Rode "cargo build --release" em host/.`)

// Outro hub na porta receberia estes testes, e um painel daqui tomaria o lugar do painel dele.
const portTaken = () =>
  new Promise<boolean>((resolve) => {
    const probe = net.connect({ host: '127.0.0.1', port: HUB_PORT })
    probe.once('connect', () => (probe.destroy(), resolve(true)))
    probe.once('error', () => resolve(false))
  })
const busy = present && (await portTaken())

const http = `http://127.0.0.1:${HUB_PORT}`
const ws = `ws://127.0.0.1:${HUB_PORT}`
const ORIGIN = 'https://oblita.giuli.dev'
const MiB = 1024 * 1024
const decoder = new TextDecoder()

let proc: ReturnType<typeof Bun.spawn>
let token = ''
let log = ''

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await sleep(25)
  }
  throw new Error(`tempo esgotado: ${what}`)
}

const ping = async () => (await (await fetch(`${http}/ping`)).json()) as { students: number; host: boolean }

type Client = { sock: WebSocket; frames: Uint8Array[]; next: () => Promise<Uint8Array> }

function open(url: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url)
    sock.binaryType = 'arraybuffer'
    const frames: Uint8Array[] = []
    const waiters: ((f: Uint8Array) => void)[] = []
    sock.onmessage = (e) => {
      const f = new Uint8Array(e.data as ArrayBuffer)
      const w = waiters.shift()
      if (w) w(f)
      else frames.push(f)
    }
    sock.onerror = () => reject(new Error('falhou ao abrir'))
    sock.onopen = () =>
      resolve({
        sock,
        frames,
        next: () => {
          const f = frames.shift()
          return f ? Promise.resolve(f) : new Promise((r) => waiters.push(r))
        },
      })
  })
}

const closed = (s: WebSocket) =>
  new Promise<void>((r) => {
    if (s.readyState === WebSocket.CLOSED) return r()
    s.addEventListener('close', () => r())
  })

const openPanel = () => open(`${ws}/ws/host?token=${token}`)
const openStudent = () => open(`${ws}/ws/student`)

// O WebSocket do Bun não escolhe o IP de origem nem para de ler: para isso, um cliente sobre TCP cru.
type Raw = { socket: net.Socket; closed: Promise<void>; isClosed: () => boolean; send: (data: Uint8Array) => void; received: () => number }

function rawFrame(data: Uint8Array): Uint8Array {
  const n = data.length
  const head = n < 126 ? [0x82, 0x80 | n] : n < 65536 ? [0x82, 0x80 | 126, n >> 8, n & 255] : [0x82, 0x80 | 127, 0, 0, 0, 0, (n / 2 ** 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]
  // Máscara zero: é válida e o quadro continua igual aos bytes.
  const out = new Uint8Array(head.length + 4 + n)
  out.set(head)
  out.set(data, head.length + 4)
  return out
}

function rawConnect(path: string, opts: { localAddress?: string; paused?: boolean } = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: HUB_PORT, localAddress: opts.localAddress })
    let received = 0
    let upgraded = false
    let isClosed = false
    let head = ''
    const done = new Promise<void>((r) =>
      socket.once('close', () => {
        isClosed = true
        r()
      }),
    )
    socket.on('error', (e) => {
      if (!upgraded) reject(e)
    })
    socket.once('connect', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`))
    socket.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (upgraded) return
      head += chunk.toString('latin1')
      if (!head.includes('\r\n\r\n')) return
      if (!head.startsWith('HTTP/1.1 101')) return reject(new Error(head.split('\r\n')[0]))
      upgraded = true
      if (opts.paused) socket.pause()
      resolve({ socket, closed: done, isClosed: () => isClosed, send: (d) => void socket.write(rawFrame(d)), received: () => received })
    })
  })
}

// Conjunto de trabalho do processo em bytes; "tasklist" muda o separador conforme o idioma do Windows.
async function memory(pid: number) {
  const out = await new Response(Bun.spawn(['tasklist', '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']).stdout).text()
  const kib = out.trim().split('","').at(-1)?.replace(/\D/g, '')
  return Number(kib) * 1024
}

async function drain(from: ReadableStream<Uint8Array>, onText: (t: string) => void) {
  const decode = new TextDecoder()
  for await (const chunk of from) onText(decode.decode(chunk, { stream: true }))
}

test.if(busy)(`a porta ${HUB_PORT} precisa estar livre para testar o .exe`, () => {
  throw new Error(`a porta ${HUB_PORT} já está em uso por outro processo; nada foi testado`)
})

describe.skipIf(!present || busy)('hub em Rust (.exe real)', () => {
  beforeAll(async () => {
    proc = Bun.spawn([EXE], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
    void drain(proc.stdout as ReadableStream<Uint8Array>, (t) => (log += t))
    await until('o .exe abrir a porta', () => log.includes('tudo certo'))
    const res = await fetch(`${http}/host-token`, { headers: { origin: ORIGIN } })
    token = ((await res.json()) as { token: string }).token
  })

  afterAll(() => {
    proc?.kill()
  })

  afterEach(async () => {
    expect(proc.exitCode).toBeNull()
    await until('o hub ficar vazio', async () => {
      const p = await ping()
      return p.students === 0 && !p.host
    }, 15_000)
  })

  test('/ping responde com os cabeçalhos de rede local', async () => {
    const res = await fetch(`${http}/ping`, { headers: { origin: ORIGIN } })
    expect(await res.json()).toEqual({ app: 'oblita', v: 1, students: 0, host: false })
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
  })

  test('CORS e rede local em toda resposta, inclusive erros e OPTIONS', async () => {
    const cases: [string, string, Record<string, string>, number][] = [
      ['GET', '/ping', {}, 200],
      ['OPTIONS', '/ping', {}, 204],
      ['OPTIONS', '/host-token', { 'access-control-request-method': 'GET', 'access-control-request-local-network': 'true' }, 204],
      ['OPTIONS', '/nao-existe', {}, 204],
      ['GET', '/nao-existe', {}, 404],
      ['POST', '/ping', {}, 405],
      ['GET', '/host-token', {}, 403],
      ['GET', '/ws/student', {}, 400],
      ['GET', '/ws/host?token=errado', {}, 400],
    ]
    for (const [method, path, headers, status] of cases) {
      for (const origin of ['https://malicioso.example', undefined]) {
        const res = await fetch(`${http}${path}`, { method, headers: { ...headers, ...(origin ? { origin } : {}) } })
        const where = `${method} ${path} origin=${origin}`
        expect([where, res.status]).toEqual([where, status])
        expect([where, res.headers.get('access-control-allow-origin')]).toEqual([where, origin ?? '*'])
        expect(res.headers.get('access-control-allow-private-network')).toBe('true')
        expect(res.headers.get('access-control-allow-local-network')).toBe('true')
        expect(res.headers.get('access-control-allow-headers')).toBe('*')
        expect(res.headers.get('access-control-allow-methods')).toContain('GET')
      }
    }
    const upgrade = { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' }
    const denied = await fetch(`${http}/ws/host?token=errado`, { headers: { ...upgrade, origin: ORIGIN } })
    expect(denied.status).toBe(403)
    expect(denied.headers.get('access-control-allow-local-network')).toBe('true')
  })

  test('/host-token: só origens de HUB_ORIGINS, exatas', async () => {
    for (const origin of HUB_ORIGINS) {
      const res = await fetch(`${http}/host-token`, { headers: { origin } })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { token: string; addresses: string[] }
      expect(body.token).toMatch(/^[0-9a-f]{32}$/)
      expect(Array.isArray(body.addresses)).toBe(true)
    }
    expect((await fetch(`${http}/host-token`)).status).toBe(403)
    for (const origin of ['https://malicioso.example', 'http://oblita.giuli.dev', 'https://oblita.giuli.dev.malicioso.example', 'https://oblita.giuli.dev/', 'HTTPS://OBLITA.GIULI.DEV', 'null', 'http://localhost:5174']) {
      const res = await fetch(`${http}/host-token`, { headers: { origin } })
      expect([origin, res.status]).toEqual([origin, 403])
      expect(await res.json()).toEqual({ error: 'forbidden' })
    }
  })

  test('/host-token e /ws/host só pelo loopback', async () => {
    const res = await fetch(`${http}/host-token`, { headers: { origin: ORIGIN } })
    const { addresses } = (await res.json()) as { addresses: string[] }
    const lan = addresses.find((a) => !a.startsWith('100.')) ?? addresses[0]
    if (!lan) return console.warn('hub-rust: sem IP de rede; a recusa fora do loopback não foi testada.')
    const fromLan = await fetch(`http://${lan}:${HUB_PORT}/host-token`, { headers: { origin: ORIGIN } })
    expect(fromLan.status).toBe(403)
    expect(fromLan.headers.get('access-control-allow-local-network')).toBe('true')
    await expect(open(`ws://${lan}:${HUB_PORT}/ws/host?token=${token}`)).rejects.toThrow()
    expect((await ping()).host).toBe(false)
  })

  test('painel com token errado ou sem token é recusado', async () => {
    await expect(open(`${ws}/ws/host?token=errado`)).rejects.toThrow()
    await expect(open(`${ws}/ws/host`)).rejects.toThrow()
    expect((await ping()).host).toBe(false)
  })

  test('repassa bytes nos dois sentidos, e o aluno sobrevive ao painel recarregar', async () => {
    const host = await openPanel()
    const student = await openStudent()
    const opened = decodeHub(await host.next())
    expect(opened.op).toBe(HubOp.open)

    student.sock.send(new Uint8Array([1, 2, 3]))
    const data = decodeHub(await host.next())
    expect(data.op).toBe(HubOp.data)
    expect(data.conn).toBe(opened.conn)
    expect([...data.data]).toEqual([1, 2, 3])

    host.sock.send(encodeHub(opened.conn, HubOp.data, new Uint8Array([9, 8])))
    expect([...(await student.next())]).toEqual([9, 8])

    // Texto não faz parte do protocolo.
    student.sock.send('oi')
    student.sock.send(new Uint8Array([7]))
    expect([...decodeHub(await host.next()).data]).toEqual([7])

    host.sock.close()
    await closed(host.sock)
    await until('o hub notar a queda do painel', async () => !(await ping()).host)
    expect((await ping()).students).toBe(1)
    expect(student.sock.readyState).toBe(WebSocket.OPEN)
    // Sem painel, o que o aluno manda some, sem derrubar ninguém.
    student.sock.send(new Uint8Array([6]))

    const again = await openPanel()
    const reopened = decodeHub(await again.next())
    expect(reopened.op).toBe(HubOp.open)
    expect(reopened.conn).toBe(opened.conn)
    student.sock.send(new Uint8Array([5]))
    expect([...decodeHub(await again.next()).data]).toEqual([5])

    // O último dado chega antes do fechamento: é assim que o aluno recebe "refused".
    again.sock.send(encodeHub(opened.conn, HubOp.data, new Uint8Array([4])))
    again.sock.send(encodeHub(opened.conn, HubOp.close))
    expect([...(await student.next())]).toEqual([4])
    await closed(student.sock)
    const bye = decodeHub(await again.next())
    expect(bye.op).toBe(HubOp.close)
    expect(bye.conn).toBe(opened.conn)
    again.sock.close()
  })

  test('o painel novo recebe os alunos na ordem de chegada', async () => {
    const a = await openStudent()
    const b = await openStudent()
    const c = await openStudent()
    const host = await openPanel()
    const conns = [decodeHub(await host.next()), decodeHub(await host.next()), decodeHub(await host.next())]
    expect(conns.every((f) => f.op === HubOp.open)).toBe(true)
    expect(conns.map((f) => f.conn)).toEqual(conns.map((f) => f.conn).toSorted((x, y) => x - y))
    for (const s of [a, b, c]) s.sock.close()
    host.sock.close()
  })

  test('um segundo painel substitui o primeiro, que perde o poder', async () => {
    const student = await openStudent()
    student.sock.send(new Uint8Array([1]))
    const first = await openPanel()
    const { conn } = decodeHub(await first.next())
    const second = await openPanel()
    expect(decodeHub(await second.next()).conn).toBe(conn)
    await closed(first.sock)
    expect(second.sock.readyState).toBe(WebSocket.OPEN)
    // O painel antigo fechou, mas isso não pode tirar o novo do lugar.
    await sleep(100)
    expect((await ping()).host).toBe(true)
    second.sock.send(encodeHub(conn, HubOp.data, new Uint8Array([2])))
    expect([...(await student.next())]).toEqual([2])
    student.sock.close()
    second.sock.close()
  })

  test('quadro curto, conexão desconhecida e op estranha não derrubam nada', async () => {
    const host = await openPanel()
    host.sock.send(new Uint8Array([]))
    host.sock.send(new Uint8Array([1, 2]))
    host.sock.send(new Uint8Array([0, 0, 0, 1]))
    host.sock.send('texto')
    host.sock.send(encodeHub(999999, HubOp.data, new Uint8Array([1])))
    host.sock.send(encodeHub(999999, HubOp.close))
    const student = await openStudent()
    const opened = decodeHub(await host.next())
    expect(opened.op).toBe(HubOp.open)
    host.sock.send(encodeHub(opened.conn, 9, new Uint8Array([1])))
    host.sock.send(encodeHub(opened.conn, HubOp.open))
    host.sock.send(encodeHub(opened.conn, HubOp.data, new Uint8Array([3])))
    expect([...(await student.next())]).toEqual([3])
    // Quadro vazio do aluno ainda é um quadro, com 5 bytes de cabeçalho.
    student.sock.send(new Uint8Array([]))
    expect(decodeHub(await host.next()).data.length).toBe(0)
    student.sock.close()
    host.sock.close()
  })

  test('painel -> aluno vai até 16 MiB; acima disso cai só o painel', async () => {
    const host = await openPanel()
    const student = await openStudent()
    const { conn } = decodeHub(await host.next())
    student.sock.send(new Uint8Array([1]))
    await host.next()

    host.sock.send(encodeHub(conn, HubOp.data, new Uint8Array(16 * MiB).fill(7)))
    const big = await student.next()
    expect(big.length).toBe(16 * MiB)
    expect(big[16 * MiB - 1]).toBe(7)

    host.sock.send(encodeHub(conn, HubOp.data, new Uint8Array(16 * MiB + 1)))
    await closed(host.sock)
    await until('o hub soltar o painel', async () => !(await ping()).host)
    expect(student.sock.readyState).toBe(WebSocket.OPEN)
    expect((await ping()).students).toBe(1)
    student.sock.close()
  }, 30_000)

  test('aluno -> painel vai até 8 MiB; acima disso cai só o aluno', async () => {
    const host = await openPanel()
    const student = await openStudent()
    const { conn } = decodeHub(await host.next())

    student.sock.send(new Uint8Array(8 * MiB).fill(9))
    const big = decodeHub(await host.next())
    expect(big.conn).toBe(conn)
    expect(big.data.length).toBe(8 * MiB)
    expect(big.data[8 * MiB - 1]).toBe(9)

    student.sock.send(new Uint8Array(8 * MiB + 1))
    await closed(student.sock)
    const bye = decodeHub(await host.next())
    expect([bye.conn, bye.op]).toEqual([conn, HubOp.close])
    expect(host.sock.readyState).toBe(WebSocket.OPEN)
    host.sock.close()
  }, 30_000)

  test('aluno lento é fechado em vez de a memória crescer sem limite', async () => {
    const host = await openPanel()
    const slow = await rawConnect('/ws/student', { paused: true })
    const slowConn = decodeHub(await host.next()).conn
    slow.send(new Uint8Array([1]))
    await host.next()
    const fine = await openStudent()
    const fineConn = decodeHub(await host.next()).conn

    const pid = proc.pid
    const before = await memory(pid)
    let peak = before
    const frame = encodeHub(slowConn, HubOp.data, new Uint8Array(MiB))
    let sent = 0
    let closedAt = 0
    let bye = false
    // Depois do limite de 64 MiB não há o que esperar; 300 MiB seria o gasto sem limite.
    const watcher = host.next().then((f) => {
      const d = decodeHub(f)
      bye = d.conn === slowConn && d.op === HubOp.close
      closedAt = sent
    })
    while (sent < 300 && !closedAt) {
      if (host.sock.bufferedAmount > 8 * MiB) {
        await sleep(5)
        continue
      }
      host.sock.send(frame)
      sent++
      if (sent % 16 === 0) peak = Math.max(peak, await memory(pid))
    }
    await watcher
    expect(bye).toBe(true)
    expect(closedAt).toBeLessThan(300)
    expect(peak - before).toBeLessThan(150 * MiB)
    console.log(`hub-rust: aluno lento fechado após ${closedAt} MiB enviados; memória subiu ${((peak - before) / MiB).toFixed(0)} MiB`)

    // O resto da sala não sente.
    host.sock.send(encodeHub(fineConn, HubOp.data, new Uint8Array([1])))
    expect([...(await fine.next())]).toEqual([1])
    expect(host.sock.readyState).toBe(WebSocket.OPEN)
    slow.socket.destroy()
    fine.sock.close()
    host.sock.close()
  }, 60_000)

  test('fila do painel cheia derruba o aluno que encheu, nunca o painel', async () => {
    const panel = await rawConnect(`/ws/host?token=${token}`, { paused: true })
    const student = await openStudent()
    const flood = new Uint8Array(MiB)
    let sent = 0
    while (student.sock.readyState === WebSocket.OPEN && sent < 200) {
      if (student.sock.bufferedAmount > 4 * MiB) {
        await sleep(5)
        continue
      }
      student.sock.send(flood)
      sent++
      await sleep(0)
    }
    await closed(student.sock)
    console.log(`hub-rust: painel parado; aluno derrubado após ${sent} MiB`)
    expect(sent).toBeLessThan(200)
    const p = await ping()
    expect(p.host).toBe(true)
    expect(panel.isClosed()).toBe(false)

    // Quem vem de outro IP ainda passa, porque a cota é de cada IP.
    const other = await rawConnect('/ws/student', { localAddress: '127.0.9.2' })
    other.send(new Uint8Array(MiB))
    await sleep(300)
    expect(other.isClosed()).toBe(false)
    expect((await ping()).host).toBe(true)
    other.socket.destroy()
    panel.socket.destroy()
  }, 60_000)

  test('reconectar em loop não renova a cota da fila do painel', async () => {
    const panel = await rawConnect(`/ws/host?token=${token}`, { paused: true })
    const honest = await rawConnect('/ws/student', { localAddress: '127.0.9.3' })
    honest.send(new Uint8Array([1]))
    const before = await memory(proc.pid)
    let peak = before
    const flood = rawFrame(new Uint8Array(MiB))
    // Cada volta cabia na cota antiga; somadas, passam dos 256 MiB da fila inteira.
    for (let round = 0; round < 40; round++) {
      const bad = await rawConnect('/ws/student', { localAddress: '127.0.9.4' })
      for (let i = 0; i < 10 && !bad.isClosed(); i++) bad.socket.write(flood)
      await Promise.race([bad.closed, sleep(100)])
      bad.socket.destroy()
      peak = Math.max(peak, await memory(proc.pid))
    }
    await sleep(200)
    console.log(`hub-rust: reconexão em loop; memória subiu ${((peak - before) / MiB).toFixed(0)} MiB`)
    expect(peak - before).toBeLessThan(80 * MiB)
    expect(honest.isClosed()).toBe(false)
    honest.send(new Uint8Array(MiB))
    await sleep(200)
    expect(honest.isClosed()).toBe(false)
    expect((await ping()).host).toBe(true)
    expect(panel.isClosed()).toBe(false)
    honest.socket.destroy()
    panel.socket.destroy()
  }, 60_000)

  test('enxurrada de quadros minúsculos com o painel parado também cai no aluno', async () => {
    const panel = await rawConnect(`/ws/host?token=${token}`, { paused: true })
    const student = await rawConnect('/ws/student')
    // 200 mil quadros de 1 byte: muito além dos 4096 que antes derrubavam o painel.
    const one = rawFrame(new Uint8Array([1]))
    const batch = new Uint8Array(one.length * 5000)
    for (let i = 0; i < 5000; i++) batch.set(one, i * one.length)
    for (let i = 0; i < 40 && !student.isClosed(); i++) {
      student.socket.write(batch)
      await sleep(5)
    }
    await Promise.race([student.closed, sleep(10_000).then(() => Promise.reject(new Error('aluno não foi fechado')))])
    expect((await ping()).host).toBe(true)
    expect(panel.isClosed()).toBe(false)
    panel.socket.destroy()
  }, 30_000)

  test('no máximo 16 conexões por IP, inclusive no loopback', async () => {
    const host = await openPanel()
    const mine: Client[] = []
    for (let i = 0; i < 16; i++) {
      mine.push(await openStudent())
      decodeHub(await host.next())
    }
    expect((await ping()).students).toBe(16)

    const extra = await openStudent()
    await closed(extra.sock)
    expect((await ping()).students).toBe(16)

    // Outro IP não é afetado.
    const other = await rawConnect('/ws/student', { localAddress: '127.0.9.1' })
    decodeHub(await host.next())
    expect((await ping()).students).toBe(17)
    other.socket.destroy()
    expect(decodeHub(await host.next()).op).toBe(HubOp.close)

    // A vaga volta quando alguém sai.
    mine[0].sock.close()
    expect(decodeHub(await host.next()).op).toBe(HubOp.close)
    const back = await openStudent()
    expect(decodeHub(await host.next()).op).toBe(HubOp.open)
    expect(back.sock.readyState).toBe(WebSocket.OPEN)
    back.sock.close()
    for (const s of mine) s.sock.close()
    host.sock.close()
  }, 30_000)

  test('o limite global de 512 alunos continua valendo', async () => {
    const raws: Raw[] = []
    for (let ip = 1; raws.length < 512; ip++) {
      const batch = Array.from({ length: Math.min(16, 512 - raws.length) }, () => rawConnect('/ws/student', { localAddress: `127.0.${100 + ip}.1` }))
      raws.push(...(await Promise.all(batch)))
    }
    await until('512 alunos', async () => (await ping()).students === 512)
    for (const r of raws) r.send(new Uint8Array([1]))
    const late = await rawConnect('/ws/student', { localAddress: '127.0.99.1' })
    await Promise.race([late.closed, sleep(5000).then(() => Promise.reject(new Error('o 513º não foi fechado')))])
    expect((await ping()).students).toBe(512)
    for (const r of raws) r.socket.destroy()
  }, 60_000)

  test('socket mudo cai em 15 s; quem já mandou um quadro fica', async () => {
    const started = Date.now()
    const mute = await openStudent()
    const textOnly = await openStudent()
    const talker = await openStudent()
    textOnly.sock.send('texto não conta')
    talker.sock.send(new Uint8Array([1]))
    await sleep(10_000)
    expect(mute.sock.readyState).toBe(WebSocket.OPEN)
    await Promise.all([closed(mute.sock), closed(textOnly.sock)])
    const took = Date.now() - started
    expect(took).toBeGreaterThan(14_000)
    expect(took).toBeLessThan(17_000)
    await sleep(1500)
    expect(talker.sock.readyState).toBe(WebSocket.OPEN)
    expect((await ping()).students).toBe(1)
    talker.sock.close()
  }, 30_000)

  test('porta ocupada: explica o erro e espera o Enter', async () => {
    const second = Bun.spawn([EXE], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
    try {
      let text = ''
      void drain(second.stdout as ReadableStream<Uint8Array>, (t) => (text += t))
      await until('a mensagem de porta em uso', () => text.includes('Aperte Enter'))
      expect(text).toContain(`A porta ${HUB_PORT} já está em uso`)
      await sleep(1000)
      expect(second.exitCode).toBeNull()
      second.stdin.write('\r\n')
      await second.stdin.flush()
      expect(await second.exited).toBe(1)
      // O primeiro continua no ar.
      expect((await fetch(`${http}/ping`)).ok).toBe(true)
    } finally {
      second.kill()
    }
  })

  test('o log sai em UTF-8 com acentos, e o programa ainda está de pé', async () => {
    await sleep(200)
    expect(log).toContain('o programa está rodando')
    expect(log).toContain('Aluno conectou')
    expect(log).not.toContain('�')
    expect(decoder.decode(new TextEncoder().encode(log))).toBe(log)
    expect(proc.exitCode).toBeNull()
  })
})
