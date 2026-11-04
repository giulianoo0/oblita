// Gravação em segmentos curtos: cada um é um arquivo tocável sozinho.
// Isso resolve a busca no player e faz uma perda parcial custar só um pedaço.

const SEGMENT_MS = 60_000
const SLICE_MS = 3_000
const BITRATE = 400_000

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

  constructor(
    private stream: MediaStream,
    private segment: number,
    private onPart: (part: RecPart) => void,
  ) {}

  start() {
    this.stopped = false
    this.startSegment()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    if (this.current?.state === 'recording') this.current.stop()
  }

  private startSegment() {
    // Trilha encerrada não grava: o próximo compartilhamento cria outro gravador.
    if (this.stopped || !this.stream.active) return
    const segment = this.segment++
    const startedAt = Date.now()
    const rec = new MediaRecorder(this.stream, { mimeType: this.mime, videoBitsPerSecond: BITRATE })
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
    // A trilha encerrada para o gravador sozinho; o proctor já avisou o professor.
    rec.start(SLICE_MS)
    this.current = rec
    // O novo começa antes do antigo parar, então não há buraco entre os segmentos.
    this.timer = window.setTimeout(() => {
      const old = rec
      this.startSegment()
      if (old.state === 'recording') old.stop()
    }, SEGMENT_MS)
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

  async grab(width: number, quality: number): Promise<Blob | null> {
    const { videoWidth: w, videoHeight: h } = this.video
    if (!w || !h) return null
    this.canvas.width = width
    this.canvas.height = Math.round((h / w) * width)
    this.canvas.getContext('2d')?.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height)
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
