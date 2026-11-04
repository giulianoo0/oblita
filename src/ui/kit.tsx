import { AnimatePresence, motion } from 'motion/react'
import { X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { IMAGE_MARKDOWN } from '../../shared/exam'
import { formatClock } from '../lib/store'
import './dia.css'

const pop = { type: 'spring', bounce: 0.25, duration: 0.6 } as const
const settle = { type: 'spring', bounce: 0, duration: 0.36 } as const

type PillProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: 'soft' | 'primary' | 'brand' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  icon?: boolean
}

export function Pill({ tone = 'soft', size = 'md', icon, className = '', ...rest }: PillProps) {
  const cls = ['pill', tone !== 'soft' && tone, size !== 'md' && size, icon && 'icon', className].filter(Boolean).join(' ')
  return <button type="button" className={cls} {...rest} />
}

export function Logo({ size = 1.5 }: { size?: number }) {
  return (
    <Link to="/" className="logo" style={{ fontSize: `${size}rem` }} aria-label="oblita">
      oblita<i>_</i>
    </Link>
  )
}

// `hint` fica embaixo do rótulo, mais calada: diz o que o campo faz sem virar parágrafo.
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {hint && <small className="field-hint">{hint}</small>}
      {children}
    </label>
  )
}

// O fundo compartilhado do lawcore (SlidingPill): uma pílula só, medida do escolhido, que desliza até o
// novo. No primeiro desenho, ao remedir e pelo teclado ela já está no lugar.
function SlidingPill({ value }: { value: unknown }) {
  const ref = useRef<HTMLSpanElement>(null)
  const placedFor = useRef<{ value: unknown } | undefined>(undefined)
  useLayoutEffect(() => {
    const pill = ref.current
    const group = pill?.parentElement
    if (!pill || !group) return
    const place = () => {
      const target = group.querySelector<HTMLElement>('[aria-checked="true"]')
      if (!target) return void delete group.dataset.placed
      pill.style.setProperty('--pill-left', `${target.offsetLeft}px`)
      pill.style.setProperty('--pill-top', `${target.offsetTop}px`)
      pill.style.setProperty('--pill-width', `${target.offsetWidth}px`)
      pill.style.setProperty('--pill-height', `${target.offsetHeight}px`)
      group.dataset.placed = ''
    }
    const changed = placedFor.current !== undefined && placedFor.current.value !== value
    placedFor.current = { value }
    let current = true
    if (changed) {
      pill.dataset.sliding = ''
      place()
      void Promise.allSettled(pill.getAnimations().map((a) => a.finished)).then(() => current && delete pill.dataset.sliding)
    } else place()
    const observer = new ResizeObserver(place)
    observer.observe(group)
    return () => {
      current = false
      observer.disconnect()
    }
  }, [value])
  return <span ref={ref} className="seg-pill" aria-hidden="true" />
}

// Uma escolha entre poucas, todas à vista. Setas andam entre as opções, como num grupo de rádio.
// `stretch` divide a linha inteira em partes iguais (formulário); sem ele, ocupa só o que precisa.
export function Segmented<T extends string>({ value, onChange, options, label, stretch }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label?: string; stretch?: boolean }) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const i = options.findIndex((o) => o.value === value)
    const next = options[(i + step + options.length) % options.length]
    onChange(next.value)
    ;(e.currentTarget.querySelector(`[data-value="${CSS.escape(next.value)}"]`) as HTMLElement | null)?.focus()
  }
  return (
    <div className={`segmented${stretch ? ' stretch' : ''}`} role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" data-value={o.value} aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
      <SlidingPill value={value} />
    </div>
  )
}

export function Switch({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="switch">
      <span className="switch-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <i />
    </label>
  )
}

// O "Exibir" do lawcore: o popover sai do gatilho com mola e blur e volta amortecido.
// Fecha com Esc, clique fora ou ao escolher. Fica num portal, então nenhum overflow o corta.
export function Popover({ trigger, label, className, title, align = 'start', children }: { trigger: ReactNode; label: string; className?: string; title?: string; align?: 'start' | 'end'; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const [present, setPresent] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; origin: string } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  if (open && !present) setPresent(true)
  const close = () => setOpen(false)

  useLayoutEffect(() => {
    if (!open || !button.current) return
    const r = button.current.getBoundingClientRect()
    const width = popup.current?.offsetWidth ?? 224
    const height = popup.current?.offsetHeight ?? 0
    const below = r.bottom + 8 + height < innerHeight - 16 || r.top < height + 24
    const left = Math.min(Math.max(16, align === 'end' ? r.right - width : r.left), innerWidth - width - 16)
    setPos({ top: below ? r.bottom + 8 : r.top - 8 - height, left, origin: `${(align === 'end' ? width : 0) + (align === 'end' ? r.right - width - left : r.left - left)}px ${below ? '0' : '100%'}` })
    const el = popup.current
    if (el) {
      el.setAttribute('data-starting-style', '')
      void el.offsetWidth
      el.removeAttribute('data-starting-style')
      el.querySelector<HTMLElement>('[role=menuitemradio],[role=menuitem]')?.focus({ preventScroll: true })
    }
  }, [open, present, align])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!popup.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      close()
      button.current?.focus()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (open || !present) return
    const t = setTimeout(() => setPresent(false), 420)
    return () => clearTimeout(t)
  }, [open, present])

  return (
    <>
      <button ref={button} type="button" className={className} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v) }}>
        {trigger}
      </button>
      {present &&
        createPortal(
          <div
            ref={popup}
            className="popover"
            role="menu"
            aria-label={title ?? label}
            data-ending-style={!open ? '' : undefined}
            inert={!open || undefined}
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, transformOrigin: pos?.origin }}
            onTransitionEnd={(e) => !open && e.target === e.currentTarget && (e.propertyName === 'scale' || e.propertyName === 'opacity') && setPresent(false)}
          >
            {title && <div className="popover-title">{title}</div>}
            {children(close)}
          </div>,
          document.body,
        )}
    </>
  )
}

export function PopoverRow({ label, hint, checked, onSelect }: { label: string; hint?: string; checked?: boolean; onSelect: () => void }) {
  return (
    <button type="button" role={checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={checked} className="popover-row" onClick={onSelect}>
      <span className="popover-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
      {checked && (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m3.5 8.4 2.9 2.9 6.1-6.6" />
        </svg>
      )}
    </button>
  )
}

export function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="modal-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={settle} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
          <motion.div className="modal" role="dialog" aria-label={title} initial={{ scale: 0, filter: 'blur(8px)', opacity: 0 }} animate={{ scale: 1, filter: 'blur(0px)', opacity: 1 }} exit={{ scale: 0.6, filter: 'blur(8px)', opacity: 0, transition: settle }} transition={pop}>
            <div className="row">
              <h2 className="grow">{title}</h2>
              <Pill icon size="sm" aria-label="Fechar" onClick={onClose}>
                <X size={16} />
              </Pill>
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

const HUES = [255, 150, 70, 320, 200, 25, 355, 290]

export function Avatar({ name }: { name: string }) {
  let sum = 0
  for (const ch of name) sum += ch.codePointAt(0) ?? 0
  const hue = HUES[sum % HUES.length]
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('')
  return (
    <div className="avatar" style={{ background: `oklch(0.42 0.08 ${hue})`, color: `oklch(0.86 0.09 ${hue})` }}>
      {initials}
    </div>
  )
}

export function useTick(ms = 1000) {
  const [, set] = useState(0)
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms)
    return () => clearInterval(t)
  }, [ms])
}

export function Countdown({ ms, className }: { ms: number | null; className?: string }) {
  useTick(500)
  return <span className={className}>{ms === null ? '--:--' : formatClock(ms)}</span>
}

export const browserIssue = (): string | null => {
  const ok =
    typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
    'isExtended' in screen &&
    'keyboard' in navigator &&
    'locks' in navigator
  return ok ? null : 'Use Chrome ou Edge atualizado neste computador.'
}

const REVEAL_STAGGER_MS = 140

// Markdown só com o necessário. Vira nós do React, então nunca há HTML injetado do enunciado.
export function Markdown({ text, reveal }: { text: string; reveal?: boolean }) {
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null)
  const blocks = text.split(/```/)
  let paragraph = 0
  return (
    <div className={reveal ? 'md revealing' : 'md'}>
      {blocks.map((block, i) =>
        i % 2 ? (
          <pre key={i}>{block.replace(/^\w*\n/, '')}</pre>
        ) : (
          block
            .split(/\n{2,}/)
            .filter((p) => p.trim())
            .map((p, j) => {
              const delay = paragraph++ * REVEAL_STAGGER_MS
              // Parágrafo só de imagem não leva gradiente: não há texto para varrer.
              const sweep = reveal && !IMAGE_ONLY.test(p.trim())
              return (
                <p key={`${i}-${j}`} className={sweep ? 'dia-reveal' : undefined} style={sweep && delay ? { animationDelay: `${delay}ms` } : undefined}>
                  {inline(p, setZoom)}
                </p>
              )
            })
        ),
      )}
      <Modal open={!!zoom} title={zoom?.alt || 'Imagem'} onClose={() => setZoom(null)}>
        {zoom && (
          <div className="md-zoom">
            <img src={zoom.src} alt={zoom.alt} />
          </div>
        )}
      </Modal>
    </div>
  )
}

const IMAGE_ONLY = new RegExp(`^${IMAGE_MARKDOWN.source}$`)
const INLINE = /(!\[[^\]]*\]\(data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+\)|`[^`]+`|\*\*[^*]+\*\*)/

function inline(text: string, onZoom: (image: { src: string; alt: string }) => void) {
  return text.split(INLINE).map((part, i) => {
    const image = part.match(IMAGE_MARKDOWN)
    if (image && image[0] === part) {
      const [, alt, src] = image
      return <img key={i} src={src} alt={alt} onClick={() => onZoom({ src, alt })} />
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) return <code key={i}>{part.slice(1, -1)}</code>
    if (part.startsWith('**') && part.endsWith('**') && part.length > 3) return <strong key={i}>{part.slice(2, -2)}</strong>
    return part
  })
}
