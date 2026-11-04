// Sinalização do modo "só navegador": troca as ofertas WebRTC enquanto ainda há internet.
// Depois do aperto de mão, nada mais passa por aqui. A prova e as respostas nunca passam.
import { Elysia, t } from 'elysia'

interface Sock {
  id: string
  send(data: string): unknown
  close(): unknown
}

interface Room {
  host: Sock
  peers: Map<string, Sock>
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const MAX_SIGNAL_BYTES = 16 * 1024

function makeCode(rooms: Map<string, Room>): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(6))
    const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
    if (!rooms.has(code)) return code
  }
}

export function createSignal() {
  const rooms = new Map<string, Room>()
  const roleOf = new Map<string, { code: string; peer?: string }>()

  return new Elysia().ws('/signal', {
    body: t.Object({
      t: t.String(),
      code: t.Optional(t.String()),
      to: t.Optional(t.String()),
      sdp: t.Optional(t.String({ maxLength: MAX_SIGNAL_BYTES })),
    }),
    message(ws, msg) {
      const sock = ws as unknown as Sock
      const send = (s: Sock, m: unknown) => s.send(JSON.stringify(m))
      if (msg.t === 'create') {
        const wanted = msg.code?.toUpperCase()
        if (wanted && rooms.has(wanted)) return send(sock, { t: 'taken' })
        const code = wanted ?? makeCode(rooms)
        rooms.set(code, { host: sock, peers: new Map() })
        roleOf.set(sock.id, { code })
        return send(sock, { t: 'created', code })
      }
      if (msg.t === 'join') {
        const code = msg.code?.toUpperCase() ?? ''
        const room = rooms.get(code)
        if (!room) return send(sock, { t: 'no-room' })
        room.peers.set(sock.id, sock)
        roleOf.set(sock.id, { code, peer: sock.id })
        return send(room.host, { t: 'peer', peer: sock.id, sdp: msg.sdp })
      }
      if (msg.t === 'answer') {
        const role = roleOf.get(sock.id)
        const room = role && rooms.get(role.code)
        const peer = room?.host.id === sock.id && msg.to ? room.peers.get(msg.to) : undefined
        if (peer) send(peer, { t: 'answer', sdp: msg.sdp })
      }
    },
    close(ws) {
      const sock = ws as unknown as Sock
      const role = roleOf.get(sock.id)
      roleOf.delete(sock.id)
      if (!role) return
      const room = rooms.get(role.code)
      if (!room) return
      if (room.host.id === sock.id) rooms.delete(role.code)
      else room.peers.delete(sock.id)
    },
  })
}
