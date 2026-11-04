// Liga um editor Monaco ao documento da equipe: um binding por arquivo, desfazer próprio e cursores com nome.
import { MonacoBinding } from 'y-monaco'
import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { mainFile } from '../../shared/exam'
import { FILE_NAME } from '../../shared/protocol'
import type { ExamDoc } from '../collab/examDoc'
import { monaco, openModel } from './monaco'

type Editor = monaco.editor.IStandaloneCodeEditor
type Model = monaco.editor.ITextModel
type PeerState = { user?: { name?: unknown }; selection?: { anchor?: unknown; head?: unknown } | null }

interface FileEntry {
  ytext: Y.Text
  model: Model
  binding: MonacoBinding
  undo: Y.UndoManager
  release: () => void
}

export interface Peer {
  id: number
  name: string
  hue: number
}

const MAX_LABEL = 24
const LF = monaco.editor.EndOfLineSequence.LF
const EOL_REPAIR = 'eol-repair'

// O desfazer e a posição na tela sobrevivem ao editor, que é recriado ao passar por uma questão sem código.
const undoers = new WeakMap<Y.Text, Y.UndoManager>()
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>()
const tracked = new WeakSet<ExamDoc>()
let serial = 0

function forgetWithDoc(doc: ExamDoc) {
  if (tracked.has(doc)) return
  tracked.add(doc)
  doc.doc.once('destroy', () => {
    viewStates.clear()
    for (const model of monaco.editor.getModels()) if (model.uri.scheme === 'file') model.dispose()
  })
}

const validId = (id: number) => Number.isSafeInteger(id) && id >= 0
const hueOf = (id: number) => (Math.imul(id, 2654435761) >>> 0) % 360

function peerName(state: PeerState) {
  const raw = state.user?.name
  const clean = typeof raw === 'string' ? raw.replace(/\p{C}|\p{Zl}|\p{Zp}/gu, '').trim() : ''
  return Array.from(clean).slice(0, MAX_LABEL).join('') || 'Colega'
}

// O nome vem de outro navegador. Só letra, número e espaço passam crus; o resto vira escape hexadecimal.
function cssString(text: string) {
  return `"${text.replace(/[^\p{L}\p{N} ]/gu, (ch) => `\\${ch.codePointAt(0)!.toString(16)} `)}"`
}

export function peersOf(awareness: Awareness): Peer[] {
  const byName = new Map<string, Peer>()
  awareness.getStates().forEach((state, id) => {
    if (id === awareness.clientID || !validId(id) || !(state as PeerState).user) return
    const name = peerName(state as PeerState)
    // Depois de um F5 o estado antigo ainda vive 30 s: a mesma pessoa não aparece duas vezes.
    byName.set(name, { id, name, hue: hueOf(id) })
  })
  return [...byName.values()]
}

const stem = (file: string) => file.slice(0, file.lastIndexOf('.'))

export class CollabEditor {
  private files = new Map<string, Map<string, FileEntry>>()
  private watching = new Map<string, () => void>()
  private questionId: string | null = null
  private file: string | null = null
  private style = document.createElement('style')
  private release: (() => void)[] = []

  constructor(
    private editor: Editor,
    private doc: ExamDoc,
    private awareness: Awareness,
    private onSwitch: (questionId: string, file: string | null) => void,
  ) {
    forgetWithDoc(doc)
    this.style.dataset.collab = ''
    document.head.append(this.style)
    this.bindKeys()

    // Registrado antes dos bindings: um cursor malformado faria o y-monaco lançar no meio de uma edição.
    this.cleanSelections()
    this.paint()
    const onChange = () => {
      this.cleanSelections()
      this.paint()
    }
    awareness.on('change', onChange)
    this.release.push(() => awareness.off('change', onChange))
  }

  private bindKeys() {
    const { KeyMod, KeyCode } = monaco
    // O addCommand não devolve como desfazer o registro: a referência solta evita segurar este objeto depois de fechado.
    let self: CollabEditor | null = this
    this.release.push(() => (self = null))
    const scope = `oblitaCollab${++serial}`
    this.editor.createContextKey(scope, true)
    const when = `${scope} && textInputFocus`
    const bind = (keys: number, fn: (c: CollabEditor) => void) => this.editor.addCommand(keys, () => self && fn(self), when)
    bind(KeyMod.CtrlCmd | KeyCode.KeyZ, (c) => c.step('undo'))
    bind(KeyMod.CtrlCmd | KeyCode.KeyY, (c) => c.step('redo'))
    bind(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ, (c) => c.step('redo'))
    // O autosave já cuida de tudo: aqui só impede o "salvar página" do navegador.
    bind(KeyMod.CtrlCmd | KeyCode.KeyS, () => {})
  }

  private active() {
    if (!this.questionId || !this.file) return null
    return this.files.get(this.questionId)?.get(this.file) ?? null
  }

  private step(kind: 'undo' | 'redo') {
    const entry = this.active()
    if (!entry) return
    let at: number | null = null
    const watch = (event: Y.YTextEvent) => {
      let index = 0
      for (const op of event.delta) {
        if (op.retain) index += op.retain
        else if (typeof op.insert === 'string') at = index += op.insert.length
        else if (op.delete) at = index
      }
    }
    entry.ytext.observe(watch)
    entry.undo[kind]()
    entry.ytext.unobserve(watch)
    // Sem isto, digitar logo depois de desfazer entraria no mesmo passo já desfeito.
    entry.undo.stopCapturing()
    if (at === null) return
    const position = entry.model.getPositionAt(at)
    this.editor.setPosition(position)
    this.editor.revealPositionInCenterIfOutsideViewport(position)
  }

  private cleanSelections() {
    this.awareness.getStates().forEach((raw, id) => {
      const state = raw as PeerState
      if (id === this.awareness.clientID || !state.selection) return
      try {
        Y.createAbsolutePositionFromRelativePosition(state.selection.anchor as Y.RelativePosition, this.doc.doc)
        Y.createAbsolutePositionFromRelativePosition(state.selection.head as Y.RelativePosition, this.doc.doc)
      } catch {
        state.selection = null
      }
    })
  }

  private paint() {
    let css = ''
    this.awareness.getStates().forEach((state, id) => {
      if (id === this.awareness.clientID || !validId(id)) return
      const hue = hueOf(id)
      css += `.yRemoteSelection-${id}{background:hsl(${hue} 70% 50% / 0.3)}`
      css += `.yRemoteSelectionHead-${id}{border-left-color:hsl(${hue} 70% 45%)}`
      css += `.yRemoteSelectionHead-${id}::after{background:hsl(${hue} 70% 36%);content:${cssString(peerName(state as PeerState))}}`
    })
    if (this.style.textContent !== css) this.style.textContent = css
  }

  private entries(questionId: string) {
    let map = this.files.get(questionId)
    if (!map) this.files.set(questionId, (map = new Map()))
    return map
  }

  private watch(questionId: string) {
    if (this.watching.has(questionId)) return
    const map = this.doc.files(questionId)
    const observer = () => this.sync(questionId)
    map.observe(observer)
    this.watching.set(questionId, () => map.unobserve(observer))
    this.sync(questionId)
  }

  private bindFile(questionId: string, name: string, ytext: Y.Text): FileEntry {
    const model = openModel(questionId, name, ytext.toString(), this.doc.lang(questionId) ?? 'cpp')
    const subs: monaco.IDisposable[] = []
    const editor = this.editor
    // O y-monaco assina a seleção do editor e nunca solta. Por esta fachada a assinatura fica com a gente.
    const facade = {
      getModel: () => editor.getModel(),
      getSelection: () => editor.getSelection(),
      setSelection: (selection: monaco.ISelection) => editor.setSelection(selection),
      deltaDecorations: (old: string[], next: monaco.editor.IModelDeltaDecoration[]) => editor.deltaDecorations(old, next),
      onDidChangeCursorSelection: (fn: (e: monaco.editor.ICursorSelectionChangedEvent) => void) => {
        const sub = editor.onDidChangeCursorSelection(fn)
        subs.push(sub)
        return sub
      },
    } as unknown as Editor
    const binding = new MonacoBinding(ytext, model, new Set([facade]), this.awareness)
    // O setValue do binding recria o buffer, e no Windows ele nasceria em CRLF de novo.
    model.setEOL(LF)

    let undo = undoers.get(ytext)
    if (undo) undo.trackedOrigins.add(binding)
    else {
      undo = new Y.UndoManager(ytext, { trackedOrigins: new Set([binding]), captureTimeout: 400 })
      undoers.set(ytext, undo)
    }

    const entry: FileEntry = {
      ytext,
      model,
      binding,
      undo,
      release: () => {
        subs.forEach((sub) => sub.dispose())
        ytext.unobserve(scrub)
        undo.trackedOrigins.delete(binding)
        // Modelo descartado já levou o binding junto.
        if (!model.isDisposed()) binding.destroy()
      },
    }
    const scrub = (event: Y.YTextEvent) => {
      if (event.transaction.origin === binding) return
      if (event.delta.some((op) => typeof op.insert === 'string' && op.insert.includes('\r'))) this.repairEol(entry)
    }
    ytext.observe(scrub)
    if (ytext.toString().includes('\r')) this.repairEol(entry)
    return entry
  }

  // O Monaco guarda só LF: um CR no Y.Text desalinharia todos os offsets. Apagar é idempotente entre integrantes,
  // e vai depois da transação atual, com o binding travado, para ele não aplicar a remoção duas vezes.
  // O colega pode ter limpado antes e o modelo ter ficado torto, então o texto é conferido mesmo sem CR.
  private repairEol({ ytext, model, binding }: FileEntry) {
    queueMicrotask(() => {
      if (model.isDisposed()) return
      binding.mux(() => {
        const text = ytext.toString()
        if (text.includes('\r')) {
          this.doc.doc.transact(() => {
            for (let i = text.length - 1; i >= 0; i--) if (text[i] === '\r') ytext.delete(i, 1)
          }, EOL_REPAIR)
        }
        const clean = ytext.toString()
        if (model.getValue() !== clean) model.setValue(clean)
        model.setEOL(LF)
      })
    })
  }

  // Compara por identidade: dois integrantes criando o mesmo nome ao mesmo tempo trocam o Y.Text por baixo da chave.
  private sync(questionId: string) {
    const map = this.doc.files(questionId)
    const entries = this.entries(questionId)
    const gone: [string, FileEntry][] = []
    for (const [name, entry] of entries) {
      const value = map.get(name)
      if (value === entry.ytext) continue
      entries.delete(name)
      if (value instanceof Y.Text) {
        entry.release()
        this.dropUndo(entry)
      } else gone.push([name, entry])
    }

    const added: string[] = []
    map.forEach((value, name) => {
      if (entries.has(name) || !(value instanceof Y.Text) || !FILE_NAME.test(name)) return
      entries.set(name, this.bindFile(questionId, name, value))
      added.push(name)
    })

    // Renomear é copiar e apagar na mesma transação: quem está no arquivo vai junto, com a mesma posição.
    const renamedTo = (name: string) => added.find((a) => stem(a) === stem(name)) ?? (gone.length === 1 && added.length === 1 ? added[0] : null)
    for (const [name, entry] of gone) {
      const target = renamedTo(name)
      const uri = entry.model.uri.toString()
      const state = this.questionId === questionId && this.file === name ? this.editor.saveViewState() : viewStates.get(uri)
      if (target && state) viewStates.set(entries.get(target)!.model.uri.toString(), state)
      viewStates.delete(uri)
    }
    const current = this.questionId === questionId ? gone.find(([name]) => name === this.file) : undefined
    if (current) {
      const next = renamedTo(current[0]) ?? this.fallback(questionId)
      this.show(questionId, next, false)
      this.onSwitch(questionId, next)
    }
    for (const [, entry] of gone) {
      entry.release()
      this.dropUndo(entry)
      entry.model.dispose()
    }
  }

  private dropUndo({ ytext, undo }: FileEntry) {
    undo.destroy()
    undoers.delete(ytext)
  }

  private fallback(questionId: string) {
    const entries = this.entries(questionId)
    const lang = this.doc.lang(questionId)
    if (lang && entries.has(mainFile(lang))) return mainFile(lang)
    return [...entries.keys()].sort()[0] ?? null
  }

  show(questionId: string, file: string | null, save = true) {
    this.watch(questionId)
    const entry = file ? this.entries(questionId).get(file) : null
    const prev = this.editor.getModel()
    this.questionId = questionId
    this.file = entry ? file : null
    if (prev === (entry?.model ?? null)) return
    if (prev && save) viewStates.set(prev.uri.toString(), this.editor.saveViewState())
    this.editor.setModel(entry?.model ?? null)
    if (!entry) return this.publishSelection()
    const state = viewStates.get(entry.model.uri.toString())
    if (state) this.editor.restoreViewState(state)
    // Trocar de modelo apaga as decorações do editor, e os cursores dos colegas só voltariam no próximo movimento deles.
    entry.binding._rerenderDecorations()
    this.publishSelection()
  }

  refreshLanguage(questionId: string) {
    const lang = this.doc.lang(questionId)
    if (!lang) return
    for (const [name, { ytext }] of this.entries(questionId)) openModel(questionId, name, ytext.toString(), lang)
  }

  private publishSelection() {
    const entry = this.active()
    const selection = this.editor.getSelection()
    if (!entry || !selection) return this.awareness.setLocalStateField('selection', null)
    const start = entry.model.getOffsetAt(selection.getStartPosition())
    const end = entry.model.getOffsetAt(selection.getEndPosition())
    const rtl = selection.getDirection() === monaco.SelectionDirection.RTL
    this.awareness.setLocalStateField('selection', {
      anchor: Y.createRelativePositionFromTypeIndex(entry.ytext, rtl ? end : start),
      head: Y.createRelativePositionFromTypeIndex(entry.ytext, rtl ? start : end),
    })
  }

  dispose() {
    const model = this.editor.getModel()
    if (model) viewStates.set(model.uri.toString(), this.editor.saveViewState())
    this.awareness.setLocalStateField('selection', null)
    this.release.forEach((fn) => fn())
    this.style.remove()
    this.watching.forEach((stop) => stop())
    this.watching.clear()
    for (const entries of this.files.values()) for (const entry of entries.values()) entry.release()
    this.files.clear()
  }
}
