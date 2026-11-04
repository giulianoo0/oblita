import { compile, parseDiagnostics, run } from '../src/compiler/client'
import type { CompileResult, RunResult } from '../src/compiler/client'
import { RUN_LIMITS } from '../shared/protocol'
import { cases, SANITY_SRC } from './cases'
import type { Case, Expect, Outcome, ScenarioApi } from './cases'

const clip = (s: string | undefined, n = 400) => (s === undefined ? undefined : s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s)

function matches(want: string | RegExp, got: string) {
  return typeof want === 'string' ? want === got : want.test(got)
}

function verify(e: Expect, o: Outcome): string[] {
  const f: string[] = []
  const show = (s: string) => JSON.stringify(clip(s, 200))
  const wantCompile = e.compile ?? 'ok'
  if (!e.anyCompile) {
    if (wantCompile === 'ok' && !o.compile.ok) f.push(`não compilou: ${clip(o.log, 500)}`)
    if (wantCompile === 'error' && o.compile.ok) f.push('compilou, devia dar erro')
  }
  if (e.internal !== undefined && !o.compile.ok && !!o.compile.internal !== e.internal) f.push(`internal=${o.compile.ok ? '' : o.compile.internal}: ${clip(o.log, 300)}`)
  if (e.log && !e.log.test(o.log)) f.push(`log sem ${e.log}: ${clip(o.log, 500)}`)
  if (e.logNot && e.logNot.test(o.log)) f.push(`log tem ${e.logNot}: ${clip(o.log, 300)}`)
  if (e.diags) {
    const got = parseDiagnostics(o.log)
    for (const d of e.diags) {
      const hit = got.some((g) => g.file === d.file && g.line === d.line && (d.column === undefined || g.column === d.column) && (d.severity === undefined || g.severity === d.severity) && (!d.message || d.message.test(g.message)))
      if (!hit) f.push(`diagnóstico ausente ${JSON.stringify({ ...d, message: String(d.message ?? '') })}; recebidos ${JSON.stringify(got).slice(0, 500)}`)
    }
  }
  const r = o.run
  if (r) {
    const silent = e.exit === undefined && e.error === undefined && e.timedOut === undefined && !e.anyExit
    if (silent) {
      if (r.exitCode !== 0) f.push(`código ${r.exitCode}, erro ${r.error}; stderr ${show(r.stderr)}`)
      if (r.error) f.push(`erro de execução: ${r.error}`)
      if (r.timedOut) f.push('tempo esgotado')
    }
    if (e.exit !== undefined && r.exitCode !== e.exit) f.push(`código ${r.exitCode}, esperado ${e.exit} (erro: ${r.error})`)
    if (e.timedOut !== undefined && r.timedOut !== e.timedOut) f.push(`timedOut=${r.timedOut}`)
    if (e.error === null && r.error) f.push(`erro inesperado: ${r.error}`)
    if (e.error && !e.error.test(r.error ?? '')) f.push(`erro ${JSON.stringify(r.error)} não bate com ${e.error}`)
    if (e.stdout !== undefined && !matches(e.stdout, r.stdout)) f.push(`stdout ${show(r.stdout)}, esperado ${typeof e.stdout === 'string' ? show(e.stdout) : e.stdout}`)
    if (e.stderr !== undefined && !matches(e.stderr, r.stderr)) f.push(`stderr ${show(r.stderr)}, esperado ${typeof e.stderr === 'string' ? show(e.stderr) : e.stderr}`)
    if (e.merged !== undefined && !matches(e.merged, o.merged)) f.push(`ordem ${show(o.merged)}, esperada ${typeof e.merged === 'string' ? show(e.merged) : e.merged}`)
  } else if (wantCompile === 'ok' && !e.anyCompile && o.compile.ok) f.push('não executou')
  const extra = e.check?.(o)
  if (extra) f.push(extra)
  return f
}

async function mustCompile(lang: 'c' | 'cpp', src: string) {
  const r = await compile(lang, { [lang === 'c' ? 'main.c' : 'main.cpp']: src })
  if (!r.ok) throw new Error(`não compilou: ${r.log}`)
  return r.wasm
}

const api: ScenarioApi = { compile, run, parseDiagnostics, mustCompile }

// Mede quanto a página ficou sem responder durante o caso.
function lagMeter() {
  let last = performance.now()
  let max = 0
  const t = setInterval(() => {
    const now = performance.now()
    max = Math.max(max, now - last - 20)
    last = now
  }, 20)
  return () => {
    clearInterval(t)
    return Math.round(max)
  }
}

async function runCase(id: string) {
  const c = cases.find((x) => x.id === id) as Case
  const stopLag = lagMeter()
  const base = { id, group: c.group, note: c.note }
  const t0 = performance.now()
  try {
    if (c.scenario) {
      const r = await c.scenario(api)
      return { ...base, status: r.failures.length ? 'fail' : 'pass', failures: r.failures, notes: r.notes, metrics: r.metrics, totalMs: Math.round(performance.now() - t0), lagMs: stopLag() }
    }
    const built: CompileResult = await compile(c.lang as 'c' | 'cpp', c.files as Record<string, string>)
    const compileMs = Math.round(performance.now() - t0)
    let rr: RunResult | undefined
    let merged = ''
    let runMs = 0
    if (built.ok) {
      const t1 = performance.now()
      rr = await run(built.wasm, c.stdin ?? '', c.timeoutMs ?? RUN_LIMITS.timeMs, (_s, text) => {
        merged += text
      })
      runMs = Math.round(performance.now() - t1)
    }
    const o: Outcome = { compile: built, run: rr, merged, log: built.log }
    const failures = verify(c, o)
    if (c.maxCompileMs && compileMs > c.maxCompileMs) failures.push(`compilação em ${compileMs} ms, máximo ${c.maxCompileMs}`)
    const lagMs = stopLag()
    if (c.maxLagMs && lagMs > c.maxLagMs) failures.push(`a página travou ${lagMs} ms, máximo ${c.maxLagMs}`)
    let status = failures.length ? 'fail' : 'pass'
    let limit: string | undefined
    const reason: string[] = []
    if (c.knownLimit) {
      if (failures.length) {
        const again = c.knownLimit.actual ? verify(c.knownLimit.actual, o) : []
        if (!again.length) {
          status = 'known'
          limit = c.knownLimit.reason
        } else reason.push(...again.map((x) => `real: ${x}`))
      }
    }
    return {
      ...base,
      status,
      failures: status === 'known' ? [] : [...failures, ...reason],
      limit,
      compileMs,
      runMs,
      lagMs,
      notes: c.knownLimit && !failures.length ? ['passou: o limite conhecido não se confirmou nesta execução'] : undefined,
      actual: {
        compiled: built.ok,
        internal: built.ok ? undefined : built.internal,
        log: clip(built.log, 600),
        stdout: clip(rr?.stdout),
        stderr: clip(rr?.stderr),
        stdoutLen: rr?.stdout.length,
        stderrLen: rr?.stderr.length,
        exitCode: rr?.exitCode,
        timedOut: rr?.timedOut,
        error: rr?.error,
      },
    }
  } catch (err) {
    return { ...base, status: 'fail', failures: [`exceção no harness: ${String(err)}`], totalMs: Math.round(performance.now() - t0), lagMs: stopLag() }
  }
}

async function sanity() {
  const t0 = performance.now()
  const r = await compile('c', { 'main.c': SANITY_SRC })
  const compileMs = Math.round(performance.now() - t0)
  if (!r.ok) return { ok: false, detail: `sanity não compilou: ${r.log}`, compileMs, runMs: 0 }
  const t1 = performance.now()
  const o = await run(r.wasm, '41', RUN_LIMITS.timeMs)
  const runMs = Math.round(performance.now() - t1)
  const ok = o.stdout === 'sanity 42\n' && o.exitCode === 0
  return { ok, detail: ok ? '' : `sanity: ${JSON.stringify(o)}`, compileMs, runMs }
}

// ------------------------------------------------- medições que o processo Node comanda

const STL_SRC = `#include <algorithm>
#include <iostream>
#include <map>
#include <string>
#include <vector>
int main() { std::vector<int> v{3, 1, 2}; std::sort(v.begin(), v.end()); std::map<std::string, int> m{{"a", v[0]}}; std::cout << m["a"] << std::endl; }
`
let seq = 0
async function compileOnce(i: number) {
  const t0 = performance.now()
  const r = await compile('cpp', { 'main.cpp': `// ${i}\n${STL_SRC}` })
  const ms = Math.round(performance.now() - t0)
  let out = ''
  if (r.ok) out = (await run(r.wasm, '', RUN_LIMITS.timeMs)).stdout
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory
  return { ms, ok: r.ok && out === '1\n', heapUsed: mem?.usedJSHeapSize ?? 0, heapTotal: mem?.totalJSHeapSize ?? 0 }
}

const BURNERS: (Promise<RunResult> & { kill: () => void })[] = []
let burnWasm: Uint8Array<ArrayBuffer> | null = null
// Compila antes e separado: a otimização do clang em segundo plano sujaria a medida de CPU.
async function burnPrepare() {
  burnWasm = await mustCompile('c', 'int main(void) { volatile int x = 1; while (x) { } return 0; }\n')
}
async function burnStart(n: number) {
  for (let i = 0; i < n; i++) BURNERS.push(run(burnWasm as Uint8Array<ArrayBuffer>, '', 120_000))
  return n
}
async function burnStop() {
  const t0 = performance.now()
  BURNERS.forEach((b) => b.kill())
  const res = await Promise.all(BURNERS)
  BURNERS.length = 0
  return { killMs: Math.round(performance.now() - t0), all: res.every((r) => /Interrompido/.test(r.error ?? '')) }
}
async function burnTimeout(n: number, ms: number) {
  const res = await Promise.all(Array.from({ length: n }, () => run(burnWasm as Uint8Array<ArrayBuffer>, '', ms)))
  return res.every((r) => r.timedOut)
}

function workerCompile(w: Worker, args: string[], files: Record<string, string>) {
  return new Promise<{ ok: boolean; wasm: Uint8Array<ArrayBuffer> | null; log: string; ms: number }>((resolve, reject) => {
    const id = ++seq
    const t = setTimeout(() => reject(new Error('compile de medição passou de 180 s')), 180_000)
    w.onmessage = ({ data }) => {
      if (data.id !== id) return
      clearTimeout(t)
      resolve(data)
    }
    w.onerror = (e) => {
      clearTimeout(t)
      reject(new Error(e.message))
    }
    w.postMessage({ id, args, files })
  })
}

// O mínimo resiste melhor à carga de outros processos na máquina do que a mediana.
const best = (a: number[]) => Math.min(...a)
const STUB = 'extern "C" { void *__cxa_allocate_exception(unsigned long) { return 0; } void __cxa_throw(void *, void *, void (*)(void *)) { __builtin_trap(); } }\n'
const LINK = ['-Wl,-z,stack-size=8388608', '-Wl,--max-memory=268435456']
const HELLO_C = '#include <stdio.h>\nint main(void) { puts("oi"); return 0; }\n'
const BENCH_CPP = `#include <algorithm>
#include <iostream>
#include <map>
#include <string>
#include <vector>
int main() {
  std::vector<int> v(1000000);
  unsigned x = 12345;
  for (auto &e : v) { x = x * 1664525u + 1013904223u; e = x >> 8; }
  std::sort(v.begin(), v.end());
  std::map<int, int> m;
  for (int i = 0; i < 100000; i++) m[v[i * 7]] += i;
  std::string s;
  for (int i = 0; i < 200000; i++) s += char('a' + i % 26);
  long long t = 0;
  for (int i = 0; i < 40000000; i++) t += i ^ (i >> 3);
  std::cout << v[5] % 7 << ' ' << m.size() << ' ' << s.size() << ' ' << t % 13 << std::endl;
}
`
const BENCH_C = `#include <stdio.h>
#include <stdlib.h>
int main(void) { int n = 2000000; int *v = malloc(n * sizeof *v); unsigned x = 1; for (int i = 0; i < n; i++) { x = x * 1664525u + 1013904223u; v[i] = x >> 8; } long long t = 0; for (int r = 0; r < 20; r++) for (int i = 0; i < n; i++) t += v[i] ^ r; printf("%lld\\n", t % 13); return 0; }
`

async function benchFlags() {
  const out: Record<string, unknown> = {}
  const mk = () => new Worker(new URL('./flags.worker.ts', import.meta.url), { type: 'module' })
  // cada worker novo busca e compila o llvm.core.wasm de novo: esse é o custo a frio
  let w = mk()
  const COLD_C = ['clang', '-std=c17', '-O1', 'main.c', '-o', 'main.wasm', '-lm', ...LINK]
  const coldC: number[] = []
  for (let i = 0; i < 3; i++) {
    w.terminate()
    w = mk()
    coldC.push(Math.round((await workerCompile(w, COLD_C, { 'main.c': HELLO_C })).ms))
  }
  const warmC: number[] = []
  for (let i = 0; i < 4; i++) warmC.push((await workerCompile(w, COLD_C, { 'main.c': HELLO_C })).ms)
  out.c = { frioMs: coldC, mornoMs: Math.round(best(warmC)) }
  w.terminate()
  w = mk()
  const COLD_CPP = ['clang++', '-std=c++20', '-O1', 'main.cpp', 'rt.cpp', '-o', 'main.wasm', '-lm', ...LINK]
  const c2 = await workerCompile(w, COLD_CPP, { 'main.cpp': STL_SRC, 'rt.cpp': STUB })
  const warmCpp: number[] = []
  for (let i = 0; i < 6; i++) warmCpp.push((await workerCompile(w, COLD_CPP, { 'main.cpp': STL_SRC, 'rt.cpp': STUB })).ms)
  out.cppStl = { frioMs: Math.round(c2.ms), mornoMs: warmCpp.map(Math.round), ok: c2.ok, log: clip(c2.log, 200) }
  const table: Record<string, unknown> = {}
  for (const [name, flag] of [['O0', ['-O0']], ['O1', ['-O1']], ['O2', ['-O2']], ['O0-lto', ['-O0', '-flto', '-Wl,--lto-O0']], ['O1-lto', ['-O1', '-flto', '-Wl,--lto-O1']], ['O1-lto-null', ['-O1', '-flto', '-Wl,--lto-O1', '-fsanitize=null', '-fsanitize-trap=null']]] as [string, string[]][]) {
    const stl: number[] = []
    const cc: number[] = []
    let size = 0
    let log = ''
    let benchMs = -1
    let benchCMs = -1
    let wasm: Uint8Array<ArrayBuffer> | null = null
    let wasmC: Uint8Array<ArrayBuffer> | null = null
    for (let i = 0; i < 4; i++) {
      const r = await workerCompile(w, ['clang++', '-std=c++20', ...flag, 'main.cpp', 'rt.cpp', '-o', 'main.wasm', '-lm', ...LINK], { 'main.cpp': BENCH_CPP, 'rt.cpp': STUB })
      stl.push(r.ms)
      wasm = r.wasm
      log = r.log
      size = r.wasm?.length ?? 0
      const rc = await workerCompile(w, ['clang', '-std=c17', ...flag, 'main.c', '-o', 'main.wasm', '-lm', ...LINK], { 'main.c': HELLO_C })
      cc.push(rc.ms)
      const rb = await workerCompile(w, ['clang', '-std=c17', ...flag, 'main.c', '-o', 'main.wasm', '-lm', ...LINK], { 'main.c': BENCH_C })
      wasmC = rb.wasm
    }
    if (wasm) {
      const times: number[] = []
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now()
        const r = await run(wasm, '', 60_000)
        times.push(performance.now() - t0)
        if (r.error) log += ` erro: ${r.error}`
      }
      benchMs = Math.round(best(times))
    }
    if (wasmC) {
      const times: number[] = []
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now()
        await run(wasmC, '', 60_000)
        times.push(performance.now() - t0)
      }
      benchCMs = Math.round(best(times))
    }
    table[name] = { compileStlMs: Math.round(best(stl)), compileCMs: Math.round(best(cc)), wasmKb: Math.round(size / 1024), runCppMs: benchMs, runCMs: benchCMs, log: clip(log, 160) }
  }
  out.flags = table
  // NULL com -fsanitize=null: vale como proteção?
  const nul = await workerCompile(w, ['clang', '-std=c17', '-O1', '-fsanitize=null', '-fsanitize-trap=null', 'main.c', '-o', 'main.wasm', '-lm', ...LINK], { 'main.c': '#include <stdio.h>\nint main(void) { int *volatile p = 0; *p = 5; printf("%d\\n", *p); return 0; }\n' })
  if (nul.wasm) out.sanitizeNull = await run(nul.wasm, '', 5000)
  else out.sanitizeNull = clip(nul.log, 300)
  w.terminate()
  return out
}

async function slowCompile() {
  const seen: number[] = []
  const t0 = performance.now()
  const r = await compile('c', { 'main.c': 'int main(void) { return 0; }\n' }, (p) => seen.push(p))
  return { ok: r.ok, log: r.log, ms: Math.round(performance.now() - t0), progresso: seen.length, ultimo: seen.at(-1) }
}

const t = {
  slowCompile,
  list: () => cases.map((c) => ({ id: c.id, group: c.group, harnessMs: c.harnessMs ?? 45_000, scenario: !!c.scenario })),
  runCase,
  sanity,
  compileOnce,
  burnPrepare,
  burnStart,
  burnStop,
  burnTimeout,
  benchFlags,
}
;(window as unknown as { __t: typeof t }).__t = t
;(document.getElementById('status') as HTMLElement).textContent = 'pronto'
