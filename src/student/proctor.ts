// Tudo o que o navegador deixa observar durante a prova. Cada sinal vira alerta na hora.
// Nenhum sinal sozinho é prova de nada: o professor decide olhando a gravação.
import type { AlertKind, StudentStatus } from '../../shared/protocol'

export type ProctorHandlers = {
  alert: (kind: AlertKind, detail?: string) => void
  status: (status: StudentStatus) => void
  snapshot: () => void
}

const DEVTOOLS_KEYS = new Set(['F12'])
const BLOCKED_COMBOS = new Set(['u', 's', 'p', 'o', 'f', 'g', 'h', 'j', 'n', 't', 'w', 'l', 'd', 'r', 'e'])
const EDITOR_COMBOS = new Set(['f', 'h', 'g', 'd', 'l', 'e', 'j'])
const PROBES = ['https://www.gstatic.com/generate_204', 'https://1.1.1.1/cdn-cgi/trace', 'https://oblita.giuli.dev/healthz']
const PROBE_TIMEOUT = 2500

// Qualquer endereço de fora que responda significa que a rede não está isolada.
export async function hasInternet(): Promise<boolean> {
  const attempts = PROBES.map((url) =>
    fetch(`${url}?${Date.now()}`, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(PROBE_TIMEOUT) }),
  )
  try {
    await Promise.any(attempts)
    return true
  } catch {
    return false
  }
}

export type ScreenResult = { ok: true; stream: MediaStream } | { ok: false; reason: 'denied' | 'not-monitor' | 'unsupported' }

export async function requestScreen(): Promise<ScreenResult> {
  if (!navigator.mediaDevices?.getDisplayMedia) return { ok: false, reason: 'unsupported' }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'monitor', frameRate: { ideal: 5, max: 10 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: false,
      // Os campos abaixo existem no Chromium, mas ainda não nos tipos do TypeScript.
      monitorTypeSurfaces: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'exclude',
      systemAudio: 'exclude',
    } as DisplayMediaStreamOptions)
  } catch {
    return { ok: false, reason: 'denied' }
  }
  const track = stream.getVideoTracks()[0]
  // O que vale é o que foi compartilhado de fato, não o que foi pedido.
  if (track?.getSettings().displaySurface !== 'monitor') {
    stream.getTracks().forEach((t) => t.stop())
    return { ok: false, reason: 'not-monitor' }
  }
  return { ok: true, stream }
}

export const isExtendedDisplay = () => (screen as Screen & { isExtended?: boolean }).isExtended === true

export async function enterFullscreen() {
  await document.documentElement.requestFullscreen({ navigationUI: 'hide' })
  // Captura Esc e parte dos atalhos do sistema enquanto estiver em tela cheia.
  const kb = (navigator as Navigator & { keyboard?: { lock?: (keys?: string[]) => Promise<void> } }).keyboard
  await kb?.lock?.().catch(() => {})
}

export class Proctor {
  private stopFns: (() => void)[] = []
  private stream: MediaStream | null = null
  private worker: Worker | null = null
  private lastAlert = new Map<AlertKind, number>()
  private isolated: boolean | null = null
  private devtoolsOpen = false
  private armed = false

  constructor(private h: ProctorHandlers) {}

  status(): StudentStatus {
    const track = this.stream?.getVideoTracks()[0]
    return {
      screen: track?.readyState === 'live' && !track.muted,
      fullscreen: !!document.fullscreenElement,
      focused: document.hasFocus() && document.visibilityState === 'visible',
      isolated: this.isolated,
      extended: isExtendedDisplay(),
    }
  }

  setStream(stream: MediaStream) {
    this.stream = stream
    const track = stream.getVideoTracks()[0]
    track.addEventListener('ended', () => {
      this.fire('share-ended')
      this.emit()
    })
    track.addEventListener('mute', () => this.emit())
    track.addEventListener('unmute', () => this.emit())
    this.emit()
  }

  // Durante a preparação só observa; os alertas começam quando ela termina.
  arm() {
    this.armed = true
  }

  start() {
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, capture = true) => {
      window.addEventListener(type, fn, capture)
      this.stopFns.push(() => window.removeEventListener(type, fn, capture))
    }
    const onDoc = <K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void) => {
      document.addEventListener(type, fn, true)
      this.stopFns.push(() => document.removeEventListener(type, fn, true))
    }

    onDoc('fullscreenchange', () => {
      if (!document.fullscreenElement) this.fire('fullscreen-exit')
      this.emit()
    })
    onDoc('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.fire('tab-hidden')
      this.emit()
    })
    on('blur', () => {
      this.fire('focus-lost')
      this.emit()
    })
    on('focus', () => this.emit())
    on('resize', () => this.checkDocked())
    on('keydown', (e) => this.onKey(e))
    on('contextmenu', (e) => e.preventDefault())
    on('beforeprint', () => this.fire('blocked-shortcut', 'imprimir'))
    onDoc('paste', (e) => this.onPaste(e))
    onDoc('drop', (e) => {
      e.preventDefault()
      this.fire('paste', 'arrastou conteúdo')
    })

    const screenObj = screen as Screen & { addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void }
    const onScreenChange = () => {
      if (isExtendedDisplay()) this.fire('multi-monitor')
      this.emit()
    }
    screenObj.addEventListener?.('change', onScreenChange)
    this.stopFns.push(() => screenObj.removeEventListener?.('change', onScreenChange))

    this.startDevtoolsWatch()

    const timers = [
      setInterval(() => this.checkFocus(), 1000),
      setInterval(() => this.checkDocked(), 1000),
      setInterval(() => void this.checkInternet(), 10000),
    ]
    this.stopFns.push(() => timers.forEach(clearInterval))
    void this.checkInternet()
  }

  stop() {
    this.stopFns.forEach((f) => f())
    this.stopFns = []
    this.worker?.terminate()
    this.worker = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.armed = false
  }

  async checkInternet() {
    const online = await hasInternet()
    const was = this.isolated
    this.isolated = !online
    if (online && was === true) this.fire('internet-back')
    if (was !== this.isolated) this.emit()
    return !online
  }

  private emit() {
    this.h.status(this.status())
  }

  private fire(kind: AlertKind, detail?: string) {
    if (!this.armed) return
    const now = Date.now()
    if (now - (this.lastAlert.get(kind) ?? 0) < 1500) return
    this.lastAlert.set(kind, now)
    this.h.alert(kind, detail)
    this.h.snapshot()
  }

  private checkFocus() {
    if (!document.hasFocus()) this.fire('focus-lost', 'sem foco')
    this.emit()
  }

  // Em tela cheia a janela ocupa o monitor. Se a área útil encolhe, algo foi encaixado nela.
  private checkDocked() {
    if (!document.fullscreenElement) return
    const gapH = screen.height - window.innerHeight
    const gapW = screen.width - window.innerWidth
    const docked = gapH > 80 || gapW > 80
    if (docked && !this.devtoolsOpen) {
      this.devtoolsOpen = true
      this.fire('devtools', `área útil encolheu ${Math.max(gapH, gapW)}px`)
    } else if (!docked) {
      this.devtoolsOpen = false
    }
  }

  // Um debugger em worker só pausa se o DevTools estiver aberto. Sem DevTools é instrução vazia.
  private startDevtoolsWatch() {
    const source = `
      setInterval(() => {
        postMessage(0);
        debugger;
      }, 500);
    `
    this.worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })))
    let last = performance.now()
    let ownTick = performance.now()
    this.worker.onmessage = () => {
      last = performance.now()
    }
    const timer = setInterval(() => {
      const now = performance.now()
      // Se esta própria thread também atrasou, foi a máquina que travou, não o worker.
      const mainStalled = now - ownTick > 1500
      ownTick = now
      if (!mainStalled && now - last > 2000) {
        this.fire('devtools', 'depurador pausou o worker')
        last = now
      }
    }, 500)
    this.stopFns.push(() => clearInterval(timer))
  }

  private onKey(e: KeyboardEvent) {
    const key = e.key.toLowerCase()
    const ctrl = e.ctrlKey || e.metaKey
    const devCombo = ctrl && e.shiftKey && ['i', 'j', 'c', 'k', 'm'].includes(key)
    if (DEVTOOLS_KEYS.has(e.key) || devCombo || (ctrl && e.altKey && ['i', 'j', 'c'].includes(key))) {
      e.preventDefault()
      e.stopPropagation()
      this.fire('devtools-shortcut', e.key)
      return
    }
    if (ctrl && key === 's' && !e.shiftKey) {
      e.preventDefault()
      return
    }
    if (ctrl && BLOCKED_COMBOS.has(key) && !e.shiftKey) {
      // Estes também são comandos do editor: o navegador não recebe, mas o Monaco sim.
      if (EDITOR_COMBOS.has(key) && (e.target as HTMLElement | null)?.closest?.('.monaco-editor')) {
        e.preventDefault()
        return
      }
      e.preventDefault()
      e.stopPropagation()
      this.fire('blocked-shortcut', `Ctrl+${key.toUpperCase()}`)
      return
    }
    if (e.key === 'F11' || e.key === 'F5' || e.key === 'F1') {
      e.preventDefault()
      e.stopPropagation()
      if (e.key !== 'F1') this.fire('blocked-shortcut', e.key)
    }
  }

  private onPaste(e: ClipboardEvent) {
    // Código de equipe vem de fora de propósito: esse campo não é resposta de prova.
    if ((e.target as HTMLElement | null)?.closest?.('[data-paste-ok]')) return
    const lf = (s: string) => s.replace(/\r\n/g, '\n')
    const text = lf(e.clipboardData?.getData('text/plain') ?? '')
    // Colar o que foi copiado dentro da própria prova é normal; o editor marca a origem.
    if (text && text !== lf(internalClipboard.value)) {
      e.preventDefault()
      e.stopPropagation()
      this.fire('paste', `${text.length} caracteres`)
    }
  }
}

export const internalClipboard = { value: '' }
