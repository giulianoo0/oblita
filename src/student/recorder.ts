// Gravação em segmentos curtos: cada um é um arquivo tocável sozinho.
// Isso resolve a busca no player e faz uma perda parcial custar só um pedaço.

const SEGMENT_MS = 60_000
const SLICE_MS = 3_000
const RETRY_MS = 2_000
const MAX_FAILS = 5

// Tela é quase toda texto parado: 250 kbps em 1280 px e 5 quadros por segundo bastam para ler o
// código no player. A captura em si continua nativa, porque o selo precisa da resolução real.
export const RECORDING = { bitrate: 250_000, maxWidth: 1280, maxHeight: 720, fps: 5 }

const MIMES = ['video/mp4;codecs=avc1.42E01F', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']

export interface RecPart {
  segment: number
  part: number
  startedAt: number
  last: boolean
  mime: string
  blob: Blob
}

export class ScreenRecorder {
  private mime = MIMES.find((m) => MediaRecorder.isTypeSupported(m)) ?? ''
  private current: MediaRecorder | null = null
  private timer = 0
  private stopped = false
  private fails = 0
  // Trilha só do gravador, reduzida. Parar o gravador para só ela, nunca a captura original.
  private track: MediaStreamTrack | null = null
  private stream: MediaStream | null = null

  constructor(
    private source: MediaStream,
    private segment: number,
    private onPart: (part: RecPart) => void,
    private opts = RECORDING,
  ) {}

  // O próximo número livre: quem grava depois de uma queda começa daqui, sem sobrescrever.
  get nextSegment() {
    return this.segment
  }

  async start() {
    this.stopped = false
    const original = this.source.getVideoTracks()[0]
    if (!original || original.readyState !== 'live') return
    this.track = original.clone()
    // Se o navegador não reduzir, grava como veio: o bitrate continua limitando o tamanho.
    await this.track
      .applyConstraints({ width: { max: this.opts.maxWidth }, height: { max: this.opts.maxHeight }, frameRate: { max: this.opts.fps } })
      .catch(() => {})
    if (this.stopped) return this.track.stop()
    this.stream = new MediaStream([this.track])
    this.startSegment()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    try {
      if (this.current?.state === 'recording') this.current.stop()
    } catch {
      // Já parado pelo navegador.
    }
    this.track?.stop()
  }

  private startSegment() {
    // Trilha encerrada não grava: o próximo compartilhamento cria outro gravador.
    const stream = this.stream
    if (this.stopped || !stream?.active) return
    const segment = this.segment++
    const startedAt = Date.now()
    let rec: MediaRecorder
    try {
      rec = new MediaRecorder(stream, { mimeType: this.mime, videoBitsPerSecond: this.opts.bitrate })
    } catch (err) {
      return this.retry(err)
    }
    let part = 0
    let pending: Blob | null = null
    const emit = (blob: Blob, last: boolean) =>
      this.onPart({ segment, part: part++, startedAt, last, mime: rec.mimeType || this.mime, blob })
    // Guarda sempre um pedaço: só ao parar se sabe qual foi o último.
    rec.ondataavailable = (e) => {
      if (pending) emit(pending, false)
      pending = e.data.size ? e.data : null
    }
    rec.onstop = () => {
      if (pending) emit(pending, true)
      else if (part > 0) emit(new Blob([], { type: rec.mimeType }), true)
      pending = null
    }
    // Falha do codificador no meio: fecha este segmento e tenta um novo, sem derrubar a prova.
    rec.onerror = (e) => {
      clearTimeout(this.timer)
      try {
        if (rec.state === 'recording') rec.stop()
      } catch {}
      this.retry((e as ErrorEvent).error ?? e)
    }
    try {
      // A trilha encerrada para o gravador sozinho; o proctor já avisou o professor.
      rec.start(SLICE_MS)
    } catch (err) {
      return this.retry(err)
    }
    this.fails = 0
    this.current = rec
    // O novo começa antes do antigo parar, então não há buraco entre os segmentos.
    this.timer = window.setTimeout(() => {
      const old = rec
      this.startSegment()
      try {
        if (old.state === 'recording') old.stop()
      } catch {}
    }, SEGMENT_MS)
  }

  // Poucas tentativas espaçadas: um gravador que nunca funciona não pode virar laço de erro.
  private retry(err: unknown) {
    console.error('gravador falhou', err)
    if (this.stopped || ++this.fails > MAX_FAILS) return
    this.timer = window.setTimeout(() => this.startSegment(), RETRY_MS * this.fails)
  }
}

// Miniatura para o mural do professor: pequena de propósito.
export class FrameGrabber {
  private video = document.createElement('video')
  private canvas = document.createElement('canvas')

  constructor(stream: MediaStream) {
    this.video.srcObject = stream
    this.video.muted = true
    this.video.playsInline = true
    void this.video.play().catch(() => {})
  }

  // WebP sai menor que JPEG para tela; quem não gera WebP devolve PNG, e aí vai JPEG.
  private webp = true

  async grab(width: number, quality: number): Promise<Blob | null> {
    const { videoWidth: w, videoHeight: h } = this.video
    if (!w || !h) return null
    this.canvas.width = width
    this.canvas.height = Math.round((h / w) * width)
    this.canvas.getContext('2d')?.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height)
    if (this.webp) {
      const blob = await new Promise<Blob | null>((resolve) => this.canvas.toBlob(resolve, 'image/webp', quality))
      if (blob?.type === 'image/webp') return blob
      this.webp = false
    }
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/jpeg', quality))
  }

  // Recorta a região do selo em resolução nativa, da captura real, e não do que a página acha que mostra.
  async cropRegion(rect: DOMRect): Promise<Blob | null> {
    const { videoWidth: w, videoHeight: h } = this.video
    if (!w || !h) return null
    const scaleX = w / window.innerWidth
    const scaleY = h / window.innerHeight
    const sw = Math.max(1, Math.round(rect.width * scaleX))
    const sh = Math.max(1, Math.round(rect.height * scaleY))
    this.canvas.width = sw
    this.canvas.height = sh
    this.canvas.getContext('2d')?.drawImage(this.video, Math.round(rect.left * scaleX), Math.round(rect.top * scaleY), sw, sh, 0, 0, sw, sh)
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'))
  }

  dispose() {
    this.video.srcObject = null
  }
}
