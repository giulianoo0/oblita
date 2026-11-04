// Teste de integração do motor num Edge real. Uso: node tests/engine/run.mjs [--only=regex]
import { Harness, withTimeout } from './harness.mjs'
import { scenarios } from './scenarios.mjs'

const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1]
const filter = only ? new RegExp(only) : null
const TOTAL_MS = 30 * 60_000

const h = new Harness()
let failedHard = null

// Um caso que passou do tempo continua rodando atrás; ele não pode derrubar o resto.
process.on('unhandledRejection', () => {})
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => h.cleanup().finally(() => process.exit(130)))

async function main() {
  await h.start()
  console.log(`${h.browserVersion} | página ${h.origin} | hub ${h.hubLocal} / ${h.hubLan}`)
  for (const [name, fn] of scenarios) {
    if (filter && !filter.test(name)) continue
    h.scenario = name
    console.log(`\n== ${name}`)
    const before = h.results.length
    try {
      await fn(h)
    } catch (err) {
      h.results.push({ scenario: name, name: 'preparação', ok: false, ms: 0, err: String(err?.message ?? err) })
      console.log(`  FALHA preparação: ${err?.message ?? err}`)
    }
    const rows = h.results.slice(before)
    console.log(`   ${rows.filter((r) => r.ok).length}/${rows.length}`)
    await h.closeAll().catch(() => {})
  }
  console.log(`\npermissões aceitas: ${JSON.stringify(h.grants)}`)
}

function table() {
  const rows = h.results
  const width = Math.max(10, ...rows.map((r) => r.scenario.length))
  console.log(`\n${'cenário'.padEnd(width)}  ok   falhou  tempo`)
  const groups = new Map()
  for (const r of rows) {
    const g = groups.get(r.scenario) ?? { ok: 0, bad: 0, ms: 0 }
    if (r.ok) g.ok++
    else g.bad++
    g.ms += r.ms
    groups.set(r.scenario, g)
  }
  for (const [name, g] of groups) console.log(`${name.padEnd(width)}  ${String(g.ok).padEnd(4)} ${String(g.bad).padEnd(7)} ${Math.round(g.ms / 1000)} s`)
  const bad = rows.filter((r) => !r.ok)
  console.log(`\nTOTAL: ${rows.length - bad.length} passaram, ${bad.length} falharam`)
  for (const r of bad) console.log(`  [${r.scenario}] ${r.name}\n      ${r.err.slice(0, 500)}`)
}

let code = 0
try {
  await withTimeout(main(), TOTAL_MS, 'a execução inteira')
} catch (err) {
  failedHard = err
  console.error(`erro geral: ${err?.stack ?? err}`)
} finally {
  await h.cleanup()
  table()
  if (failedHard || h.results.some((r) => !r.ok) || !h.results.length) code = 1
}
process.exit(code)
