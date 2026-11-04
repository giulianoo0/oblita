// Quem pode fazer o quê, em um lugar só. O professor aplica; o aluno nunca é confiável.
import type { Phase, RoomMode, StudentMsg } from './protocol'

export interface PolicyContext {
  phase: Phase
  mode: RoomMode
  examSent: boolean
  closed: boolean
  hasGroup: boolean
  testsEnabled: boolean
  finished: boolean
}

type Rule = (c: PolicyContext) => boolean

const always: Rule = () => true
const inExam: Rule = (c) => c.phase === 'running' && c.examSent && !c.closed && !c.finished

const RULES: Record<Exclude<StudentMsg['t'], 'hello'>, Rule> = {
  status: always,
  beat: always,
  event: always,
  frame: always,
  rec: always,
  'time-sync': always,
  draft: inExam,
  submit: inExam,
  finish: (c) => c.examSent,
  run: inExam,
  test: (c) => inExam(c) && c.testsEnabled,
  'y-sync': inExam,
  'y-update': inExam,
  'y-aware': (c) => inExam(c) && c.mode === 'group',
  'beacon-frame': inExam,
  'team-create': (c) => c.mode === 'group' && !c.hasGroup && !c.examSent && c.phase !== 'ended',
  'team-join': (c) => c.mode === 'group' && !c.hasGroup && !c.examSent && c.phase !== 'ended',
  'team-leave': (c) => c.mode === 'group' && c.hasGroup && !c.examSent && c.phase !== 'ended',
  'clock-in': (c) => c.phase === 'running' && !c.examSent && !c.closed,
}

export function isAllowed(type: string, ctx: PolicyContext) {
  return Object.hasOwn(RULES, type) && RULES[type as keyof typeof RULES](ctx)
}

// Mensagens por segundo, com folga para rajada depois de reconectar.
const LIMITS: Record<string, { rate: number; burst: number }> = {
  beat: { rate: 2, burst: 10 },
  status: { rate: 10, burst: 40 },
  event: { rate: 20, burst: 2000 },
  frame: { rate: 5, burst: 20 },
  rec: { rate: 10, burst: 4000 },
  draft: { rate: 20, burst: 200 },
  submit: { rate: 10, burst: 200 },
  finish: { rate: 1, burst: 200 },
  run: { rate: 2, burst: 5 },
  test: { rate: 2, burst: 5 },
  'y-sync': { rate: 2, burst: 20 },
  'y-update': { rate: 60, burst: 2000 },
  'y-aware': { rate: 30, burst: 200 },
  'beacon-frame': { rate: 2, burst: 10 },
  'team-create': { rate: 1, burst: 5 },
  'team-join': { rate: 1, burst: 5 },
  'team-leave': { rate: 1, burst: 5 },
  'clock-in': { rate: 1, burst: 5 },
  'time-sync': { rate: 2, burst: 10 },
}

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>()

  allow(type: string, now = Date.now()) {
    const limit = LIMITS[type]
    if (!limit) return false
    const bucket = this.buckets.get(type) ?? { tokens: limit.burst, at: now }
    bucket.tokens = Math.min(limit.burst, bucket.tokens + ((now - bucket.at) / 1000) * limit.rate)
    bucket.at = now
    this.buckets.set(type, bucket)
    if (bucket.tokens < 1) return false
    bucket.tokens--
    return true
  }
}
