// Atualização de verdade, como um deploy: a aba abre a build A, o servidor passa a servir a B, e a aba
// tem de achar a B sozinha, oferecer o botão e abrir a B no clique, mesmo com a A fixada.
// Gera as duas builds sozinho. Uso: node e2e/update.mjs
import { execSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BROWSER = process.env.BROWSER ?? (process.platform === 'win32' ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome')
const BUN = process.env.BUN ?? 'bun'
const PORT = 3018
const CDP = 9352
const ORIGIN = `http://localhost:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const work = mkdtempSync(join(tmpdir(), 'oblita-update-'))
const build = (id) => {
  execSync('npx vite build --logLevel error && node scripts/postbuild.mjs', { stdio: 'inherit', env: { ...process.env, OBLITA_BUILD_ID: id }, shell: true })
  cpSync('dist', join(work, id), { recursive: true })
}
build('teste-a')
build('teste-b')
const serveBuild = (id) => {
  rmSync('dist', { recursive: true, force: true })
  cpSync(join(work, id), 'dist', { recursive: true })
}
const swOf = (id) => readFileSync(join(work, id, 'sw.js'), 'utf8')

const results = []
const check = (name, ok, extra = '') => {
  results.push(ok)
  console.log(`${ok ? 'ok  ' : 'FALHOU'} ${name}${extra ? `: ${extra}` : ''}`)
}

check('o sw.js muda de uma build para a outra', swOf('teste-a') !== swOf('teste-b'), swOf('teste-b').split('\n')[0])

serveBuild('teste-a')
const profile = mkdtempSync(join(tmpdir(), 'oblita-update-perfil-'))
const server = spawn(BUN, ['server/index.ts'], { stdio: 'ignore', env: { ...process.env, PORT: String(PORT) }, shell: process.platform === 'win32' })
const browser = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' })

const ask = (msg) => `new Promise((resolve) => {
  const c = new MessageChannel()
  c.port1.onmessage = (e) => resolve(e.data)
  navigator.serviceWorker.controller.postMessage(${JSON.stringify(msg)}, [c.port2])
  setTimeout(() => resolve('sem resposta'), 3000)
})`

try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${ORIGIN}/healthz`)).ok) break
    } catch {}
    await sleep(100)
  }
  let info
  for (let i = 0; i < 50 && !info; i++) {
    try {
      info = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json()
    } catch {
      await sleep(200)
    }
  }
  const ws = new WebSocket(info.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params = {}, sessionId) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params, sessionId }))
    })
  const { result: { targetId } } = await send('Target.createTarget', { url: `${ORIGIN}/` })
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId)
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
    return r.result?.result?.value
  }
  const until = async (expression, tries = 120) => {
    for (let i = 0; i < tries; i++) {
      const v = await evaluate(expression).catch(() => null)
      if (v) return v
      await sleep(500)
    }
    return null
  }
  const shown = () => evaluate(`document.querySelector('.build-version')?.textContent ?? ''`).catch(() => '')

  const installedA = await until(`(async () => !!navigator.serviceWorker.controller && (await caches.keys()).length > 0 && !!document.querySelector('.build-version'))()`)
  check('a build A instala e abre', !!installedA && (await shown()).includes('teste-a'), await shown())

  // Fixada como numa prova que já acabou: o botão tem de soltar antes de recarregar.
  check('fixar a A', (await evaluate(ask({ type: 'pin', build: 'teste-a', reason: 'exam' }))) === true)

  // O deploy: o servidor passa a servir a B. A aba não navega; ela tem de procurar sozinha.
  serveBuild('teste-b')
  await evaluate(`document.dispatchEvent(new Event('visibilitychange'))`)
  const offered = await until(`document.querySelector('button.build-version.update')?.textContent ?? null`)
  check('a aba aberta acha a B e oferece o botão', !!offered && offered.includes('nova versão'), offered ?? 'sem botão')

  await evaluate(`document.querySelector('button.build-version.update')?.click()`)
  await sleep(2500)
  const after = await until(`(document.querySelector('.build-version')?.textContent ?? '').includes('teste-b') && document.querySelector('.build-version').textContent`, 30)
  check('o clique abre a B, mesmo com a A fixada', !!after, after || (await shown()))
  check('a fixação foi solta', (await evaluate(ask({ type: 'pin-status' }))) === null)

  // Pedido que não é navegação, sem hash no nome (como o de um ícone), também vem da versão nova.
  const page = await evaluate(`fetch('/').then((r) => r.text())`)
  check('a página servida é a da B', page === readFileSync(join(work, 'teste-b', 'index.html'), 'utf8'))

  // E o F5 comum continua na B.
  await send('Page.reload', {}, sessionId)
  await sleep(2500)
  check('F5 depois continua na B', (await until(`(document.querySelector('.build-version')?.textContent ?? '').includes('teste-b')`, 20)) === true, await shown())
} catch (err) {
  console.error(err)
  results.push(false)
} finally {
  browser.kill()
  server.kill()
  await sleep(500)
  rmSync(profile, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
  if (existsSync('dist')) rmSync('dist', { recursive: true, force: true })
}

console.log(`\n${results.filter(Boolean).length} ok, ${results.filter((x) => !x).length} falharam`)
process.exit(results.every(Boolean) ? 0 : 1)
