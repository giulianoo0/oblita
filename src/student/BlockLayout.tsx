import { ChevronsDownUp, ChevronsLeftRight, ChevronsRightLeft, ChevronsUpDown, Ellipsis, GripVertical, LayoutPanelLeft } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Popover, PopoverRow } from '../ui/kit'
import {
  blockIds,
  canCollapse,
  computeRects,
  dividerFraction,
  dropAt,
  loadLayout,
  moveBlock,
  nudge,
  parentDir,
  resetPair,
  resizePair,
  saveLayout,
  swapBlocks,
  toggleCollapse,
  type Divider,
  type Drop,
  type Layout,
  type Limits,
  type Rect,
  type Side,
} from './blocks'

// Os blocos ficam todos lado a lado no mesmo pai, posicionados pelo layout. Mover ou recolher
// só muda a posição deles, nunca o lugar na árvore do React: o Monaco não é recriado e não perde foco nem seleção.

const GAP = 8
const STRIP = 40
// Até aqui o ponteiro ainda é um clique; daí em diante vira arrasto.
const DRAG_START = 4
const NARROW = '(max-width: 62rem)'

export type BlockDef = { id: string; title: string; extra?: ReactNode; body: ReactNode; className?: string }

export type BlockLayoutApi = {
  layout: Layout
  defaults: Layout
  animate: boolean
  note: string
  apply: (next: Layout, note?: string) => void
  live: (next: Layout) => void
  settle: () => void
}

const storage = () => {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

// O layout de um tipo de questão numa prova: carrega do localStorage, guarda a cada mudança.
export function useBlockLayout(key: string, defaults: Layout): BlockLayoutApi {
  const load = () => ({ key, defaults, layout: loadLayout(storage(), key, blockIds(defaults), defaults), animate: false, note: '' })
  const [state, setState] = useState(load)
  let current = state
  if (state.key !== key || state.defaults !== defaults) {
    current = load()
    setState(current)
  }
  useEffect(() => {
    saveLayout(storage(), current.key, current.layout === current.defaults ? null : current.layout)
  }, [current.key, current.layout, current.defaults])
  // Estáveis entre desenhos: o temporizador da animação não pode recomeçar a cada tique do relógio.
  const [actions] = useState(() => ({
    apply: (next: Layout, note = '') => setState((s) => (s.layout === next && !note ? s : { ...s, layout: next, animate: true, note })),
    live: (next: Layout) => setState((s) => (s.layout === next ? s : { ...s, layout: next, animate: false })),
    settle: () => setState((s) => (s.animate ? { ...s, animate: false } : s)),
  }))
  return { layout: current.layout, defaults, animate: current.animate, note: current.note, ...actions }
}

function useMedia(query: string) {
  const [match, setMatch] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const media = matchMedia(query)
    const on = () => setMatch(media.matches)
    media.addEventListener('change', on)
    on()
    return () => media.removeEventListener('change', on)
  }, [query])
  return match
}

const box = (r: Rect): CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h })

// Botões, campos e o seletor do cabeçalho continuam sendo clicados; o resto do cabeçalho arrasta.
const interactive = (target: EventTarget | null) => target instanceof Element && !!target.closest('button, a, input, textarea, select, [role="radio"], [role="menuitem"], [data-no-drag]')

const MOVES: [Side, string, string][] = [
  ['left', 'Mover para a esquerda', 'para a esquerda'],
  ['right', 'Mover para a direita', 'para a direita'],
  ['top', 'Mover para cima', 'para cima'],
  ['bottom', 'Mover para baixo', 'para baixo'],
]

type Gesture = { end: (commit: boolean) => void }

export function BlockLayout({ api, blocks, limits }: { api: BlockLayoutApi; blocks: BlockDef[]; limits: Limits }) {
  const area = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const stacked = useMedia(NARROW)
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; drop: Drop | null } | null>(null)
  const [resizing, setResizing] = useState(false)
  const gesture = useRef<Gesture | null>(null)
  // A faixa recolhida abre num clique; o duplo clique que vem junto não pode fechar de novo.
  const opened = useRef({ id: '', at: 0 })
  const titles = Object.fromEntries(blocks.map((b) => [b.id, b.title]))
  const layout = api.layout
  const rects = size && !stacked ? computeRects(layout, size.w, size.h, { gap: GAP, strip: STRIP, limits }) : null
  // Os gestos leem sempre o desenho atual, não o do momento em que começaram.
  const now = useRef({ layout, rects, api })
  now.current = { layout, rects, api }

  useLayoutEffect(() => {
    const el = area.current!
    const measure = () => setSize((s) => (s && s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!api.animate) return
    const t = setTimeout(api.settle, 320)
    return () => clearTimeout(t)
  }, [api.animate, api.layout, api.settle])

  // Desmontar no meio de um gesto (trocar de questão, prova bloqueada) não deixa nada preso.
  useEffect(() => () => gesture.current?.end(false), [])

  const focusMenu = (id: string) => requestAnimationFrame(() => area.current?.querySelector<HTMLElement>(`[data-block="${id}"] .blk-menu`)?.focus())

  const toggle = (id: string) => {
    const next = toggleCollapse(now.current.layout, id)
    if (next === now.current.layout) return
    const closing = next.collapsed.includes(id)
    if (!closing) opened.current = { id, at: performance.now() }
    api.apply(next, `${titles[id]} ${closing ? 'recolhido' : 'aberto'}`)
  }

  // Um gesto por vez, e tudo o que ele liga ele desliga, qualquer que seja o jeito de acabar.
  const track = (pointerId: number, onMove: (e: PointerEvent) => void, onEnd: (commit: boolean, e?: PointerEvent) => void, capture: Element) => {
    gesture.current?.end(false)
    try {
      capture.setPointerCapture(pointerId)
    } catch {
      // Sem captura os ouvintes na janela ainda pegam o soltar.
    }
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return
      // Soltou onde nada avisou (fora da janela, sem captura): termina sem aplicar.
      if (e.buttons === 0) return end(false)
      onMove(e)
    }
    const up = (e: PointerEvent) => e.pointerId === pointerId && end(true, e)
    const cancel = (e: Event) => (!('pointerId' in e) || (e as PointerEvent).pointerId === pointerId) && end(false)
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      end(false)
    }
    const hidden = () => document.hidden && end(false)
    const g: Gesture = { end: (commit) => end(commit) }
    function end(commit: boolean, e?: PointerEvent) {
      if (gesture.current !== g) return
      gesture.current = null
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', cancel, true)
      capture.removeEventListener('lostpointercapture', cancel)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', cancel)
      document.removeEventListener('visibilitychange', hidden)
      try {
        if (capture.hasPointerCapture(pointerId)) capture.releasePointerCapture(pointerId)
      } catch {
        // O elemento pode já ter saído da página.
      }
      onEnd(commit, e)
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', cancel, true)
    capture.addEventListener('lostpointercapture', cancel)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', hidden)
    gesture.current = g
  }

  const startDrag = (e: ReactPointerEvent<HTMLElement>, id: string) => {
    if (e.button !== 0 || !e.isPrimary || interactive(e.target)) return
    // Sem isto o navegador seleciona texto e tira o foco do editor.
    e.preventDefault()
    const sx = e.clientX
    const sy = e.clientY
    let active = false
    let drop: Drop | null = null
    const collapsed = now.current.layout.collapsed.includes(id)
    track(
      e.pointerId,
      (ev) => {
        const r = now.current.rects
        if (!active) {
          if (!r || Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_START) return
          active = true
          document.documentElement.setAttribute('data-blk-drag', '')
        }
        const b = area.current?.getBoundingClientRect()
        drop = b && r ? dropAt(now.current.layout, r, b.width, b.height, id, ev.clientX - b.left, ev.clientY - b.top) : null
        setDrag({ id, x: ev.clientX, y: ev.clientY, drop })
      },
      (commit) => {
        document.documentElement.removeAttribute('data-blk-drag')
        setDrag(null)
        if (!commit) return
        if (active && drop) {
          const target = drop.target ? titles[drop.target] : 'a área'
          const note = drop.zone === 'center' ? `${titles[id]} trocado com ${target}` : `${titles[id]} movido`
          now.current.api.apply(moveBlock(now.current.layout, id, drop.target, drop.zone), note)
        } else if (!active && collapsed) toggle(id)
      },
      e.currentTarget,
    )
  }

  const startResize = (e: ReactPointerEvent<HTMLElement>, d: Divider) => {
    if (e.button !== 0 || !e.isPrimary) return
    e.preventDefault()
    const start = now.current.layout
    const origin = d.dir === 'row' ? e.clientX : e.clientY
    setResizing(true)
    track(
      e.pointerId,
      (ev) => now.current.api.live(resizePair(start, d.path, d.index, dividerFraction(d, (d.dir === 'row' ? ev.clientX : ev.clientY) - origin))),
      (commit) => {
        setResizing(false)
        // Esc ou janela perdida no meio: volta ao tamanho de antes.
        if (!commit) now.current.api.live(start)
      },
      e.currentTarget,
    )
  }

  const onDividerKey = (e: ReactKeyboardEvent, d: Divider) => {
    const back = d.dir === 'row' ? 'ArrowLeft' : 'ArrowUp'
    const forth = d.dir === 'row' ? 'ArrowRight' : 'ArrowDown'
    const step = e.shiftKey ? 64 : 16
    const delta = e.key === back ? -step : e.key === forth ? step : e.key === 'Home' ? -1e6 : e.key === 'End' ? 1e6 : null
    if (e.key === 'Enter') {
      e.preventDefault()
      api.apply(resetPair(layout, d.path, d.index, api.defaults))
      return
    }
    if (delta === null) return
    e.preventDefault()
    api.live(resizePair(layout, d.path, d.index, dividerFraction(d, delta)))
  }

  const order = blockIds(layout)

  return (
    <div ref={area} className="blk-area" data-stacked={stacked || undefined} data-animate={(api.animate && !resizing) || undefined} data-resizing={resizing || undefined}>
      {blocks.map((b) => {
        const r = rects?.blocks[b.id]
        const collapsed = layout.collapsed.includes(b.id)
        const strip = collapsed ? (r?.strip ?? 'h') : undefined
        const axis = parentDir(layout, b.id)
        const can = collapsed || canCollapse(layout, b.id)
        const CloseIcon = axis === 'row' ? ChevronsRightLeft : ChevronsDownUp
        const OpenIcon = strip === 'v' ? ChevronsLeftRight : ChevronsUpDown
        const Icon = collapsed ? OpenIcon : CloseIcon
        const style: CSSProperties = stacked ? { order: order.indexOf(b.id) } : r ? box(r) : { visibility: 'hidden' }
        return (
          <section key={b.id} className={`blk${b.className ? ` ${b.className}` : ''}`} data-block={b.id} data-strip={strip} data-dragging={drag?.id === b.id ? '' : undefined} style={style} aria-label={b.title}>
            <div
              className="blk-head"
              onPointerDown={(e) => startDrag(e, b.id)}
              onMouseDown={(e) => !interactive(e.target) && e.preventDefault()}
              onDoubleClick={(e) => {
                if (interactive(e.target) || (opened.current.id === b.id && performance.now() - opened.current.at < 500)) return
                toggle(b.id)
              }}
              title={collapsed ? `Abrir ${b.title}` : undefined}
            >
              {!stacked && <GripVertical className="blk-grip" size={14} aria-hidden="true" />}
              <span className="blk-title">{b.title}</span>
              {!collapsed && b.extra && <div className="blk-extra">{b.extra}</div>}
              <span className="blk-tools">
                <button type="button" className="ghost blk-toggle" disabled={!can} aria-expanded={!collapsed} aria-label={collapsed ? `Abrir ${b.title}` : `Recolher ${b.title}`} title={collapsed ? 'Abrir' : can ? 'Recolher' : 'Um bloco fica sempre aberto'} onClick={() => toggle(b.id)}>
                  <Icon size={14} />
                </button>
                <Popover className="ghost blk-menu" label={`Opções de ${b.title}`} title={b.title} align="end" trigger={<Ellipsis size={14} />}>
                  {(close) => (
                    <BlockMenu
                      id={b.id}
                      api={api}
                      titles={titles}
                      onDone={(next, note) => {
                        close()
                        api.apply(next, note)
                        focusMenu(b.id)
                      }}
                    />
                  )}
                </Popover>
              </span>
            </div>
            <div className="blk-body" inert={collapsed || undefined}>
              {b.body}
            </div>
          </section>
        )
      })}
      {rects?.dividers
        .filter((d) => d.active)
        .map((d) => {
          const left = blockIds({ ...layout, root: nodeAt(layout, [...d.path, d.index]) }).map((id) => titles[id]).join(', ')
          return (
            <div
              key={`${d.path.join('.')}:${d.index}`}
              className="blk-divider"
              data-divider={`${d.path.join('.')}:${d.index}`}
              data-dir={d.dir}
              role="separator"
              tabIndex={0}
              aria-orientation={d.dir === 'row' ? 'vertical' : 'horizontal'}
              aria-label={`Tamanho de ${left}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((d.a / (d.a + d.b)) * 100)}
              title="Arraste para redimensionar. Duplo clique volta ao padrão."
              style={box(d.rect)}
              onPointerDown={(e) => startResize(e, d)}
              onDoubleClick={() => api.apply(resetPair(layout, d.path, d.index, api.defaults))}
              onKeyDown={(e) => onDividerKey(e, d)}
            />
          )
        })}
      {drag?.drop && <div className="blk-preview" style={box(drag.drop.preview)} aria-hidden="true" />}
      {drag && (
        <div className="blk-ghost" style={{ translate: `${drag.x + 12}px ${drag.y + 12}px` }} aria-hidden="true">
          {titles[drag.id]}
        </div>
      )}
      <div className="sr-only" role="status" aria-live="polite">
        {api.note}
      </div>
    </div>
  )
}

function nodeAt(layout: Layout, path: number[]) {
  let node = layout.root
  for (const k of path) if (node.type === 'split') node = node.items[k].node
  return node
}

// O mesmo que o arrasto faz, pelo teclado: cada item já diz o que vai acontecer.
function BlockMenu({ id, api, titles, onDone }: { id: string; api: BlockLayoutApi; titles: Record<string, string>; onDone: (next: Layout, note: string) => void }) {
  const layout = api.layout
  const title = titles[id]
  const collapsed = layout.collapsed.includes(id)
  const others = blockIds(layout).filter((x) => x !== id)
  return (
    <>
      {(collapsed || canCollapse(layout, id)) && <PopoverRow label={collapsed ? 'Abrir' : 'Recolher'} onSelect={() => onDone(toggleCollapse(layout, id), `${title} ${collapsed ? 'aberto' : 'recolhido'}`)} />}
      {MOVES.map(([side, label, where]) => {
        const next = nudge(layout, id, side)
        return next === layout ? null : <PopoverRow key={side} label={label} onSelect={() => onDone(next, `${title} movido ${where}`)} />
      })}
      {others.map((other) => (
        <PopoverRow key={other} label={`Trocar com ${titles[other]}`} onSelect={() => onDone(swapBlocks(layout, id, other), `${title} trocado com ${titles[other]}`)} />
      ))}
      <PopoverRow label="Restaurar layout padrão" onSelect={() => onDone(api.defaults, 'Layout padrão restaurado')} />
    </>
  )
}

// No topo da prova: abrir e recolher cada bloco e voltar ao padrão, sem procurar o bloco.
export function LayoutMenu({ api, titles }: { api: BlockLayoutApi; titles: Record<string, string> }) {
  return (
    <Popover className="pill sm icon blk-layout-menu" label="Blocos da tela" title="Blocos" align="end" trigger={<LayoutPanelLeft size={16} />}>
      {(close) => (
        <>
          {blockIds(api.layout).map((id) => {
            const open = !api.layout.collapsed.includes(id)
            const next = toggleCollapse(api.layout, id)
            return <PopoverRow key={id} label={titles[id]} hint={open ? undefined : 'Recolhido'} checked={open} onSelect={() => next !== api.layout && api.apply(next, `${titles[id]} ${open ? 'recolhido' : 'aberto'}`)} />
          })}
          <PopoverRow
            label="Restaurar layout padrão"
            onSelect={() => {
              close()
              api.apply(api.defaults, 'Layout padrão restaurado')
            }}
          />
        </>
      )}
    </Popover>
  )
}
