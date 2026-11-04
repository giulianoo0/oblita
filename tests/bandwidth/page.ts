// Mede quanto cada aluno manda por minuto, com uma tela sintética parecida com a da prova:
// editor escuro, alguém digitando, rolagem de vez em quando. Grava a mesma captura com a
// configuração antiga e a nova ao mesmo tempo, e mede miniatura e selo com o mesmo quadro.
import { FrameGrabber, ScreenRecorder, RECORDING, type RecPart } from '../../src/student/recorder'

const canvas = document.querySelector('canvas')!
canvas.width = innerWidth
canvas.height = innerHeight
const ctx = canvas.getContext('2d')!
const lines: string[] = []
const CODE = 'for (int i = 0; i < n; i++) { soma += v[i] * pesos[i % k]; printf("%d\\n", soma); }'
let typed = 0
let scroll = 0

function paint() {
  ctx.fillStyle = '#1e1e1e'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#252526'
  ctx.fillRect(0, 0, 420, canvas.height)
  ctx.font = '15px monospace'
  ctx.fillStyle = '#ccc'
  for (let i = 0; i < 30; i++) ctx.fillText(`Questão ${i + 1}: enunciado com algumas palavras para ler`, 16, 40 + i * 28)
  for (let i = 0; i < 40; i++) {
    const line = lines[(i + scroll) % Math.max(1, lines.length)] ?? ''
    ctx.fillStyle = i % 3 ? '#9cdcfe' : '#ce9178'
    ctx.fillText(`${String(i + scroll + 1).padStart(3)}  ${line}`, 440, 40 + i * 24)
  }
  if ((performance.now() / 500) % 2 < 1) ctx.fillRect(440 + 40 + (typed % CODE.length) * 9, 40 + 39 * 24 - 14, 2, 18)
  requestAnimationFrame(paint)
}
for (let i = 0; i < 60; i++) lines.push(CODE.slice(0, (i * 7) % CODE.length))
setInterval(() => {
  typed++
  lines[lines.length - 1] = CODE.slice(0, typed % CODE.length)
  if (typed % CODE.length === 0) lines.push('')
}, 180)
setInterval(() => (scroll += 7), 8000)
paint()

async function measure(seconds: number) {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 5, max: 10 }, width: { max: 1920 }, height: { max: 1080 } },
    audio: false,
    preferCurrentTab: true,
  } as DisplayMediaStreamOptions)
  const settings = stream.getVideoTracks()[0].getSettings()
  const old = { bytes: 0, parts: 0 }
  const now = { bytes: 0, parts: 0 }
  const count = (acc: typeof old) => (p: RecPart) => {
    acc.bytes += p.blob.size
    acc.parts++
  }
  const before = new ScreenRecorder(stream, 0, count(old), { bitrate: 400_000, maxWidth: 1920, maxHeight: 1080, fps: 10 })
  const after = new ScreenRecorder(stream, 0, count(now), RECORDING)
  await before.start()
  await after.start()
  const grabber = new FrameGrabber(stream)
  const thumbs = { jpeg: 0, webp: 0, webp35: 0, png: 0, n: 0 }
  const video = (grabber as unknown as { video: HTMLVideoElement }).video
  const thumbTimer = setInterval(async () => {
    if (!video.videoWidth) return
    const c = document.createElement('canvas')
    c.width = 320
    c.height = Math.round((video.videoHeight / video.videoWidth) * 320)
    c.getContext('2d')!.drawImage(video, 0, 0, c.width, c.height)
    const size = (type: string, q?: number) => new Promise<number>((r) => c.toBlob((b) => r(b?.type === type ? b.size : NaN), type, q))
    thumbs.jpeg += await size('image/jpeg', 0.5)
    thumbs.webp += await size('image/webp', 0.5)
    thumbs.webp35 += (await grabber.grab(320, 0.5))?.size ?? 0
    // O selo: 7vw por 2vw no canto, recortado em resolução nativa.
    const seal = await grabber.cropRegion(new DOMRect(innerWidth * 0.93, 0, innerWidth * 0.07, innerWidth * 0.02))
    thumbs.png += seal?.size ?? 0
    thumbs.n++
  }, 3000)
  await new Promise((r) => setTimeout(r, seconds * 1000))
  clearInterval(thumbTimer)
  const recSettings = (after as unknown as { track: MediaStreamTrack }).track.getSettings()
  before.stop()
  after.stop()
  await new Promise((r) => setTimeout(r, 1500))
  stream.getTracks().forEach((t) => t.stop())
  const perMin = (n: number) => Math.round((n / seconds) * 60)
  return {
    seconds,
    capture: { width: settings.width, height: settings.height, frameRate: settings.frameRate },
    recording: { width: recSettings.width, height: recSettings.height, frameRate: recSettings.frameRate },
    videoOld: perMin(old.bytes),
    videoNew: perMin(now.bytes),
    thumbJpeg: perMin(thumbs.jpeg),
    thumbWebp: perMin(thumbs.webp),
    thumbNow: perMin(thumbs.webp35),
    seal: perMin(thumbs.png),
    samples: thumbs.n,
  }
}

Object.assign(window, { measure, ready: true })
