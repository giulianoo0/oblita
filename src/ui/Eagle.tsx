// A águia do oblita_: fica de olho. Os olhos seguem o cursor e, com ele parado, ela olha em volta sozinha.
// O movimento vem do skullet (flutua, balança, pisca, a asa ondula); o traço, dos bichinhos do juntos.
import { useEffect, useRef } from 'react'
import './eagle.css'

// Até onde a pupila anda dentro do olho, em unidades do viewBox de 320. A cabeça acompanha uma fração.
const REACH = 7
const IDLE_MS = 2600

export function Eagle({ size = 56, className, still }: { size?: number | string; className?: string; still?: boolean }) {
  const ref = useRef<SVGSVGElement>(null)

  useEffect(() => {
    const svg = ref.current
    if (!svg || still || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let frame = 0
    let idle = 0
    let pointer: { x: number; y: number } | null = null
    const look = (x: number, y: number) => {
      svg.style.setProperty('--look-x', `${x.toFixed(2)}px`)
      svg.style.setProperty('--look-y', `${y.toFixed(2)}px`)
    }
    const aim = () => {
      frame = 0
      if (!pointer) return
      const box = svg.getBoundingClientRect()
      const dx = pointer.x - (box.left + box.width / 2)
      const dy = pointer.y - (box.top + box.height * 0.45)
      const distance = Math.hypot(dx, dy) || 1
      // Perto, olha quase de frente; longe, chega na borda do olho.
      const pull = Math.min(1, distance / 260)
      look((dx / distance) * REACH * pull, (dy / distance) * REACH * pull)
    }
    // Sem ninguém mexendo, ela vigia a sala: uma olhada para um lado, uma pausa, outra.
    const glance = () => {
      const angle = Math.random() * Math.PI * 2
      const pull = 0.35 + Math.random() * 0.65
      look(Math.cos(angle) * REACH * pull, Math.sin(angle) * REACH * 0.6 * pull)
      idle = window.setTimeout(glance, 1400 + Math.random() * 2200)
    }
    const onMove = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY }
      clearTimeout(idle)
      idle = window.setTimeout(glance, IDLE_MS)
      if (!frame) frame = requestAnimationFrame(aim)
    }
    idle = window.setTimeout(glance, IDLE_MS)
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      cancelAnimationFrame(frame)
      clearTimeout(idle)
    }
  }, [still])

  return (
    <svg ref={ref} className={`eagle${still ? ' still' : ''}${className ? ` ${className}` : ''}`} width={size} height={size} viewBox="0 0 320 320" fill="none" aria-hidden="true">
      <g className="eagle-body">
        <path className="eagle-torso" d="M96 168C58 198 50 262 78 304L254 304C262 262 250 214 216 186Z" />
        <path className="eagle-wing" d="M98 206C84 238 90 282 118 304L210 304C194 272 176 236 152 212C134 196 110 194 98 206Z" />
        <path className="eagle-feathers" d="M112 236C124 244 138 246 150 240M116 262C130 270 148 272 162 264M126 286C140 294 160 296 176 288" />
        <g className="eagle-head">
          <path className="eagle-white" d="M84 188C70 150 74 96 110 66C140 42 186 44 212 66C228 80 236 98 238 116L240 160C226 178 214 188 206 194L192 208L178 196L162 214L148 200L132 216L118 200L102 212L94 198Z" />
          <path className="eagle-shade" d="M92 176C84 150 86 116 104 92C98 122 102 150 120 172C108 176 98 178 92 176Z" />
          <g className="eagle-beak">
            <path className="eagle-beak-top" d="M226 100C256 94 286 104 302 130C310 145 306 163 293 174C291 161 284 153 273 151L236 157Z" />
            <path className="eagle-beak-low" d="M238 157L276 152C283 161 279 173 266 177C254 181 242 177 236 170Z" />
            <path className="eagle-nostril" d="M246 118C252 116 258 118 262 122" />
          </g>
          <g className="eagle-eye">
            <ellipse className="eagle-iris" cx="198" cy="106" rx="16" ry="14" />
            <circle className="eagle-pupil" cx="200" cy="106" r="7.5" />
            <circle className="eagle-glint" cx="203" cy="102" r="2.5" />
          </g>
          <path className="eagle-brow" d="M164 86C186 78 214 84 236 104C214 100 194 98 172 100C166 96 162 90 164 86Z" />
        </g>
      </g>
      <path className="eagle-line" d="M60 82L36 70" />
      <path className="eagle-line" d="M54 110L28 108" />
    </svg>
  )
}
