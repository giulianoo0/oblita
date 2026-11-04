// Carga: 100 alunos simulados (handshake real, vídeo sintético ~250-400 kbps, miniaturas, Yjs,
// Testar com wasm) contra o hub + painel simulado. Mede RSS/CPU do hub, latência de repasse e
// filas ao longo do tempo. Também: painel lento (não lê) -> o hub limita a memória.
//
// Uso: node load.mjs [--students=100] [--minutes=10]
import { readFileSync } from 'node:fs'
import { randomFillSync } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { Hub, until, sleep, rawConnect, mib, ROOT } from './harness.mjs'
import { Panel, Student } from './net.mjs'

// Buffers grandes (vídeo) sem o teto de 64 KiB do WebCrypto; o conteúdo só é repassado.
function randomBytes(n) {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i += 65536) randomFillSync(out, i, Math.min(65536, n - i))
  return out
}

const arg = (n, d) => Number(process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d)
const N = arg('students', 100)
const MINUTES = arg('minutes', 10)

const soma = new Uint8Array(readFileSync(join(ROOT, 'shared', 'fixtures', 'soma.wasm')))
const contagem = new Uint8Array(gunzipSync(readFileSync(join(ROOT, 'shared', 'fixtures', 'contagem.wasm.gz'))))

const hub = new Hub()
await hub.start()
const token = await hub.token()
const base = hub.base()

// Painel que também registra latência de repasse: marca o tempo quando um 'beat' chega de cada aluno.
let testsDone = 0
let testsInvalid = 0
const panel = new Panel(base, {
  token,
  onReady: () => {},
})
await panel.start()

// ---- alunos
const students = []
for (let i = 0; i < N; i++) {
  const s = new Student(base, { name: `Aluno ${i}`, onTestResult: (r) => (r.status === 'invalid' ? testsInvalid++ : testsDone++) })
  await s.connect()
  students.push(s)
  if (i % 20 === 0) await sleep(50)
}
await until(`${N} welcomes`, () => students.filter((s) => s.welcomed).length >= N, 30000)
console.log(`${N} alunos conectados e com welcome.`)

// ---- tráfego sintético por aluno
// Vídeo: ~250-400 kbps. Enviamos pedaços de 3 s. 300 kbps => ~112 KB a cada 3 s.
// Miniatura: ~12 KB a cada 3 s. Yjs: pequenas edições a cada ~1 s. Testar: 1 por minuto.
const timers = []
let latencies = []
let videoBytes = 0

// Latência de repasse (ida e volta no nível de aplicação): o aluno manda um 'event' marcado no
// tempo e o painel responde 'ack'. Cada aluno tem no máximo uma sonda em voo, então não há
// sobreposição de seq. Mede hub + cifra + painel, que é o caminho real de um alerta.
const probeSent = new Map() // `${idx}:${seq}` -> t0
students.forEach((s, idx) => {
  s._idx = idx
  s.onAck = (stream, seq) => {
    if (stream !== 'event') return
    const t0 = probeSent.get(`${idx}:${seq}`)
    if (t0 !== undefined) {
      latencies.push(performance.now() - t0)
      probeSent.delete(`${idx}:${seq}`)
    }
  }
})

function kbEvery3s(kbps) {
  return Math.round((kbps * 1000 / 8) * 3 / 1024) * 1024
}

for (const s of students) {
  const kbps = 250 + Math.floor(Math.random() * 150) // 250-400 kbps
  let segment = 0
  let part = 0
  // vídeo a cada 3 s
  timers.push(setInterval(() => {
    if (!s.welcomed) return
    const size = kbEvery3s(kbps)
    const chunk = randomBytes(Math.min(size, 180 * 1024))
    const last = part >= 19 // segmento de 60 s = 20 pedaços de 3 s
    s.sendRec(chunk, segment, part, last)
    videoBytes += chunk.length
    part++
    if (last) {
      segment++
      part = 0
    }
    // miniatura junto
    s.sendThumb(randomBytes(12 * 1024))
  }, 3000))
  // beat a cada 2 s + sonda de latência (event marcado no tempo)
  timers.push(setInterval(() => {
    if (!s.welcomed) return
    s.sendBeat()
    const seq = ++s.eventSeq
    probeSent.set(`${s._idx}:${seq}`, performance.now())
    s.send({ t: 'event', event: { seq, kind: 'focus-lost', at: Date.now(), hash: '0'.repeat(64) } })
  }, 2000))
  // Yjs digitando a cada ~1 s
  timers.push(setInterval(() => {
    if (!s.welcomed) return
    s.sendYUpdate(randomBytes(200))
  }, 1000 + Math.floor(Math.random() * 400)))
}

// Testar com wasm: 1 aluno por segundo dispara (dentro do rate limit), alternando válido/inválido
let testIdx = 0
const testTimer = setInterval(() => {
  const s = students[testIdx % students.length]
  testIdx++
  if (!s.welcomed) return
  if (testIdx % 5 === 0) s.sendTestWasm(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])) // inválido
  else s.sendTestWasm(testIdx % 2 ? soma : contagem)
}, 1000)

// ---- amostragem de RSS/CPU/filas
const samples = []
let lastCpu = hub.cpuSeconds()
let lastT = Date.now()
const sampleTimer = setInterval(() => {
  const now = Date.now()
  const cpu = hub.cpuSeconds()
  const cpuPct = ((cpu - lastCpu) / ((now - lastT) / 1000)) * 100
  lastCpu = cpu
  lastT = now
  samples.push({ t: now, rss: hub.rss(), cpu: cpuPct })
}, 5000)

const totalMs = MINUTES * 60 * 1000
const startedAt = Date.now()
console.log(`rodando carga por ${MINUTES} min...`)
while (Date.now() - startedAt < totalMs) {
  await sleep(30000)
  const last = samples[samples.length - 1]
  const p = await hub.ping()
  console.log(`[${Math.round((Date.now() - startedAt) / 1000)}s] RSS=${mib(last?.rss ?? 0)} CPU=${(last?.cpu ?? 0).toFixed(0)}% alunos=${p.students} lat_amostras=${latencies.length} testes_ok=${testsDone} testes_inv=${testsInvalid} vídeo=${mib(videoBytes)}`)
  if (!hub.alive()) {
    console.log('HUB MORREU!')
    break
  }
}

for (const t of timers) clearInterval(t)
clearInterval(testTimer)
clearInterval(sampleTimer)

// ---- painel lento: um aluno manda muito vídeo e o painel para de ler -> hub limita memória
console.log('\n--- teste do painel/aluno lento (fila cheia derruba o aluno, hub limita memória) ---')
const rssBeforeSlow = hub.rss()
// Painel cru que faz upgrade e NÃO lê (pausado). Depois um aluno despeja vídeo.
const slowPanel = await rawConnect(hub.port, `/ws/host?token=${token}`, { headers: { origin: 'https://oblita.giuli.dev' }, paused: true })
const flood = await new Student(base).connect()
await until('flood welcome', () => flood.welcomed, 8000).catch(() => {})
// despeja ~400 MiB em pedaços de 2 MiB o mais rápido possível
let dropped = false
flood.sock.addEventListener('close', () => (dropped = true))
for (let i = 0; i < 300 && !dropped; i++) {
  flood.sendRec(randomBytes(2 * 1024 * 1024), 0, i, false)
  if (i % 20 === 0) await sleep(50)
}
await Promise.race([until('aluno lento derrubado', () => dropped, 20000).catch(() => {}), sleep(20000)])
const rssPeakSlow = hub.rss()
console.log(`painel lento: aluno despejou vídeo; aluno derrubado=${dropped}; RSS pico=${mib(rssPeakSlow)} (limite de fila do painel: 256 MiB); hub vivo=${hub.alive()}`)
slowPanel.destroy?.()
flood.close()

// ---- relatório
const rssMax = Math.max(...samples.map((s) => s.rss), 0)
const cpuVals = samples.map((s) => s.cpu).filter((c) => c >= 0 && Number.isFinite(c))
const cpuAvg = cpuVals.reduce((a, b) => a + b, 0) / (cpuVals.length || 1)
const cpuMax = Math.max(...cpuVals, 0)
latencies.sort((a, b) => a - b)
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((latencies.length - 1) * p))] ?? 0

console.log('\n=== RESUMO DA CARGA ===')
console.log(JSON.stringify({
  alunos: N,
  minutos: MINUTES,
  rss_max: mib(rssMax),
  rss_final: mib(samples[samples.length - 1]?.rss ?? 0),
  cpu_medio_pct: cpuAvg.toFixed(1),
  cpu_max_pct: cpuMax.toFixed(1),
  latencia_amostras: latencies.length,
  latencia_p50_ms: pct(0.5).toFixed(1),
  latencia_p99_ms: pct(0.99).toFixed(1),
  latencia_max_ms: (latencies[latencies.length - 1] ?? 0).toFixed(1),
  testes_ok: testsDone,
  testes_invalidos: testsInvalid,
  video_total: mib(videoBytes),
  painel_lento_derrubou_aluno: dropped,
  rss_pico_painel_lento: mib(rssPeakSlow),
  hub_vivo: hub.alive(),
}, null, 2))

for (const s of students) s.close()
panel.close()
hub.kill()
await sleep(300)
process.exit(hub.alive() === false ? 0 : 0)
