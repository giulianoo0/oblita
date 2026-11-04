// Confere o zip com ferramentas de verdade: zipfile do Python e Expand-Archive do Windows.
// Uso: node --test tests/zip/zip.test.mjs
// ZIP_BIG=1 também grava um zip acima de 4 GiB, para exercitar os deslocamentos de 64 bits (uns 5 GiB em disco).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { extname, join, relative, resolve, sep } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { crc32 } from 'node:zlib'
import ts from 'typescript'

// O app é TS para o Vite: aqui basta transpilar, e os workers nunca chegam a rodar.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.endsWith('?worker')) return { url: 'data:text/javascript,export default class {}', shortCircuit: true }
    if (spec.startsWith('virtual:')) return { url: 'data:text/javascript,export default ""', shortCircuit: true }
    if (/^\.\.?\//.test(spec) && !extname(spec) && ctx.parentURL?.startsWith('file:')) {
      const base = fileURLToPath(new URL(spec, ctx.parentURL))
      for (const e of ['.ts', '.tsx']) if (existsSync(base + e)) return { url: pathToFileURL(base + e).href, shortCircuit: true }
    }
    return next(spec, ctx)
  },
  load(url, ctx, next) {
    if (!/\.tsx?$/.test(url)) return next(url, ctx)
    const options = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
    const fileName = fileURLToPath(url)
    return { format: 'module', source: ts.transpileModule(readFileSync(fileName, 'utf8'), { fileName, compilerOptions: options }).outputText, shortCircuit: true }
  },
})

const { ZipWriter, safeName, writeRoomZip } = await import('../../src/teacher/exportZip.ts')
const { Room } = await import('../../src/teacher/room.ts')

const work = mkdtempSync(join(tmpdir(), 'oblita-zip-'))
after(() => rmSync(work, { recursive: true, force: true }))

let counter = 0
const nextDir = () => join(work, `t${++counter}`)

function fileSink(path) {
  const fd = openSync(path, 'w')
  return {
    write: async (bytes) => {
      for (let done = 0; done < bytes.length; ) done += writeSync(fd, bytes, done)
    },
    close: async () => closeSync(fd),
  }
}

const PY = `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    print(json.dumps({'bad': z.testzip(), 'entries': [{'name': i.filename, 'size': i.file_size, 'crc': i.CRC, 'date': i.date_time[0]} for i in z.infolist()]}))
`

function readWithPython(zipPath) {
  const out = spawnSync('python', ['-I', '-c', PY, zipPath], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' }, maxBuffer: 1 << 28 })
  assert.equal(out.status, 0, out.stderr)
  return JSON.parse(out.stdout)
}

function expand(zipPath, dest) {
  const script = '& { param($z, $d) $ErrorActionPreference = "Stop"; Expand-Archive -LiteralPath $z -DestinationPath $d }'
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script, zipPath, dest], { encoding: 'utf8' })
  assert.equal(out.status, 0, out.stderr)
}

function walk(dir, base = dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full, base) : [relative(base, full).split(sep).join('/')]
  })
}

// Confere nas duas ferramentas: nomes, tamanhos e CRC, e os bytes depois de extrair.
function verify(zipPath, expected) {
  const { bad, entries } = readWithPython(zipPath)
  assert.equal(bad, null, 'testzip achou CRC errado')
  assert.deepEqual(entries.map((e) => e.name).sort(), [...expected.keys()].sort())
  for (const e of entries) {
    const want = expected.get(e.name)
    assert.equal(e.size, want.length, e.name)
    assert.equal(e.crc, crc32(want), e.name)
    assert.ok(e.date >= 2020, 'data do cabeçalho inválida')
  }
  if (process.platform !== 'win32') return
  const dest = nextDir()
  expand(zipPath, dest)
  assert.deepEqual(walk(dest).sort(), [...expected.keys()].sort())
  for (const [name, want] of expected) assert.equal(Buffer.compare(readFileSync(join(dest, name)), Buffer.from(want)), 0, name)
  for (const name of expected.keys()) assert.ok(resolve(dest, name).startsWith(resolve(dest) + sep), `${name} escapou da pasta`)
}


function extractedText(zipPath) {
  const dest = nextDir()
  const py = `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    print(json.dumps({n: z.read(n).decode('utf-8', 'replace') for n in z.namelist()}))
`
  const out = spawnSync('python', ['-I', '-c', py, zipPath, dest], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' }, maxBuffer: 1 << 28 })
  assert.equal(out.status, 0, out.stderr)
  return JSON.parse(out.stdout)
}

const HOSTILE = [
  '../../x',
  '..\\..\\y',
  '/etc/passwd',
  'C:\\Windows\\z',
  'a:b:stream',
  'CON',
  'con.txt',
  'aux.h',
  'NUL.cpp',
  'COM1',
  'lpt9.log',
  'com¹',
  'conin$',
  '.',
  '..',
  '...',
  '   ',
  '',
  ' .. ',
  'fim. ',
  'fim...',
  'nul\u0000byte',
  'quebra\nlinha',
  'gpj.\u202Eexe',
  '[colchete]',
  '`crase`',
  'a'.repeat(200) + '.',
  '😀'.repeat(100),
]

test('safeName não deixa nome perigoso passar', () => {
  for (const name of HOSTILE) {
    const out = safeName(name)
    assert.ok(out.length > 0, `vazio: ${JSON.stringify(name)}`)
    assert.ok(!/[\\/:*?"<>|\u0000-\u001f\u202e]/.test(out), `caractere proibido: ${out}`)
    assert.ok(!out.startsWith('.') && !/[. ]$/.test(out), `ponta perigosa: ${out}`)
    assert.ok(!/^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])\s*(\.|$)/i.test(out), `reservado: ${out}`)
    assert.ok(out.length <= 81, `longo demais: ${out}`)
    assert.ok(!out.includes('\ufffd'), 'cortou um emoji ao meio')
  }
  assert.equal(safeName('João (123)'), 'João (123)')
  assert.equal(safeName('Jo\u0061\u0303o'), 'Joã' + 'o')
})

test('ZipWriter: UTF-8, arquivo vazio, binário e nomes hostis', async () => {
  const all = new Uint8Array(256).map((_, i) => i)
  const enc = new TextEncoder()
  const expected = new Map([
    ['resumo.txt', enc.encode('oi\n')],
    ['vazio.txt', new Uint8Array(0)],
    ['João Ação/ç é ã 日本語 😀.txt', enc.encode('conteúdo ç 日本語 😀\n')],
    ['bin/todos.bin', all],
    ['bin/grande.bin', new Uint8Array(3 * 1024 * 1024).map((_, i) => i * 31)],
    ...HOSTILE.map((name, i) => [`hostil/${i}-${safeName(name)}/${safeName(name)}`, enc.encode(`caso ${i}\n`)]),
  ])
  const path = join(work, 'writer.zip')
  const zip = new ZipWriter(fileSink(path))
  for (const [name, bytes] of expected) await zip.add(name, name === 'bin/todos.bin' ? new Blob([bytes]) : bytes)
  await zip.finish()
  verify(path, expected)
})

const SECRET = { tokenHash: 'SEGREDOTOKENHASH', roomKey: 'SEGREDOROOMKEY', teamCode: 'SEGRDO', answer: 'SEGREDOGABARITO' }

const exam = {
  version: 1,
  title: 'Prova',
  durationMin: 30,
  questions: [
    { id: 'q1', type: 'code', title: 'Soma', statement: 'some', points: 5, languages: ['cpp'] },
    { id: 'q2', type: 'choice', title: 'Múltipla', statement: 'escolha', points: 2, options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] },
    { id: 'q3', type: 'text', title: 'Texto', statement: 'escreva', points: 3 },
  ],
}

function student(clientId, name, enrollment, groupId, extra = {}) {
  return {
    clientId,
    name,
    enrollment,
    groupId,
    tokenHash: SECRET.tokenHash,
    examGranted: true,
    peer: null,
    online: false,
    examSent: true,
    status: { screen: true, fullscreen: true, focused: true, isolated: true, extended: false },
    lastBeat: 0,
    signalLost: false,
    alerts: 0,
    lastEvent: 0,
    lastRec: 0,
    chainBroken: false,
    segments: {},
    ...extra,
  }
}

const segment = (n, mime = 'video/mp4') => ({ segment: n, startedAt: 1, mime, parts: 1, size: 8, complete: true })

function makeRoom(mode, groups) {
  const room = new Room()
  room.config = { roomId: 'sala', title: 'Prova', mode, timing: 'global', compiler: true, requireIsolation: false, recordScreen: true, maxTeamSize: mode === 'group' ? 4 : 1, groups }
  room.exam = exam
  room.solutions = { version: 1, solutions: [{ questionId: 'q1', type: 'code', reference: { lang: 'cpp', code: SECRET.answer }, tests: [{ stdin: SECRET.answer, stdout: SECRET.answer, points: 5 }] }] }
  room.phase = 'ended'
  room.roomCode = 'SALA01'
  room.roomKey = new TextEncoder().encode(SECRET.roomKey)
  room.salt = SECRET.roomKey
  room.segmentBlob = async (clientId, seg) => new Blob([`video:${clientId}:${seg.segment}`], { type: seg.mime })
  return room
}

const alert = (clientId, kind, at, detail) => ({ id: `${clientId}:${at}:${kind}`, clientId, name: clientId, kind, at, detail, severe: true })

test('sala em equipe: estrutura, integrantes, alertas e gravações de cada um, sem nada privado', async () => {
  const groups = [
    { id: 'g1', name: 'Os Ponteiros' },
    { id: 'g2', name: '../../Fuga' },
    { id: 'g3', name: 'os ponteiros' },
    { id: 'g4', name: 'Vazia' },
    { id: 'g5', name: 'Movida' },
  ]
  const room = makeRoom('group', groups)
  room.teamCodes = new Map(groups.map((g) => [g.id, SECRET.teamCode]))
  const members = [
    student('aaaa', 'Ana', '111', 'g1', { alerts: 2, segments: { 0: segment(0), 1: segment(1, 'video/webm') } }),
    student('bbbb', 'Bruno', undefined, 'g1', { alerts: 1, segments: { 0: segment(0) } }),
    // Os dois "Bia" iguais precisam de pastas diferentes, e "q1" e "resumo.txt" não podem cair em cima de nada.
    student('cccc', 'Bia', undefined, 'g2'),
    student('dddd', 'bia', undefined, 'g2'),
    student('eeee', 'q1', undefined, 'g2'),
    student('ffff', 'resumo.txt', undefined, 'g2'),
    student('abab', '../../../etc', '../..', 'g3'),
    student('cdcd', 'Sem Time', '222', undefined),
    student('efef', 'CON', undefined, undefined),
    student('fefe', 'con', undefined, undefined),
    // Número de segmento adulterado não vira caminho.
    student('baba', 'Malicioso', undefined, undefined, { segments: { x: segment('../../fora'), y: segment(-1), 2: segment(2) } }),
  ]
  for (const s of members) room.students.set(s.clientId, s)
  room.alerts = [
    alert('bbbb', 'devtools', 4000, '=cmd|calc'),
    alert('aaaa', 'fullscreen-exit', 3000),
    alert('aaaa', 'focus-lost', 2000, 'linha\nnova;com;ponto e vírgula'),
    // Sala antiga pode ter tipo de alerta lixo salvo.
    alert('cdcd', 'constructor', 1000),
    alert('cdcd', '__proto__', 900),
    alert('cdcd', '=2+2', 800),
  ]
  const team = room.teamOf(members[0])
  team.answers.q1 = { answer: { type: 'code', lang: 'cpp', files: { 'main.cpp': 'int main(){}', 'Main.cpp': 'outro', 'nota.txt': 'falso', '../../sai.cpp': 'hostil', 'aux.h': 'reservado' } }, rev: 1 }
  team.submissions.q2 = { answer: { type: 'choice', selected: ['a', 'b'] }, at: 1, by: 'Ana' }
  team.submissions.q3 = { answer: { type: 'text', text: 'minha resposta' }, at: 1, by: 'Bruno' }
  team.grades.q2 = { questionId: 'q2', status: 'done', points: 2, max: 2 }
  // Equipe sem ninguém que fez a prova continua no zip; a que nunca fez nada não vira pasta.
  room.teams.set('g:g5', { key: 'g:g5', answers: { q3: { answer: { type: 'text', text: 'ficou aqui' }, rev: 1 } }, submissions: {}, grades: {} })

  const path = join(work, 'equipe.zip')
  const progress = []
  await writeRoomZip(room, fileSink(path), { video: true, onProgress: (d, t) => progress.push([d, t]) })
  assert.deepEqual(progress.at(-1), [9, 9], 'progresso precisa terminar em 100%')

  const files = extractedText(path)
  const names = Object.keys(files)
  const expected = new Map(Object.entries(files).map(([n, text]) => [n, Buffer.from(text)]))
  // Vídeo e texto aqui são ASCII/UTF-8 válidos, então a conferência de bytes vale.
  verify(path, expected)

  for (const must of [
    'resumo.csv',
    'prova.json',
    'grupos/Os Ponteiros/resumo.txt',
    'grupos/Os Ponteiros/q1/main.cpp',
    'grupos/Os Ponteiros/q1/Main (2).cpp',
    'grupos/Os Ponteiros/q1/nota.txt',
    'grupos/Os Ponteiros/q1/_aux.h',
    'grupos/Os Ponteiros/q2/resposta.txt',
    'grupos/Os Ponteiros/q3/resposta.txt',
    'grupos/Os Ponteiros/Ana (111)/alertas.csv',
    'grupos/Os Ponteiros/Ana (111)/gravacao/0000.mp4',
    'grupos/Os Ponteiros/Ana (111)/gravacao/0001.webm',
    'grupos/Os Ponteiros/Bruno/alertas.csv',
    'grupos/Os Ponteiros/Bruno/gravacao/0000.mp4',
    'grupos/os ponteiros (2)/resumo.txt',
    'grupos/__.._Fuga/Bia/alertas.csv',
    'grupos/__.._Fuga/bia (2)/alertas.csv',
    'grupos/__.._Fuga/q1 (2)/alertas.csv',
    'grupos/__.._Fuga/resumo.txt (2)/alertas.csv',
    'grupos/Movida/q3/resposta.txt',
    'alunos/Sem Time (222)/resumo.txt',
    'alunos/Sem Time (222)/alertas.csv',
    'alunos/_CON/alertas.csv',
    'alunos/_con (2)/alertas.csv',
    'alunos/Malicioso/gravacao/0002.mp4',
  ]) {
    assert.ok(names.includes(must), `falta ${must}\n${names.join('\n')}`)
  }
  assert.ok(!names.some((n) => n.startsWith('grupos/Vazia')), 'equipe sem nada não vira pasta')
  assert.ok(!names.some((n) => n.split('/').includes('..') || n.startsWith('/') || /^[A-Za-z]:/.test(n)), 'caminho fugindo')
  assert.ok(!names.some((n) => n.includes('fora') || n.includes('-001')), 'segmento adulterado virou arquivo')
  const lowered = names.map((n) => n.toLowerCase())
  assert.equal(new Set(lowered).size, names.length, 'dois caminhos iguais no Windows')

  const resumo = files['grupos/Os Ponteiros/resumo.txt']
  assert.match(resumo, /Equipe: Os Ponteiros/)
  assert.match(resumo, /Ana \(111\); alertas: 2/)
  assert.match(resumo, /Bruno; alertas: 1/)
  assert.equal(files['grupos/Os Ponteiros/q1/main.cpp'], 'int main(){}')
  assert.equal(files['grupos/Os Ponteiros/q2/resposta.txt'], 'a, b\n')
  assert.equal(files['grupos/Os Ponteiros/Ana (111)/gravacao/0000.mp4'], 'video:aaaa:0')
  assert.equal(files['grupos/Os Ponteiros/Bruno/gravacao/0000.mp4'], 'video:bbbb:0')

  const ana = files['grupos/Os Ponteiros/Ana (111)/alertas.csv']
  const bruno = files['grupos/Os Ponteiros/Bruno/alertas.csv']
  assert.match(ana, /Saiu da tela cheia/)
  assert.match(ana, /Saiu da janela/)
  assert.ok(!ana.includes('Abriu o DevTools'), 'alerta do colega na pasta errada')
  assert.match(bruno, /"'=cmd\|calc"/, 'fórmula precisa ser neutralizada')
  assert.ok(ana.indexOf('Saiu da janela') < ana.indexOf('Saiu da tela cheia'), 'alertas em ordem de tempo')
  assert.equal(ana.trim().split('\n').length, 3, 'quebra de linha do aluno não abre outra linha')

  // Sem compressão, o conteúdo aparece cru: dá para procurar segredo no arquivo inteiro.
  const junk = files['alunos/Sem Time (222)/alertas.csv']
  assert.match(junk, /"constructor"/)
  assert.match(junk, /"__proto__"/)
  assert.match(junk, /"'=2\+2"/)
  assert.ok(!junk.includes('function') && !junk.includes('[object'), 'tipo lixo virou texto de objeto')

  const raw = readFileSync(path).toString('latin1')
  for (const [what, secret] of Object.entries(SECRET)) assert.ok(!raw.includes(secret), `vazou ${what}`)
  assert.deepEqual(JSON.parse(files['prova.json']), exam)
})

test('sala individual: alunos/<nome (matrícula)>/ sem subpasta de integrante', async () => {
  const room = makeRoom('individual', [])
  const s = student('aaaa', 'João Ação', '999', undefined, { alerts: 1, segments: { 0: segment(0) } })
  const same = student('bbbb', 'João Ação', '999', undefined)
  room.students.set(s.clientId, s)
  room.students.set(same.clientId, same)
  room.alerts = [alert('aaaa', 'paste', 1000, '12 caracteres')]
  room.teamOf(s).answers.q1 = { answer: { type: 'code', lang: 'cpp', files: { 'main.cpp': 'x' } }, rev: 1 }

  const path = join(work, 'individual.zip')
  await writeRoomZip(room, fileSink(path), { video: true })
  const files = extractedText(path)
  verify(path, new Map(Object.entries(files).map(([n, t]) => [n, Buffer.from(t)])))
  for (const must of [
    'alunos/João Ação (999)/resumo.txt',
    'alunos/João Ação (999)/alertas.csv',
    'alunos/João Ação (999)/gravacao/0000.mp4',
    'alunos/João Ação (999)/q1/main.cpp',
    'alunos/João Ação (999)/q1/nota.txt',
    'alunos/João Ação (999)/q2/sem-resposta.txt',
    'alunos/João Ação (999) (2)/resumo.txt',
  ]) {
    assert.ok(must in files, `falta ${must}\n${Object.keys(files).join('\n')}`)
  }
  assert.equal(files['alunos/João Ação (999)/q2/sem-resposta.txt'], '')
  assert.match(files['alunos/João Ação (999)/resumo.txt'], /João Ação \(999\); alertas: 1/)
})

// Finge um Blob enorme sem gastar a memória: só `size` e `stream` são usados pelo ZipWriter.
class HugeBlob extends Blob {
  constructor(total) {
    super([])
    this.total = total
  }
  get size() {
    return this.total
  }
  stream() {
    let left = this.total
    const piece = new Uint8Array(4 * 1024 * 1024).fill(7)
    return new ReadableStream({
      pull(c) {
        if (!left) return c.close()
        const n = Math.min(left, piece.length)
        c.enqueue(piece.subarray(0, n))
        left -= n
      },
    })
  }
}

test('ZIP64 real: arquivo e deslocamento acima de 4 GiB', { skip: !process.env.ZIP_BIG, timeout: 600_000 }, async () => {
  const path = join(work, 'big.zip')
  const size = Math.floor(4.2 * 1024 ** 3)
  const zip = new ZipWriter(fileSink(path))
  await zip.add('antes.txt', 'antes\n')
  await zip.add('gravacao/grande.bin', new HugeBlob(size))
  await zip.add('depois é ção.txt', 'depois\n')
  await zip.finish()
  const { bad, entries } = readWithPython(path)
  assert.equal(bad, null)
  assert.deepEqual(entries.map((e) => [e.name, e.size]), [['antes.txt', 6], ['gravacao/grande.bin', size], ['depois é ção.txt', 7]])
  if (process.platform === 'win32') {
    const dest = nextDir()
    expand(path, dest)
    assert.equal(statSync(join(dest, 'gravacao/grande.bin')).size, size)
    assert.equal(readFileSync(join(dest, 'depois é ção.txt'), 'utf8'), 'depois\n')
  }
})
