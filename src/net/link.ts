// Lado do aluno: uma conexão com o professor, seja pelo IP ou por WebRTC.
import { FRONT_PORT, HUB_PORT } from '../../shared/protocol'
import { DataPipe, RTC_CONFIG, signalUrl, waitIce } from './rtc'

export interface Link {
  kind: 'hub' | 'rtc'
  send(frame: Uint8Array): void
  buffered(): number
  close(): void
  onframe: (frame: Uint8Array) => void
  onclose: () => void
}

export type ConnectError = 'bad-address' | 'permission' | 'unreachable' | 'no-host' | 'no-room' | 'no-signal' | 'lan-failed'

export class LinkError extends Error {
  constructor(readonly code: ConnectError) {
    super(code)
  }
}

// Página aberta pelo programa, na porta do site: o hub é a própria origem, sem IP para digitar
// e sem permissão de rede local.
export const servedByHost = () => typeof location !== 'undefined' && location.port === String(FRONT_PORT)

// Só o computador do professor recebe o token do painel.
export const onTeacherMachine = () => location.hostname === 'localhost' || location.hostname === '127.0.0.1'

export function hubUrls(host: string, port: number) {
  if (!servedByHost()) return { http: `http://${host}:${port}`, ws: `ws://${host}:${port}` }
  return { http: location.origin, ws: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}` }
}

export function parseAddress(input: string): { host: string; port: number } | null {
  const raw = input.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  const m = raw.match(/^([a-z0-9.-]+)(?::(\d{1,5}))?$/i)
  if (!m) return null
  const port = m[2] ? Number(m[2]) : HUB_PORT
  if (port < 1 || port > 65535) return null
  return { host: m[1], port }
}

export function addressSpace(host: string): 'local' | 'loopback' | undefined {
  if (host === 'localhost' || host.startsWith('127.')) return 'loopback'
  if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.endsWith('.local')) return 'local'
  return undefined
}

// O fetch com targetAddressSpace libera http a partir de https e dispara a permissão de rede local.
export async function pingHub(host: string, port: number, timeoutMs = 5000) {
  const init: RequestInit & { targetAddressSpace?: string } = { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' }
  const space = addressSpace(host)
  if (space && !servedByHost()) init.targetAddressSpace = space
  const res = await fetch(`${hubUrls(host, port).http}/ping`, init)
  const body = (await res.json()) as { app?: string; host?: boolean }
  if (body.app !== 'oblita') throw new LinkError('unreachable')
  return body
}

async function permissionDenied(host: string): Promise<boolean> {
  const space = addressSpace(host)
  if (!space) return false
  for (const name of [space === 'local' ? 'local-network' : 'loopback-network', 'local-network-access']) {
    try {
      const status = await navigator.permissions.query({ name: name as PermissionName })
      return status.state === 'denied'
    } catch {
      continue
    }
  }
  return false
}

export async function connectHub(address: string): Promise<Link> {
  const parsed = parseAddress(address)
  if (!parsed) throw new LinkError('bad-address')
  const { host, port } = parsed
  try {
    const info = await pingHub(host, port)
    if (!info.host) throw new LinkError('no-host')
  } catch (err) {
    if (err instanceof LinkError) throw err
    throw new LinkError((await permissionDenied(host)) ? 'permission' : 'unreachable')
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${hubUrls(host, port).ws}/ws/student`)
    ws.binaryType = 'arraybuffer'
    const link: Link = {
      kind: 'hub',
      send: (frame) => ws.readyState === WebSocket.OPEN && ws.send(frame as Uint8Array<ArrayBuffer>),
      buffered: () => ws.bufferedAmount,
      close: () => ws.close(),
      onframe: () => {},
      onclose: () => {},
    }
    let opened = false
    ws.onopen = () => {
      opened = true
      resolve(link)
    }
    ws.onmessage = (e) => link.onframe(new Uint8Array(e.data as ArrayBuffer))
    ws.onclose = () => (opened ? link.onclose() : reject(new LinkError('unreachable')))
  })
}

export async function connectRtc(code: string): Promise<Link> {
  const pc = new RTCPeerConnection(RTC_CONFIG)
  const dc = pc.createDataChannel('oblita', { ordered: true })
  await pc.setLocalDescription(await pc.createOffer())
  await waitIce(pc)

  const signal = new WebSocket(signalUrl(code))
  const fail = (code: ConnectError) => {
    signal.close()
    pc.close()
    return new LinkError(code)
  }

  return new Promise((resolve, reject) => {
    const giveUp = setTimeout(() => reject(fail('lan-failed')), 15000)
    signal.onerror = () => {
      clearTimeout(giveUp)
      reject(fail('no-signal'))
    }
    signal.onopen = () => signal.send(JSON.stringify({ t: 'join', code, sdp: pc.localDescription!.sdp }))
    signal.onmessage = async (e) => {
      const msg = JSON.parse(e.data as string)
      if (msg.t === 'no-room') {
        clearTimeout(giveUp)
        reject(fail('no-room'))
      } else if (msg.t === 'answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
      }
    }
    const link: Link = {
      kind: 'rtc',
      send: (frame) => pipe.send(frame),
      buffered: () => pipe.buffered(),
      close: () => pc.close(),
      onframe: () => {},
      onclose: () => {},
    }
    const pipe = new DataPipe(dc, (frame) => link.onframe(frame))
    dc.onopen = () => {
      clearTimeout(giveUp)
      signal.close()
      resolve(link)
    }
    let closed = false
    const closeOnce = () => {
      if (closed) return
      closed = true
      link.onclose()
    }
    dc.onclose = closeOnce
    pc.onconnectionstatechange = () => pc.connectionState === 'failed' && closeOnce()
  })
}
