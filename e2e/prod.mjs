// O caminho real do aluno: visita o site publicado uma vez, e depois abre com o domínio inacessível
// e fala com o hub pelo IP da rede. O corte é simulado no resolvedor de nomes deste navegador.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BUN = join('node_modules', 'bun', 'bin', 'bun.exe')
const SITE = 'https://oblita.giuli.dev'
const CDP = 9345
const HUB_PORT = 17788
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (name, ok, extra = '') => {
  results.push(ok)
  console.log(`${ok ? 'ok  ' : 'FALHOU'} ${name}${extra ? `: ${extra}` : ''}`)
}

const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((i) => i.family === 'IPv4' && !i.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address))?.address

async function launch(profile, extra = []) {
  const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--no-first-run', ...extra, 'about:blank'], { stdio: 'ignore' })
  let info
  for (let i = 0; i < 60 && !info; i++) {
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
  const { result: { targetId } } = await send('Target.createTarget', { url: `${SITE}/` })
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Runtime.enable', {}, sessionId)
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId)
    return r.result?.exceptionDetails ? `ERRO ${JSON.stringify(r.result.exceptionDetails).slice(0, 200)}` : r.result?.result?.value
  }
  return {
    evaluate,
    navigate: (url) => send('Page.navigate', { url }, sessionId),
    grant: async () => {
      for (const name of ['local-network', 'loopback-network', 'local-network-access']) await send('Browser.setPermission', { origin: SITE, permission: { name }, setting: 'granted' })
    },
    // Fecha pelo protocolo e espera: o mesmo perfil não abre enquanto o processo anterior vive.
    stop: async () => {
      const gone = new Promise((r) => proc.once('exit', r))
      await Promise.race([send('Browser.close'), sleep(3000)])
      ws.close()
      await Promise.race([gone, sleep(8000)])
      proc.kill()
      for (let i = 0; i < 40; i++) {
        try {
          await fetch(`http://127.0.0.1:${CDP}/json/version`, { signal: AbortSignal.timeout(300) })
          await sleep(250)
        } catch {
          return
        }
      }
    },
  }
}

async function httpChecks() {
  const get = (path, init) => fetch(`${SITE}${path}`, init)
  const health = await get('/healthz')
  check('/healthz', health.status === 200 && (await health.text()) === 'ok')
  check('/healthz sem cache', (health.headers.get('cache-control') ?? '').includes('no-store'))
  const sw = await get('/sw.js')
  check('/sw.js é JavaScript e sem cache', sw.ok && (sw.headers.get('content-type') ?? '').includes('javascript') && (sw.headers.get('cache-control') ?? '').includes('no-cache'), sw.headers.get('content-type') ?? '')
  const manifest = await (await get('/precache.json')).json()
  check('precache.json', manifest.files?.length > 10, `${manifest.files?.length} arquivos`)
  const big = manifest.files.filter((f) => f.gz)
  for (const f of big) {
    const res = await get(`${f.url}.gz`, { method: 'HEAD' })
    check(`${f.url}.gz publicado`, res.ok && !(res.headers.get('content-type') ?? '').includes('text/html'), `${res.headers.get('content-type')}, ${res.headers.get('content-length')} bytes`)
  }
  const llms = await get('/llms.txt')
  check('/llms.txt', llms.ok && (await llms.text()).includes('exam.json'))
  const html = await (await get('/')).text()
  check('embed: título e descrição', html.includes('og:title" content="oblita_"') && html.includes('provas online de código sem cola.'))
  const card = await get('/social-card.png')
  check('imagem de compartilhamento', card.ok && (card.headers.get('content-type') ?? '').includes('image/png'))
  const route = await get('/entrar')
  check('rota do app devolve a página', route.ok && (await route.text()).includes('id="root"'))
  check('código de sala inválido é recusado', (await get('/signal?code=!!')).status === 400)
}

// O aperto de mão do modo só navegador, pelo Durable Object de produção.
async function signalCheck() {
  const code = `T${Date.now().toString(36).toUpperCase()}`.slice(0, 10)
  const url = `wss://oblita.giuli.dev/signal?code=${code}`
  const open = () =>
    new Promise((res, rej) => {
      const ws = new WebSocket(url)
      const inbox = []
      const waiters = []
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data)
        const w = waiters.shift()
        if (w) w(m)
        else inbox.push(m)
      }
      ws.onerror = () => rej(new Error('ws'))
      ws.onopen = () => res({ ws, next: () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => waiters.push(r))) })
    })
  const host = await open()
  host.ws.send(JSON.stringify({ t: 'create', code }))
  check('sinalização: cria sala', (await host.next()).t === 'created')
  const thief = await open()
  thief.ws.send(JSON.stringify({ t: 'create', code }))
  check('sinalização: sala ocupada não é tomada', (await thief.next()).t === 'taken')
  const peer = await open()
  peer.ws.send(JSON.stringify({ t: 'join', code, sdp: 'oferta' }))
  const got = await host.next()
  check('sinalização: oferta chega ao professor', got.t === 'peer' && got.sdp === 'oferta')
  host.ws.send(JSON.stringify({ t: 'answer', to: got.peer, sdp: 'resposta' }))
  check('sinalização: resposta chega ao aluno', (await peer.next()).sdp === 'resposta')
  const big = await open()
  big.ws.send(JSON.stringify({ t: 'join', code, sdp: 'x'.repeat(20000) }))
  const closed = await new Promise((r) => {
    big.ws.onclose = () => r(true)
    setTimeout(() => r(false), 4000)
  })
  check('sinalização: mensagem gigante é recusada', closed)
  for (const c of [host, thief, peer]) c.ws.close()
}

const profile = mkdtempSync(join(tmpdir(), 'oblita-prod-'))
const hub = spawn(BUN, ['-e', `import { createHub } from './server/hub.ts'; createHub('t').listen({ hostname: '0.0.0.0', port: ${HUB_PORT} })`], { stdio: 'ignore' })
let browser
try {
  await httpChecks()
  await signalCheck()
  check('IP de rede local encontrado', !!lanIp, lanIp)

  browser = await launch(profile)
  let ready = false
  const started = Date.now()
  for (let i = 0; i < 240 && !ready; i++) {
    await sleep(500)
    ready = await browser.evaluate(`document.body.innerText.includes('Baixado neste computador')`)
  }
  check('1ª visita: baixou tudo', ready === true, `${Math.round((Date.now() - started) / 1000)} s`)
  const before = await browser.evaluate(`navigator.storage.persisted().then((p) => navigator.storage.estimate().then((e) => ({ persistida: p, mb: Math.round(e.usage / 1048576) })))`)
  console.log('     armazenamento:', JSON.stringify(before))
  await browser.stop()

  // Mesmo perfil, agora sem resolver o domínio: é o que o aluno vive com a rede cortada.
  browser = await launch(profile, ['--host-resolver-rules=MAP oblita.giuli.dev ~NOTFOUND, MAP *.gstatic.com ~NOTFOUND'])
  await browser.grant()
  await sleep(3500)
  const reach = await browser.evaluate(`fetch('https://oblita.giuli.dev/healthz', { cache: 'no-store' }).then(() => 'alcançou', () => 'inacessível')`)
  check('domínio está mesmo inacessível', reach === 'inacessível', reach)
  check('rede cortada: página abre pelo cache', (await browser.evaluate(`document.body.innerText.includes('Sou aluno')`)) === true)
  await browser.navigate(`${SITE}/entrar`)
  await sleep(2500)
  check('rede cortada: /entrar abre', (await browser.evaluate(`document.body.innerText.length`)) > 20)

  const ping = await browser.evaluate(`fetch('http://${lanIp}:${HUB_PORT}/ping', { targetAddressSpace: 'local', cache: 'no-store' }).then((r) => r.json()).then((j) => j.app, (e) => 'ERRO ' + e.message)`)
  check('rede cortada: alcança o hub pelo IP', ping === 'oblita', String(ping))
  const socket = await browser.evaluate(`new Promise((res) => {
    const w = new WebSocket('ws://${lanIp}:${HUB_PORT}/ws/student')
    w.onopen = () => { w.close(); res('abriu') }
    w.onerror = () => res('erro')
    setTimeout(() => res('tempo'), 5000)
  })`)
  check('rede cortada: WebSocket para o hub', socket === 'abriu', socket)
  const compiled = await browser.evaluate(`(async () => {
    const m = await caches.keys()
    for (const name of m) {
      const keys = await (await caches.open(name)).keys()
      const core = keys.find((r) => r.url.includes('llvm.core-') && !r.url.endsWith('.gz'))
      if (core) {
        const res = await caches.match(new URL(core.url).pathname)
        return (await WebAssembly.compile(await res.arrayBuffer())) instanceof WebAssembly.Module
      }
    }
    return false
  })()`)
  check('rede cortada: compilador carrega do cache', compiled === true, String(compiled))
} catch (err) {
  check('execução sem exceção', false, String(err))
} finally {
  await browser?.stop()
  hub.kill()
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    // O Edge pode segurar arquivos do perfil por um instante; é só uma pasta temporária.
  }
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed} ok, ${failed} falhas`)
process.exit(failed ? 1 : 0)
