import { CircleCheck, CircleX, FlaskConical, Info, LoaderCircle, Pencil, Play, Plus, Square, Trash2 } from 'lucide-react'
import { useEffect, useReducer, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import type { CodeQuestion, Lang } from '../../shared/exam'
import { FILE_NAME, MAX_CODE_BYTES, MAX_FILES, RUN_LIMITS } from '../../shared/protocol'
import { useObservable } from '../lib/store'
import { Modal, Pill, Segmented, useTick } from '../ui/kit'
import { CollabEditor, peersOf } from './collabEditor'
import { registerCompletions } from './completions'
import './exam.css'
import { EDITOR_FONT, monaco, remeasureWhenFontLoads, showDiagnostics } from './monaco'
import { internalClipboard } from './proctor'
import { defaultStarter, mainFile, studentSession } from './session'

type Editor = monaco.editor.IStandaloneCodeEditor

const MAX_DISPLAY = RUN_LIMITS.outputKb * 1024
const LANG_LABEL: Record<Lang, string> = { c: 'C', cpp: 'C++' }

// Vivem fora do componente porque ele desmonta ao passar por uma questão que não é de código.
const remembered = { file: new Map<string, string>(), stdin: new Map<string, string>() }
const lastJob = { run: '', test: '' }
let currentEditor: Editor | null = null

const isSource = (file: string, lang: Lang) => (lang === 'c' ? file.endsWith('.c') : /\.(c|cc|cpp)$/.test(file))
const starterOf = (q: CodeQuestion, lang: Lang) => q.starter?.[lang] ?? defaultStarter(lang)
const lf = (text: string) => text.replace(/\r\n?/g, '\n')

// O mesmo texto que o Monaco manda para a área de transferência, inclusive a linha inteira sem seleção.
function editorClipboardText(editor: Editor) {
  const model = editor.getModel()
  const selections = editor.getSelections()
  if (!model || !selections) return ''
  const sorted = [...selections].sort((a, b) => monaco.Range.compareRangesUsingStarts(a, b))
  const parts: string[] = []
  let prevLine = 0
  for (const sel of sorted) {
    if (!sel.isEmpty()) parts.push(model.getValueInRange(sel))
    else if (sel.startLineNumber !== prevLine && sorted.every((s) => s.isEmpty())) parts.push(`${model.getLineContent(sel.startLineNumber)}\n`)
    else if (sel.startLineNumber !== prevLine) parts.push(model.getLineContent(sel.startLineNumber))
    prevLine = sel.startLineNumber
  }
  return sorted.every((s) => s.isEmpty()) ? parts.join('') : parts.join('\n')
}

// Marca o que foi copiado dentro da prova, para o vigia não tratar a colagem como vinda de fora.
export function useInternalClipboard() {
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      if (currentEditor?.hasTextFocus()) {
        internalClipboard.value = editorClipboardText(currentEditor)
        return
      }
      const el = document.activeElement
      if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === 'text')) {
        internalClipboard.value = el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)
        return
      }
      const text = window.getSelection()?.toString() ?? ''
      if (!text) return
      internalClipboard.value = text
      // O navegador às vezes serializa diferente de toString(); assim o que vai copiado é o que foi guardado.
      e.clipboardData?.setData('text/plain', text)
      e.preventDefault()
    }
    document.addEventListener('copy', onCopy, true)
    document.addEventListener('cut', onCopy, true)
    return () => {
      document.removeEventListener('copy', onCopy, true)
      document.removeEventListener('cut', onCopy, true)
    }
  }, [])
}

const isDark = () => matchMedia('(prefers-color-scheme: dark)').matches
const editorTheme = () => (isDark() ? 'vs-dark' : 'vs')

const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  model: null,
  fontFamily: EDITOR_FONT,
  fontSize: 14,
  lineHeight: 21,
  fontLigatures: false,
  minimap: { enabled: false },
  automaticLayout: true,
  dragAndDrop: false,
  dropIntoEditor: { enabled: false },
  pasteAs: { enabled: false },
  contextmenu: false,
  // Um link no comentário abriria outra aba com um clique.
  links: false,
  quickSuggestions: { other: true, comments: false, strings: false },
  suggestOnTriggerCharacters: true,
  tabCompletion: 'on',
  parameterHints: { enabled: true },
  wordBasedSuggestions: 'allDocuments',
  bracketPairColorization: { enabled: true },
  guides: { bracketPairs: true, indentation: true },
  autoClosingBrackets: 'languageDefined',
  autoClosingQuotes: 'languageDefined',
  autoIndent: 'full',
  detectIndentation: false,
  tabSize: 4,
  insertSpaces: true,
  scrollBeyondLastLine: false,
  // O nome do colega fica em cima do cursor: na primeira linha ele precisa deste espaço.
  padding: { top: 18, bottom: 6 },
  // O .ide corta o que passa da borda; sem isto a lista de sugestões fica pela metade.
  fixedOverflowWidgets: true,
  ariaLabel: 'Editor de código',
}

// Os colegas no cabeçalho do editor. O nome só entra como texto.
function Presence({ awareness }: { awareness: Awareness }) {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    awareness.on('change', bump)
    return () => awareness.off('change', bump)
  }, [awareness])
  return (
    <div className="peers">
      {peersOf(awareness).map((peer) => (
        <span key={peer.id} className="peer" title={peer.name} style={{ background: `hsl(${peer.hue} 70% 36%)` }}>
          {Array.from(peer.name)[0]?.toUpperCase()}
        </span>
      ))}
    </div>
  )
}

export function CodeWorkspace({ question }: { question: CodeQuestion }) {
  const s = useObservable(studentSession)
  const answer = s.answerOf(question.id)
  const lang = answer?.type === 'code' ? answer.lang : question.languages[0]
  const files = answer?.type === 'code' ? answer.files : {}
  const names = Object.keys(files).filter((name) => FILE_NAME.test(name)).sort()
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const [view, setView] = useState<'output' | 'tests'>('output')
  const [renaming, setRenaming] = useState<{ from: string | null; value: string; error?: string } | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const mount = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const collabRef = useRef<CollabEditor | null>(null)
  const posRef = useRef<HTMLSpanElement>(null)

  const wanted = remembered.file.get(question.id)
  const fallback = mainFile(lang)
  const active = wanted && names.includes(wanted) ? wanted : names.includes(fallback) ? fallback : (names[0] ?? null)
  const stdin = remembered.stdin.get(question.id) ?? ''

  const runNow = () => {
    if (s.running) return
    lastJob.run = question.id
    setView('output')
    void s.runProgram(question.id, remembered.stdin.get(question.id) ?? '')
  }

  // O editor é criado uma vez só; os callbacks dele leem sempre a versão atual por aqui.
  const latest = useRef(runNow)
  latest.current = runNow

  const showPosition = () => {
    const pos = editorRef.current?.getPosition()
    if (posRef.current && pos) posRef.current.textContent = `Ln ${pos.lineNumber}, Col ${pos.column}`
  }

  // A sessão troca documento e presença juntos ao entrar em outra prova, e tudo aqui depende deles.
  useEffect(() => {
    registerCompletions()
    const editor = monaco.editor.create(mount.current!, {
      ...EDITOR_OPTIONS,
      theme: editorTheme(),
      smoothScrolling: !matchMedia('(prefers-reduced-motion: reduce)').matches,
    })
    editorRef.current = editor
    currentEditor = editor
    void remeasureWhenFontLoads()
    const collab = new CollabEditor(editor, s.doc, s.awareness, (questionId, file) => {
      if (file) remembered.file.set(questionId, file)
      else remembered.file.delete(questionId)
      bump()
    })
    collabRef.current = collab

    const sub = editor.onDidChangeCursorPosition((e) => {
      if (posRef.current) posRef.current.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`
    })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => latest.current())

    const media = matchMedia('(prefers-color-scheme: dark)')
    const onTheme = () => monaco.editor.setTheme(editorTheme())
    media.addEventListener('change', onTheme)

    return () => {
      media.removeEventListener('change', onTheme)
      sub.dispose()
      collab.dispose()
      collabRef.current = null
      if (currentEditor === editor) currentEditor = null
      editorRef.current = null
      editor.dispose()
    }
  }, [s.doc, s.awareness])

  useEffect(() => {
    collabRef.current?.show(question.id, active)
    showPosition()
  }, [question.id, active, s.doc])

  useEffect(() => {
    collabRef.current?.refreshLanguage(question.id)
  }, [question.id, lang])

  // Erros voltam para o arquivo certo mesmo se o aluno já tiver mudado de arquivo.
  const run = s.runOutput
  useEffect(() => {
    if (run && lastJob.run && (run.state === 'done' || run.state === 'compile-error')) showDiagnostics(lastJob.run, run.log)
  }, [run])
  const report = s.testReport
  useEffect(() => {
    if (report) showDiagnostics(report.questionId, report.log)
  }, [report])

  const selectFile = (file: string) => {
    remembered.file.set(question.id, file)
    bump()
    editorRef.current?.focus()
  }

  // Sem entrar no desfazer: quem troca a linguagem não espera perder isso num Ctrl+Z, e o colega recebe tudo de uma vez.
  const switchLanguage = (next: Lang) => {
    if (next === lang) return
    const doc = s.doc
    const id = question.id
    const from = mainFile(lang)
    const to = mainFile(next)
    doc.doc.transact(() => {
      doc.setLang(id, next)
      const map = doc.files(id)
      if (map.has(from) && !map.has(to)) {
        if (lf(map.get(from)!.toString()) === lf(starterOf(question, lang))) {
          doc.removeFile(id, from)
          doc.addFile(id, to, starterOf(question, next))
        } else doc.renameFile(id, from, to)
      }
      // Em C só os .c são compilados: um .cpp esquecido sumiria da compilação sem aviso.
      if (next !== 'c') return
      for (const name of [...map.keys()]) {
        const target = name.replace(/\.(cpp|cc)$/, '.c')
        if (target !== name && !map.has(target)) doc.renameFile(id, name, target)
      }
    })
  }

  const fileNameError = (name: string, from: string | null) => {
    if (!FILE_NAME.test(name)) return 'Use letras e .c, .cpp ou .h'
    if (lang === 'c' && !/\.[ch]$/.test(name)) return 'Em C, use .c ou .h'
    if (name !== from && s.doc.files(question.id).has(name)) return 'Esse nome já existe'
    if (from === null && names.length >= MAX_FILES) return `No máximo ${MAX_FILES} arquivos`
    if (from && isSource(from, lang) && !isSource(name, lang) && names.filter((n) => isSource(n, lang)).length === 1) return 'Precisa de um arquivo de código'
    return null
  }

  const commitName = () => {
    if (!renaming) return
    const raw = renaming.value.trim()
    if (!raw) return setRenaming(null)
    const name = /\.\w+$/.test(raw) ? raw : `${raw}.${lang === 'c' ? 'c' : 'cpp'}`
    if (name === renaming.from) return setRenaming(null)
    const error = fileNameError(name, renaming.from)
    if (error) return setRenaming({ ...renaming, error })
    if (renaming.from === null) {
      s.doc.addFile(question.id, name)
      remembered.file.set(question.id, name)
    } else s.doc.renameFile(question.id, renaming.from, name)
    setRenaming(null)
  }

  const onNameKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter') commitName()
    if (e.key === 'Escape') setRenaming(null)
  }

  const removeFile = (file: string) => {
    s.doc.removeFile(question.id, file)
    setDeleting(null)
  }

  const lastSource = (file: string) => isSource(file, lang) && names.filter((n) => isSource(n, lang)).length === 1
  const totalSize = Object.values(files).reduce((sum, text) => sum + text.length, 0)

  return (
    <div className="workspace">
      <div className="ide">
        <div className="files" role="listbox" aria-label="Arquivos">
          <div className="files-head">
            <span>Arquivos</span>
            <button type="button" className="ghost" aria-label="Novo arquivo" title="Novo arquivo" disabled={names.length >= MAX_FILES} onClick={() => setRenaming({ from: null, value: '' })}>
              <Plus size={14} />
            </button>
          </div>
          {names.map((file) =>
            renaming?.from === file ? (
              <input key={file} className="file-new" autoFocus spellCheck={false} aria-label={`Novo nome de ${file}`} value={renaming.value} onChange={(e) => setRenaming({ ...renaming, value: e.target.value, error: undefined })} onKeyDown={onNameKey} onBlur={commitName} />
            ) : (
              <div key={file} className="file" role="option" tabIndex={0} aria-selected={file === active} title={file} onClick={() => selectFile(file)} onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && selectFile(file)} onDoubleClick={() => setRenaming({ from: file, value: file })}>
                <span>{file}</span>
                <button type="button" className="x" aria-label={`Renomear ${file}`} title="Renomear" onClick={(e) => { e.stopPropagation(); setRenaming({ from: file, value: file }) }}>
                  <Pencil size={12} />
                </button>
                <button type="button" className="x" aria-label={`Apagar ${file}`} title="Apagar" disabled={lastSource(file)} onClick={(e) => { e.stopPropagation(); setDeleting(file) }}>
                  <Trash2 size={12} />
                </button>
              </div>
            ),
          )}
          {renaming?.from === null && <input className="file-new" autoFocus spellCheck={false} aria-label="Nome do novo arquivo" placeholder={lang === 'c' ? 'util.c' : 'util.cpp'} value={renaming.value} onChange={(e) => setRenaming({ ...renaming, value: e.target.value, error: undefined })} onKeyDown={onNameKey} onBlur={commitName} />}
          {renaming?.error && <div className="files-error" role="alert">{renaming.error}</div>}
        </div>
        <div className="editor-host">
          <div className="editor-tabs">
            <span className="editor-name grow">{active}</span>
            <Presence awareness={s.awareness} />
            {totalSize > MAX_CODE_BYTES && <span className="badge danger">Código grande demais</span>}
            <span ref={posRef} className="editor-pos">Ln 1, Col 1</span>
            {question.languages.length > 1 ? (
              <Segmented<Lang> value={lang} onChange={switchLanguage} options={question.languages.map((l) => ({ value: l, label: LANG_LABEL[l] }))} />
            ) : (
              <span className="badge">{LANG_LABEL[lang]}</span>
            )}
          </div>
          <div ref={mount} className="editor-mount" />
        </div>
      </div>
      <Console
        question={question}
        stdin={stdin}
        onStdin={(value) => {
          remembered.stdin.set(question.id, value)
          bump()
        }}
        view={view}
        onView={setView}
        onRun={runNow}
        onTest={() => {
          lastJob.test = question.id
          setView('tests')
          s.runTest(question.id)
        }}
      />
      <Modal open={deleting !== null} title={`Apagar ${deleting ?? ''}?`} onClose={() => setDeleting(null)}>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Pill onClick={() => setDeleting(null)}>Manter</Pill>
          <Pill tone="danger" onClick={() => deleting && removeFile(deleting)}>
            Apagar
          </Pill>
        </div>
      </Modal>
    </div>
  )
}

type ConsoleProps = {
  question: CodeQuestion
  stdin: string
  onStdin: (value: string) => void
  view: 'output' | 'tests'
  onView: (view: 'output' | 'tests') => void
  onRun: () => void
  onTest: () => void
}

function Console({ question, stdin, onStdin, view, onView, onRun, onTest }: ConsoleProps) {
  const s = studentSession
  // Rodar é sempre possível; só o teste contra o professor depende da sala.
  const testsOn = s.config?.compiler === true
  const shown = testsOn ? view : 'output'
  const out = s.runOutput
  const canStop = s.running && out?.state === 'running' && out.where === 'local'
  const box = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  const printed = (out?.stdout.length ?? 0) + (out?.stderr.length ?? 0)

  // Acompanha a saída descendo, a não ser que o aluno tenha subido para ler.
  useEffect(() => {
    if (box.current && stick.current) box.current.scrollTop = box.current.scrollHeight
  }, [printed, shown])

  return (
    <div className="console">
      <div className="console-box">
        <div className="console-head">
          <b className="grow">Entrada</b>
          {canStop ? (
            <Pill size="sm" onClick={() => s.stopRun()}>
              <Square size={14} /> Parar
            </Pill>
          ) : (
            <Pill size="sm" tone="primary" disabled={s.running} title="Rodar (Ctrl+Enter)" onClick={onRun}>
              {s.running ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />} Rodar
            </Pill>
          )}
          {testsOn && <TestButton onTest={onTest} />}
        </div>
        <textarea className="console-in" spellCheck={false} aria-label="Entrada do programa" value={stdin} onChange={(e) => onStdin(e.target.value)} />
      </div>
      <div className="console-box">
        <div className="console-head">
          <div className="grow">
            {testsOn ? (
              <Segmented
                value={view}
                onChange={onView}
                options={[
                  { value: 'output', label: 'Terminal' },
                  { value: 'tests', label: 'Testes' },
                ]}
              />
            ) : (
              <b>Terminal</b>
            )}
            {shown === 'output' && out?.where === 'host' && <span className="badge">Máquina do professor</span>}
          </div>
          <span className="console-info" title={`Limites: ${RUN_LIMITS.memoryMb} MB de memória, ${RUN_LIMITS.timeMs / 1000} s e ${RUN_LIMITS.outputKb} KB de saída`} aria-label="Limites de execução">
            <Info size={14} />
          </span>
        </div>
        <pre
          ref={box}
          className="console-out"
          onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
        >
          {shown === 'output' ? <RunOutputView /> : <TestView question={question} />}
        </pre>
      </div>
    </div>
  )
}

function TestButton({ onTest }: { onTest: () => void }) {
  useTick(1000)
  const s = studentSession
  const wait = Math.ceil((s.nextTestAt - Date.now()) / 1000)
  return (
    <Pill size="sm" disabled={s.testing || wait > 0} title="Um teste por minuto" onClick={onTest}>
      {s.testing ? <LoaderCircle size={14} className="spin" /> : <FlaskConical size={14} />}
      {wait > 0 ? <span className="num">{wait} s</span> : 'Testar'}
    </Pill>
  )
}

function RunOutputView() {
  const out = studentSession.runOutput
  if (!out) return null
  const tail = (text: string) => (text.length > MAX_DISPLAY ? text.slice(-MAX_DISPLAY) : text)
  return (
    <>
      {out.state === 'compiling' && <span className="i">Compilando…{'\n'}</span>}
      {out.log && <span className={out.state === 'compile-error' ? 'e' : 'i'}>{out.log.endsWith('\n') ? out.log : `${out.log}\n`}</span>}
      {tail(out.stdout)}
      {out.stderr && <span className="e">{tail(out.stderr)}</span>}
      {out.error && <span className="e">{`${out.error}\n`}</span>}
      {out.state === 'running' && !out.stdout && !out.stderr && <span className="i">Rodando…{'\n'}</span>}
      {out.state === 'done' && out.exitCode !== undefined && <span className="i">{`\nSaiu com código ${out.exitCode}`}</span>}
    </>
  )
}

function TestView({ question }: { question: CodeQuestion }) {
  const s = studentSession
  if (s.testing && lastJob.test === question.id) return <span className="i">Testando…</span>
  const report = s.testReport
  if (!report || report.questionId !== question.id) return null
  if (report.status === 'compile-error') return <span className="e">{report.log}</span>
  return (
    <>
      {report.samples.map((sample, i) => (
        <div key={i} className="test">
          <div className="row">
            {sample.passed ? <CircleCheck size={14} className="ok" /> : <CircleX size={14} className="e" />}
            <b>Exemplo {i + 1}</b>
          </div>
          {!sample.passed && (
            <>
              <pre>Entrada{'\n'}{sample.stdin}</pre>
              <pre>Esperado{'\n'}{sample.expected}</pre>
              <pre>Saiu{'\n'}{sample.stdout}{sample.stderr}</pre>
              {sample.error && <span className="e">{sample.error}</span>}
            </>
          )}
        </div>
      ))}
      {report.hidden.total > 0 && (
        <div className="row">
          {report.hidden.passed === report.hidden.total ? <CircleCheck size={14} className="ok" /> : <CircleX size={14} className="e" />}
          <b>
            Ocultos: {report.hidden.passed} de {report.hidden.total}
          </b>
        </div>
      )}
    </>
  )
}
