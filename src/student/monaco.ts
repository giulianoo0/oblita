// Monaco vindo só do bundle: nada aqui pode depender de CDN, a prova roda sem internet.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import 'monaco-editor/esm/vs/editor/edcore.main'
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import type { Lang } from '../../shared/exam'
import { parseDiagnostics } from '../compiler/client'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

// A gramática é carregada sob demanda. Aquecendo agora, ela já está na memória antes de a internet ser cortada.
void import('monaco-editor/esm/vs/basic-languages/cpp/cpp.js')

export { monaco }

const MARKER_OWNER = 'compilador'

export const EDITOR_FONT = "'Geist Mono Variable', monospace"

// O Monaco mede a largura dos caracteres uma vez só; sem isto o cursor desalinha quando a fonte chega depois.
export async function remeasureWhenFontLoads() {
  await document.fonts.load(`14px ${EDITOR_FONT}`).catch(() => {})
  monaco.editor.remeasureFonts()
}

export const fileUri = (questionId: string, file: string) =>
  monaco.Uri.from({ scheme: 'file', path: `/${encodeURIComponent(questionId)}/${file}` })

export function describeModel(model: monaco.editor.ITextModel) {
  const [, questionId, ...file] = model.uri.path.split('/')
  return { questionId: decodeURIComponent(questionId), file: file.join('/') }
}

export function languageFor(file: string, lang: Lang) {
  if (file.endsWith('.c')) return 'c'
  if (file.endsWith('.h')) return lang
  return 'cpp'
}

export const questionModels = (questionId: string) =>
  monaco.editor.getModels().filter((m) => m.uri.scheme === 'file' && describeModel(m).questionId === questionId)

// Os modelos vivem fora do editor: trocar de questão mantém texto, desfazer e marcadores.
export function openModel(questionId: string, file: string, text: string, lang: Lang) {
  const uri = fileUri(questionId, file)
  const language = languageFor(file, lang)
  const found = monaco.editor.getModel(uri)
  if (found) {
    if (found.getLanguageId() !== language) monaco.editor.setModelLanguage(found, language)
    return found
  }
  const model = monaco.editor.createModel(text, language, uri)
  // No Windows um arquivo novo nasceria em CRLF, e o texto enviado ao compilador mudaria de forma.
  model.setEOL(monaco.editor.EndOfLineSequence.LF)
  model.updateOptions({ tabSize: 4, insertSpaces: true })
  return model
}

const SEVERITY = {
  error: monaco.MarkerSeverity.Error,
  warning: monaco.MarkerSeverity.Warning,
  note: monaco.MarkerSeverity.Info,
}

// Uma compilação limpa passa aqui com a lista vazia, o que apaga os marcadores antigos.
export function showDiagnostics(questionId: string, log: string) {
  const found = parseDiagnostics(log)
  for (const model of questionModels(questionId)) {
    const file = describeModel(model).file
    const markers = found
      .filter((d) => d.file === file)
      .map((d) => {
        const lineNumber = Math.min(d.line, model.getLineCount())
        const word = model.getWordAtPosition({ lineNumber, column: d.column })
        return {
          severity: SEVERITY[d.severity],
          message: d.message,
          startLineNumber: lineNumber,
          startColumn: word?.startColumn ?? d.column,
          endLineNumber: lineNumber,
          endColumn: word?.endColumn ?? d.column + 1,
        }
      })
    monaco.editor.setModelMarkers(model, MARKER_OWNER, markers)
  }
}
