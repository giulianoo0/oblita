// Faz o papel do professor e da rede: semeia o documento e repassa updates entre dois iframes.
// Cada iframe tem o próprio Monaco e a própria sessão, como dois computadores.
import { ExamDoc } from '../../src/collab/examDoc'
import { defaultStarter } from '../../shared/exam'

type Peer = { applyDoc(u: Uint8Array): void; applyAware(u: Uint8Array): void }
const frame = (id: string) => document.getElementById(id) as HTMLIFrameElement
const peer = (id: string) => (frame(id).contentWindow as unknown as { __t: Peer }).__t

let paused = false
let queue: (() => void)[] = []
const deliver = (fn: () => void) => {
  if (paused) queue.push(fn)
  else queueMicrotask(fn)
}

export const STARTERS = {
  q1: 'int main() {\n    return 0;\n}\n',
  q3: 'int main() {\r\n    return 0;\r\n}\r\n',
}

function seed() {
  const teacher = new ExamDoc()
  teacher.seed('q1', 'cpp', 'main.cpp', STARTERS.q1)
  teacher.seed('q2', 'cpp', 'main.cpp', defaultStarter('cpp'))
  teacher.seed('q3', 'cpp', 'main.cpp', STARTERS.q3)
  return teacher.encodeState()
}

const host = {
  STARTERS,
  doc(from: string, update: Uint8Array) {
    const copy = new Uint8Array(update)
    deliver(() => peer(from === 'a' ? 'b' : 'a').applyDoc(copy))
  },
  aware(from: string, update: Uint8Array) {
    const copy = new Uint8Array(update)
    deliver(() => peer(from === 'a' ? 'b' : 'a').applyAware(copy))
  },
  pause() {
    paused = true
  },
  resume() {
    paused = false
    const waiting = queue
    queue = []
    waiting.forEach((fn) => fn())
  },
  seed() {
    const state = seed()
    peer('a').applyDoc(state)
    peer('b').applyDoc(state)
  },
  ready: false,
}
// O nome hostil entra só no teste dele (run.mjs): nas outras telas o colega tem um nome comum.
const HOSTILE = '"};body{display:none}/*'
Object.assign(window, { __host: Object.assign(host, { HOSTILE }) })

frame('a').src = '/tests/collab/peer.html?id=a&name=Ana'
frame('b').src = '/tests/collab/peer.html?id=b&name=Bruno'

let loaded = 0
for (const id of ['a', 'b']) {
  frame(id).addEventListener('load', () => {
    const wait = setInterval(() => {
      if (!peer(id)) return
      clearInterval(wait)
      if (++loaded === 2) {
        host.seed()
        host.ready = true
      }
    }, 50)
  })
}
