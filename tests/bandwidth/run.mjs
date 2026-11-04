// Mede bytes por minuto por aluno, antes e depois, num Chrome real capturando a própria aba.
// Uso: node tests/bandwidth/run.mjs [--seconds=60]
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BROWSER = process.env.BROWSER ?? (process.platform === 'win32' ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome')
const SECONDS = Number(process.argv.find((a) => a.startsWith('--seconds='))?.split('=')[1] ?? 60)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const freePort = () =>
  new Promise((res, rej) => {
    const srv = createServer()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => res(port))
    })
  })

const procs = []
let userDir
const kill = (p) => {
  if (!p?.pid || p.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' })
  else p.kill('SIGKILL')
}

async function main() {
  const port = await freePort()
  const vite = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', join(ROOT, 'tests', 'bandwidth', 'vite.config.ts'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' })
  procs.push(vite)
  const url = `http://127.0.0.1:${port}/tests/bandwidth/page.html`
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) break
    } catch {}
    await sleep(500)
  }
  userDir = mkdtempSync(join(tmpdir(), 'oblita-banda-'))
  const browser = spawn(BROWSER, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDir}`, '--window-size=1920,1080', '--auto-accept-this-tab-capture', '--no-first-run', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' })
  procs.push(browser)
  let debug
  for (let i = 0; i < 120 && !debug; i++) {
    const file = join(userDir, 'DevToolsActivePort')
    if (existsSync(file)) debug = Number(readFileSync(file, 'utf8').split('\n')[0])
    await sleep(250)
  }
  const target = await (await fetch(`http://127.0.0.1:${debug}/json/new?${url}`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let next = 1
  const waiting = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    waiting.get(m.id)?.(m)
  }
  const send = (method, params) =>
    new Promise((r) => {
      const id = next++
      waiting.set(id, r)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)
    return r.result?.result?.value
  }
  for (let i = 0; i < 100 && !(await ev('!!window.ready').catch(() => false)); i++) await sleep(300)
  console.log(`medindo ${SECONDS} s…`)
  const r = await ev(`measure(${SECONDS})`)
  const kb = (n) => `${(n / 1024).toFixed(0)} KB`
  console.log(JSON.stringify(r, null, 2))
  console.log(`\nbytes por minuto por aluno (captura ${r.capture.width}x${r.capture.height}, gravação nova ${r.recording.width}x${r.recording.height})`)
  console.log(`  vídeo:     antes ${kb(r.videoOld)}   depois ${kb(r.videoNew)}`)
  console.log(`  miniatura: antes ${kb(r.thumbJpeg)} (JPEG 0,5)   WebP 0,5 ${kb(r.thumbWebp)}   depois ${kb(r.thumbNow)} (FrameGrabber atual)`)
  console.log(`  selo:      ${kb(r.seal)} (igual nos dois)`)
  console.log(`  total:     antes ${kb(r.videoOld + r.thumbJpeg + r.seal)}   depois ${kb(r.videoNew + r.thumbNow + r.seal)}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => {
    procs.forEach(kill)
    if (userDir) rmSync(userDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  })
