// Confere um par prova e gabarito antes de usar: formato, pontos, e se a referência passa nos próprios testes.
// Uso: bun scripts/check-exam.ts exam.json solutions.json
import { WASI } from 'node:wasi'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runClang } from '@yowasp/clang'
import { checkOutput, validateExam, validateSolutions } from '../shared/exam.ts'

const [examPath, solutionsPath] = process.argv.slice(2)
const { exam, errors } = validateExam(JSON.parse(readFileSync(examPath, 'utf8')))
if (!exam) throw new Error(errors.join('\n'))
const { solutions, errors: solErrors } = validateSolutions(JSON.parse(readFileSync(solutionsPath, 'utf8')), exam)
if (!solutions) throw new Error(solErrors.join('\n'))

let failed = 0
const fail = (text: string) => {
  failed++
  console.log(`FALHOU ${text}`)
}

const dir = mkdtempSync(join(tmpdir(), 'oblita-check-'))
function run(wasm: Uint8Array, stdin: string): Promise<string> {
  const inPath = join(dir, 'in')
  const outPath = join(dir, 'out')
  writeFileSync(inPath, stdin)
  const stdinFd = openSync(inPath, 'r')
  const stdoutFd = openSync(outPath, 'w')
  const wasi = new WASI({ version: 'preview1', args: ['main'], stdin: stdinFd, stdout: stdoutFd })
  return WebAssembly.instantiate(wasm, { wasi_snapshot_preview1: wasi.wasiImport }).then(({ instance }) => {
    wasi.start(instance)
    closeSync(stdinFd)
    closeSync(stdoutFd)
    return readFileSync(outPath, 'utf8')
  })
}

for (const q of exam.questions) {
  const sol = solutions.solutions.find((s) => s.questionId === q.id)
  if (!sol) {
    console.log(`${q.id}: sem gabarito`)
    continue
  }
  if (sol.type !== 'code') {
    console.log(`${q.id}: ok (${sol.type})`)
    continue
  }
  const sum = sol.tests.reduce((n, t) => n + t.points, 0)
  if (sum !== q.points) fail(`${q.id}: testes somam ${sum}, a questão vale ${q.points}`)
  const isC = sol.reference.lang === 'c'
  const name = isC ? 'main.c' : 'main.cpp'
  const files: Record<string, string> = { [name]: sol.reference.code }
  // Mesmos símbolos do compile.worker: sem exceções neste compilador, a libc++ ainda os referencia.
  if (!isC) files['rt.cpp'] = 'extern "C" { void* __cxa_allocate_exception(unsigned long) { __builtin_trap(); } void __cxa_throw(void*, void*, void (*)(void*)) { __builtin_trap(); } }'
  let log = ''
  let out: Record<string, Uint8Array>
  try {
    out = (await runClang([isC ? 'clang' : 'clang++', isC ? '-std=gnu17' : '-std=gnu++20', '-O1', ...Object.keys(files), '-o', 'a.wasm', '-lm'], files, { stdout: null, stderr: (b) => { if (b) log += new TextDecoder().decode(b) } })) as Record<string, Uint8Array>
  } catch {
    fail(`${q.id}: a referência não compilou
${log}`)
    continue
  }
  for (const [i, t] of sol.tests.entries()) {
    const got = await run(out['a.wasm'], t.stdin)
    if (!checkOutput(t.stdout, got, t.checker)) fail(`${q.id} teste ${i + 1}: esperava ${JSON.stringify(t.stdout)}, veio ${JSON.stringify(got)}`)
  }
  const samples = q.type === 'code' ? (q.samples ?? []) : []
  for (const [i, sample] of samples.entries()) {
    const got = await run(out['a.wasm'], sample.stdin)
    if (!checkOutput(sample.stdout, got)) fail(`${q.id} exemplo ${i + 1}: esperava ${JSON.stringify(sample.stdout)}, veio ${JSON.stringify(got)}`)
  }
  console.log(`${q.id}: ${sol.tests.length} testes e ${samples.length} exemplos conferidos`)
}
rmSync(dir, { recursive: true, force: true })
console.log(failed ? `\n${failed} problemas` : '\ntudo certo')
process.exit(failed ? 1 : 0)
