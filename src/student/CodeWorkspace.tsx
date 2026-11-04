import { CircleCheck, CircleX, FlaskConical, Info, LoaderCircle, Play, Square } from 'lucide-react'
import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import type { CodeQuestion, Lang } from '../../shared/exam'
import { MAX_CODE_BYTES, RUN_LIMITS, validPath } from '../../shared/protocol'
import { useObservable } from '../lib/store'
import { Pill, Segmented, useTick } from '../ui/kit'
import { BlockLayout, type BlockLayoutApi } from './BlockLayout'
import { CollabEditor, peersOf, type Peer } from './collabEditor'
import { registerCompletions } from './completions'
import './exam.css'
import { BLOCK_LIMITS, BLOCK_TITLES } from './examLayout'
import { FileExplorer } from './FileExplorer'
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

export function usePeers(awareness: Awareness) {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    awareness.on('change', bump)
    return () => awareness.off('change', bump)
  }, [awareness])
  return peersOf(awareness)
}

export { PeerDots } from './FileExplorer'

// Os colegas no cabeçalho do editor. O nome só entra como texto.
function Presence({ peers, questions }: { peers: Peer[]; questions: string[] }) {
  return (
    <div className="peers">
      {peers.map((peer) => {
        const index = peer.q ? questions.indexOf(peer.q) : -1
        const where = index < 0 ? '' : ` · questão ${index + 1}${peer.file ? ` · ${peer.file}` : ''}`
        return (
          <span key={peer.id} className="peer" title={`${peer.name}${where}`} style={{ background: `hsl(${peer.hue} 70% 36%)` }}>
            {Array.from(peer.name)[0]?.toUpperCase()}
          </span>
        )
      })}
    </div>
  )
}

// O enunciado vem pronto de fora; aqui ele vira um dos blocos, junto do editor, da entrada e da saída.
export function CodeWorkspace({ question, statement, layout }: { question: CodeQuestion; statement: ReactNode; layout: BlockLayoutApi }) {
  const s = useObservable(studentSession)
  const peers = usePeers(s.awareness)
  const answer = s.answerOf(question.id)
  const open = s.questionOpen(question.id)
  const lang = answer?.type === 'code' ? answer.lang : question.languages[0]
  const files = answer?.type === 'code' ? answer.files : {}
  const names = Object.keys(files).filter(validPath).sort()
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const [view, setView] = useState<'output' | 'tests'>('output')
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
    editorRef.current?.updateOptions({ readOnly: !open })
  }, [open, s.doc])

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

  const selectFile = (file: string, focus = true) => {
    remembered.file.set(question.id, file)
    bump()
    if (focus) editorRef.current?.focus()
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

  const totalSize = Object.values(files).reduce((sum, text) => sum + text.length, 0)

  const onTest = () => {
    lastJob.test = question.id
    setView('tests')
    void s.runTest(question.id)
  }

  return (
    <>
      <BlockLayout
        api={layout}
        limits={BLOCK_LIMITS}
        blocks={[
          { id: 'statement', title: BLOCK_TITLES.statement, body: statement },
          {
            id: 'editor',
            title: BLOCK_TITLES.editor,
            className: 'blk-ide',
            extra: (
              <div className="editor-tabs">
                <span className="editor-name grow">{active}</span>
                <Presence peers={peers} questions={s.saved?.exam?.questions.map((q) => q.id) ?? []} />
                {totalSize > MAX_CODE_BYTES && <span className="badge danger">Código grande demais</span>}
                <span ref={posRef} className="editor-pos">Ln 1, Col 1</span>
                {question.languages.length > 1 ? (
                  <Segmented<Lang> value={lang} onChange={switchLanguage} options={question.languages.map((l) => ({ value: l, label: LANG_LABEL[l] }))} />
                ) : (
                  <span className="badge">{LANG_LABEL[lang]}</span>
                )}
              </div>
            ),
            body: (
              <div className="ide">
                <FileExplorer questionId={question.id} lang={lang} doc={s.doc} names={names} active={active} peers={peers} editable={open} onSelect={selectFile} />
                <div className="editor-host">
                  <div ref={mount} className="editor-mount" />
                </div>
              </div>
            ),
          },
          {
            id: 'input',
            title: BLOCK_TITLES.input,
            extra: <RunButtons closed={!open} onRun={runNow} onTest={onTest} />,
            body: (
              <textarea
                className="console-in"
                spellCheck={false}
                aria-label="Entrada do programa"
                value={stdin}
                onChange={(e) => {
                  remembered.stdin.set(question.id, e.target.value)
                  bump()
                }}
              />
            ),
          },
          { id: 'output', title: BLOCK_TITLES.output, extra: <OutputTabs view={view} onView={setView} />, body: <OutputBody question={question} view={view} /> },
        ]}
      />
    </>
  )
}

// Rodar é sempre possível; só o teste contra o professor depende da sala.
const testsOn = () => studentSession.config?.compiler === true

function RunButtons({ closed, onRun, onTest }: { closed: boolean; onRun: () => void; onTest: () => void }) {
  const s = studentSession
  const out = s.runOutput
  const canStop = s.running && out?.state === 'running' && out.where === 'local'
  return (
    <>
      {canStop ? (
        <Pill size="sm" onClick={() => s.stopRun()}>
          <Square size={14} /> Parar
        </Pill>
      ) : (
        <Pill size="sm" tone="primary" disabled={s.running} title="Rodar (Ctrl+Enter)" onClick={onRun}>
          {s.running ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />} Rodar
        </Pill>
      )}
      {testsOn() && <TestButton closed={closed} onTest={onTest} />}
    </>
  )
}

function OutputTabs({ view, onView }: { view: 'output' | 'tests'; onView: (view: 'output' | 'tests') => void }) {
  const out = studentSession.runOutput
  const shown = testsOn() ? view : 'output'
  return (
    <>
      {testsOn() && (
        <Segmented
          value={view}
          onChange={onView}
          options={[
            { value: 'output', label: 'Terminal' },
            { value: 'tests', label: 'Testes' },
          ]}
        />
      )}
      {shown === 'output' && out?.where === 'host' && <span className="badge">Máquina do professor</span>}
      <span className="grow" />
      <span className="console-info" title={`Limites: ${RUN_LIMITS.memoryMb} MB de memória, ${RUN_LIMITS.timeMs / 1000} s e ${RUN_LIMITS.outputKb} KB de saída`} aria-label="Limites de execução">
        <Info size={14} />
      </span>
    </>
  )
}

function OutputBody({ question, view }: { question: CodeQuestion; view: 'output' | 'tests' }) {
  const out = studentSession.runOutput
  const shown = testsOn() ? view : 'output'
  const box = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  const printed = (out?.stdout.length ?? 0) + (out?.stderr.length ?? 0)

  // Acompanha a saída descendo, a não ser que o aluno tenha subido para ler.
  useEffect(() => {
    if (box.current && stick.current) box.current.scrollTop = box.current.scrollHeight
  }, [printed, shown])

  return (
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
  )
}

function TestButton({ onTest, closed }: { onTest: () => void; closed: boolean }) {
  useTick(1000)
  const s = studentSession
  const wait = Math.ceil((s.nextTestAt - Date.now()) / 1000)
  return (
    <Pill size="sm" disabled={s.testing || wait > 0 || closed} title={closed ? 'Questão fechada' : 'Um teste por minuto'} onClick={onTest}>
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
  if (s.testing && lastJob.test === question.id) {
    if (s.testStage === 'compiling') return <span className="i">Compilando para testar…</span>
    if (s.testPosition) return <span className="i">Na fila do professor: posição {s.testPosition}</span>
    return <span className="i">Testando…</span>
  }
  if (s.testNotice && lastJob.test === question.id) return <span className="e">{s.testNotice}</span>
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
