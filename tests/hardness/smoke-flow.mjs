// Fluxo completo de ponta a ponta: sobe o hub, abre o painel simulado e um aluno, confere
// handshake, welcome+token, prova, event/ack, rec/ack e test-wasm (válido e inválido).
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Panel, Student, checkStudentWasm, sleep } from './net.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const EXE = join(root, 'host', 'target', 'release', 'oblita-host')
const PORT = 7787
const base = `ws://127.0.0.1:${PORT}`

async function getToken() {
  const res = await fetch(`http://127.0.0.1:${PORT}/host-token`, { headers: { origin: 'https://oblita.giuli.dev' } })
  return (await res.json()).token
}

async function until(what, check, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await sleep(50)
  }
  throw new Error(`tempo esgotado: ${what}`)
}

const hub = spawn(EXE, ['--pasta', '/tmp/oblita-prova', '--porta', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
hub.stdout.on('data', (d) => (log += d))
hub.stderr.on('data', (d) => (log += d))

try {
  await until('hub abrir', () => log.includes('tudo certo'))
  const token = await getToken()
  const panel = await new Panel(base, { token }).start()
  const student = await new Student(base).connect()
  await until('welcome', () => student.welcomed, 8000)
  console.log('welcome ok, token recebido:', !!student.token, 'fp:', student.teacherFp)
  await until('exam', () => student.hasExam, 4000)
  console.log('prova recebida:', student.hasExam)

  student.sendEvent('focus-lost')
  await until('ack event', () => student.ackedEvent === 1, 4000)
  console.log('event/ack ok:', student.ackedEvent)

  student.sendRec(new Uint8Array(1000), 0, 0, true)
  await until('ack rec', () => student.ackedRec === 1, 4000)
  console.log('rec/ack ok:', student.ackedRec)

  // wasm válido e inválido
  const soma = readFileSync(join(root, 'shared', 'fixtures', 'soma.wasm'))
  const contagem = gunzipSync(readFileSync(join(root, 'shared', 'fixtures', 'contagem.wasm.gz')))
  console.log('check soma local:', checkStudentWasm(new Uint8Array(soma)))
  console.log('check contagem local:', checkStudentWasm(new Uint8Array(contagem)))
  let result
  student.onTestResult = (r) => (result = r)
  student.sendTestWasm(new Uint8Array(soma))
  await until('test-result', () => result, 5000)
  console.log('test-wasm válido:', result.status)

  result = null
  student.sendTestWasm(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))
  await until('test-result inválido', () => result, 5000)
  console.log('test-wasm inválido:', result.status, '-', result.log)

  console.log('stats do painel:', panel.stats)
  student.close()
  panel.close()
  console.log('SMOKE OK')
} finally {
  hub.kill()
}
