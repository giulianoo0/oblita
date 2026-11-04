import type { Exam, Lang } from './exam'
import type { Flow, QuestionClocks } from './flow'

export const PROTOCOL_VERSION = 1
export const HUB_ORIGINS = ['https://oblita.giuli.dev', 'http://localhost:5173', 'http://localhost:3000']
export const HUB_PORT = 7787

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
  | { t: 'run'; reqId: string; lang: Lang; files: Record<string, string>; stdin: string }
  | { t: 'clock-in' }
  | { t: 'time-sync'; c: number }
  | { t: 'frame'; at: number; focus: boolean }
  | { t: 'rec'; seq: number; segment: number; part: number; startedAt: number; last: boolean; mime: string }

// Professor → aluno (sempre cifrado)
export type TeacherMsg =
  | { t: 'refused'; reason: 'version' | 'ended' | 'identity' | 'full' }
  | { t: 'welcome'; token?: string; config: StudentRoomConfig; phase: Phase; lastEvent: number; lastEventHash?: string; lastRec: number; team?: TeamInfo; drafts?: Record<string, { answer: Answer; rev: number }> }
  | { t: 'exam'; exam: Exam; endsAt: number | null; clocks: QuestionClocks; now: number }
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

// Só nomes simples: nada de pasta, para o nome nunca escapar do diretório ao exportar.
export const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,48}\.(c|cc|cpp|h|hpp)$/

export function validFiles(files: unknown): files is Record<string, string> {
  if (typeof files !== 'object' || !files) return false
  const entries = Object.entries(files)
  if (!entries.length || entries.length > MAX_FILES) return false
  let total = 0
  for (const [name, content] of entries) {
    if (!FILE_NAME.test(name) || typeof content !== 'string') return false
    total += content.length
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
  | { reqId: string; questionId: string; status: 'queued' }
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
