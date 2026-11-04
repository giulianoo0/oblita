// Scripts que entram na página antes de tudo. O único substituto é o getDisplayMedia; o resto só observa.

// No Windows a captura real em headless devolve 'monitor', mas filma a área de trabalho do dono, onde
// a página não aparece. A trilha falsa desenha o selo da própria página, então o caminho dele roda de verdade.
export const displayStub = (useReal) => String.raw`(() => {
  if (window.top !== window) return
  const md = navigator.mediaDevices
  if (!md) return
  const real = md.getDisplayMedia.bind(md)
  const state = (window.__e2e = { surface: 'monitor', useReal: ${useReal}, tracks: [], calls: 0 })
  const fake = () => {
    const canvas = document.createElement('canvas')
    canvas.width = innerWidth
    canvas.height = innerHeight
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const draw = () => {
      const sx = canvas.width / innerWidth
      const sy = canvas.height / innerHeight
      ctx.fillStyle = '#20242c'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = '#9fb3c8'
      ctx.font = '48px sans-serif'
      ctx.fillText('tela de teste', 80, 160)
      ctx.fillText(new Date().toISOString(), 80, 240)
      const seal = document.querySelector('[data-beacon]')
      if (!seal || getComputedStyle(seal).visibility === 'hidden') return
      for (const cell of seal.children) {
        const b = cell.getBoundingClientRect()
        ctx.fillStyle = getComputedStyle(cell).backgroundColor
        ctx.fillRect(Math.round(b.left * sx), Math.round(b.top * sy), Math.ceil(b.width * sx), Math.ceil(b.height * sy))
      }
    }
    draw()
    const timer = setInterval(draw, 100)
    const stream = canvas.captureStream(5)
    stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer))
    return stream
  }
  md.getDisplayMedia = async (options) => {
    state.calls++
    state.lastOptions = options
    const stream = state.useReal ? await real(options) : fake()
    const track = stream.getVideoTracks()[0]
    const settings = track.getSettings.bind(track)
    const surface = state.surface
    if (!state.useReal || surface !== 'monitor') track.getSettings = () => ({ ...settings(), displaySurface: surface })
    state.tracks.push(track)
    return stream
  }
  // A barra "parar de compartilhar" é do navegador e não existe em headless: o evento é o que ela causaria.
  state.stopShare = () => {
    for (const track of state.tracks.splice(0)) {
      track.stop()
      track.dispatchEvent(new Event('ended'))
    }
  }
})()`

// Tudo o que o aluno decifra passa por aqui, para procurar gabarito no que chegou de fato.
export const DECRYPT_TAP = String.raw`(() => {
  if (window.top !== window) return
  const proto = SubtleCrypto.prototype
  const decrypt = proto.decrypt
  const text = new TextDecoder('utf-8', { fatal: false })
  proto.decrypt = async function (...args) {
    const plain = await decrypt.apply(this, args)
    try {
      if (plain.byteLength < 2_000_000) window.__e2eFrame?.(text.decode(plain))
    } catch {}
    return plain
  }
})()`

// O bipe sai sem nenhum sinal na tela: conta os osciladores criados.
export const BEEP_SPY = String.raw`(() => {
  if (window.top !== window) return
  window.__e2eBeeps = 0
  const make = AudioContext.prototype.createOscillator
  AudioContext.prototype.createOscillator = function () {
    window.__e2eBeeps++
    return make.call(this)
  }
})()`

// A porta do programa é fixa no código. Quando outra cópia está nela, o painel vai para a porta do teste.
export const hubPortShim = (port) => String.raw`(() => {
  const swap = (u) => String(u).replace('localhost:7787', 'localhost:${port}')
  const f = window.fetch
  window.fetch = (u, init) => f.call(window, typeof u === 'string' ? swap(u) : u, init)
  const W = window.WebSocket
  window.WebSocket = class extends W {
    constructor(u, p) {
      super(swap(u), p)
    }
  }
})()`

// Procura os marcadores em tudo o que a página guarda. Blob vira texto para achar também em gravações.
export const searchStorage = (markers) => String.raw`(async () => {
  const markers = ${JSON.stringify(markers)}
  const hits = []
  const scan = (where, text) => {
    for (const m of markers) if (text.includes(m)) hits.push({ where, marker: m })
  }
  const flat = async (v) => {
    if (v instanceof Blob) return v.size < 4e6 ? await v.text() : ''
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return new TextDecoder().decode(v)
    if (typeof v === 'string') return v
    return JSON.stringify(v, (_, x) => (x instanceof ArrayBuffer || ArrayBuffer.isView(x) ? '[bytes]' : x instanceof Blob ? '[blob]' : x)) ?? ''
  }
  let records = 0
  for (const { name } of await indexedDB.databases()) {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(name)
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    for (const store of db.objectStoreNames) {
      const all = await new Promise((res, rej) => {
        const r = db.transaction(store).objectStore(store).getAll()
        r.onsuccess = () => res(r.result)
        r.onerror = () => rej(r.error)
      })
      for (const v of all) {
        records++
        scan('idb:' + name + '/' + store, await flat(v))
      }
    }
    db.close()
  }
  scan('localStorage', JSON.stringify({ ...localStorage }))
  scan('sessionStorage', JSON.stringify({ ...sessionStorage }))
  scan('dom', document.documentElement.outerHTML)
  return { hits, records }
})()`

// Faixa com o passo atual, fora do body para não entrar nos textos que o teste procura.
export const LABEL_SCRIPT = (text) => String.raw`(() => {
  let host = document.getElementById('__e2e-label')
  if (!host) {
    host = document.createElement('div')
    host.id = '__e2e-label'
    host.style.cssText = 'position:fixed;left:50%;bottom:12px;translate:-50% 0;z-index:2147483647;pointer-events:none;font:600 15px system-ui;color:#fff;background:rgb(20 20 30 / 88%);padding:8px 16px;border-radius:999px;max-width:80vw;text-align:center'
    host.attachShadow({ mode: 'open' }).append(document.createElement('span'))
    document.documentElement.append(host)
  }
  host.shadowRoot.firstChild.textContent = ${JSON.stringify(text)}
})()`
