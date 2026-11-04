// O painel gravando na pasta pelo programa em Rust de verdade: estrutura da sala, vídeo por
// pedaços, regravação atômica e recusa de caminho perigoso. Roda em macOS e Windows.
// Precisa de "cargo build" em host/ e da porta 17791 livre.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
// Porta própria: a 7787 pode estar com outro hub de teste aberto.
const HUB_PORT = 17791
import { DiskMirror } from '../src/teacher/diskSink'
import { FileLink, FileStatus } from '../src/teacher/fileLink'
import { roomFolder, roomLayout, type LayoutRoom } from '../src/teacher/layout'
import { Recordings } from '../src/teacher/recStore'
import type { SegmentInfo, Student, Team } from '../src/teacher/room'

const EXE = join(import.meta.dir, '../host/target/debug', process.platform === 'win32' ? 'oblita-host.exe' : 'oblita-host')
const ORIGIN = 'https://oblita.giuli.dev'
const present = existsSync(EXE)
if (!present) console.warn(`files-rust: testes pulados, ${EXE} não existe. Rode "cargo build" em host/.`)

const portTaken = () =>
  new Promise<boolean>((resolve) => {
    const probe = net.connect({ host: '127.0.0.1', port: HUB_PORT })
    probe.once('connect', () => (probe.destroy(), resolve(true)))
    probe.once('error', () => resolve(false))
  })
const busy = present && (await portTaken())

const work = mkdtempSync(join(tmpdir(), 'oblita-pasta-'))
const root = join(work, 'raiz')
let proc: ReturnType<typeof Bun.spawn>
let token = ''
let log = ''

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const socket = (url: string) => new WebSocket(url, { headers: { Origin: ORIGIN } } as unknown as string[])
const connect = () => FileLink.connect(token, { url: `ws://127.0.0.1:${HUB_PORT}/ws/files`, socket })

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [relative(root, full).split(sep).join('/')]
  })
}

beforeAll(async () => {
  if (!present || busy) return
  proc = Bun.spawn([EXE, '--plain', '--pasta', root, '--porta', String(HUB_PORT)], { stdout: 'pipe', stderr: 'pipe', stdin: 'pipe' })
  void (async () => {
    const decode = new TextDecoder()
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) log += decode.decode(chunk, { stream: true })
  })()
  for (let i = 0; i < 100 && !token; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${HUB_PORT}/host-token`, { headers: { Origin: ORIGIN } })
      token = ((await res.json()) as { token: string }).token
    } catch {
      await sleep(100)
    }
  }
})

afterAll(() => {
  proc?.kill()
  rmSync(work, { recursive: true, force: true })
})

const run = test.if(present && !busy)

test.if(busy)(`a porta ${HUB_PORT} precisa estar livre para testar o programa`, () => {
  throw new Error(`a porta ${HUB_PORT} já está em uso; nada foi testado`)
})

run('sem a origem do Oblita ou sem o token, o canal de arquivos é recusado', async () => {
  const noOrigin = await FileLink.connect(token, { url: `ws://127.0.0.1:${HUB_PORT}/ws/files` }).then(
    (l) => (l.close(), 'abriu'),
    () => 'recusou',
  )
  expect(noOrigin).toBe('recusou')
  const noToken = await FileLink.connect('errado', { url: `ws://127.0.0.1:${HUB_PORT}/ws/files`, socket }).then(
    (l) => (l.close(), 'abriu'),
    () => 'recusou',
  )
  expect(noToken).toBe('recusou')
})

function student(clientId: string, name: string, extra: Partial<Student> = {}): Student {
  return {
    clientId,
    name,
    tokenHash: 'SEGREDO',
    examGranted: true,
    peer: null,
    online: false,
    examSent: true,
    status: { screen: true, fullscreen: true, focused: true, isolated: true, extended: false },
    lastBeat: 0,
    signalLost: false,
    alerts: 1,
    lastEvent: 0,
    lastRec: 0,
    chainBroken: false,
    segments: {},
    ...extra,
  }
}

run('a pasta da prova recebe a estrutura do zip, o vídeo por pedaços e o aviso de tudo salvo', async () => {
  const link = await connect()
  const info = await link.info()
  expect(info.root).toBe(root)
  expect(info.free).toBeGreaterThan(0)

  const seg: SegmentInfo = { segment: 0, startedAt: 1, mime: 'video/webm', parts: 0, size: 0, complete: false }
  const ana = student('aaaa', 'Ana Ação', { enrollment: '123', segments: { 0: seg } })
  const hostil = student('bbbb', '../../CON')
  const teams = new Map<string, Team>()
  const room: LayoutRoom = {
    config: { roomId: 'r', title: 'Prova de C', mode: 'individual', groups: [] } as unknown as LayoutRoom['config'],
    exam: { version: 1, title: 'Prova de C', durationMin: 30, questions: [{ id: 'q1', type: 'code', title: 'Soma', statement: 's', points: 5, languages: ['cpp'] }] } as LayoutRoom['exam'],
    students: new Map([
      [ana.clientId, ana],
      [hostil.clientId, hostil],
    ]),
    teams,
    alerts: [{ id: 'x', clientId: 'aaaa', name: 'Ana', kind: 'focus-lost', at: 1, severe: false }],
    teamOf: (s) => {
      const key = `s:${s.clientId}`
      if (!teams.has(key)) teams.set(key, { key, answers: {}, submissions: {}, grades: {} })
      return teams.get(key)!
    },
    scoreOf: () => ({ earned: 5, total: 5, pending: 0 }),
    resultsCsv: () => '"nome"',
  }
  const dir = roomFolder('Prova de C', new Date(2026, 10, 4, 14, 30).getTime())
  const memory = { load: async () => [] as string[], save: async () => {} }
  const mirror = new DiskMirror(dir, () => roomLayout(room), memory)
  expect(await mirror.sync(link)).toEqual({ failed: [] })

  // O vídeo chega em pedaços e vai sendo acrescentado ao arquivo do segmento.
  const recs = new Recordings('r', {
    disk: () => link,
    browser: { put: async () => {}, values: async () => [], remove: async () => {} },
    pathFor: (clientId, s) => mirror.pathFor(clientId, s),
  })
  expect(await recs.store('aaaa', seg, 0, new Uint8Array([1, 2, 3]))).toBe('disk')
  expect(await recs.store('aaaa', seg, 1, new Uint8Array([4, 5]))).toBe('disk')

  // A resposta muda: o arquivo é regravado e o "sem resposta" some.
  room.teamOf(ana).answers.q1 = { answer: { type: 'code', lang: 'cpp', files: { 'main.cpp': 'int main() { return 0; }\n', '../fora.cpp': 'x' } }, rev: 1 }
  expect(await mirror.sync(link)).toEqual({ failed: [] })

  const files = walk(root).sort()
  console.log(files.join('\n'))
  const base = `${dir}`
  for (const must of [
    `${base}/.oblita-sala`,
    `${base}/resumo.csv`,
    `${base}/prova.json`,
    `${base}/alunos/Ana Ação (123)/resumo.txt`,
    `${base}/alunos/Ana Ação (123)/alertas.csv`,
    `${base}/alunos/Ana Ação (123)/q1/main.cpp`,
    `${base}/alunos/Ana Ação (123)/q1/__fora.cpp`,
    `${base}/alunos/Ana Ação (123)/q1/nota.txt`,
    `${base}/alunos/Ana Ação (123)/gravacao/0000.webm`,
    `${base}/alunos/__.._CON/q1/sem-resposta.txt`,
  ]) {
    expect(files).toContain(must)
  }
  expect(files).not.toContain(`${base}/alunos/Ana Ação (123)/q1/sem-resposta.txt`)
  expect([...readFileSync(join(root, base, 'alunos/Ana Ação (123)/gravacao/0000.webm'))]).toEqual([1, 2, 3, 4, 5])
  expect(readFileSync(join(root, base, 'alunos/Ana Ação (123)/q1/main.cpp'), 'utf8')).toBe('int main() { return 0; }\n')
  expect(files.some((f) => /oblita-tmp/.test(f))).toBe(false)

  const saved = await link.done(dir)
  expect(saved).toBe(join(root, dir))
  for (let i = 0; i < 50 && !log.includes('Tudo salvo em'); i++) await sleep(20)
  expect(log).toContain(`Tudo salvo em ${join(root, dir)}`)
  link.close()
})

run('caminho com .., absoluto, de unidade ou reservado é recusado e nada sai da raiz', async () => {
  const link = await connect()
  const before = readdirSync(work).sort()
  for (const bad of ['../fora.txt', 'sala/../../fora.txt', '/tmp/fora.txt', 'C:\\fora.txt', '\\\\?\\C:\\fora.txt', 'sala/aux.txt', 'sala/f.txt:stream']) {
    await expect(link.replace(bad, 'x')).rejects.toMatchObject({ status: FileStatus.invalid })
    await expect(link.writeAt(bad, 0, new Uint8Array([1]))).rejects.toMatchObject({ status: FileStatus.invalid })
  }
  expect(readdirSync(work).sort()).toEqual(before)
  expect(existsSync(join(work, 'fora.txt'))).toBe(false)
  link.close()
})
