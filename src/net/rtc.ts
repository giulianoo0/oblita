// WebRTC só de rede local: sem STUN nem TURN, o caminho nunca depende de internet.

export const RTC_CONFIG: RTCConfiguration = { iceServers: [] }

const SLICE = 60 * 1024
const HIGH_WATER = 4 * 1024 * 1024
const LOW_WATER = 512 * 1024
const MAX_FRAME = 32 * 1024 * 1024

// Fatia quadros grandes e respeita a fila do canal: [u8 último?][dados].
export class DataPipe {
  private queue: Uint8Array<ArrayBuffer>[] = []
  private parts: Uint8Array[] = []

  constructor(
    private dc: RTCDataChannel,
    onFrame: (frame: Uint8Array) => void,
  ) {
    dc.binaryType = 'arraybuffer'
    dc.bufferedAmountLowThreshold = LOW_WATER
    dc.onbufferedamountlow = () => this.flush()
    dc.onmessage = (e) => {
      const bytes = new Uint8Array(e.data as ArrayBuffer)
      this.parts.push(bytes.subarray(1))
      const total = this.parts.reduce((n, p) => n + p.length, 0)
      if (total > MAX_FRAME) return dc.close()
      if (bytes[0] !== 1) return
      const out = new Uint8Array(total)
      let at = 0
      for (const p of this.parts) {
        out.set(p, at)
        at += p.length
      }
      this.parts = []
      onFrame(out)
    }
  }

  send(frame: Uint8Array) {
    for (let at = 0; at < frame.length || at === 0; at += SLICE) {
      const piece = frame.subarray(at, at + SLICE)
      const out = new Uint8Array(piece.length + 1)
      out[0] = at + SLICE >= frame.length ? 1 : 0
      out.set(piece, 1)
      this.queue.push(out)
    }
    this.flush()
  }

  buffered = () => this.dc.bufferedAmount + this.queue.reduce((n, q) => n + q.length, 0)

  private flush() {
    while (this.queue.length && this.dc.readyState === 'open' && this.dc.bufferedAmount < HIGH_WATER) {
      this.dc.send(this.queue.shift()!)
    }
  }
}

export function waitIce(pc: RTCPeerConnection, timeoutMs = 4000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check)
      clearTimeout(timer)
      resolve()
    }
    const check = () => pc.iceGatheringState === 'complete' && done()
    const timer = setTimeout(done, timeoutMs)
    pc.addEventListener('icegatheringstatechange', check)
  })
}

export function signalUrl(code: string) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/signal?code=${encodeURIComponent(code.toUpperCase())}`
}
