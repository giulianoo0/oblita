// Onde cada pedaço de gravação fica: no arquivo do segmento, pelo programa, ou no navegador se o
// disco falhar. Só devolve depois de gravado de fato; se os dois falharem, lança, e quem chamou
// não confirma o pedaço ao aluno, que o guarda e reenvia.
//
// O arquivo do segmento só cresce em ordem. Se um pedaço caiu no navegador, o resto daquele
// segmento vai para lá também, e flush devolve tudo ao arquivo quando o disco voltar.
import type { SegmentInfo } from './room'

export interface RecDisk {
  writeAt(path: string, offset: number, bytes: Uint8Array): Promise<void>
}

export interface RecBrowser {
  put(key: string, blob: Blob): Promise<void>
  values(prefix: string): Promise<Blob[]>
  remove(prefix: string): Promise<void>
}

export interface RecDeps {
  disk: () => RecDisk | null
  browser: RecBrowser
  pathFor: (clientId: string, seg: SegmentInfo) => string | null
}

const pad = (n: number) => String(n).padStart(6, '0')

export class Recordings {
  constructor(
    private roomId: string,
    private deps: RecDeps,
  ) {}

  // A mesma chave de antes desta divisão: salas antigas continuam tocando.
  private prefix(clientId: string, seg: SegmentInfo) {
    return `${this.roomId}/${clientId}/${pad(seg.segment)}/`
  }

  async store(clientId: string, seg: SegmentInfo, part: number, bytes: Uint8Array<ArrayBuffer>): Promise<'disk' | 'browser'> {
    const disk = this.deps.disk()
    if (disk && seg.browserFrom === undefined) {
      const file = seg.file ?? this.deps.pathFor(clientId, seg)
      if (file) {
        const offset = seg.disk ?? 0
        try {
          await disk.writeAt(file, offset, bytes)
          seg.file = file
          seg.disk = offset + bytes.length
          return 'disk'
        } catch {
          // Cai para o navegador logo abaixo; quem avisa o professor é quem olha o estado do disco.
        }
      }
    }
    await this.deps.browser.put(`${this.prefix(clientId, seg)}${pad(part)}`, new Blob([bytes], { type: seg.mime }))
    seg.browserFrom ??= part
    return 'browser'
  }

  // O navegador não lê o que o programa gravou: o segmento que começou no disco é aberto pela pasta.
  async blob(clientId: string, seg: SegmentInfo): Promise<Blob> {
    if (seg.disk) return new Blob([], { type: seg.mime })
    return new Blob(await this.deps.browser.values(this.prefix(clientId, seg)), { type: seg.mime })
  }

  // Leva ao arquivo o que ficou no navegador. Repetir é seguro: cada escrita vai no mesmo ponto.
  async flush(clientId: string, seg: SegmentInfo): Promise<boolean> {
    const disk = this.deps.disk()
    if (!disk || seg.browserFrom === undefined) return false
    const file = seg.file ?? this.deps.pathFor(clientId, seg)
    if (!file) return false
    const prefix = this.prefix(clientId, seg)
    let offset = seg.disk ?? 0
    try {
      for (const part of await this.deps.browser.values(prefix)) {
        const bytes = new Uint8Array(await part.arrayBuffer())
        await disk.writeAt(file, offset, bytes)
        offset += bytes.length
      }
    } catch {
      return false
    }
    seg.file = file
    seg.disk = offset
    seg.browserFrom = undefined
    await this.deps.browser.remove(prefix).catch(() => {})
    return true
  }
}
