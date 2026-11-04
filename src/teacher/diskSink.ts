// Mantém a pasta da prova igual à estrutura do zip: regrava o texto que mudou (respostas, notas,
// alertas, resumos), de forma atômica no programa, e apaga o que saiu da estrutura, como o
// "sem-resposta.txt" de quem respondeu. A gravação em vídeo não passa por aqui: vai em recStore.
import type { LayoutEntry } from './layout'
import type { SegmentInfo } from './room'

export interface MirrorLink {
  replace(path: string, data: string | Uint8Array): Promise<void>
  remove(path: string): Promise<void>
}

// O que já foi escrito sobrevive ao F5, senão um arquivo velho ficaria para sempre na pasta.
export interface MirrorMemory {
  load(): Promise<string[]>
  save(paths: string[]): Promise<void>
}

export class DiskMirror {
  private last = new Map<string, string>()
  private stamps = new Map<string, unknown>()
  private known: Set<string> | null = null
  private videos = new Map<string, string>()

  constructor(
    readonly roomDir: string,
    private layout: () => LayoutEntry[][],
    private memory: MirrorMemory,
  ) {}

  // A pasta foi trocada no programa: nada do que foi escrito está na nova.
  reset() {
    this.last.clear()
    this.stamps.clear()
  }

  private compute() {
    const entries = this.layout().flat()
    this.videos.clear()
    for (const e of entries) if ('segment' in e) this.videos.set(`${e.segment.clientId}/${e.segment.info.segment}`, `${this.roomDir}/${e.path}`)
    return entries
  }

  // O arquivo de um segmento novo. A pasta do aluno pode mudar depois (trocou de equipe):
  // o segmento já começado continua onde nasceu.
  pathFor(clientId: string, seg: SegmentInfo): string | null {
    const key = `${clientId}/${seg.segment}`
    if (!this.videos.has(key)) this.compute()
    return this.videos.get(key) ?? null
  }

  async sync(link: MirrorLink): Promise<{ failed: string[] }> {
    this.known ??= new Set(await this.memory.load().catch(() => []))
    const known = this.known
    const before = known.size
    const failed: string[] = []
    const wanted = new Set<string>()
    for (const entry of this.compute()) {
      if (!('text' in entry)) continue
      const path = `${this.roomDir}/${entry.path}`
      wanted.add(path)
      if (entry.stamp !== undefined && this.stamps.get(path) === entry.stamp) continue
      const content = entry.text()
      if (this.last.get(path) === content) continue
      try {
        await link.replace(path, content)
        this.last.set(path, content)
        if (entry.stamp !== undefined) this.stamps.set(path, entry.stamp)
        known.add(path)
      } catch {
        failed.push(path)
      }
    }
    let removed = false
    for (const path of [...known]) {
      if (wanted.has(path)) continue
      try {
        await link.remove(path)
        known.delete(path)
        this.last.delete(path)
        removed = true
      } catch {
        failed.push(path)
      }
    }
    if (removed || known.size !== before) await this.memory.save([...known]).catch(() => {})
    return { failed }
  }
}
