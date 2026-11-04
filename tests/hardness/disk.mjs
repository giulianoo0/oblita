// Dureza da pasta da prova (/ws/files, host/src/files.rs). Access control está no abuse.mjs e a
// bateria de caminhos/limites/symlink roda no cargo (host: files::tests). Aqui exercemos o caminho
// REAL pela rede (quadro do protocolo de arquivos) para confirmar que o ataque não grava nada fora
// da raiz: path traversal em todas as formas, nomes reservados/NUL/unicode, symlink plantado,
// escrita concorrente e idempotência.
import net from 'node:net'
import { mkdtempSync, rmSync, readdirSync, statSync, symlinkSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hub, until, sleep } from './harness.mjs'

const results = []
function check(name, expected, observed, pass) {
  results.push({ name, expected, observed, pass })
  console.log(`${pass ? 'PASSOU' : 'FALHOU'} | ${name}\n   esperado: ${expected}\n   observado: ${observed}`)
}

// ---- cliente cru de /ws/files (precisa do header Origin, que o WebSocket do Node não põe)
const OP = { writeAt: 1, replace: 2, remove: 4, info: 6, done: 7 }
function encodeReq(id, op, path, offset = 0, body = new Uint8Array()) {
  const name = new TextEncoder().encode(path)
  const out = new Uint8Array(15 + name.length + body.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, id)
  out[4] = op
  view.setBigUint64(5, BigInt(offset))
  view.setUint16(13, name.length)
  out.set(name, 15)
  out.set(body, 15 + name.length)
  return out
}
function wsMask(data) {
  const n = data.length
  const head = n < 126 ? [0x82, 0x80 | n] : n < 65536 ? [0x82, 0x80 | 126, n >> 8, n & 255] : [0x82, 0x80 | 127, 0, 0, 0, 0, (n / 2 ** 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]
  const out = new Uint8Array(head.length + 4 + n)
  out.set(head)
  out.set(data, head.length + 4)
  return out
}

class FilesClient {
  constructor() {
    this.waiters = []
    this.buf = Buffer.alloc(0)
    this.frames = []
  }
  connect(port, token) {
    return new Promise((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port })
      this.socket = s
      let upgraded = false
      let head = ''
      s.on('error', reject)
      s.once('connect', () => s.write(`GET /ws/files?token=${token} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: https://oblita.giuli.dev\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`))
      s.on('data', (chunk) => {
        if (!upgraded) {
          head += chunk.toString('latin1')
          const i = head.indexOf('\r\n\r\n')
          if (i < 0) return
          if (!head.startsWith('HTTP/1.1 101')) return reject(new Error(head.split('\r\n')[0]))
          upgraded = true
          const rest = Buffer.from(head.slice(i + 4), 'latin1')
          this.buf = rest
          this.pump()
          resolve(this)
          return
        }
        this.buf = Buffer.concat([this.buf, chunk])
        this.pump()
      })
    })
  }
  pump() {
    // decodifica quadros de servidor (sem máscara)
    for (;;) {
      if (this.buf.length < 2) return
      const len0 = this.buf[1] & 0x7f
      let off = 2
      let len = len0
      if (len0 === 126) {
        if (this.buf.length < 4) return
        len = this.buf.readUInt16BE(2)
        off = 4
      } else if (len0 === 127) {
        if (this.buf.length < 10) return
        len = Number(this.buf.readBigUInt64BE(2))
        off = 10
      }
      if (this.buf.length < off + len) return
      const payload = this.buf.subarray(off, off + len)
      this.buf = this.buf.subarray(off + len)
      const w = this.waiters.shift()
      if (w) w(payload)
      else this.frames.push(payload)
    }
  }
  next() {
    const f = this.frames.shift()
    if (f) return Promise.resolve(f)
    return new Promise((r) => this.waiters.push(r))
  }
  send(req) {
    this.socket.write(wsMask(req))
  }
  async request(id, op, path, offset, body) {
    this.send(encodeReq(id, op, path, offset, body))
    // espera a resposta com o mesmo id (pode chegar o info id=0 antes)
    for (let i = 0; i < 20; i++) {
      const f = await this.next()
      const rid = f.readUInt32BE(0)
      if (rid === id) return { status: f[4], body: f.subarray(5) }
    }
    throw new Error('sem resposta')
  }
  close() {
    this.socket.destroy()
  }
}

const provaDir = mkdtempSync(join(tmpdir(), 'oblita-prova-'))
const outside = mkdtempSync(join(tmpdir(), 'oblita-fora-'))
writeFileSync(join(outside, 'alvo.txt'), 'original')

const hub = new Hub({ folder: provaDir })
await hub.start()
const token = await hub.token()

function listAll(dir) {
  const out = []
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const p = join(cur, e.name)
      out.push(p)
      if (e.isDirectory()) stack.push(p)
    }
  }
  return out.sort()
}

try {
  const cli = await new FilesClient().connect(hub.port, token)
  // primeiro quadro é o info (id 0)
  const first = await cli.next()
  check('info inicial chega (id 0)', 'id=0', `id=${first.readUInt32BE(0)}`, first.readUInt32BE(0) === 0)

  // escrita válida
  let id = 1
  const okWrite = await cli.request(id++, OP.writeAt, 'sala/aluno/gravacao/0000.webm', 0, new Uint8Array([1, 2, 3]))
  check('escrita válida dentro da sala', 'status 0', `status=${okWrite.status}`, okWrite.status === 0)

  // path traversal em todas as formas -> status 1 (invalid), nada fora da raiz
  const outsideBefore = listAll(outside)
  const traversal = [
    '../fora.txt',
    'sala/../../fora.txt',
    '/etc/passwd',
    '/tmp/fora.txt',
    'C:\\fora.txt',
    'C:/Windows/x.txt',
    '\\\\servidor\\c\\x.txt',
    '//servidor/c/x.txt',
    '\\\\?\\C:\\x.txt',
    'sala\\b.txt',
    'sala/CON',
    'sala/aux.txt',
    'sala/com1.log',
    'sala/arq.txt:stream',
    'sala/arq.txt::$DATA',
    'sala/nul\u0000byte.txt',
    'sala/.oblita-sala',
    'sala/.oculto',
    'sala/gpj.\u202eexe',
    'sala/zero\u200bwidth',
    'sala/b .',
    'sala/ b',
  ]
  let allRefused = true
  const refusedList = []
  for (const bad of traversal) {
    const r = await cli.request(id++, OP.writeAt, bad, 0, new Uint8Array([9]))
    const r2 = await cli.request(id++, OP.replace, bad, 0, new Uint8Array([9]))
    const r3 = await cli.request(id++, OP.remove, bad, 0, new Uint8Array())
    const refused = r.status !== 0 && r2.status !== 0 && r3.status !== 0
    if (!refused) {
      allRefused = false
      refusedList.push(`${bad} (w=${r.status} r=${r2.status} rm=${r3.status})`)
    }
  }
  check('path traversal / nomes reservados / NUL / unicode (todas as formas)', 'todos recusados (status != 0)', allRefused ? `${traversal.length} formas recusadas` : `passaram: ${refusedList.join(', ')}`, allRefused)
  check('nada foi escrito fora da raiz', 'pasta de fora intacta', `igual=${JSON.stringify(listAll(outside)) === JSON.stringify(outsideBefore)}`, JSON.stringify(listAll(outside)) === JSON.stringify(outsideBefore))

  // symlink plantado dentro da raiz apontando para fora -> escrita recusada, alvo intacto
  symlinkSync(outside, join(provaDir, 'elo'))
  symlinkSync(join(outside, 'alvo.txt'), join(provaDir, 'sala', 'elo.txt'))
  const sl1 = await cli.request(id++, OP.writeAt, 'elo/x.txt', 0, new Uint8Array([7]))
  const sl2 = await cli.request(id++, OP.replace, 'elo/x.txt', 0, new Uint8Array([7]))
  const targetUntouched = readFileSync(join(outside, 'alvo.txt'), 'utf8') === 'original'
  check('symlink plantado na pasta (sala -> fora)', 'escrita recusada, alvo externo intacto', `w=${sl1.status} r=${sl2.status} alvoIntacto=${targetUntouched}`, sl1.status !== 0 && sl2.status !== 0 && targetUntouched)

  // escrita concorrente na mesma sala (vários ids em voo, Store serializa pelo mutex)
  const parts = []
  for (let p = 0; p < 50; p++) parts.push(cli.request(id++, OP.writeAt, 'sala/aluno/gravacao/0000.webm', p === 0 ? 0 : 3 + (p - 1), new Uint8Array([p & 255])).catch(() => ({ status: 255 })))
  // (offsets sequenciais; concorrência real: muitos replace simultâneos em arquivos distintos)
  const files = []
  for (let f = 0; f < 60; f++) files.push(cli.request(id++, OP.replace, `sala/conc/f${f}.txt`, 0, new Uint8Array(1000)).then((r) => r.status))
  const statuses = await Promise.all(files)
  const allOk = statuses.every((s) => s === 0)
  const written = existsSync(join(provaDir, 'sala', 'conc')) ? readdirSync(join(provaDir, 'sala', 'conc')).length : 0
  check('escrita concorrente de 60 arquivos', 'todas gravam, sem corromper', `ok=${allOk} arquivos=${written} hub_vivo=${hub.alive()}`, allOk && written === 60 && hub.alive())

  // idempotência: regravar o mesmo pedaço não duplica
  await cli.request(id++, OP.writeAt, 'sala/idem.webm', 0, new Uint8Array([1, 2, 3]))
  await cli.request(id++, OP.writeAt, 'sala/idem.webm', 3, new Uint8Array([4, 5]))
  await cli.request(id++, OP.writeAt, 'sala/idem.webm', 3, new Uint8Array([4, 5]))
  const idem = readFileSync(join(provaDir, 'sala', 'idem.webm'))
  check('write_at idempotente (reenvio do mesmo pedaço)', 'conteúdo [1,2,3,4,5]', `bytes=[${[...idem]}]`, idem.length === 5 && idem[3] === 4 && idem[4] === 5)

  cli.close()
} finally {
  hub.kill()
  await sleep(200)
  rmSync(provaDir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== DISCO: ${results.length - failed.length}/${results.length} passaram ===`)
  console.log('Limites de cota/disco cheio e símbólico multiplataforma: ver cargo (host: files::tests).')
  if (failed.length) console.log('FALHARAM:', failed.map((f) => f.name).join('; '))
  process.exit(failed.length ? 1 : 0)
}
