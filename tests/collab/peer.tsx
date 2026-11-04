// Um integrante: a tela real da prova (ExamPage, CodeWorkspace, collabEditor) sem professor.
// A sessão é preenchida à mão, e a rede é o que o host.ts repassa.
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '../../src/styles/tokens.css'
import '../../src/styles/app.css'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import type { Exam } from '../../shared/exam'
import ExamPage from '../../src/student/ExamPage'
import { monaco } from '../../src/student/monaco'
import { studentSession } from '../../src/student/session'

const params = new URLSearchParams(location.search)
const id = params.get('id') ?? 'a'
const name = params.get('name') ?? 'Ana'
const stage = params.get('stage') ?? 'exam'
const s = studentSession as any
const host = () => (window.parent as any).__host

const exam: Exam = {
  version: 1,
  title: 'Prova de teste com um título bem comprido para ver o que acontece no canto do selo',
  durationMin: 60,
  questions: [
    { id: 'q1', type: 'code', title: 'Soma', statement: 'Some dois números.', points: 2, languages: ['cpp'], starter: { cpp: 'int main() {\n    return 0;\n}\n' } },
    { id: 'q2', type: 'code', title: 'Duas linguagens', statement: 'Em C ou C++.', points: 1, languages: ['cpp', 'c'] },
    { id: 'q3', type: 'code', title: 'CRLF', statement: 'Modelo com CRLF.', points: 1, languages: ['cpp'] },
    { id: 'q4', type: 'text', title: 'Texto', statement: 'Explique.', points: 1 },
  ],
}

const config = { title: exam.title, mode: 'group', timing: 'global', durationMin: 60, compiler: true, requireIsolation: false, recordScreen: false, maxTeamSize: 4 }
const TEAM = {
  id: 't1',
  name: 'Os Ponteiros',
  code: 'K7QX2M',
  max: 4,
  members: [
    { clientId: 'a', name: 'Ana', focused: true },
    { clientId: 'b', name: 'Bruno com nome bem comprido', focused: false },
  ],
}

function hook() {
  s.doc.doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') host()?.doc(id, update)
  })
  s.awareness.on('update', ({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
    if (origin !== 'remote') host()?.aware(id, encodeAwarenessUpdate(s.awareness, [...added, ...updated, ...removed]))
  })
}

const OK = { screen: true, fullscreen: true, focused: true, isolated: true, extended: false }
s.extended = () => false

if (stage !== 'connect') {
  s.saved = { via: { kind: 'hub', address: '127.0.0.1' }, roomCode: 'TESTE', clientId: id, name, answers: {}, eventSeq: 0, recSeq: 0, segment: 0, lastHash: '', active: true, config }
  s.config = config
  s.linkState = 'online'
  s.status = OK
  s.teacherFp = 'ABC-123'
  s.setIdentity()
}
if (stage === 'exam') {
  s.saved.exam = exam
  s.phase = 'running'
  s.team = TEAM
  s.beaconCode = 341
}
if (stage === 'team-waiting') s.team = TEAM
if (stage === 'connect') s.restore = async () => false
hook()

const editor = () => monaco.editor.getEditors()[0]
const relative = (line: number, column: number) => {
  const pos = editor().getScrolledVisiblePosition({ lineNumber: line, column })!
  const box = editor().getDomNode()!.getBoundingClientRect()
  return { x: box.left + pos.left + 1, y: box.top + pos.top + pos.height / 2 }
}

Object.assign(window, {
  __t: {
    session: s,
    monaco,
    TEAM,
    OK,
    refresh: () => s.dismissWarning(),
    applyDoc: (update: Uint8Array) => s.doc.apply(new Uint8Array(update), 'remote'),
    applyAware: (update: Uint8Array) => applyAwarenessUpdate(s.awareness, new Uint8Array(update), 'remote'),
    removeAware: (ids: number[]) => removeAwarenessStates(s.awareness, ids, 'remote'),
    editor,
    relative,
    text: (q: string, file: string) => s.doc.files(q).get(file)?.toString(),
    names: (q: string) => [...s.doc.files(q).keys()].sort(),
    modelText: () => editor().getModel()?.getValue(),
    modelEol: () => editor().getModel()?.getEOL(),
    file: () => document.querySelector('.editor-name')?.textContent ?? null,
    // Trocar de documento como begin() e clear() fazem.
    swap: () => {
      s.resetDoc()
      hook()
      s.setIdentity()
      s.dismissWarning()
    },
    listeners: () => ({
      cursor: (editor() as any)?._onDidChangeCursorSelection._size,
      awareness: s.awareness._observers.get('change')?.size ?? 0,
      before: s.doc.doc._observers.get('beforeAllTransactions')?.size ?? 0,
      after: s.doc.doc._observers.get('afterTransaction')?.size ?? 0,
      models: monaco.editor.getModels().length,
      styles: document.querySelectorAll('style[data-collab]').length,
      editors: monaco.editor.getEditors().length,
    }),
  },
})

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <ExamPage />
  </BrowserRouter>,
)
