// A lista de arquivos da questão como árvore: os caminhos são planos no documento, as pastas
// vêm deles e das pastas criadas vazias.

export interface TreeRow {
  kind: 'folder' | 'file'
  path: string
  name: string
  depth: number
}

interface Folder {
  folders: Map<string, Folder>
  files: string[]
}

const order = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0)

// Só as linhas à mostra: o que está dentro de pasta recolhida fica de fora.
export function visibleRows(files: string[], folders: string[], collapsed: Set<string>): TreeRow[] {
  const root: Folder = { folders: new Map(), files: [] }
  const folderAt = (parts: string[]) => {
    let dir = root
    for (const part of parts) {
      let next = dir.folders.get(part)
      if (!next) dir.folders.set(part, (next = { folders: new Map(), files: [] }))
      dir = next
    }
    return dir
  }
  for (const path of folders) folderAt(path.split('/'))
  for (const path of files) {
    const parts = path.split('/')
    folderAt(parts.slice(0, -1)).files.push(parts[parts.length - 1])
  }

  const rows: TreeRow[] = []
  const walk = (dir: Folder, prefix: string, depth: number) => {
    for (const name of [...dir.folders.keys()].sort(order)) {
      const path = prefix + name
      rows.push({ kind: 'folder', path, name, depth })
      if (!collapsed.has(path)) walk(dir.folders.get(name)!, `${path}/`, depth + 1)
    }
    for (const name of dir.files.sort(order)) rows.push({ kind: 'file', path: prefix + name, name, depth })
  }
  walk(root, '', 0)
  return rows
}

export const filesInside = (files: string[], folder: string) => files.filter((f) => f.startsWith(`${folder}/`))

export type FileKind = 'c' | 'cpp' | 'h' | 'other'

export function fileKind(path: string): FileKind {
  if (path.endsWith('.c')) return 'c'
  if (/\.(cpp|cc)$/.test(path)) return 'cpp'
  if (/\.(h|hpp)$/.test(path)) return 'h'
  return 'other'
}
