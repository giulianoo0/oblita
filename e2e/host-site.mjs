// O site servido pelo próprio programa, sem o oblita.giuli.dev: professor em http://localhost:3067,
// aluno em https://IP:3067 passando pelo aviso real de certificado. Precisa do .exe em host/target/release
// e das portas 3067 e 7787 livres.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Edge, Person, killTree, sleep } from './helpers/cdp.mjs'
import { exam } from './helpers/fixtures.mjs'

const EXE = join('host', 'target', 'release', 'oblita-host.exe')
const results = []
const check = (name, ok, extra = '') => {
  results.push(!!ok)
  console.log(`${ok ? 'ok    ' : 'FALHOU'} ${name}${extra ? `: ${extra}` : ''}`)
}

const lan = Object.values(networkInterfaces())
  .flat()
  .find((i) => i.family === 'IPv4' && !i.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address))?.address
if (!lan) throw new Error('sem IP de rede local')

const tmp = mkdtempSync(join(tmpdir(), 'oblita-host-site-'))
const host = spawn(EXE, ['--plain', '--pasta', join(tmp, 'pasta')], { stdio: 'ignore' })
let edge
try {
  for (let i = 0; i < 40; i++) {
    if (await fetch('http://127.0.0.1:3067/ping').then((r) => r.ok, () => false)) break
    await sleep(250)
  }
  edge = await Edge.launch({ tag: 'host-site' })
  const opts = process.env.OBLITA_SHOTS ? { shotsDir: process.env.OBLITA_SHOTS } : {}
  const teacher = await Person.create(edge, 'professor', opts)
  const student = await Person.create(edge, 'aluno', opts)

  // ---- professor
  const T = await teacher.tab('http://localhost:3067/')
  await T.waitText('Sou professor')
  check('professor: status de servido pelo programa', (await T.text()).includes('Servido pelo programa'))
  check('professor: sem service worker', (await T.ev(`navigator.serviceWorker.getRegistration().then((r) => !r)`)) === true)
  await T.clickText('Sou professor')
  await T.waitFor(`location.pathname === '/nova'`)
  const examPath = join(tmp, 'exam.json')
  writeFileSync(examPath, JSON.stringify(exam))
  await T.clickText('Arquivo')
  await T.waitFor(`!!document.querySelector('input[type=file]')`)
  await T.setFile(0, examPath)
  await T.waitText(`3 questões em "${exam.title}"`)
  await T.clickText('Criar sala')
  await T.waitFor(`location.pathname.startsWith('/sala/')`, { timeout: 30000 })
  await T.waitText(`https://${lan}:3067`, { timeout: 15000 })
  const dash = await T.text()
  check('painel: conectou sozinho ao programa', dash.includes('Programa') && !dash.includes('Conectar ao programa'))
  check('painel: mostra o IP e o endereço do site', dash.includes(lan) && dash.includes(`https://${lan}:3067`))
  check('painel: sem "Só navegador"', !dash.includes('Só navegador'))
  await T.shot?.('host-site-painel')
  const ping = await fetch('http://127.0.0.1:7787/ping').then((r) => r.json())
  check('hub: painel conectado, visto também pela 7787', ping.host === true, JSON.stringify(ping))

  // ---- aluno: o aviso de certificado de verdade
  const A = await student.tab(`https://${lan}:3067/`)
  await A.waitFor(`!!document.getElementById('details-button') || document.body?.innerText.includes('Sou aluno')`, { timeout: 15000 })
  const warned = await A.ev(`!!document.getElementById('proceed-link')`)
  check('aluno: navegador mostra o aviso de certificado', warned)
  await A.ev(`document.getElementById('details-button')?.click(); document.getElementById('proceed-link')?.click(); true`)
  await sleep(1500)
  await A.waitText('Sou aluno', { timeout: 20000 })
  check('aluno: depois de Continuar a página abre em https', (await A.url()).startsWith(`https://${lan}:3067/`), await A.url())
  check('aluno: contexto seguro, cifra e captura disponíveis', await A.ev(`isSecureContext && !!crypto.subtle && !!navigator.mediaDevices?.getDisplayMedia`))
  check('aluno: sem "Sou professor"', !(await A.text()).includes('Sou professor'))
  const wasm = await A.ev(`(async () => {
    const m = await (await fetch('/precache.json')).json()
    const f = m.files.find((x) => x.gz && x.url.endsWith('.wasm'))
    return WebAssembly.compile(await (await fetch(f.url)).arrayBuffer()).then((x) => x instanceof WebAssembly.Module)
  })()`)
  check('aluno: compilador abre vindo do programa', wasm === true)
  const leak = await A.ev(`fetch('/host-token').then((r) => r.status)`)
  check('aluno: token do painel recusado', leak === 403, String(leak))

  await A.clickText('Sou aluno')
  await A.waitText('Quem é você?')
  const form = await A.text()
  check('aluno: formulário sem IP e sem código', !form.includes('IP do professor') && !form.includes('Código da sala') && !form.includes('trocar'))
  await A.fill('Nome', 'Ana Teste')
  await A.shot?.('host-site-entrar')
  await A.clickText('Entrar')
  await T.waitText('Ana Teste', { timeout: 30000 })
  check('professor vê o aluno que entrou pelo wss', true)
  const after = await fetch('http://127.0.0.1:7787/ping').then((r) => r.json())
  check('hub: um aluno conectado', after.students === 1, JSON.stringify(after))
  await sleep(1500)
  const page = await A.text()
  check('aluno: entrou na sala, sem recusa', !/recusou|não respondeu/.test(page), page.replace(/\s+/g, ' ').slice(0, 120))
  const errors = [...T.errors, ...A.errors].filter((e) => !/generate_204|cdn-cgi|healthz|ERR_/.test(e))
  check('sem erro de página', errors.length === 0, errors.slice(0, 3).join(' | ').slice(0, 300))
} catch (err) {
  check('terminou sem exceção', false, err.message.slice(0, 400))
} finally {
  await edge?.close().catch(() => {})
  killTree(host)
  await sleep(500)
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    // Pasta temporária: o sistema limpa depois.
  }
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} falha(s) de ${results.length}` : `tudo certo: ${results.length}`)
process.exit(failed ? 1 : 0)
