import type { Lang, Question } from './exam'
import type { Flow, QuestionClocks } from './flow'

// 2: quadro comprimido, prova por partes, teste com o executável do aluno.
export const PROTOCOL_VERSION = 2
export const HUB_ORIGINS = [
  'https://oblita.giuli.dev',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:3067',
  'http://127.0.0.1:3067',
  'https://localhost:3067',
  'https://127.0.0.1:3067',
]
export const HUB_PORT = 7787
// Onde o programa serve o próprio site, independente do oblita.giuli.dev.
export const FRONT_PORT = 3067

export type RoomMode = 'individual' | 'group'
export type Phase = 'lobby' | 'running' | 'ended'

export interface Group {
  id: string
  name: string
}

export const DEFAULT_TEAM_SIZE = 4
export const MAX_Y_UPDATE_BYTES = 512 * 1024

// global: todos começam e terminam juntos. clock-in: cada um começa quando quiser e tem a duração inteira.
export type Timing = 'global' | 'clock-in'

export interface RoomConfig {
  roomId: string
  title: string
  mode: RoomMode
  flow: Flow
  timing: Timing
  compiler: boolean
  requireIsolation: boolean
  recordScreen: boolean
  maxTeamSize: number
  // Equipes criadas pelos alunos. Os códigos ficam fora daqui, para nunca irem junto.
  groups: Group[]
}

export type AlertKind =
  | 'fullscreen-exit'
  | 'focus-lost'
  | 'tab-hidden'
  | 'devtools'
  | 'devtools-shortcut'
  | 'blocked-shortcut'
  | 'share-ended'
  | 'share-invalid'
  | 'internet-back'
  | 'multi-monitor'
  | 'paste'
  | 'reload'
  | 'signal-lost'
  | 'disconnected'
  | 'beacon-missing'

export const ALERT_LABEL: Record<AlertKind, string> = {
  'fullscreen-exit': 'Saiu da tela cheia',
  'focus-lost': 'Saiu da janela',
  'tab-hidden': 'Saiu da aba',
  devtools: 'Abriu o DevTools',
  'devtools-shortcut': 'Atalho do DevTools',
  'blocked-shortcut': 'Atalho bloqueado',
  'share-ended': 'Parou de compartilhar',
  'share-invalid': 'Tela inválida',
  'internet-back': 'Internet voltou',
  'multi-monitor': 'Segundo monitor',
  paste: 'Colou de fora',
  reload: 'Recarregou a página',
  'signal-lost': 'Sem sinal',
  disconnected: 'Desconectou',
  'beacon-missing': 'Prova fora da tela',
}

export const ALERT_SEVERE = new Set<AlertKind>([
  'devtools',
  'devtools-shortcut',
  'share-ended',
  'share-invalid',
  'internet-back',
  'multi-monitor',
  'signal-lost',
  'focus-lost',
  'tab-hidden',
  'beacon-missing',
  'fullscreen-exit',
])

export interface StudentStatus {
  screen: boolean
  fullscreen: boolean
  focused: boolean
  isolated: boolean | null
  extended: boolean
}

export interface ProctorEvent {
  seq: number
  kind: AlertKind
  at: number
  detail?: string
  // SHA-256 do evento anterior + este: um buraco na cadeia mostra evento apagado.
  hash: string
}

export type Answer =
  | { type: 'code'; lang: Lang; files: Record<string, string> }
  | { type: 'choice'; selected: string[] }
  | { type: 'text'; text: string }

// Únicas mensagens em claro: antes do canal cifrado existir, e a recusa de senha errada.
export type TeacherPlain =
  | { t: 'hi'; v: number; code: string; salt: string; nonce: string; pub: string; password: boolean; signPub: string; sig: string }
  | { t: 'refused'; reason: 'password' }

export type StudentPlain = { t: 'key'; pub: string }

// Aluno → professor (sempre cifrado)
export type StudentMsg =
  | { t: 'hello'; v: number; clientId: string; proof?: string; name: string; enrollment?: string; lastEvent: number; lastRec: number; resumed: boolean }
  | { t: 'status'; status: StudentStatus }
  | { t: 'beat'; at: number; status: StudentStatus }
  | { t: 'event'; event: ProctorEvent }
  | { t: 'draft'; questionId: string; answer: Answer; rev: number }
  | { t: 'submit'; seq: number; questionId: string; answer: Answer; at: number }
  | { t: 'finish'; seq: number; at: number }
  | { t: 'team-create'; name: string }
  | { t: 'team-join'; code: string }
  | { t: 'team-leave' }
  | { t: 'y-sync' }
  | { t: 'y-update' }
  | { t: 'y-aware' }
  | { t: 'beacon-frame'; code: number }
  | { t: 'test'; reqId: string; questionId: string; lang: Lang; files: Record<string, string> }
  | StudentMsgV2
  | { t: 'run'; reqId: string; lang: Lang; files: Record<string, string>; stdin: string }
  | { t: 'clock-in' }
  | { t: 'time-sync'; c: number }
  | { t: 'frame'; at: number; focus: boolean }
  | { t: 'rec'; seq: number; segment: number; part: number; startedAt: number; last: boolean; mime: string }

// Professor → aluno (sempre cifrado)
export type TeacherMsg =
  | { t: 'refused'; reason: 'version' | 'ended' | 'identity' | 'full' }
  | { t: 'welcome'; token?: string; config: StudentRoomConfig; phase: Phase; lastEvent: number; lastEventHash?: string; lastRec: number; team?: TeamInfo; drafts?: Record<string, { answer: Answer; rev: number }> }
  | TeacherMsgV2
  | { t: 'clock'; endsAt: number; now: number }
  | { t: 'phase'; phase: Phase }
  | { t: 'ack'; stream: 'event' | 'rec'; seq: number }
  | { t: 'warn'; text: string }
  | { t: 'focus'; on: boolean }
  | { t: 'team'; team: TeamInfo | null }
  | { t: 'team-error'; reason: 'code' | 'full' | 'started' | 'name' }
  | { t: 'group-draft'; questionId: string; answer: Answer; rev: number; by: string }
  | { t: 'y-sync' }
  | { t: 'y-update' }
  | { t: 'y-aware' }
  | { t: 'beacon'; code: number }
  | { t: 'countdown'; seconds: number }
  | { t: 'test-result'; result: TestReport }
  | { t: 'run-result'; result: RunReport }
  | { t: 'time'; c: number; s: number }

// O código só vai para quem já está na equipe.
export interface TeamInfo {
  id: string
  name: string
  code: string
  max: number
  members: { clientId: string; name: string; focused: boolean }[]
}

export const REVEAL_COUNTDOWN_SECONDS = 3
export const TEST_INTERVAL_MS = 60_000
export const HOST_RUN_INTERVAL_MS = 5_000
export const MAX_CODE_BYTES = 256 * 1024
export const MAX_FILES = 20
export const RUN_LIMITS = { memoryMb: 256, timeMs: 5_000, outputKb: 1024 } as const

// Caminho relativo com "/", validado nome a nome, para nunca escapar do diretório ao compilar
// nem ao exportar: sem "..", ".", nome vazio, barra invertida, letra de unidade nem nome reservado do Windows.
export const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,48}\.(c|cc|cpp|h|hpp)$/
const FOLDER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,48}$/
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i
export const MAX_PATH_DEPTH = 4
export const MAX_PATH_CHARS = 120

const folderName = (name: string) => FOLDER_NAME.test(name) && !name.endsWith('.') && !RESERVED.test(name)

export function validFolder(path: string) {
  const parts = path.split('/')
  return path.length <= MAX_PATH_CHARS && parts.length < MAX_PATH_DEPTH && parts.every(folderName)
}

export function validPath(path: string) {
  const parts = path.split('/')
  const name = parts.pop()!
  return path.length <= MAX_PATH_CHARS && parts.length < MAX_PATH_DEPTH && parts.every(folderName) && FILE_NAME.test(name) && !RESERVED.test(name)
}

export function validFiles(files: unknown): files is Record<string, string> {
  if (typeof files !== 'object' || !files) return false
  const entries = Object.entries(files)
  if (!entries.length || entries.length > MAX_FILES) return false
  let total = 0
  for (const [name, content] of entries) {
    if (!validPath(name) || typeof content !== 'string') return false
    total += content.length
  }
  // "a.c" e "a.c/x.h" exigiriam um nome que é arquivo e pasta ao mesmo tempo.
  const names = new Set(entries.map(([name]) => name))
  for (const name of names) {
    for (let i = name.indexOf('/'); i > 0; i = name.indexOf('/', i + 1)) if (names.has(name.slice(0, i))) return false
  }
  return total <= MAX_CODE_BYTES
}

export type RunReport =
  | { reqId: string; status: 'limited'; retryInMs: number }
  | { reqId: string; status: 'compile-error'; log: string }
  | { reqId: string; status: 'done'; log: string; stdout: string; stderr: string; exitCode: number; timedOut: boolean; error?: string }

// Dos testes ocultos o aluno só recebe a contagem. Entrada e saída esperada nunca saem do professor.
export type TestReport =
  | { reqId: string; questionId: string; status: 'limited'; retryInMs: number }
  | { reqId: string; questionId: string; status: 'queued'; position?: number }
  | TestReportV2
  | { reqId: string; questionId: string; status: 'compile-error'; log: string; nextInMs: number }
  | {
      reqId: string
      questionId: string
      status: 'done'
      log: string
      samples: { passed: boolean; stdin: string; expected: string; stdout: string; stderr: string; error?: string }[]
      hidden: { passed: number; total: number }
      nextInMs: number
    }

// O que o aluno vê da configuração. Sem campos de gabarito por construção.
export interface StudentRoomConfig {
  title: string
  mode: RoomMode
  flow: Flow
  timing: Timing
  durationMin: number
  compiler: boolean
  requireIsolation: boolean
  recordScreen: boolean
  maxTeamSize: number
}

// ---- versão 2

// O executável já compilado no aluno vai nos bytes. O professor só roda, e a nota continua
// saindo do código no documento da equipe, compilado lá.
export type StudentMsgV2 = { t: 'test-wasm'; reqId: string; questionId: string; lang: Lang }

export type TeacherMsgV2 =
  // Prova inteira, ao conectar: os bytes são o JSON da prova em deflate-raw, codificado uma vez só
  // para a sala toda.
  | { t: 'exam'; endsAt: number | null; clocks: QuestionClocks; now: number }
  // Liberar e retirar mandam só a diferença. `restore` é questão que o aluno já recebeu nesta
  // conexão e guardou ao ser retirada: volta sem reenviar enunciado nem imagens.
  | { t: 'questions'; add: Question[]; restore: string[]; remove: string[]; order: string[]; clocks: QuestionClocks; now: number }
  // Somar tempo e fim do tempo de uma questão: só os relógios.
  | { t: 'clocks'; clocks: QuestionClocks; now: number }

export type TestReportV2 =
  // Já tem um teste desta equipe esperando ou rodando. Não gasta o minuto.
  | { reqId: string; questionId: string; status: 'busy' }
  // Executável recusado antes de rodar. Também não gasta o minuto.
  | { reqId: string; questionId: string; status: 'invalid'; log: string }

// Teto do que cada lado aceita descomprimir: a prova com imagens de um lado, o executável do outro.
export const MAX_INFLATED_TO_STUDENT = 48 * 1024 * 1024
export const MAX_INFLATED_TO_TEACHER = 9 * 1024 * 1024
