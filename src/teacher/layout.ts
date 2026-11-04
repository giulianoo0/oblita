// Estrutura de pastas da sala, a mesma no zip e na pasta de gravação (SPEC §14).
// Todo nome que vem do aluno, da equipe ou da prova passa por safeName antes de virar caminho;
// o programa do professor confere de novo do lado dele.
import { ALERT_LABEL, type AlertKind } from '../../shared/protocol'
import type { AlertEntry, Grade, Room, SegmentInfo, Student, Team } from './room'

export type LayoutRoom = Pick<Room, 'config' | 'exam' | 'students' | 'teams' | 'alerts' | 'teamOf' | 'scoreOf' | 'resultsCsv'>

// `stamp` diz quando o texto não mudou sem precisar montá-lo: a prova pode ter 12 MB.
export type LayoutEntry = { path: string; text: () => string; stamp?: unknown } | { path: string; segment: { clientId: string; info: SegmentInfo } }

// Sala salva antes da validação pode ter `kind` lixo, e "constructor" devolveria uma função.
export const alertLabel = (kind: string) => (Object.hasOwn(ALERT_LABEL, kind) ? ALERT_LABEL[kind as AlertKind] : String(kind))

// O Windows conta em UTF-16, então o corte também: um único caminho acima de 260 faz o
// Expand-Archive desfazer a extração inteira. Sem cortar um emoji pela metade.
function cut(text: string, max: number) {
  let out = ''
  for (const ch of text) {
    if (out.length + ch.length > max) break
    out += ch
  }
  return out
}

// O nome vem digitado pelo aluno. Sem isto, "../../x" escreveria fora da pasta ao extrair,
// "aux.h" travaria a extração no Windows, e um caractere de direção disfarçaria a extensão.
export function safeName(name: string) {
  const bare = String(name)
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, '_')
  const clean = cut(bare, 80)
    .trim()
    .replace(/^\.+/, '_')
    .replace(/[. ]+$/, '')
  return /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])\s*(\.|$)/i.test(clean) || !clean ? `_${clean}` : clean
}

const two = (n: number) => String(n).padStart(2, '0')

// Uma pasta por prova, com a hora em que a sala foi criada: duas turmas no mesmo dia não se misturam.
export function roomFolder(title: string, createdAt: number) {
  const d = new Date(createdAt)
  const when = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}h${two(d.getMinutes())}`
  return safeName(`${cut(safeName(title), 60)} ${when}`)
}

// No Windows "Main.cpp" e "main.cpp" são o mesmo arquivo: um apagaria o outro ao extrair.
const unique = (used: Set<string>, name: string, tail = '') => {
  let out = name + tail
  for (let i = 2; used.has(out.toLowerCase()); i++) out = `${name} (${i})${tail}`
  used.add(out.toLowerCase())
  return out
}

const uniqueFile = (used: Set<string>, name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? unique(used, name.slice(0, dot), name.slice(dot)) : unique(used, name)
}

const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')

// Fórmula em CSV roda ao abrir no Excel, e o detalhe do alerta vem do aluno.
const csvCell = (value: string) => {
  const text = oneLine(value).replace(/"/g, '""')
  return `"${/^[=+\-@]/.test(text) ? `'${text}` : text}"`
}

// O mime vem do aluno: só duas extensões possíveis.
const ext = (mime: string) => (mime.includes('mp4') ? 'mp4' : 'webm')
const label = (s: Student) => (s.enrollment ? `${s.name} (${s.enrollment})` : s.name)
const date = (t?: number) => (t ? new Date(t).toLocaleString('pt-BR') : '')
const hasWork = (team: Team) => Object.keys(team.answers).length > 0 || Object.keys(team.submissions).length > 0

function gradeText(g: Grade | undefined) {
  if (!g) return 'sem nota'
  const lines = [`${g.points} de ${g.max} pontos`]
  if (g.status === 'manual') lines[0] += g.graded ? ' (correção manual)' : ' (falta corrigir)'
  if (g.status === 'compile-error') lines.push('', 'Não compilou:', g.compileLog ?? '')
  for (const t of g.tests ?? []) {
    lines.push(`teste ${t.index + 1}: ${t.passed ? 'passou' : t.timedOut ? 'tempo esgotado' : 'falhou'} (${t.points} pts)`)
  }
  return lines.join('\n')
}

function teamEntries(room: LayoutRoom, team: Team, dir: string, members: Student[], alertsOf: Map<string, AlertEntry[]>, teamName?: string) {
  const out: LayoutEntry[] = []
  const text = (path: string, content: string) => out.push({ path, text: () => content })
  const score = room.scoreOf(team)
  const info = [
    ...(teamName ? [`Equipe: ${oneLine(teamName)}`] : []),
    `Pontos: ${score.earned} de ${score.total}`,
    '',
    ...members.map((s) => `${oneLine(label(s))}; alertas: ${s.alerts}; entregou: ${date(s.finishedAt) || 'não'}`),
    '',
    ...room.exam.questions.map((q) => `${q.id} ${oneLine(q.title)}: ${team.grades[q.id]?.points ?? 0}/${q.points}`),
  ]
  text(`${dir}/resumo.txt`, info.join('\n') + '\n')

  // Um aluno chamado "q1" ou "resumo.txt" não pode cair em cima da questão nem do resumo.
  const names = new Set(['resumo.txt', 'alertas.csv', 'gravacao'])
  for (const q of room.exam.questions) {
    const sub = team.submissions[q.id]
    const answer = sub?.answer ?? team.answers[q.id]?.answer
    const base = `${dir}/${unique(names, safeName(q.id))}`
    if (answer?.type === 'code') {
      const files = new Set(['nota.txt'])
      for (const [name, content] of Object.entries(answer.files)) text(`${base}/${uniqueFile(files, safeName(name))}`, content)
    } else if (answer?.type === 'text') text(`${base}/resposta.txt`, answer.text)
    else if (answer?.type === 'choice') text(`${base}/resposta.txt`, answer.selected.join(', ') + '\n')
    else text(`${base}/sem-resposta.txt`, '')
    text(`${base}/nota.txt`, gradeText(team.grades[q.id]) + '\n')
  }

  for (const s of members) {
    const who = teamName !== undefined ? `${dir}/${unique(names, safeName(label(s)))}` : dir
    const alerts = [...(alertsOf.get(s.clientId) ?? [])].reverse()
    const rows = ['hora;evento;detalhe', ...alerts.map((a) => [date(a.at), alertLabel(a.kind), a.detail ?? ''].map(csvCell).join(';'))]
    text(`${who}/alertas.csv`, '\ufeff' + rows.join('\n') + '\n')
    // O número do segmento veio do aluno e vira nome de arquivo.
    const segments = Object.values(s.segments).filter((seg) => Number.isSafeInteger(seg.segment) && seg.segment >= 0)
    for (const seg of segments.sort((a, b) => a.segment - b.segment)) {
      out.push({ path: `${who}/gravacao/${String(seg.segment).padStart(4, '0')}.${ext(seg.mime)}`, segment: { clientId: s.clientId, info: seg } })
    }
  }
  return out
}

// Um grupo de entradas por pessoa ou equipe, depois do primeiro com os arquivos da sala.
// Só lê o que é público da sala: token, chave e códigos de equipe nunca passam por aqui.
export function roomLayout(room: LayoutRoom): LayoutEntry[][] {
  const units: LayoutEntry[][] = [
    [
      { path: 'resumo.csv', text: () => '\ufeff' + room.resultsCsv() + '\n' },
      { path: 'prova.json', text: () => JSON.stringify(room.exam, null, 2), stamp: room.exam },
    ],
  ]
  const alertsOf = new Map<string, AlertEntry[]>()
  for (const a of room.alerts) {
    const list = alertsOf.get(a.clientId)
    if (list) list.push(a)
    else alertsOf.set(a.clientId, [a])
  }
  const students = [...room.students.values()]
  const teamMode = room.config.mode === 'group'
  const groups = teamMode ? room.config.groups : []
  const known = new Set(groups.map((g) => g.id))
  const loose = students.filter((s) => !teamMode || !s.groupId || !known.has(s.groupId))
  const teamDirs = new Set<string>()
  for (const g of groups) {
    const members = students.filter((s) => s.groupId === g.id)
    // Sem integrantes, ainda vale se fez a prova: o professor pode ter movido todo mundo.
    const team = members[0] ? room.teamOf(members[0]) : room.teams.get(`g:${g.id}`)
    if (team && (members.length || hasWork(team))) units.push(teamEntries(room, team, `grupos/${unique(teamDirs, safeName(g.name))}`, members, alertsOf, g.name))
    else units.push([])
  }
  const studentDirs = new Set<string>()
  for (const s of loose) units.push(teamEntries(room, room.teamOf(s), `alunos/${unique(studentDirs, safeName(label(s)))}`, [s], alertsOf))
  return units
}
