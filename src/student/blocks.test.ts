import { describe, expect, test } from 'bun:test'
import {
  blockIds,
  canCollapse,
  computeRects,
  dividerFraction,
  dropAt,
  loadLayout,
  moveBlock,
  nudge,
  resetPair,
  resizePair,
  saveLayout,
  swapBlocks,
  toggleCollapse,
  validate,
  type Layout,
  type Node,
  type Rect,
  type Zone,
} from './blocks'

const IDS = ['statement', 'editor', 'input', 'output']
const leaf = (id: string): Node => ({ type: 'block', id })

// O padrão da prova de código: enunciado à esquerda; à direita o editor em cima e entrada e terminal embaixo.
const DEFAULT: Layout = {
  v: 1,
  collapsed: [],
  root: {
    type: 'split',
    dir: 'row',
    items: [
      { node: leaf('statement'), w: 0.27 },
      {
        node: {
          type: 'split',
          dir: 'col',
          items: [
            { node: leaf('editor'), w: 0.7 },
            { node: { type: 'split', dir: 'row', items: [{ node: leaf('input'), w: 0.3 }, { node: leaf('output'), w: 0.7 }] }, w: 0.3 },
          ],
        },
        w: 0.73,
      },
    ],
  },
}

const SPEC = { gap: 8, strip: 40 }
const W = 1200
const H = 800

function shape(node: Node): unknown {
  return node.type === 'block' ? node.id : { [node.dir]: node.items.map((i) => shape(i.node)) }
}

function overlap(a: Rect, b: Rect) {
  const x = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const y = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return x > 0.5 && y > 0.5
}

// Árvore normalizada: nenhuma divisão de um filho só, nenhuma divisão dentro de outra na mesma direção.
function normalized(node: Node, parentDir?: string): boolean {
  if (node.type === 'block') return true
  if (node.items.length < 2 || node.dir === parentDir) return false
  return node.items.every((i) => Number.isFinite(i.w) && i.w > 0 && normalized(i.node, node.dir))
}

describe('recolher', () => {
  test('recolhe e abre de novo', () => {
    const closed = toggleCollapse(DEFAULT, 'statement')
    expect(closed.collapsed).toEqual(['statement'])
    expect(toggleCollapse(closed, 'statement').collapsed).toEqual([])
  })

  test('o último bloco aberto não recolhe', () => {
    let l = DEFAULT
    for (const id of ['statement', 'input', 'output']) l = toggleCollapse(l, id)
    expect(canCollapse(l, 'editor')).toBe(false)
    expect(toggleCollapse(l, 'editor')).toBe(l)
  })

  test('recolhido vira faixa: fina na direção da divisão em que está', () => {
    const r = computeRects(toggleCollapse(toggleCollapse(DEFAULT, 'statement'), 'input'), W, H, SPEC)
    expect(r.blocks.statement.w).toBe(40)
    expect(r.blocks.statement.h).toBe(H)
    expect(r.blocks.statement.strip).toBe('v')
    expect(r.blocks.input.w).toBe(40)
    expect(r.blocks.input.strip).toBe('v')
    // O terminal fica com o espaço que a entrada liberou.
    expect(r.blocks.output.w).toBeCloseTo(W - 40 - 8 - 40 - 8, 5)
  })

  test('divisão com tudo recolhido vira uma faixa só, e a vizinha ocupa o resto', () => {
    const l = toggleCollapse(toggleCollapse(DEFAULT, 'input'), 'output')
    const r = computeRects(l, W, H, SPEC)
    expect(r.blocks.input.h).toBe(40)
    expect(r.blocks.output.h).toBe(40)
    expect(r.blocks.editor.h).toBeCloseTo(H - 40 - 8, 5)
  })
})

describe('mover', () => {
  test('soltar embaixo de outro bloco divide a coluna', () => {
    const l = moveBlock(DEFAULT, 'output', 'statement', 'bottom')
    expect(shape(l.root)).toEqual({ row: [{ col: ['statement', 'output'] }, { col: ['editor', 'input'] }] })
  })

  test('soltar ao lado, na mesma direção da divisão, entra como irmão', () => {
    const l = moveBlock(DEFAULT, 'input', 'statement', 'left')
    expect(shape(l.root)).toEqual({ row: ['input', 'statement', { col: ['editor', 'output'] }] })
  })

  test('soltar no meio troca de lugar', () => {
    const l = moveBlock(DEFAULT, 'statement', 'output', 'center')
    expect(shape(l.root)).toEqual({ row: ['output', { col: ['editor', { row: ['input', 'statement'] }] }] })
    expect(swapBlocks(DEFAULT, 'statement', 'output')).toEqual(l)
  })

  test('soltar na borda da área inteira põe o bloco de ponta a ponta', () => {
    const l = moveBlock(DEFAULT, 'output', null, 'bottom')
    expect(shape(l.root)).toEqual({ col: [{ row: ['statement', { col: ['editor', 'input'] }] }, 'output'] })
  })

  test('soltar em si mesmo não muda nada', () => {
    expect(moveBlock(DEFAULT, 'editor', 'editor', 'left')).toBe(DEFAULT)
    expect(swapBlocks(DEFAULT, 'editor', 'editor')).toBe(DEFAULT)
  })

  test('bloco ou alvo que não existem não mudam nada', () => {
    expect(moveBlock(DEFAULT, 'nada', 'editor', 'left')).toBe(DEFAULT)
    expect(moveBlock(DEFAULT, 'editor', 'nada', 'left')).toBe(DEFAULT)
  })

  test('mover não troca os pesos dos outros blocos', () => {
    const l = moveBlock(DEFAULT, 'input', 'output', 'bottom')
    const root = l.root as Extract<Node, { type: 'split' }>
    expect(root.items[0].w).toBeCloseTo(0.27, 5)
  })

  test('recolhido continua recolhido depois de mover', () => {
    const l = moveBlock(toggleCollapse(DEFAULT, 'input'), 'input', 'statement', 'top')
    expect(l.collapsed).toEqual(['input'])
  })
})

describe('mover pelo teclado', () => {
  test('troca com o vizinho do lado na mesma divisão', () => {
    expect(shape(nudge(DEFAULT, 'output', 'left').root)).toEqual({ row: ['statement', { col: ['editor', { row: ['output', 'input'] }] }] })
  })

  test('sobe para a divisão de cima quando está na ponta', () => {
    expect(shape(nudge(DEFAULT, 'input', 'left').root)).toEqual({ row: ['statement', 'input', { col: ['editor', 'output'] }] })
  })

  test('na ponta da área inteira vai de ponta a ponta, e de novo não muda nada', () => {
    const once = nudge(DEFAULT, 'editor', 'bottom')
    expect(shape(once.root)).toEqual({ row: ['statement', { col: [{ row: ['input', 'output'] }, 'editor'] }] })
    const twice = nudge(once, 'editor', 'bottom')
    expect(shape(twice.root)).toEqual({ col: [{ row: ['statement', 'input', 'output'] }, 'editor'] })
    expect(nudge(twice, 'editor', 'bottom')).toBe(twice)
    const right = nudge(DEFAULT, 'output', 'right')
    expect(shape(right.root)).toEqual({ row: ['statement', { col: ['editor', 'input'] }, 'output'] })
    expect(nudge(right, 'output', 'right')).toBe(right)
  })
})

describe('redimensionar', () => {
  test('a divisória mexe só nos dois vizinhos e respeita os limites', () => {
    const r = computeRects(DEFAULT, W, H, { ...SPEC, limits: { statement: { min: [240, 120], max: [600, Infinity] } } })
    const d = r.dividers.find((x) => x.path.length === 0 && x.index === 0)!
    expect(d.active).toBe(true)
    expect(d.dir).toBe('row')
    expect(dividerFraction(d, 10_000)).toBeCloseTo(600 / (d.a + d.b), 5)
    expect(dividerFraction(d, -10_000)).toBeCloseTo(240 / (d.a + d.b), 5)
    const l = resizePair(DEFAULT, [], 0, 0.5)
    const root = l.root as Extract<Node, { type: 'split' }>
    expect(root.items[0].w).toBeCloseTo(0.5, 5)
    expect(root.items[1].w).toBeCloseTo(0.5, 5)
  })

  test('divisória ao lado de um recolhido não arrasta', () => {
    const r = computeRects(toggleCollapse(DEFAULT, 'statement'), W, H, SPEC)
    expect(r.dividers.find((x) => x.path.length === 0)!.active).toBe(false)
  })

  test('caminho inválido não muda nada', () => {
    expect(resizePair(DEFAULT, [5], 0, 0.5)).toBe(DEFAULT)
    expect(resizePair(DEFAULT, [], 3, 0.5)).toBe(DEFAULT)
  })

  test('voltar ao padrão usa o peso do padrão quando a divisão é a mesma', () => {
    const l = resetPair(resizePair(DEFAULT, [], 0, 0.6), [], 0, DEFAULT)
    expect((l.root as Extract<Node, { type: 'split' }>).items[0].w).toBeCloseTo(0.27, 5)
  })

  test('e divide igual quando a divisão não existe no padrão', () => {
    const moved = moveBlock(DEFAULT, 'output', 'statement', 'bottom')
    const path = [0]
    const l = resetPair(resizePair(moved, path, 0, 0.8), path, 0, DEFAULT)
    const col = (l.root as Extract<Node, { type: 'split' }>).items[0].node as Extract<Node, { type: 'split' }>
    expect(col.items[0].w).toBeCloseTo(col.items[1].w, 5)
  })
})

describe('soltar', () => {
  test('perto da borda de um bloco mira aquele lado, no meio troca', () => {
    const r = computeRects(DEFAULT, W, H, SPEC)
    const s = r.blocks.statement
    expect(dropAt(DEFAULT, r, W, H, 'output', s.x + s.w / 2, s.y + s.h - 60)?.zone).toBe('bottom')
    expect(dropAt(DEFAULT, r, W, H, 'output', s.x + s.w / 2, s.y + s.h / 2)?.zone).toBe('center')
  })

  test('a prévia é o lugar exato onde o bloco vai ficar', () => {
    const r = computeRects(DEFAULT, W, H, SPEC)
    const s = r.blocks.statement
    const drop = dropAt(DEFAULT, r, W, H, 'output', s.x + s.w / 2, s.y + s.h - 60)!
    expect(drop.zone).toBe('bottom')
    const after = computeRects(moveBlock(DEFAULT, 'output', 'statement', 'bottom'), W, H, SPEC)
    expect(after.blocks.output).toMatchObject(drop.preview)
  })

  test('sobre o próprio bloco, fora da área ou sem efeito, não há destino', () => {
    const r = computeRects(DEFAULT, W, H, SPEC)
    const e = r.blocks.editor
    expect(dropAt(DEFAULT, r, W, H, 'editor', e.x + 20, e.y + 20)).toBeNull()
    expect(dropAt(DEFAULT, r, W, H, 'editor', -50, 300)).toBeNull()
    expect(dropAt(DEFAULT, r, W, H, 'editor', W + 1, 300)).toBeNull()
    // A entrada já está à esquerda do terminal: soltar ali não muda nada.
    const o = r.blocks.output
    expect(dropAt(DEFAULT, r, W, H, 'input', o.x + 4, o.y + o.h / 2)).toBeNull()
  })

  test('colado na borda da área mira a área inteira', () => {
    const r = computeRects(DEFAULT, W, H, SPEC)
    const drop = dropAt(DEFAULT, r, W, H, 'statement', W / 2, H - 3)
    expect(drop).toMatchObject({ target: null, zone: 'bottom' })
  })
})

describe('layout salvo', () => {
  const memory = () => {
    const data = new Map<string, string>()
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), data }
  }

  test('volta igual ao que foi salvo', () => {
    const store = memory()
    const l = toggleCollapse(moveBlock(DEFAULT, 'output', 'statement', 'bottom'), 'input')
    saveLayout(store, 'k', l)
    expect(loadLayout(store, 'k', IDS, DEFAULT)).toEqual(l)
  })

  const bad: [string, unknown][] = [
    ['JSON quebrado', '{"v":1,'],
    ['versão antiga', { ...DEFAULT, v: 0 }],
    ['bloco que não existe mais', { ...DEFAULT, root: { type: 'split', dir: 'row', items: [{ node: leaf('statement'), w: 1 }, { node: leaf('velho'), w: 1 }, { node: leaf('editor'), w: 1 }, { node: leaf('input'), w: 1 }, { node: leaf('output'), w: 1 }] } }],
    ['bloco faltando', { ...DEFAULT, root: { type: 'split', dir: 'row', items: [{ node: leaf('statement'), w: 1 }, { node: leaf('editor'), w: 1 }] } }],
    ['bloco repetido', { ...DEFAULT, root: { type: 'split', dir: 'row', items: [...IDS, 'editor'].map((id) => ({ node: leaf(id), w: 1 })) } }],
    ['peso negativo', { ...DEFAULT, root: { type: 'split', dir: 'row', items: IDS.map((id, i) => ({ node: leaf(id), w: i ? 1 : -1 })) } }],
    ['peso NaN', { ...DEFAULT, root: { type: 'split', dir: 'row', items: IDS.map((id, i) => ({ node: leaf(id), w: i ? 1 : 'x' })) } }],
    ['direção estranha', { ...DEFAULT, root: { type: 'split', dir: 'diagonal', items: IDS.map((id) => ({ node: leaf(id), w: 1 })) } }],
    ['tudo recolhido', { ...DEFAULT, collapsed: IDS }],
    ['recolhido que não existe', { ...DEFAULT, collapsed: ['velho'] }],
    ['nulo', null],
    ['texto', 'oi'],
  ]
  for (const [name, raw] of bad) {
    test(`${name} cai no padrão`, () => {
      const store = memory()
      store.setItem('k', typeof raw === 'string' ? raw : JSON.stringify(raw))
      expect(loadLayout(store, 'k', IDS, DEFAULT)).toBe(DEFAULT)
    })
  }

  test('árvore funda demais ou com ciclo não trava', () => {
    let node: unknown = leaf('editor')
    for (let i = 0; i < 5000; i++) node = { type: 'split', dir: i % 2 ? 'row' : 'col', items: [{ node, w: 1 }, { node: leaf('x'), w: 1 }] }
    expect(validate({ v: 1, collapsed: [], root: node }, IDS)).toBeNull()
    const cyclic: Record<string, unknown> = { type: 'split', dir: 'row', items: [] }
    ;(cyclic.items as unknown[]).push({ node: cyclic, w: 1 })
    expect(validate({ v: 1, collapsed: [], root: cyclic }, IDS)).toBeNull()
  })

  test('armazenamento que lança erro não quebra nada', () => {
    const broken = {
      getItem: () => {
        throw new Error('negado')
      },
      setItem: () => {
        throw new Error('cheio')
      },
      removeItem: () => {
        throw new Error('negado')
      },
    }
    expect(loadLayout(broken, 'k', IDS, DEFAULT)).toBe(DEFAULT)
    expect(() => saveLayout(broken, 'k', DEFAULT)).not.toThrow()
    expect(loadLayout(null, 'k', IDS, DEFAULT)).toBe(DEFAULT)
  })

  test('divisão de um filho só ou dentro de outra igual é arrumada ao carregar', () => {
    const raw = { v: 1, collapsed: [], root: { type: 'split', dir: 'row', items: [{ node: { type: 'split', dir: 'row', items: [{ node: leaf('statement'), w: 1 }, { node: leaf('editor'), w: 1 }] }, w: 2 }, { node: { type: 'split', dir: 'col', items: [{ node: { type: 'split', dir: 'row', items: [{ node: leaf('input'), w: 1 }, { node: leaf('output'), w: 1 }] }, w: 1 }] }, w: 1 }] } }
    const l = validate(raw, IDS)!
    expect(shape(l.root)).toEqual({ row: ['statement', 'editor', 'input', 'output'] })
    expect(normalized(l.root)).toBe(true)
  })
})

// Gerador com semente: a mesma sequência sempre, para o teste que falhar ser reproduzível.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
}

function splitPaths(node: Node, path: number[] = []): { path: number[]; n: number }[] {
  if (node.type === 'block') return []
  return [{ path, n: node.items.length }, ...node.items.flatMap((i, k) => splitPaths(i.node, [...path, k]))]
}

describe('qualquer sequência de operações', () => {
  const ZONES: Zone[] = ['left', 'right', 'top', 'bottom', 'center']
  const SIDES = ['left', 'right', 'top', 'bottom'] as const

  for (const seed of [1, 2, 3, 42, 1337, 9001]) {
    test(`semente ${seed}: nenhum bloco some, duplica ou fica sem lugar`, () => {
      const r = rng(seed)
      const pick = <T,>(list: readonly T[]) => list[Math.floor(r() * list.length)]
      let l = DEFAULT
      for (let step = 0; step < 400; step++) {
        const op = Math.floor(r() * 7)
        const ids = blockIds(l)
        if (op === 0) l = toggleCollapse(l, pick(ids))
        else if (op === 1) l = moveBlock(l, pick(ids), pick(ids), pick(ZONES))
        else if (op === 2) l = moveBlock(l, pick(ids), null, pick(ZONES.slice(0, 4)))
        else if (op === 3) l = swapBlocks(l, pick(ids), pick(ids))
        else if (op === 4) l = nudge(l, pick(ids), pick(SIDES))
        else {
          const splits = splitPaths(l.root)
          const s = pick(splits)
          const index = Math.floor(r() * (s.n - 1))
          l = op === 5 ? resizePair(l, s.path, index, r()) : resetPair(l, s.path, index, DEFAULT)
        }
        expect([...blockIds(l)].sort()).toEqual([...IDS].sort())
        expect(normalized(l.root)).toBe(true)
        expect(l.collapsed.length).toBeLessThan(IDS.length)
        expect(validate(JSON.parse(JSON.stringify(l)), IDS)).toEqual(l)
        const rects = computeRects(l, W, H, SPEC)
        const list = IDS.map((id) => rects.blocks[id])
        for (const b of list) {
          expect(b.x).toBeGreaterThanOrEqual(-0.01)
          expect(b.y).toBeGreaterThanOrEqual(-0.01)
          expect(b.x + b.w).toBeLessThanOrEqual(W + 0.01)
          expect(b.y + b.h).toBeLessThanOrEqual(H + 0.01)
          expect(b.w).toBeGreaterThan(0)
          expect(b.h).toBeGreaterThan(0)
        }
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) expect(overlap(list[i], list[j])).toBe(false)
      }
    })
  }
})
