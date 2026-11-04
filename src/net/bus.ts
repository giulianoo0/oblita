// Lado do professor: muitas conexões de aluno, vindas do programa local ou de WebRTC.
import { HUB_PORT } from '../../shared/protocol'
import { HubOp, decodeHub, encodeHub } from '../../shared/frames'
import { DataPipe, RTC_CONFIG, signalUrl, waitIce } from './rtc'
import { hubUrls, parseAddress, pingHub, servedByHost } from './link'

const MAX_RTC_PEERS = 512
// O que a aba pode ter na fila para o programa. Acima disso o programa está travado ou lento,
// e crescer a memória da aba só adia a queda dela. A prova inteira para um aluno cabe folgada.
const MAX_BUFFERED = 256 * 1024 * 1024

export interface Bus {
  kind: 'hub' | 'rtc'
  // false quando não saiu: conexão fechada, ou fila cheia e o aluno foi derrubado.
  send(peer: string, frame: Uint8Array): boolean
  buffered(peer: string): number
  drop(peer: string): void
  close(): void
  onopen: (peer: string) => void
  onframe: (peer: string, frame: Uint8Array) => void
  onpeerclose: (peer: string) => void
  ondown: () => void
}

export type BusInfo = { kind: 'hub'; address: string } | { kind: 'rtc'; code: string }

export async function connectHubBus(address: string, token: string, opts: { maxBuffered?: number } = {}): Promise<Bus> {
  const maxBuffered = opts.maxBuffered ?? MAX_BUFFERED
  const parsed = parseAddress(address) ?? { host: 'localhost', port: HUB_PORT }
  await pingHub(parsed.host, parsed.port, 2500)
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${hubUrls(parsed.host, parsed.port).ws}/ws/host?token=${encodeURIComponent(token)}`)
    ws.binaryType = 'arraybuffer'
    const bus: Bus = {
      kind: 'hub',
      send: (peer, frame) => {
        if (ws.readyState !== WebSocket.OPEN) return false
        // O aluno reenvia ao reconectar o que não foi confirmado: event e rec são fluxos confiáveis.
        if (ws.bufferedAmount + frame.length > maxBuffered) {
          ws.send(encodeHub(Number(peer), HubOp.close))
          return false
        }
        ws.send(encodeHub(Number(peer), HubOp.data, frame))
        return true
      },
      buffered: () => ws.bufferedAmount,
      drop: (peer) => ws.readyState === WebSocket.OPEN && ws.send(encodeHub(Number(peer), HubOp.close)),
      close: () => ws.close(),
      onopen: () => {},
      onframe: () => {},
      onpeerclose: () => {},
      ondown: () => {},
    }
    let opened = false
    ws.onopen = () => {
      opened = true
      resolve(bus)
    }
    ws.onclose = () => (opened ? bus.ondown() : reject(new Error('hub recusou o painel')))
    ws.onmessage = (e) => {
      const { conn, op, data } = decodeHub(new Uint8Array(e.data as ArrayBuffer))
      const peer = String(conn)
      if (op === HubOp.open) bus.onopen(peer)
      else if (op === HubOp.close) bus.onpeerclose(peer)
      else bus.onframe(peer, data)
    }
  })
}

export function connectRtcBus(code: string): Promise<Bus> {
  return new Promise((resolve, reject) => {
    const signal = new WebSocket(signalUrl(code))
    const peers = new Map<string, { pc: RTCPeerConnection; pipe?: DataPipe }>()
    const bus: Bus = {
      kind: 'rtc',
      send: (peer, frame) => {
        const pipe = peers.get(peer)?.pipe
        if (!pipe) return false
        pipe.send(frame)
        return true
      },
      buffered: (peer) => peers.get(peer)?.pipe?.buffered() ?? 0,
      drop: (peer) => peers.get(peer)?.pc.close(),
      close: () => {
        signal.close()
        for (const p of peers.values()) p.pc.close()
      },
      onopen: () => {},
      onframe: () => {},
      onpeerclose: () => {},
      ondown: () => {},
    }
    let settled = false
    signal.onopen = () => signal.send(JSON.stringify({ t: 'create', code }))
    signal.onerror = () => {
      if (!settled) reject(new Error('sem sinalização'))
    }
    signal.onmessage = async (e) => {
      const msg = JSON.parse(e.data as string)
      if (msg.t === 'created') {
        settled = true
        resolve(bus)
      } else if (msg.t === 'taken') {
        // Outra aba do professor já está com esta sala aberta.
        settled = true
        signal.close()
        reject(new Error('sala aberta em outra aba'))
      } else if (msg.t === 'peer') {
        if (peers.size >= MAX_RTC_PEERS) return
        const peer = msg.peer as string
        const pc = new RTCPeerConnection(RTC_CONFIG)
        const entry: { pc: RTCPeerConnection; pipe?: DataPipe } = { pc }
        peers.set(peer, entry)
        let closed = false
        const closeOnce = () => {
          if (closed) return
          closed = true
          peers.delete(peer)
          bus.onpeerclose(peer)
        }
        pc.ondatachannel = ({ channel }) => {
          entry.pipe = new DataPipe(channel, (frame) => bus.onframe(peer, frame))
          channel.onopen = () => bus.onopen(peer)
          channel.onclose = closeOnce
          if (channel.readyState === 'open') bus.onopen(peer)
        }
        pc.onconnectionstatechange = () => pc.connectionState === 'failed' && closeOnce()
        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp })
        await pc.setLocalDescription(await pc.createAnswer())
        await waitIce(pc)
        signal.send(JSON.stringify({ t: 'answer', to: peer, sdp: pc.localDescription!.sdp }))
      }
    }
    // A queda da sinalização é esperada: é o corte da rede. As conexões já feitas continuam.
    signal.onclose = () => {
      if (!settled) reject(new Error('sem sinalização'))
    }
  })
}

// O programa só entrega o token para uma página do Oblita na própria máquina do professor.
export async function detectHub(): Promise<{ token: string; addresses: string[]; site?: string[] } | null> {
  try {
    const init: RequestInit & { targetAddressSpace?: string } = { signal: AbortSignal.timeout(1500), cache: 'no-store', targetAddressSpace: 'loopback' }
    if (servedByHost()) delete init.targetAddressSpace
    const res = await fetch(`${hubUrls('localhost', HUB_PORT).http}/host-token`, init)
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}
