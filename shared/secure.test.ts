import { describe, expect, test } from 'bun:test'
import { RateLimiter, isAllowed, type PolicyContext } from './policy'
import { SEALED_TAG, SecureChannel, deriveRoomKey, fingerprint, helloTranscript, newEphemeral, newTeacherIdentity, randomBytes, sha256Hex, signHello, tokenProof, verifyHello, verifyTokenProof } from './secure'

async function pair(studentPassword = 'segredo', teacherPassword = 'segredo') {
  const salt = randomBytes(16)
  const nonce = randomBytes(16)
  const teacher = await newEphemeral()
  const student = await newEphemeral()
  const tKey = await deriveRoomKey('ABC123', teacherPassword, salt)
  const sKey = await deriveRoomKey('abc123', studentPassword, salt)
  return {
    t: await SecureChannel.create('teacher', teacher, student.pub, tKey, nonce, teacher.pub, student.pub),
    s: await SecureChannel.create('student', student, teacher.pub, sKey, nonce, teacher.pub, student.pub),
  }
}

const msg = (text: string) => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>
const read = (b: Uint8Array) => new TextDecoder().decode(b)

describe('canal', () => {
  test('mesma senha abre nos dois sentidos, sem texto claro', async () => {
    const { t, s } = await pair()
    const sealed = await s.seal(msg('resposta secreta'))
    expect(sealed[0]).toBe(SEALED_TAG)
    expect(read(sealed)).not.toContain('secreta')
    expect(read(await t.open(sealed))).toBe('resposta secreta')
    expect(read(await s.open(await t.seal(msg('prova'))))).toBe('prova')
  })

  test('senha errada não abre', async () => {
    const { t, s } = await pair('errada', 'certa')
    expect(t.open(await s.seal(msg('oi')))).rejects.toThrow()
  })

  test('quadro repetido é rejeitado', async () => {
    const { t, s } = await pair()
    const a = await s.seal(msg('a'))
    await t.open(a)
    expect(t.open(a)).rejects.toThrow()
  })

  test('quadro adulterado é rejeitado', async () => {
    const { t, s } = await pair()
    const a = await s.seal(msg('a'))
    a[a.length - 1] ^= 1
    expect(t.open(a)).rejects.toThrow()
  })

  test('não aceita o próprio quadro de volta', async () => {
    const { s } = await pair()
    expect(s.open(await s.seal(msg('eco')))).rejects.toThrow()
  })

  test('mantém a ordem sob envio concorrente', async () => {
    const { t, s } = await pair()
    const sealed = await Promise.all(Array.from({ length: 50 }, (_, i) => s.seal(msg(String(i)))))
    const opened = await Promise.all(sealed.map((f) => t.open(f)))
    expect(opened.map(read)).toEqual(Array.from({ length: 50 }, (_, i) => String(i)))
  })
})

const base: PolicyContext = { phase: 'running', mode: 'individual', examSent: true, closed: false, hasGroup: false, testsEnabled: true, finished: false }

describe('policy', () => {
  test('sem prova recebida não envia resposta nem roda', () => {
    for (const t of ['draft', 'submit', 'run', 'test', 'finish']) expect(isAllowed(t, { ...base, examSent: false })).toBe(false)
  })
  test('depois de encerrar não muda resposta', () => {
    for (const t of ['draft', 'submit', 'run', 'test']) expect(isAllowed(t, { ...base, closed: true })).toBe(false)
  })
  test('tipo desconhecido e herança de objeto são negados', () => {
    for (const t of ['constructor', '__proto__', 'toString', 'nada']) expect(isAllowed(t, base)).toBe(false)
  })
  test('quem já entregou não edita nem roda', () => {
    for (const t of ['draft', 'submit', 'run', 'test', 'y-update']) expect(isAllowed(t, { ...base, finished: true })).toBe(false)
  })
  test('teste só quando habilitado', () => expect(isAllowed('test', { ...base, testsEnabled: false })).toBe(false))
  test('individual não mexe em equipe nem envia cursor', () => {
    for (const t of ['team-create', 'team-join', 'team-leave', 'y-aware']) expect(isAllowed(t, base)).toBe(false)
    expect(isAllowed('y-update', base)).toBe(true)
  })
  test('equipe se escolhe antes da prova, e sair exige estar nela', () => {
    const before = { ...base, mode: 'group' as const, examSent: false }
    expect(isAllowed('team-join', before)).toBe(true)
    expect(isAllowed('team-create', { ...before, hasGroup: true })).toBe(false)
    expect(isAllowed('team-leave', before)).toBe(false)
    expect(isAllowed('team-leave', { ...before, hasGroup: true })).toBe(true)
    expect(isAllowed('team-join', { ...before, examSent: true })).toBe(false)
  })
  test('documento só anda durante a prova', () => {
    for (const t of ['y-sync', 'y-update', 'beacon-frame']) {
      expect(isAllowed(t, { ...base, examSent: false })).toBe(false)
      expect(isAllowed(t, { ...base, closed: true })).toBe(false)
    }
  })
  test('ponto só antes de receber a prova', () => expect(isAllowed('clock-in', base)).toBe(false))
})

describe('limite', () => {
  test('corta rajada e recupera com o tempo', () => {
    const r = new RateLimiter()
    const results = Array.from({ length: 10 }, () => r.allow('run', 0))
    expect(results.filter(Boolean).length).toBe(5)
    expect(r.allow('run', 1000)).toBe(true)
  })
  test('tipo sem limite é negado', () => expect(new RateLimiter().allow('x')).toBe(false))
})

describe('identidade do professor', () => {
  test('assinatura vale só para a mesma abertura e a mesma chave', async () => {
    const teacher = await newTeacherIdentity()
    const other = await newTeacherIdentity()
    const t = helloTranscript('ABC', 'sal', 'n', 'pub')
    const sig = await signHello(teacher, t)
    expect(await verifyHello(teacher.publicRaw, sig, t)).toBe(true)
    expect(await verifyHello(teacher.publicRaw, sig, helloTranscript('ABC', 'sal', 'n', 'outra'))).toBe(false)
    expect(await verifyHello(other.publicRaw, sig, t)).toBe(false)
  })
  test('impressão digital é estável e distingue chaves', async () => {
    const a = await newTeacherIdentity()
    const b = await newTeacherIdentity()
    expect(await fingerprint(a.publicRaw)).toBe(await fingerprint(a.publicRaw))
    expect(await fingerprint(a.publicRaw)).not.toBe(await fingerprint(b.publicRaw))
    expect(await fingerprint(a.publicRaw)).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/)
  })
  test('prova do token não serve em outra conexão', async () => {
    const hash = await sha256Hex('token')
    const t = helloTranscript('A', 'b', 'c', 'd')
    const proof = await tokenProof(hash, t)
    expect(await verifyTokenProof(hash, proof, t)).toBe(true)
    expect(await verifyTokenProof(hash, proof, helloTranscript('A', 'b', 'outro', 'd'))).toBe(false)
    expect(await verifyTokenProof(await sha256Hex('outro'), proof, t)).toBe(false)
  })
})
