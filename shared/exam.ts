// Formato da prova (exam.json) e do gabarito (solutions.json).
// A prova vai para os alunos; o gabarito nunca sai do navegador do professor.

export type Lang = 'c' | 'cpp'
export type Checker = 'exact' | 'trim' | 'tokens' | 'float'

export interface Sample {
  stdin: string
  stdout: string
}

export interface CodeQuestion {
  id: string
  type: 'code'
  title: string
  statement: string
  points: number
  languages: Lang[]
  starter?: Partial<Record<Lang, string>>
  samples?: Sample[]
}

export interface ChoiceQuestion {
  id: string
  type: 'choice'
  title: string
  statement: string
  points: number
  multiple?: boolean
  options: { id: string; text: string }[]
}

export interface TextQuestion {
  id: string
  type: 'text'
  title: string
  statement: string
  points: number
}

export type Question = CodeQuestion | ChoiceQuestion | TextQuestion

export interface Exam {
  version: 1
  title: string
  durationMin: number
  questions: Question[]
}

export interface HiddenTest {
  stdin: string
  stdout: string
  points: number
  checker?: Checker
  timeoutMs?: number
}

export type Solution =
  | { questionId: string; type: 'code'; reference: { lang: Lang; code: string }; tests: HiddenTest[] }
  | { questionId: string; type: 'choice'; correct: string[] }
  | { questionId: string; type: 'text'; rubric: string }

export interface Solutions {
  version: 1
  solutions: Solution[]
}

// Chaves que só existem em gabarito. Se aparecerem na prova, ela é recusada:
// é o caso de alguém (ou uma LLM) colar a resposta dentro do arquivo errado.
const FORBIDDEN = new Set([
  'solution', 'solutions', 'answer', 'answers', 'correct', 'tests', 'hidden', 'hiddentests',
  'reference', 'rubric', 'expected', 'gabarito', 'resposta', 'respostas',
])

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function findForbidden(v: unknown, path = '$'): string | null {
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const hit = findForbidden(v[i], `${path}[${i}]`)
      if (hit) return hit
    }
  } else if (isObj(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (FORBIDDEN.has(k.toLowerCase())) return `${path}.${k}`
      const hit = findForbidden(val, `${path}.${k}`)
      if (hit) return hit
    }
  }
  return null
}

const str = (v: unknown) => typeof v === 'string' && v.trim().length > 0
const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0

export function validateExam(raw: unknown): { exam?: Exam; errors: string[] } {
  const errors: string[] = []
  if (!isObj(raw)) return { errors: ['O arquivo precisa ser um objeto JSON.'] }
  const leaked = findForbidden(raw)
  if (leaked) return { errors: [`A prova não pode ter gabarito: ${leaked}`] }
  if (raw.version !== 1) errors.push('version precisa ser 1.')
  if (!str(raw.title)) errors.push('title é obrigatório.')
  if (!positive(raw.durationMin)) errors.push('durationMin precisa ser maior que zero.')
  if (!Array.isArray(raw.questions) || raw.questions.length === 0) {
    errors.push('questions precisa ter ao menos uma questão.')
    return { errors }
  }
  const ids = new Set<string>()
  raw.questions.forEach((q: unknown, i: number) => {
    const at = `questions[${i}]`
    if (!isObj(q)) return void errors.push(`${at} inválida.`)
    if (!str(q.id)) errors.push(`${at}.id é obrigatório.`)
    else if (ids.has(q.id as string)) errors.push(`${at}.id repetido: ${q.id}`)
    else ids.add(q.id as string)
    if (!str(q.title)) errors.push(`${at}.title é obrigatório.`)
    if (!str(q.statement)) errors.push(`${at}.statement é obrigatório.`)
    if (!positive(q.points)) errors.push(`${at}.points precisa ser maior que zero.`)
    if (q.type === 'code') {
      const langs = q.languages
      if (!Array.isArray(langs) || !langs.length || !langs.every((l) => l === 'c' || l === 'cpp'))
        errors.push(`${at}.languages aceita "c" e "cpp".`)
    } else if (q.type === 'choice') {
      const opts = q.options
      if (!Array.isArray(opts) || opts.length < 2) errors.push(`${at}.options precisa de ao menos 2 opções.`)
      else if (!opts.every((o) => isObj(o) && str(o.id) && str(o.text)))
        errors.push(`${at}.options precisa de id e text.`)
      else if (new Set(opts.map((o) => (o as { id: string }).id)).size !== opts.length)
        errors.push(`${at}.options tem id repetido.`)
    } else if (q.type !== 'text') {
      errors.push(`${at}.type aceita "code", "choice" e "text".`)
    }
  })
  return errors.length ? { errors } : { exam: raw as unknown as Exam, errors }
}

export function validateSolutions(raw: unknown, exam?: Exam): { solutions?: Solutions; errors: string[] } {
  const errors: string[] = []
  if (!isObj(raw)) return { errors: ['O arquivo precisa ser um objeto JSON.'] }
  if (raw.version !== 1) errors.push('version precisa ser 1.')
  if (!Array.isArray(raw.solutions)) return { errors: [...errors, 'solutions precisa ser uma lista.'] }
  const byId = new Map(exam?.questions.map((q) => [q.id, q]))
  const seen = new Set<string>()
  raw.solutions.forEach((s: unknown, i: number) => {
    const at = `solutions[${i}]`
    if (!isObj(s) || !str(s.questionId)) return void errors.push(`${at}.questionId é obrigatório.`)
    const id = s.questionId as string
    if (seen.has(id)) errors.push(`${at}: questão repetida (${id}).`)
    seen.add(id)
    const q = byId.get(id)
    if (exam && !q) return void errors.push(`${at}: questão ${id} não existe na prova.`)
    if (q && q.type !== s.type) errors.push(`${at}: tipo diferente da questão ${id}.`)
    if (s.type === 'code') {
      const r = s.reference
      if (!isObj(r) || (r.lang !== 'c' && r.lang !== 'cpp') || !str(r.code))
        errors.push(`${at}.reference precisa de lang e code.`)
      if (!Array.isArray(s.tests) || !s.tests.length) errors.push(`${at}.tests precisa de ao menos um teste.`)
      else
        s.tests.forEach((t: unknown, j: number) => {
          if (!isObj(t) || typeof t.stdin !== 'string' || typeof t.stdout !== 'string' || !positive(t.points))
            errors.push(`${at}.tests[${j}] precisa de stdin, stdout e points.`)
        })
    } else if (s.type === 'choice') {
      const c = s.correct
      if (!Array.isArray(c) || !c.length) errors.push(`${at}.correct precisa de ao menos uma opção.`)
      else if (q?.type === 'choice') {
        const valid = new Set(q.options.map((o) => o.id))
        for (const id of c as string[]) if (!valid.has(id)) errors.push(`${at}.correct: opção ${id} não existe.`)
      }
    } else if (s.type !== 'text') {
      errors.push(`${at}.type aceita "code", "choice" e "text".`)
    }
  })
  return errors.length ? { errors } : { solutions: raw as unknown as Solutions, errors }
}

// A única forma da prova que entra na rede: copia campo a campo, então um campo
// desconhecido no JSON original nunca chega ao aluno.
export function examForStudent(exam: Exam): Exam {
  return {
    version: 1,
    title: exam.title,
    durationMin: exam.durationMin,
    questions: exam.questions.map((q): Question => {
      const base = { id: q.id, title: q.title, statement: q.statement, points: q.points }
      if (q.type === 'code')
        return { ...base, type: 'code', languages: q.languages, starter: q.starter, samples: q.samples }
      if (q.type === 'choice')
        return {
          ...base,
          type: 'choice',
          multiple: q.multiple,
          options: q.options.map((o) => ({ id: o.id, text: o.text })),
        }
      return { ...base, type: 'text' }
    }),
  }
}

export function checkOutput(expected: string, actual: string, checker: Checker = 'tokens'): boolean {
  const lf = (s: string) => s.replace(/\r\n/g, '\n')
  const e = lf(expected)
  const a = lf(actual)
  if (checker === 'exact') return e === a
  if (checker === 'trim') {
    const lines = (s: string) => s.trimEnd().split('\n').map((l) => l.trimEnd())
    return lines(e).join('\n') === lines(a).join('\n')
  }
  const te = e.split(/\s+/).filter(Boolean)
  const ta = a.split(/\s+/).filter(Boolean)
  if (te.length !== ta.length) return false
  if (checker === 'tokens') return te.every((t, i) => t === ta[i])
  return te.every((t, i) => {
    const x = Number(t)
    const y = Number(ta[i])
    return t === ta[i] || (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(x)))
  })
}

export const mainFile = (lang: Lang) => (lang === 'c' ? 'main.c' : 'main.cpp')
export const defaultStarter = (lang: Lang) =>
  lang === 'c'
    ? '#include <stdio.h>\n\nint main(void) {\n    \n    return 0;\n}\n'
    : '#include <iostream>\n\nint main() {\n    \n    return 0;\n}\n'
