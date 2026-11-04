// O que cada pessoa ou equipe pode ver e editar em cada modo. Função pura: o professor decide com isto.
import { examForStudent, type Exam } from './exam'

// Livre: todas as questões de uma vez, com tempo total. Manual: o professor libera e retira ao vivo.
export type Flow = 'free' | 'manual'

export interface QuestionClock {
  releasedAt: number
  endsAt: number | null
  closed: boolean
  // Retirada sai da tela do aluno. Fechada por tempo continua visível, só sem editar.
  withdrawn: boolean
}

export type QuestionClocks = Record<string, QuestionClock>

export function isVisible(flow: Flow, clock: QuestionClock | undefined) {
  return flow === 'free' || (!!clock && !clock.withdrawn)
}

export function isOpen(flow: Flow, clock: QuestionClock | undefined, now: number) {
  if (flow === 'free') return true
  if (!clock || clock.withdrawn || clock.closed) return false
  return clock.endsAt === null || now < clock.endsAt
}

// A única forma de a prova sair do professor: o que não está visível nem existe aqui.
export function visibleExam(exam: Exam, flow: Flow, clocks: QuestionClocks): Exam {
  const safe = examForStudent(exam)
  return { ...safe, questions: safe.questions.filter((q) => isVisible(flow, clocks[q.id])) }
}

export function release(clocks: QuestionClocks, id: string, now: number, minutes?: number): QuestionClocks {
  const endsAt = minutes && minutes > 0 ? now + minutes * 60_000 : null
  return { ...clocks, [id]: { releasedAt: clocks[id]?.releasedAt ?? now, endsAt, closed: false, withdrawn: false } }
}

export function withdraw(clocks: QuestionClocks, id: string): QuestionClocks {
  const clock = clocks[id]
  return clock ? { ...clocks, [id]: { ...clock, closed: true, withdrawn: true } } : clocks
}

export function addTime(clocks: QuestionClocks, id: string, minutes: number, now: number): QuestionClocks {
  const clock = clocks[id]
  if (!clock || clock.endsAt === null) return clocks
  return { ...clocks, [id]: { ...clock, closed: false, endsAt: Math.max(clock.endsAt, now) + minutes * 60_000 } }
}

// Questões cujo tempo acabou agora e que precisam ter a resposta congelada.
export function expiredQuestions(clocks: QuestionClocks, now: number) {
  return Object.entries(clocks)
    .filter(([, c]) => !c.closed && c.endsAt !== null && now >= c.endsAt)
    .map(([id]) => id)
}
