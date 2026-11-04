import { AnimatePresence, motion } from 'motion/react'
import { X } from 'lucide-react'
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { formatClock } from '../lib/store'

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

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  )
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="segmented" role="group">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.value === value && <motion.span layoutId={`seg-${options[0].value}`} className="chip" transition={settle} />}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="switch">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <i />
    </label>
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

// Markdown só com o necessário. Vira nós do React, então nunca há HTML injetado do enunciado.
export function Markdown({ text }: { text: string }) {
  const blocks = text.split(/```/)
  return (
    <div className="md">
      {blocks.map((block, i) =>
        i % 2 ? (
          <pre key={i}>{block.replace(/^\w*\n/, '')}</pre>
        ) : (
          block
            .split(/\n{2,}/)
            .filter((p) => p.trim())
            .map((p, j) => <p key={`${i}-${j}`}>{inline(p)}</p>)
        ),
      )}
    </div>
  )
}

function inline(text: string) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) return <code key={i}>{part.slice(1, -1)}</code>
    if (part.startsWith('**') && part.endsWith('**') && part.length > 3) return <strong key={i}>{part.slice(2, -2)}</strong>
    return part
  })
}
