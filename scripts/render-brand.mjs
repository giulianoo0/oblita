// Gera social-card.png e os ícones a partir de scripts/card.html e scripts/icon.html, num Chrome sem janela.
// Uso: node scripts/render-brand.mjs  (BROWSER troca o executável)
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BROWSER = process.env.BROWSER ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : process.platform === 'win32' ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : 'chromium')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT = [
  ['scripts/card.html', 1200, 630, 'public/social-card.png'],
  ['scripts/icon.html', 512, 512, 'public/icon-512.png'],
  ['scripts/icon.html', 192, 192, 'public/icon-192.png'],
  ['scripts/icon.html', 180, 180, 'public/apple-touch-icon.png'],
]

const dir = mkdtempSync(join(tmpdir(), 'oblita-brand-'))
const browser = spawn(BROWSER, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' })
try {
  let port
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(150)
    const file = join(dir, 'DevToolsActivePort')
    if (existsSync(file)) port = Number(readFileSync(file, 'utf8').split('\n')[0])
  }
  if (!port) throw new Error('o navegador não abriu a porta de depuração')
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
  let id = 0
  const waiting = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id) waiting.get(m.id)?.(m)
  }
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  for (const [page, width, height, out] of OUT) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url: pathToFileURL(join(ROOT, page)).href })
    await sleep(1200)
    const { result } = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ROOT, out), Buffer.from(result.data, 'base64'))
    console.log(`${out}: ${width}x${height}`)
  }
} finally {
  browser.kill('SIGKILL')
  rmSync(dir, { recursive: true, force: true })
}
process.exit(0)
