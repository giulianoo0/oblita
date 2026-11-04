// O documento de uma pessoa ou equipe. Todos os integrantes e o professor têm uma cópia.
import * as Y from 'yjs'
import type { Lang } from '../../shared/exam'
import { validFolder, type Answer } from '../../shared/protocol'

export class ExamDoc {
  readonly doc = new Y.Doc()

  private meta(questionId: string) {
    return this.doc.getMap<string>(`meta:${questionId}`)
  }

  files(questionId: string) {
    return this.doc.getMap<Y.Text>(`files:${questionId}`)
  }

  // Só as pastas criadas vazias; a de um arquivo vem do próprio caminho dele.
  private dirs(questionId: string) {
    return this.doc.getMap<true>(`dirs:${questionId}`)
  }

  folders(questionId: string) {
    return [...this.dirs(questionId).keys()].filter(validFolder).sort()
  }

  lang(questionId: string) {
    return this.meta(questionId).get('lang') as Lang | undefined
  }

  // Só o professor semeia: dois alunos semeando duplicariam o texto ao mesclar.
  seed(questionId: string, lang: Lang, fileName: string, content: string) {
    if (this.lang(questionId)) return
    this.doc.transact(() => {
      this.meta(questionId).set('lang', lang)
      this.files(questionId).set(fileName, new Y.Text(content))
    })
  }

  setLang(questionId: string, lang: Lang) {
    this.meta(questionId).set('lang', lang)
  }

  addFile(questionId: string, name: string, content = '') {
    const files = this.files(questionId)
    if (!files.has(name)) files.set(name, new Y.Text(content))
  }

  // Y.Text não muda de chave: renomear copia o texto. Por isso não entra no desfazer.
  renameFile(questionId: string, from: string, to: string) {
    const files = this.files(questionId)
    const source = files.get(from)
    if (!source || files.has(to)) return
    this.doc.transact(() => {
      files.set(to, new Y.Text(source.toString()))
      files.delete(from)
    })
  }

  removeFile(questionId: string, name: string) {
    this.files(questionId).delete(name)
  }

  addFolder(questionId: string, path: string) {
    this.dirs(questionId).set(path, true)
  }

  // Tudo numa transação: o colega nunca vê metade da pasta no lugar novo.
  renameFolder(questionId: string, from: string, to: string) {
    const files = this.files(questionId)
    const dirs = this.dirs(questionId)
    const moved = (path: string) => (path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : null)
    this.doc.transact(() => {
      for (const [name, text] of [...files.entries()]) {
        const target = moved(name)
        if (target === null || files.has(target) || !(text instanceof Y.Text)) continue
        files.set(target, new Y.Text(text.toString()))
        files.delete(name)
      }
      for (const path of [...dirs.keys()]) {
        const target = moved(path)
        if (target === null) continue
        dirs.delete(path)
        dirs.set(target, true)
      }
    })
  }

  removeFolder(questionId: string, path: string) {
    const inside = (name: string) => name === path || name.startsWith(`${path}/`)
    const files = this.files(questionId)
    const dirs = this.dirs(questionId)
    this.doc.transact(() => {
      for (const name of [...files.keys()]) if (inside(name)) files.delete(name)
      for (const name of [...dirs.keys()]) if (inside(name)) dirs.delete(name)
    })
  }

  snapshot(questionId: string): Extract<Answer, { type: 'code' }> | null {
    const lang = this.lang(questionId)
    if (lang !== 'c' && lang !== 'cpp') return null
    const files: Record<string, string> = {}
    this.files(questionId).forEach((text, name) => {
      if (text instanceof Y.Text) files[name] = text.toString()
    })
    return { type: 'code', lang, files }
  }

  encodeState() {
    return Y.encodeStateAsUpdate(this.doc)
  }

  encodeVector() {
    return Y.encodeStateVector(this.doc)
  }

  diffFor(vector: Uint8Array) {
    return Y.encodeStateAsUpdate(this.doc, vector)
  }

  apply(update: Uint8Array, origin?: unknown) {
    Y.applyUpdate(this.doc, update, origin)
  }

  destroy() {
    this.doc.destroy()
  }
}
