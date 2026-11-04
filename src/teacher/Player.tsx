// Player das gravações. Cada segmento é um arquivo independente, então a linha do tempo é
// só o relógio: o segmento diz quando começou e o vídeo diz quanto andou dentro dele.
import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, MatroskaInputFormat, Mp4OutputFormat, Output, WebMOutputFormat } from 'mediabunny'
import { Loader2, Pause, Play, SkipBack, SkipForward, VideoOff } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'
import { alertLabel } from './exportZip'
import { formatClock } from '../lib/store'
import type { AlertEntry, Room, SegmentInfo, Student } from './room'

const CACHE_SIZE = 4
const SPEEDS = [1, 2, 4]
const ARROW_MS = 5000
// Abrir um alerta exatamente no instante dele esconde o que levou até lá.
const ALERT_LEAD_MS = 3000
// Enquanto o vídeo não abre, a duração é estimada pelas partes: o gravador fecha uma a cada 3 s.
const PART_MS = 3000

interface Loaded {
  url: string
  remuxed: boolean
}

// O MediaRecorder não escreve duração nem índice, e sem eles o navegador não busca.
// Reescrever o contêiner copia os pacotes e resolve isso sem recodificar.
async function remux(blob: Blob) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const webm = (await input.getFormat()) instanceof MatroskaInputFormat
    const target = new BufferTarget()
    const format = webm ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: 'in-memory' })
    const output = new Output({ format, target })
    const conversion = await Conversion.init({ input, output, copy: { mode: 'forced', shiftTolerance: Infinity }, showWarnings: false })
    if (!conversion.isValid) throw new Error('segmento sem faixa copiável')
    await conversion.execute()
    if (!target.buffer) throw new Error('segmento vazio')
    return new Blob([target.buffer], { type: format.mimeType })
  } finally {
    input.dispose()
  }
}

async function prepare(room: Room, clientId: string, seg: SegmentInfo, raw: boolean): Promise<Loaded> {
  const blob = await room.segmentBlob(clientId, seg)
  if (!raw) {
    try {
      return { url: URL.createObjectURL(await remux(blob)), remuxed: true }
    } catch {
      // Segmento cortado por uma queda: o arquivo cru ainda toca até onde foi gravado.
    }
  }
  return { url: URL.createObjectURL(blob), remuxed: false }
}

class SegmentCache {
  private items = new Map<string, Promise<Loaded>>()

  get(key: string, make: () => Promise<Loaded>) {
    const item = this.items.get(key) ?? make()
    this.items.delete(key)
    this.items.set(key, item)
    for (const [old, value] of this.items) {
      if (this.items.size <= CACHE_SIZE) break
      this.items.delete(old)
      revoke(value)
    }
    return item
  }

  clear() {
    for (const value of this.items.values()) revoke(value)
    this.items.clear()
  }
}

const revoke = (item: Promise<Loaded>) =>
  void item.then(
    (l) => URL.revokeObjectURL(l.url),
    () => {},
  )

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

function locate(segs: SegmentInfo[], durations: Map<number, number>, at: number) {
  let index = 0
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i].startedAt <= at) {
      index = i
      break
    }
  }
  const offset = Math.max(0, at - segs[index].startedAt)
  const known = durations.get(segs[index].segment)
  if (known === undefined || offset < known) return { index, offset }
  // Caiu no vão entre dois segmentos (queda, reconexão): segue para o próximo que existe.
  if (index + 1 < segs.length) return { index: index + 1, offset: 0 }
  return { index, offset: Math.max(0, known - 250) }
}

export default function Player({ room, student, seekTo, alerts }: { room: Room; student: Student; seekTo?: { at: number } | null; alerts: AlertEntry[] }) {
  const clientId = student.clientId
  const segs = Object.values(student.segments)
    .filter((s) => s.parts > 0)
    .sort((a, b) => a.segment - b.segment)

  const video = useRef<HTMLVideoElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const cache = useRef(new SegmentCache())
  const durations = useRef(new Map<number, number>())
  const rawOnly = useRef(new Set<number>())
  const segsRef = useRef(segs)
  segsRef.current = segs
  const loadId = useRef(0)
  const loadedKey = useRef<string | null>(null)
  const loaded = useRef<Loaded | null>(null)
  const currentIndex = useRef(0)
  const pendingOffset = useRef(0)
  const wantPlay = useRef(false)
  const metaPending = useRef(false)
  const loadingRef = useRef(false)
  const speedRef = useRef(1)

  const [pos, setPos] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [drag, setDrag] = useState<number | null>(null)

  const setBusy = (busy: boolean) => {
    loadingRef.current = busy
    setLoading(busy)
  }

  const startPlay = useCallback(() => {
    wantPlay.current = true
    setPlaying(true)
    video.current?.play().catch((err: Error) => {
      // Trocar de segmento interrompe o play anterior. Isso não é o usuário pausando.
      if (err.name === 'AbortError') return
      wantPlay.current = false
      setPlaying(false)
    })
  }, [])

  const goTo = useCallback(
    async (at: number, play: boolean) => {
      const v = video.current
      const list = segsRef.current
      if (!v || !list.length) return
      const { index, offset } = locate(list, durations.current, at)
      const seg = list[index]
      const raw = rawOnly.current.has(seg.segment)
      const key = `${seg.segment}:${seg.parts}:${raw ? 'raw' : 'remux'}`
      const id = ++loadId.current
      wantPlay.current = play
      setPlaying(play)
      setFailed(false)
      setPos(seg.startedAt + offset)
      if (loadedKey.current === key) {
        if (metaPending.current) {
          pendingOffset.current = offset / 1000
          return
        }
        // Pode ter cancelado a carga de outro segmento que ainda estava a caminho.
        setBusy(false)
        v.currentTime = offset / 1000
        if (play) startPlay()
        else v.pause()
        return
      }
      setBusy(true)
      try {
        const next = await cache.current.get(key, () => prepare(room, clientId, seg, raw))
        if (id !== loadId.current) return
        loadedKey.current = key
        loaded.current = next
        currentIndex.current = index
        pendingOffset.current = offset / 1000
        metaPending.current = true
        v.src = next.url
        v.load()
      } catch {
        if (id !== loadId.current) return
        setBusy(false)
        setFailed(true)
        setPlaying(false)
      }
    },
    [room, clientId, startPlay],
  )

  const onMeta = () => {
    const v = video.current
    const seg = segsRef.current[currentIndex.current]
    if (!v || !seg) return
    metaPending.current = false
    if (Number.isFinite(v.duration)) durations.current.set(seg.segment, v.duration * 1000)
    v.defaultPlaybackRate = speedRef.current
    v.playbackRate = speedRef.current
    if (pendingOffset.current > 0) {
      v.currentTime = Number.isFinite(v.duration) ? Math.min(pendingOffset.current, Math.max(0, v.duration - 0.1)) : pendingOffset.current
      pendingOffset.current = 0
    }
    setBusy(false)
    if (wantPlay.current) startPlay()
  }

  const onDuration = () => {
    const v = video.current
    const seg = segsRef.current[currentIndex.current]
    if (v && seg && Number.isFinite(v.duration)) durations.current.set(seg.segment, v.duration * 1000)
  }

  const onTime = () => {
    const v = video.current
    const seg = segsRef.current[currentIndex.current]
    if (v && seg && !loadingRef.current) setPos(seg.startedAt + v.currentTime * 1000)
  }

  const onEnded = () => {
    const next = segsRef.current[currentIndex.current + 1]
    if (next) void goTo(next.startedAt, true)
    else {
      wantPlay.current = false
      setPlaying(false)
    }
  }

  const onError = () => {
    const seg = segsRef.current[currentIndex.current]
    if (!video.current?.currentSrc || !seg) return
    metaPending.current = false
    if (loaded.current?.remuxed) {
      // O navegador recusou o arquivo reescrito: tenta o original antes de desistir.
      rawOnly.current.add(seg.segment)
      void goTo(seg.startedAt + pendingOffset.current * 1000, wantPlay.current)
      return
    }
    const next = segsRef.current[currentIndex.current + 1]
    if (next) return void goTo(next.startedAt, wantPlay.current)
    setBusy(false)
    setFailed(true)
    setPlaying(false)
  }

  const toggle = () => {
    const v = video.current
    if (!v) return
    if (playing) {
      wantPlay.current = false
      setPlaying(false)
      v.pause()
      return
    }
    if (loadingRef.current) {
      wantPlay.current = true
      setPlaying(true)
      return
    }
    if (v.ended) {
      const list = segsRef.current
      const next = list[currentIndex.current + 1]
      if (next) return void goTo(next.startedAt, true)
      // O último segmento pode ter crescido enquanto estava parado (aluno ainda gravando).
      const last = list[currentIndex.current]
      const grew = last && !loadedKey.current?.startsWith(`${last.segment}:${last.parts}:`)
      return void goTo(grew ? pos : list[0].startedAt, true)
    }
    startPlay()
  }

  const step = (dir: 1 | -1) => {
    const list = segsRef.current
    const target = list[Math.min(list.length - 1, Math.max(0, currentIndex.current + dir))]
    if (target) void goTo(target.startedAt, wantPlay.current)
  }

  const changeSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]
    speedRef.current = next
    setSpeed(next)
    if (video.current) {
      video.current.defaultPlaybackRate = next
      video.current.playbackRate = next
    }
  }

  const t0 = segs[0]?.startedAt ?? 0
  const lastSeg = segs[segs.length - 1]
  const t1 = lastSeg ? Math.max(lastSeg.startedAt + (durations.current.get(lastSeg.segment) ?? lastSeg.parts * PART_MS), pos) : 0
  const span = Math.max(1, t1 - t0)
  const shown = drag ?? pos
  const percent = (t: number) => `${clamp01((t - t0) / span) * 100}%`

  const hasSegs = segs.length > 0
  useEffect(() => {
    if (!hasSegs) return
    const first = segsRef.current[0].startedAt
    if (seekTo) void goTo(Math.max(first, seekTo.at - ALERT_LEAD_MS), true)
    else if (!loadedKey.current) void goTo(first, false)
  }, [seekTo, hasSegs, goTo])

  useEffect(() => {
    const store = cache.current
    return () => {
      loadId.current++
      loadedKey.current = null
      loaded.current = null
      metaPending.current = false
      store.clear()
    }
  }, [])

  const keys = useRef({ toggle, goTo, pos, t0, t1 })
  keys.current = { toggle, goTo, pos, t0, t1 }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
      const k = keys.current
      if (e.code === 'Space') {
        // Espaço num botão focado já é o clique dele.
        if (el.tagName === 'BUTTON' || el.tagName === 'A') return
        e.preventDefault()
        k.toggle()
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault()
        const delta = e.key === 'ArrowRight' ? ARROW_MS : -ARROW_MS
        void k.goTo(Math.min(k.t1, Math.max(k.t0, k.pos + delta)), wantPlay.current)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const pointAt = (e: PointerEvent) => {
    const r = bar.current!.getBoundingClientRect()
    return t0 + clamp01((e.clientX - r.left) / r.width) * span
  }

  if (!hasSegs) {
    return (
      <div className="player player-empty">
        <VideoOff size={22} />
        <span>Sem gravação</span>
      </div>
    )
  }

  return (
    <div className="player">
      <video ref={video} muted playsInline onClick={toggle} onLoadedMetadata={onMeta} onDurationChange={onDuration} onTimeUpdate={onTime} onEnded={onEnded} onError={onError} />
      {loading && <Loader2 size={26} className="spin player-spin" />}
      {failed && (
        <div className="player-empty player-over">
          <VideoOff size={22} />
          <span>Segmento ilegível</span>
        </div>
      )}
      <div className="player-bar">
        <button type="button" aria-label={playing ? 'Pausar' : 'Tocar'} onClick={toggle}>
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button type="button" aria-label="Segmento anterior" onClick={() => step(-1)}>
          <SkipBack size={16} />
        </button>
        <button type="button" aria-label="Próximo segmento" onClick={() => step(1)}>
          <SkipForward size={16} />
        </button>
        <div
          ref={bar}
          className="seek"
          role="slider"
          tabIndex={0}
          aria-label="Posição"
          aria-valuemin={0}
          aria-valuemax={Math.round(span / 1000)}
          aria-valuenow={Math.round((shown - t0) / 1000)}
          aria-valuetext={formatClock(shown - t0)}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            setDrag(pointAt(e))
          }}
          onPointerMove={(e) => {
            if (drag !== null) setDrag(pointAt(e))
          }}
          onPointerUp={(e) => {
            if (drag === null) return
            setDrag(null)
            void goTo(pointAt(e), wantPlay.current)
          }}
          onPointerCancel={() => setDrag(null)}
        >
          <div className="seek-fill" style={{ width: percent(shown) }} />
          {/* Os graves vêm por último para ficar por cima quando caem no mesmo ponto da barra. */}
          {[...alerts].sort((a, b) => Number(a.severe) - Number(b.severe)).map((a, i) =>
            a.at >= t0 && a.at <= t1 ? (
              <span
                key={`${a.id}:${i}`}
                className={`seek-mark${a.severe ? '' : ' mild'}`}
                role="button"
                title={alertLabel(a.kind)}
                style={{ left: percent(a.at) }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => void goTo(Math.max(t0, a.at - ALERT_LEAD_MS), true)}
              />
            ) : null,
          )}
        </div>
        <span className="mono xs num player-time" title={new Date(shown).toLocaleTimeString('pt-BR')}>
          {formatClock(shown - t0)} / {formatClock(span)}
        </span>
        <button type="button" className="player-speed" aria-label="Velocidade" onClick={changeSpeed}>
          {speed}x
        </button>
      </div>
    </div>
  )
}
