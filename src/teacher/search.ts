// Busca do painel: sem acento e sem maiúscula, palavra por palavra.

const strip = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

export const normalize = strip

export const words = (query: string) => strip(query).split(/\s+/).filter(Boolean)

// O campo de busca manda cada letra em transição, e o valor volta atrasado ou pulando passos. Valor
// que ele mesmo mandou é eco e não mexe no que já está digitado; outro valor veio de fora (limpar).
export function settleEcho(pending: string[], value: string) {
  const i = pending.indexOf(value)
  if (i === -1) return { pending: [], external: true }
  return { pending: pending.slice(i + 1), external: false }
}

export interface Piece {
  text: string
  hit: boolean
}

// Cada letra do texto normalizado aponta para o pedaço do original de onde veio. Acento solto
// (forma decomposta) some na normalização e fica grudado na letra de antes.
function mapped(text: string) {
  let norm = ''
  const from: number[] = []
  const to: number[] = []
  let i = 0
  for (const ch of text) {
    const n = strip(ch)
    if (n) {
      for (let k = 0; k < n.length; k++) {
        from.push(i)
        to.push(i + ch.length)
      }
      norm += n
    } else {
      for (let k = to.length - 1; k >= 0 && to[k] === i; k--) to[k] = i + ch.length
    }
    i += ch.length
  }
  return { norm, from, to }
}

export function highlight(text: string, query: string): Piece[] {
  const ws = words(query)
  if (!ws.length) return [{ text, hit: false }]
  const { norm, from, to } = mapped(text)
  const marked = new Array<boolean>(norm.length).fill(false)
  for (const w of ws) {
    for (let at = norm.indexOf(w); at !== -1; at = norm.indexOf(w, at + 1)) marked.fill(true, at, at + w.length)
  }
  const pieces: Piece[] = []
  const push = (start: number, end: number, hit: boolean) => {
    if (start >= end) return
    const last = pieces[pieces.length - 1]
    if (last && last.hit === hit) last.text += text.slice(start, end)
    else pieces.push({ text: text.slice(start, end), hit })
  }
  let cursor = 0
  for (let k = 0; k < norm.length; ) {
    if (!marked[k]) {
      k++
      continue
    }
    let end = k
    while (end + 1 < norm.length && marked[end + 1]) end++
    push(cursor, from[k], false)
    push(from[k], to[end], true)
    cursor = to[end]
    k = end + 1
  }
  push(cursor, text.length, false)
  return pieces
}
