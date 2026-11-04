import type { Layout, Limits, Node } from './blocks'

// Os blocos da tela da prova, o padrão de cada tipo de questão e os limites de tamanho em px.
const leaf = (id: string): Node => ({ type: 'block', id })

// Enunciado à esquerda; à direita, o editor em cima e entrada e terminal embaixo.
export const CODE_LAYOUT: Layout = {
  v: 1,
  collapsed: [],
  root: {
    type: 'split',
    dir: 'row',
    items: [
      { node: leaf('statement'), w: 0.3 },
      {
        node: {
          type: 'split',
          dir: 'col',
          items: [
            { node: leaf('editor'), w: 0.68 },
            { node: { type: 'split', dir: 'row', items: [{ node: leaf('input'), w: 0.45 }, { node: leaf('output'), w: 0.55 }] }, w: 0.32 },
          ],
        },
        w: 0.7,
      },
    ],
  },
}

export const OTHER_LAYOUT: Layout = {
  v: 1,
  collapsed: [],
  root: { type: 'split', dir: 'row', items: [{ node: leaf('statement'), w: 0.38 }, { node: leaf('answer'), w: 0.62 }] },
}

export const BLOCK_TITLES: Record<string, string> = {
  statement: 'Enunciado',
  editor: 'Código',
  input: 'Entrada',
  output: 'Saída',
  answer: 'Resposta',
}

export const BLOCK_LIMITS: Limits = {
  statement: { min: [220, 120], max: [560, Infinity] },
  editor: { min: [320, 200] },
  input: { min: [300, 96] },
  output: { min: [200, 96] },
  answer: { min: [280, 160] },
}

export const layoutKey = (room: string, kind: 'code' | 'other') => `oblita.blocks.${room}.${kind}`
