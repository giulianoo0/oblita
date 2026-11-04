import './dia.css'

// O reveal, não um brilho: o texto nasce invisível e é trazido da esquerda para a direita pela faixa de cor.
// Só CSS: o gradiente é fixo e o que se move é a posição dele.
export function DiaTextReveal({ text, className, delayMs }: { text: string; className?: string; delayMs?: number }) {
  return (
    <span className={['dia-reveal', className].filter(Boolean).join(' ')} style={delayMs ? { animationDelay: `${delayMs}ms` } : undefined}>
      {text}
    </span>
  )
}
