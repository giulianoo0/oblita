// O documento de uma pessoa ou equipe. Todos os integrantes e o professor têm uma cópia.
import * as Y from 'yjs'
import type { Lang } from '../../shared/exam'
import type { Answer } from '../../shared/protocol'

export class ExamDoc {
  readonly doc = new Y.Doc()

  private meta(questionId: string) {
    return this.doc.getMap<string>(`meta:${questionId}`)
  }

  files(questionId: string) {
    return this.doc.getMap<Y.Text>(`files:${questionId}`)
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
