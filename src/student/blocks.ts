// Os blocos da tela da prova como dado puro: uma árvore de linhas e colunas com pesos.
// Toda operação devolve um layout novo e normalizado, com cada bloco exatamente uma vez,
// e devolve o mesmo objeto quando não muda nada (o React não redesenha à toa).

export type Dir = 'row' | 'col'
export type Side = 'left' | 'right' | 'top' | 'bottom'
export type Zone = Side | 'center'
export type Node = { type: 'block'; id: string } | { type: 'split'; dir: Dir; items: Item[] }
export type Item = { node: Node; w: number }
type Split = Extract<Node, { type: 'split' }>
export type Layout = { v: typeof LAYOUT_VERSION; root: Node; collapsed: string[] }

export type Rect = { x: number; y: number; w: number; h: number }
export type BlockRect = Rect & { collapsed: boolean; strip?: 'v' | 'h' }
export type Limits = Record<string, { min?: [number, number]; max?: [number, number] }>
export type RectSpec = { gap: number; strip: number; limits?: Limits }
export type Divider = { path: number[]; index: number; dir: Dir; rect: Rect; active: boolean; a: number; b: number; minA: number; maxA: number; minB: number; maxB: number }
export type Rects = { blocks: Record<string, BlockRect>; dividers: Divider[]; spec: RectSpec }
export type Drop = { target: string | null; zone: Zone; preview: Rect }
export type LayoutStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export const LAYOUT_VERSION = 1
const MAX_DEPTH = 8
const MAX_ITEMS = 16
const DEFAULT_MIN = 80
// A faixa da borda da área inteira, em px, que mira "de ponta a ponta".
const ROOT_EDGE = 14
// Quanto da borda de um bloco mira aquele lado; o miolo troca de lugar.
const EDGE_SHARE = 0.3

const axisOf = (side: Side): Dir => (side === 'left' || side === 'right' ? 'row' : 'col')
const before = (side: Side) => side === 'left' || side === 'top'
const clone = <T,>(value: T): T => structuredClone(value)

export function blockIds(layout: Layout): string[] {
  const out: string[] = []
  const walk = (node: Node) => (node.type === 'block' ? out.push(node.id) : node.items.forEach((i) => walk(i.node)))
  walk(layout.root)
  return out
}

// Divisão de um filho só vira o filho; divisão dentro de outra na mesma direção se espalha nela.
// Os pesos de cada divisão somam 1.
function normalizeNode(node: Node): Node {
  if (node.type === 'block') return node
  const items: Item[] = []
  for (const item of node.items) {
    const child = normalizeNode(item.node)
    if (child.type === 'split' && child.dir === node.dir) {
      const sum = child.items.reduce((s, i) => s + i.w, 0)
      for (const inner of child.items) items.push({ node: inner.node, w: (item.w * inner.w) / sum })
    } else items.push({ node: child, w: item.w })
  }
  if (items.length === 1) return items[0].node
  const sum = items.reduce((s, i) => s + i.w, 0)
  // Já somando 1, fica como está: normalizar de novo não pode mexer nos pesos.
  if (Math.abs(sum - 1) < 1e-9) return { type: 'split', dir: node.dir, items }
  return { type: 'split', dir: node.dir, items: items.map((i) => ({ node: i.node, w: i.w / sum })) }
}

function finish(layout: Layout, root: Node): Layout {
  return { v: LAYOUT_VERSION, root: normalizeNode(root), collapsed: layout.collapsed }
}

const same = (a: Layout, b: Layout) => JSON.stringify(a) === JSON.stringify(b)

// --- recolher

export function canCollapse(layout: Layout, id: string) {
  const ids = blockIds(layout)
  if (!ids.includes(id) || layout.collapsed.includes(id)) return false
  return ids.filter((x) => !layout.collapsed.includes(x)).length > 1
}

export function toggleCollapse(layout: Layout, id: string): Layout {
  if (layout.collapsed.includes(id)) return { ...layout, collapsed: layout.collapsed.filter((x) => x !== id) }
  if (!canCollapse(layout, id)) return layout
  return { ...layout, collapsed: [...layout.collapsed, id] }
}

// --- mover

// Localiza a folha e a divisão em que ela está, numa cópia que pode ser alterada.
function findLeaf(root: Node, id: string, parent: Split | null = null): { leaf: Node; parent: Split | null } | null {
  if (root.type === 'block') return root.id === id ? { leaf: root, parent } : null
  for (const item of root.items) {
    const found = findLeaf(item.node, id, root)
    if (found) return found
  }
  return null
}

// Tira a folha da cópia sem normalizar, para as referências aos outros nós continuarem valendo.
// Devolve a raiz nova (a própria raiz some se for a folha) ou null se a folha era tudo.
function detach(root: Node, leaf: Node): Node | null {
  if (root === leaf) return null
  const prune = (node: Node): boolean => {
    if (node.type === 'block') return node === leaf
    const index = node.items.findIndex((i) => i.node === leaf)
    if (index >= 0) {
      node.items.splice(index, 1)
      return false
    }
    node.items.forEach((i) => prune(i.node))
    return false
  }
  prune(root)
  return root
}

// Divisão vazia fica para o normalize; uma de um filho só também. Só a divisão com o nó alvo importa aqui.
function parentOf(root: Node, target: Node): Split | null {
  if (root.type === 'block') return null
  for (const item of root.items) {
    if (item.node === target) return root
    const found = parentOf(item.node, target)
    if (found) return found
  }
  return null
}

// Põe a folha ao lado do alvo: como irmã se a divisão do alvo já tem essa direção, senão numa divisão nova no lugar dele.
function placeNextTo(root: Node, target: Node, leaf: Node, side: Side): Node {
  const dir = axisOf(side)
  const parent = parentOf(root, target)
  if (parent && parent.dir === dir) {
    const index = parent.items.findIndex((i) => i.node === target)
    const half = parent.items[index].w / 2
    parent.items[index].w = half
    parent.items.splice(before(side) ? index : index + 1, 0, { node: leaf, w: half })
    return root
  }
  const pair: Split = { type: 'split', dir, items: before(side) ? [{ node: leaf, w: 1 }, { node: target, w: 1 }] : [{ node: target, w: 1 }, { node: leaf, w: 1 }] }
  if (!parent) return pair
  const index = parent.items.findIndex((i) => i.node === target)
  parent.items[index].node = pair
  return root
}

// De ponta a ponta: a folha vira uma faixa inteira na borda da área.
function placeAtEdge(root: Node, leaf: Node, side: Side): Node {
  const items: Item[] = before(side) ? [{ node: leaf, w: 0.3 }, { node: root, w: 0.7 }] : [{ node: root, w: 0.7 }, { node: leaf, w: 0.3 }]
  return { type: 'split', dir: axisOf(side), items }
}

export function swapBlocks(layout: Layout, a: string, b: string): Layout {
  if (a === b) return layout
  const ids = blockIds(layout)
  if (!ids.includes(a) || !ids.includes(b)) return layout
  const root = clone(layout.root)
  const la = findLeaf(root, a)!.leaf as { id: string }
  const lb = findLeaf(root, b)!.leaf as { id: string }
  la.id = b
  lb.id = a
  return finish(layout, root)
}

// `target` null é a área inteira. `center` troca de lugar com o alvo.
export function moveBlock(layout: Layout, id: string, target: string | null, zone: Zone): Layout {
  if (zone === 'center') return target === null ? layout : swapBlocks(layout, id, target)
  if (id === target) return layout
  const ids = blockIds(layout)
  if (!ids.includes(id) || (target !== null && !ids.includes(target))) return layout
  const root = clone(layout.root)
  const { leaf, parent } = findLeaf(root, id)!
  // Já está bem desse lado do alvo, na mesma divisão: nada muda.
  if (target !== null && parent?.dir === axisOf(zone)) {
    const at = parent.items.findIndex((i) => i.node === leaf)
    const neighbor = parent.items[at + (before(zone) ? 1 : -1)]?.node
    if (neighbor?.type === 'block' && neighbor.id === target) return layout
  }
  const rest = normalizeNode(detach(root, leaf)!)
  const next = target === null ? placeAtEdge(rest, leaf, zone) : placeNextTo(rest, findLeaf(rest, target)!.leaf, leaf, zone)
  const out = finish(layout, next)
  return same(out, layout) ? layout : out
}

// "Mover para a esquerda" pelo teclado: troca com o vizinho daquele lado na mesma divisão;
// na ponta, passa para o lado do vizinho numa divisão de cima; na ponta da área, vai de ponta a ponta.
export function nudge(layout: Layout, id: string, side: Side): Layout {
  if (!blockIds(layout).includes(id)) return layout
  const dir = axisOf(side)
  const step = before(side) ? -1 : 1
  const root = clone(layout.root)
  const leaf = findLeaf(root, id)!.leaf
  // Caminho da raiz até a folha, com o índice do ramo em cada divisão.
  const chain: { split: Split; index: number }[] = []
  const walk = (node: Node): boolean => {
    if (node === leaf) return true
    if (node.type === 'block') return false
    for (let i = 0; i < node.items.length; i++) {
      chain.push({ split: node, index: i })
      if (walk(node.items[i].node)) return true
      chain.pop()
    }
    return false
  }
  walk(root)
  for (let k = chain.length - 1; k >= 0; k--) {
    const { split, index } = chain[k]
    const to = index + step
    if (split.dir !== dir || to < 0 || to >= split.items.length) continue
    if (k === chain.length - 1) {
      // Vizinho direto: só troca a ordem, cada um com o seu peso.
      ;[split.items[index], split.items[to]] = [split.items[to], split.items[index]]
      return finish(layout, root)
    }
    detach(root, leaf)
    const half = split.items[to].w / 2
    split.items[to].w = half
    split.items.splice(step < 0 ? to + 1 : to, 0, { node: leaf, w: half })
    return finish(layout, root)
  }
  if (root.type === 'split' && root.dir === dir && root.items[step < 0 ? 0 : root.items.length - 1].node === leaf) return layout
  const rest = normalizeNode(detach(root, leaf)!)
  const out = finish(layout, placeAtEdge(rest, leaf, side))
  return same(out, layout) ? layout : out
}

// --- redimensionar

function splitAt(root: Node, path: number[]): Split | null {
  let node = root
  for (const k of path) {
    if (node.type !== 'split' || !node.items[k]) return null
    node = node.items[k].node
  }
  return node.type === 'split' ? node : null
}

// `fraction` é quanto do par fica com o primeiro dos dois.
export function resizePair(layout: Layout, path: number[], index: number, fraction: number): Layout {
  const root = clone(layout.root)
  const split = splitAt(root, path)
  if (!split || index < 0 || index + 1 >= split.items.length || !Number.isFinite(fraction)) return layout
  const f = Math.min(Math.max(fraction, 0.01), 0.99)
  const total = split.items[index].w + split.items[index + 1].w
  split.items[index].w = total * f
  split.items[index + 1].w = total * (1 - f)
  return finish(layout, root)
}

const leafSet = (node: Node): string => {
  const ids: string[] = []
  const walk = (n: Node) => (n.type === 'block' ? ids.push(n.id) : n.items.forEach((i) => walk(i.node)))
  walk(node)
  return ids.sort().join(',')
}

function findSimilar(node: Node, like: Split): Split | null {
  if (node.type === 'block') return null
  const sig = (s: Split) => s.dir + ':' + s.items.map((i) => leafSet(i.node)).join('|')
  if (sig(node) === sig(like)) return node
  for (const item of node.items) {
    const found = findSimilar(item.node, like)
    if (found) return found
  }
  return null
}

// Duplo clique na divisória: o par volta à proporção do padrão, se essa divisão existir nele; senão, meio a meio.
export function resetPair(layout: Layout, path: number[], index: number, defaults: Layout): Layout {
  const split = splitAt(layout.root, path)
  if (!split || index < 0 || index + 1 >= split.items.length) return layout
  const twin = findSimilar(defaults.root, split)
  const fraction = twin ? twin.items[index].w / (twin.items[index].w + twin.items[index + 1].w) : 0.5
  return resizePair(layout, path, index, fraction)
}

// --- geometria

const isCollapsed = (node: Node, collapsed: Set<string>): boolean => (node.type === 'block' ? collapsed.has(node.id) : node.items.every((i) => isCollapsed(i.node, collapsed)))

function extent(node: Node, dir: Dir, kind: 'min' | 'max', ctx: { collapsed: Set<string>; spec: RectSpec }): number {
  const axis = dir === 'row' ? 0 : 1
  if (node.type === 'block') {
    if (ctx.collapsed.has(node.id)) return ctx.spec.strip
    const limit = ctx.spec.limits?.[node.id]?.[kind]?.[axis]
    return limit ?? (kind === 'min' ? DEFAULT_MIN : Infinity)
  }
  const parts = node.items.map((i) => extent(i.node, dir, kind, ctx))
  if (node.dir !== dir) return kind === 'min' ? Math.max(...parts) : Math.min(...parts)
  return parts.reduce((s, x) => s + x, 0) + ctx.spec.gap * (node.items.length - 1)
}

export function computeRects(layout: Layout, width: number, height: number, spec: RectSpec): Rects {
  const ctx = { collapsed: new Set(layout.collapsed), spec }
  const blocks: Record<string, BlockRect> = {}
  const dividers: Divider[] = []
  const place = (node: Node, rect: Rect, path: number[]) => {
    if (node.type === 'block') {
      const collapsed = ctx.collapsed.has(node.id)
      blocks[node.id] = collapsed ? { ...rect, collapsed, strip: rect.w < rect.h ? 'v' : 'h' } : { ...rect, collapsed }
      return
    }
    const row = node.dir === 'row'
    const length = row ? rect.w : rect.h
    const gaps = spec.gap * (node.items.length - 1)
    const fixed = node.items.map((i) => isCollapsed(i.node, ctx.collapsed))
    // Tudo recolhido aqui dentro: a divisão é uma faixa, e os recolhidos dividem o comprimento dela.
    const flex = fixed.some((f) => !f) ? fixed.map((f) => !f) : fixed.map(() => true)
    const fixedSize = node.items.reduce((s, i, k) => s + (flex[k] ? 0 : extent(i.node, node.dir, 'min', ctx)), 0)
    const weight = node.items.reduce((s, i, k) => s + (flex[k] ? i.w : 0), 0)
    const free = Math.max(0, length - gaps - fixedSize)
    const sizes = node.items.map((i, k) => (flex[k] ? (free * i.w) / weight : extent(i.node, node.dir, 'min', ctx)))
    let at = row ? rect.x : rect.y
    node.items.forEach((item, k) => {
      const size = sizes[k]
      place(item.node, row ? { x: at, y: rect.y, w: size, h: rect.h } : { x: rect.x, y: at, w: rect.w, h: size }, [...path, k])
      at += size
      if (k === node.items.length - 1) return
      const next = node.items[k + 1].node
      dividers.push({
        path,
        index: k,
        dir: node.dir,
        rect: row ? { x: at, y: rect.y, w: spec.gap, h: rect.h } : { x: rect.x, y: at, w: rect.w, h: spec.gap },
        active: flex[k] && flex[k + 1] && !fixed[k] && !fixed[k + 1],
        a: size,
        b: sizes[k + 1],
        minA: extent(item.node, node.dir, 'min', ctx),
        maxA: extent(item.node, node.dir, 'max', ctx),
        minB: extent(next, node.dir, 'min', ctx),
        maxB: extent(next, node.dir, 'max', ctx),
      })
      at += spec.gap
    })
  }
  place(layout.root, { x: 0, y: 0, w: width, h: height }, [])
  return { blocks, dividers, spec }
}

// Quanto do par fica com o primeiro depois de arrastar `delta` px, dentro dos limites dos dois.
export function dividerFraction(d: Divider, delta: number): number {
  const total = d.a + d.b
  if (total <= 0) return 0.5
  const low = Math.max(d.minA, total - d.maxB)
  const high = Math.min(d.maxA, total - d.minB)
  const a = low > high ? d.a : Math.min(Math.max(d.a + delta, low), high)
  return a / total
}

// O destino de um bloco arrastado até (x, y), com a prévia exata de onde ele vai ficar.
// Sem destino quando o ponto está fora, sobre o próprio bloco, ou quando soltar não mudaria nada.
export function dropAt(layout: Layout, rects: Rects, width: number, height: number, dragged: string, x: number, y: number): Drop | null {
  if (!(x >= 0 && y >= 0 && x <= width && y <= height) || !rects.blocks[dragged]) return null
  const result = (target: string | null, zone: Zone): Drop | null => {
    const next = moveBlock(layout, dragged, target, zone)
    if (next === layout) return null
    const preview = zone === 'center' && target ? rects.blocks[target] : computeRects(next, width, height, rects.spec).blocks[dragged]
    return { target, zone, preview: { x: preview.x, y: preview.y, w: preview.w, h: preview.h } }
  }
  const edges: [Side, number][] = [
    ['left', x],
    ['right', width - x],
    ['top', y],
    ['bottom', height - y],
  ]
  const nearest = edges.reduce((a, b) => (b[1] < a[1] ? b : a))
  if (nearest[1] <= ROOT_EDGE) return result(null, nearest[0])
  for (const [id, r] of Object.entries(rects.blocks)) {
    if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue
    if (id === dragged) return null
    const fx = (x - r.x) / r.w
    const fy = (y - r.y) / r.h
    const sides: [Side, number][] = [
      ['left', fx],
      ['right', 1 - fx],
      ['top', fy],
      ['bottom', 1 - fy],
    ]
    const side = sides.reduce((a, b) => (b[1] < a[1] ? b : a))
    return result(id, side[1] < EDGE_SHARE ? side[0] : 'center')
  }
  return null
}

// --- salvo

// Confere tudo de um layout que veio de fora: estrutura, pesos, cada bloco uma vez e só os que existem.
export function validate(raw: unknown, ids: string[]): Layout | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  if (data.v !== LAYOUT_VERSION || !Array.isArray(data.collapsed)) return null
  const seen = new Set<string>()
  const wanted = new Set(ids)
  const read = (value: unknown, depth: number): Node | null => {
    if (depth > MAX_DEPTH || !value || typeof value !== 'object') return null
    const n = value as Record<string, unknown>
    if (n.type === 'block') {
      if (typeof n.id !== 'string' || !wanted.has(n.id) || seen.has(n.id)) return null
      seen.add(n.id)
      return { type: 'block', id: n.id }
    }
    if (n.type !== 'split' || (n.dir !== 'row' && n.dir !== 'col') || !Array.isArray(n.items)) return null
    if (n.items.length < 1 || n.items.length > MAX_ITEMS) return null
    const items: Item[] = []
    for (const it of n.items as unknown[]) {
      if (!it || typeof it !== 'object') return null
      const { node, w } = it as Record<string, unknown>
      if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) return null
      const child = read(node, depth + 1)
      if (!child) return null
      items.push({ node: child, w })
    }
    return { type: 'split', dir: n.dir, items }
  }
  const root = read(data.root, 0)
  if (!root || seen.size !== wanted.size) return null
  const collapsed = data.collapsed as unknown[]
  if (!collapsed.every((c): c is string => typeof c === 'string' && wanted.has(c)) || new Set(collapsed).size !== collapsed.length) return null
  if (collapsed.length >= ids.length) return null
  return { v: LAYOUT_VERSION, root: normalizeNode(root), collapsed }
}

export function loadLayout(storage: LayoutStorage | null, key: string, ids: string[], fallback: Layout): Layout {
  try {
    const text = storage?.getItem(key)
    if (!text) return fallback
    return validate(JSON.parse(text), ids) ?? fallback
  } catch {
    return fallback
  }
}

export function saveLayout(storage: LayoutStorage | null, key: string, layout: Layout | null) {
  try {
    if (!storage) return
    if (layout) storage.setItem(key, JSON.stringify(layout))
    else storage.removeItem(key)
  } catch {
    // Sem espaço ou sem permissão: o layout só não fica guardado.
  }
}
