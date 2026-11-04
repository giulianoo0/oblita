// A lista de arquivos da questão, no jeito do explorador do VS Code: pastas recolhíveis, guias
// de indentação, criar, renomear e apagar. Tudo vai para o documento da equipe.
import { ChevronRight, File, FilePlus, FolderPlus, Pencil, Trash2 } from 'lucide-react'
import { useReducer, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Lang } from '../../shared/exam'
import { MAX_FILES, MAX_PATH_CHARS, MAX_PATH_DEPTH, validFolder, validPath } from '../../shared/protocol'
import type { ExamDoc } from '../collab/examDoc'
import { Modal, Pill } from '../ui/kit'
import type { Peer } from './collabEditor'
import { fileKind, filesInside, visibleRows, type TreeRow } from './fileTree'

// Vive fora do componente, como o arquivo aberto: passar por outra questão não reabre as pastas.
const collapsedOf = new Map<string, Set<string>>()

type Editing =
  | { mode: 'new-file' | 'new-folder'; dir: string; value: string; error?: string }
  | { mode: 'rename'; kind: 'file' | 'folder'; path: string; value: string; error?: string }

const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))
const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
const ancestors = (path: string) => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))
const isSource = (file: string, lang: Lang) => (lang === 'c' ? file.endsWith('.c') : /\.(c|cc|cpp)$/.test(file))
const isHeader = (file: string) => /\.(h|hpp)$/.test(file)

// Selo do tipo, desenhado aqui: C, C++ e H com a letra; o resto com o ícone genérico.
function FileIcon({ path }: { path: string }) {
  const kind = fileKind(path)
  if (kind === 'other') return <File size={14} className="tree-icon" aria-hidden />
  return (
    <svg className={`tree-icon badge-${kind}`} width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <rect x="0.5" y="0.5" width="13" height="13" rx="3.5" />
      {kind === 'cpp' ? (
        <>
          <text className="c" x="4.4" y="7.6">C</text>
          <text className="plus" x="10.2" y="5.2">++</text>
        </>
      ) : (
        <text x="7" y="7.6">{kind === 'c' ? 'C' : 'H'}</text>
      )}
    </svg>
  )
}

// Pontinhos coloridos de quem está ali: na aba da questão e na linha do arquivo.
export function PeerDots({ peers }: { peers: Peer[] }) {
  if (!peers.length) return null
  return (
    <span className="peer-dots" title={peers.map((p) => p.name).join(', ')}>
      {peers.slice(0, 4).map((p) => (
        <i key={p.id} style={{ background: `hsl(${p.hue} 70% 50%)` }} />
      ))}
    </span>
  )
}

function pathError(path: string, folder: boolean) {
  if (path.length > MAX_PATH_CHARS) return 'Caminho longo demais'
  if (path.split('/').length > (folder ? MAX_PATH_DEPTH - 1 : MAX_PATH_DEPTH)) return `No máximo ${MAX_PATH_DEPTH - 1} pastas, uma dentro da outra`
  return folder ? 'Use letras, números, _ e -' : 'Use letras, números e .c, .cpp ou .h'
}

type Props = {
  questionId: string
  lang: Lang
  doc: ExamDoc
  names: string[]
  active: string | null
  peers: Peer[]
  editable: boolean
  onSelect: (file: string, focus?: boolean) => void
}

export function FileExplorer({ questionId, lang, doc, names, active, peers, editable, onSelect }: Props) {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [deleting, setDeleting] = useState<{ kind: 'file' | 'folder'; path: string } | null>(null)
  // Onde o próximo arquivo ou pasta nasce: a pasta clicada, ou a do arquivo clicado.
  const [target, setTarget] = useState('')

  let collapsed = collapsedOf.get(questionId)
  if (!collapsed) collapsedOf.set(questionId, (collapsed = new Set()))
  const fileSet = new Set(names)
  // Uma pasta vazia que colide com um arquivo (dois colegas ao mesmo tempo) fica de fora.
  const folders = doc.folders(questionId).filter((f) => !fileSet.has(f) && !ancestors(f).some((a) => fileSet.has(a)))
  const folderSet = new Set([...folders.flatMap((f) => [...ancestors(f), f]), ...names.flatMap(ancestors)])
  const rows = visibleRows(names, folders, collapsed)
  const sources = names.filter((n) => isSource(n, lang))

  const setCollapsed = (path: string, value: boolean) => {
    if (value) collapsed.add(path)
    else collapsed.delete(path)
    bump()
  }
  const reveal = (path: string) => {
    for (const a of [...ancestors(path), path]) collapsed.delete(a)
  }

  const taken = (path: string, except?: string) =>
    path !== except && (fileSet.has(path) || folderSet.has(path) || ancestors(path).some((a) => fileSet.has(a)))

  const startNew = (mode: 'new-file' | 'new-folder', dir = target) => {
    const at = folderSet.has(dir) ? dir : ''
    reveal(at)
    setEditing({ mode, dir: at, value: '' })
  }

  const fileError = (path: string, from: string | null) => {
    if (!validPath(path)) return pathError(path, false)
    if (lang === 'c' && !/\.[ch]$/.test(path)) return 'Em C, use .c ou .h'
    if (taken(path, from ?? undefined)) return 'Esse nome já existe'
    if (from === null && names.length >= MAX_FILES) return `No máximo ${MAX_FILES} arquivos`
    if (from && isSource(from, lang) && !isSource(path, lang) && sources.length === 1) return 'Precisa de um arquivo de código'
    return null
  }

  const folderError = (path: string, from: string | null) => {
    if (!validFolder(path)) return pathError(path, true)
    if (taken(path, from ?? undefined)) return 'Esse nome já existe'
    if (from === null && folders.length >= MAX_FILES) return `No máximo ${MAX_FILES} pastas vazias`
    // As pastas e arquivos de dentro mudam de caminho junto, e precisam continuar cabendo nos limites.
    if (from && names.some((n) => n.startsWith(`${from}/`) && !validPath(path + n.slice(from.length)))) return pathError(path + names.find((n) => n.startsWith(`${from}/`))!.slice(from.length), false)
    return null
  }

  const commit = () => {
    if (!editing) return
    const raw = editing.value.trim()
    if (!raw) return setEditing(null)
    const fail = (error: string) => setEditing({ ...editing, error })
    if (editing.mode === 'rename') {
      const path = join(dirOf(editing.path), editing.kind === 'file' && !/\.\w+$/.test(raw) ? `${raw}.${lang === 'c' ? 'c' : 'cpp'}` : raw)
      if (path === editing.path) return setEditing(null)
      const error = editing.kind === 'file' ? fileError(path, editing.path) : folderError(path, editing.path)
      if (error) return fail(error)
      if (editing.kind === 'file') doc.renameFile(questionId, editing.path, path)
      else {
        doc.renameFolder(questionId, editing.path, path)
        if (collapsed.delete(editing.path)) collapsed.add(path)
      }
      reveal(dirOf(path))
      if (target === editing.path) setTarget(path)
    } else if (editing.mode === 'new-file') {
      const path = join(editing.dir, /\.\w+$/.test(raw) ? raw : `${raw}.${lang === 'c' ? 'c' : 'cpp'}`)
      const error = fileError(path, null)
      if (error) return fail(error)
      // Todo header novo já nasce protegido contra inclusão dupla.
      doc.addFile(questionId, path, isHeader(path) ? '#pragma once\n' : '')
      reveal(dirOf(path))
      // Sem focar o editor: o Enter que confirmou o nome ainda está em andamento e viraria uma linha nova.
      onSelect(path, false)
    } else {
      const path = join(editing.dir, raw)
      const error = folderError(path, null)
      if (error) return fail(error)
      doc.addFolder(questionId, path)
      reveal(path)
      setTarget(path)
    }
    setEditing(null)
  }

  const onInputKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter') commit()
    if (e.key === 'Escape') setEditing(null)
  }

  const blocked = (row: TreeRow) =>
    row.kind === 'file' ? isSource(row.path, lang) && sources.length === 1 : sources.length > 0 && sources.every((s) => s.startsWith(`${row.path}/`))

  const remove = () => {
    if (!deleting) return
    if (deleting.kind === 'file') doc.removeFile(questionId, deleting.path)
    else {
      doc.removeFolder(questionId, deleting.path)
      for (const path of [...collapsed]) if (path === deleting.path || path.startsWith(`${deleting.path}/`)) collapsed.delete(path)
      if (target === deleting.path || target.startsWith(`${deleting.path}/`)) setTarget('')
    }
    setDeleting(null)
  }

  const activate = (row: TreeRow) => {
    if (row.kind === 'folder') {
      setTarget(row.path)
      setCollapsed(row.path, !collapsed.has(row.path))
    } else {
      setTarget(dirOf(row.path))
      onSelect(row.path)
    }
  }

  const onRowKey = (e: ReactKeyboardEvent<HTMLDivElement>, row: TreeRow) => {
    if (e.target !== e.currentTarget) return
    const move = (step: 1 | -1) => {
      const all = [...(e.currentTarget.closest('.tree')?.querySelectorAll<HTMLElement>('.file') ?? [])]
      all[all.indexOf(e.currentTarget) + step]?.focus()
    }
    if (e.key === 'Enter') activate(row)
    else if (e.key === 'F2') setEditing({ mode: 'rename', kind: row.kind, path: row.path, value: row.name })
    else if ((e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) && !blocked(row)) setDeleting({ kind: row.kind, path: row.path })
    else if (e.key === 'ArrowDown') move(1)
    else if (e.key === 'ArrowUp') move(-1)
    else if (e.key === 'ArrowRight' && row.kind === 'folder') setCollapsed(row.path, false)
    else if (e.key === 'ArrowLeft' && row.kind === 'folder') setCollapsed(row.path, true)
    else return
    e.preventDefault()
  }

  const guides = (depth: number) => Array.from({ length: depth }, (_, i) => <i key={i} className="tree-guide" style={{ left: `calc(var(--tree-pad) + ${i} * var(--tree-indent) + 0.4375rem)` }} />)

  const input = (depth: number, label: string, placeholder?: string) =>
    editing && (
      <div className="tree-edit" style={{ paddingLeft: `calc(var(--tree-pad) + ${depth} * var(--tree-indent) + 1.25rem)` }}>
        {guides(depth)}
        <input className="file-new" autoFocus spellCheck={false} aria-label={label} placeholder={placeholder} value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value, error: undefined })} onKeyDown={onInputKey} onBlur={commit} onFocus={(e) => editing.mode === 'rename' && e.currentTarget.setSelectionRange(0, editing.kind === 'file' && editing.value.lastIndexOf('.') > 0 ? editing.value.lastIndexOf('.') : editing.value.length)} />
      </div>
    )

  const creating = editing && editing.mode !== 'rename' ? editing : null
  const newInput = (depth: number) =>
    creating && input(depth, creating.mode === 'new-file' ? 'Nome do novo arquivo' : 'Nome da nova pasta', creating.mode === 'new-file' ? (lang === 'c' ? 'util.c' : 'util.cpp') : 'lib')

  const deletingCount = deleting?.kind === 'folder' ? filesInside(names, deleting.path).length : 0

  return (
    <>
    <div className="files tree" role="tree" aria-label="Arquivos" inert={!editable} onClick={(e) => e.target === e.currentTarget && setTarget('')}>
      <div className="files-head">
        <span>Arquivos</span>
        <span className="files-actions">
          <button type="button" className="ghost" aria-label="Novo arquivo" title="Novo arquivo" disabled={names.length >= MAX_FILES} onClick={() => startNew('new-file')}>
            <FilePlus size={14} />
          </button>
          <button type="button" className="ghost" aria-label="Nova pasta" title="Nova pasta" onClick={() => startNew('new-folder')}>
            <FolderPlus size={14} />
          </button>
        </span>
      </div>
      {creating?.dir === '' && newInput(0)}
      {rows.map((row) => {
        if (editing?.mode === 'rename' && editing.path === row.path) return <div key={row.path}>{input(row.depth, `Novo nome de ${row.name}`)}</div>
        const open = row.kind === 'folder' && !collapsed.has(row.path)
        const here = peers.filter((p) => p.q === questionId && p.file && (row.kind === 'file' ? p.file === row.path : !open && p.file.startsWith(`${row.path}/`)))
        return (
          <div key={row.path} className="tree-node">
            <div
              className={`file ${row.kind}`}
              role="treeitem"
              tabIndex={0}
              aria-level={row.depth + 1}
              aria-expanded={row.kind === 'folder' ? open : undefined}
              aria-selected={row.kind === 'file' ? row.path === active : undefined}
              title={row.path}
              style={{ paddingLeft: `calc(var(--tree-pad) + ${row.depth} * var(--tree-indent))` }}
              onClick={() => activate(row)}
              onDoubleClick={() => setEditing({ mode: 'rename', kind: row.kind, path: row.path, value: row.name })}
              onKeyDown={(e) => onRowKey(e, row)}
            >
              {guides(row.depth)}
              {row.kind === 'folder' ? <ChevronRight size={14} className="tree-chevron" aria-hidden /> : <span className="tree-twistie" />}
              {row.kind === 'file' && <FileIcon path={row.path} />}
              <span className="file-name">{row.name}</span>
              <PeerDots peers={here} />
              {row.kind === 'folder' && (
                <button type="button" className="x" aria-label={`Novo arquivo em ${row.path}`} title="Novo arquivo aqui" disabled={names.length >= MAX_FILES} onClick={(e) => { e.stopPropagation(); startNew('new-file', row.path) }}>
                  <FilePlus size={12} />
                </button>
              )}
              <button type="button" className="x" aria-label={`Renomear ${row.path}`} title="Renomear (F2)" onClick={(e) => { e.stopPropagation(); setEditing({ mode: 'rename', kind: row.kind, path: row.path, value: row.name }) }}>
                <Pencil size={12} />
              </button>
              <button type="button" className="x" aria-label={`Apagar ${row.path}`} title="Apagar" disabled={blocked(row)} onClick={(e) => { e.stopPropagation(); setDeleting({ kind: row.kind, path: row.path }) }}>
                <Trash2 size={12} />
              </button>
            </div>
            {row.kind === 'folder' && creating?.dir === row.path && newInput(row.depth + 1)}
          </div>
        )
      })}
      {editing?.error && <div className="files-error" role="alert">{editing.error}</div>}
    </div>
      <Modal open={deleting !== null} title={`Apagar ${deleting ? baseOf(deleting.path) : ''}?`} onClose={() => setDeleting(null)}>
        <p className="tree-confirm">
          {deleting?.kind === 'folder'
            ? deletingCount === 0
              ? 'A pasta está vazia.'
              : deletingCount === 1
                ? 'O arquivo dentro dela também vai ser apagado, para toda a equipe.'
                : `Os ${deletingCount} arquivos dentro dela também vão ser apagados, para toda a equipe.`
            : 'O arquivo vai ser apagado para toda a equipe.'}
        </p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Pill onClick={() => setDeleting(null)}>Manter</Pill>
          <Pill tone="danger" onClick={remove}>
            Apagar
          </Pill>
        </div>
      </Modal>
    </>
  )
}
