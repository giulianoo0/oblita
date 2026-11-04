// Quando avisar que o espaço vai acabar: abaixo de 2 GB, ou com menos de 30 min no ritmo da gravação.
const GB = 1024 ** 3
const MIN_FREE = 2 * GB
const MIN_MINUTES = 30

export const formatBytes = (bytes: number) => {
  const gb = bytes / GB
  const text = gb >= 100 ? `${gb.toFixed(0)} GB` : gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`
  return text.replace('.', ',')
}

export function spaceWarning(free: number | null, bytesPerSecond: number): string | null {
  if (free === null || !Number.isFinite(free)) return null
  if (free <= 0) return 'Disco cheio: a gravação parou de ser guardada.'
  const minutes = bytesPerSecond > 0 ? free / bytesPerSecond / 60 : Infinity
  if (free < MIN_FREE) return `Só ${formatBytes(free)} livres. Libere espaço ou escolha outra pasta.`
  if (minutes < MIN_MINUTES) return `${formatBytes(free)} livres: no ritmo atual, acaba em cerca de ${Math.floor(minutes)} min.`
  return null
}

// Bytes de gravação por segundo, na média da janela.
export class RecRate {
  private items: { at: number; bytes: number }[] = []

  constructor(private windowMs = 5 * 60_000) {}

  add(bytes: number, at = Date.now()) {
    this.items.push({ at, bytes })
  }

  perSecond(now = Date.now()) {
    const from = now - this.windowMs
    while (this.items.length && this.items[0].at < from) this.items.shift()
    const total = this.items.reduce((n, x) => n + x.bytes, 0)
    return total / (this.windowMs / 1000)
  }
}
