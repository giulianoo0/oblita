// Os dez cenários. O código passado a p.call roda dentro da página, onde T é a window.T de page.ts.
import { TOKEN, assert, eq, sleep } from './harness.mjs'

const CANARY = {
  statement: 'ENUNCIADO_CANARIO_7f3a',
  extraField: 'CAMPO_EXTRA_CANARIO_e1a2',
  code: 'CODIGO_CANARIO_55d1',
  name: 'NOME_CANARIO_91b2',
  enrollment: 'MATRICULA_CANARIO_04c7',
  password: 'SENHA_CANARIO_c0de',
  text: 'TEXTO_CANARIO_b00b',
  team: 'EQUIPE_CANARIO_a77a',
  warn: 'AVISO_CANARIO_d4d4',
  rec: 'GRAVACAO_CANARIO_6e6e',
  reference: 'REFERENCIA_CANARIO_1234',
  rubric: 'RUBRICA_CANARIO_5678',
}

const HIDDEN_IN = '3333333333 4444444444'
const HIDDEN_OUT = '7777777777'

const STARTER_Q1 = '#include <stdio.h>\n/* STARTER_Q1 */\nint main(void) {\n  return 0;\n}\n'
const STARTER_Q2 = '#include <iostream>\n// STARTER_Q2\nint main() {\n  return 0;\n}\n'

const EXAM = {
  version: 1,
  title: 'Prova de integração',
  durationMin: 60,
  questions: [
    { id: 'q1', type: 'code', title: 'Soma', statement: `Some dois inteiros. ${CANARY.statement}`, points: 10, languages: ['c'], starter: { c: STARTER_Q1 }, samples: [{ stdin: '1 2\n', stdout: '3\n' }], notes: CANARY.extraField },
    { id: 'q2', type: 'code', title: 'Dobro', statement: 'Imprima o dobro.', points: 10, languages: ['cpp'], starter: { cpp: STARTER_Q2 }, samples: [{ stdin: '4\n', stdout: '8\n' }] },
    { id: 'q3', type: 'choice', title: 'Capital', statement: 'Capital do Brasil?', points: 5, options: [{ id: 'a', text: 'Rio' }, { id: 'b', text: 'Brasília' }, { id: 'c', text: 'Salvador' }] },
    { id: 'q4', type: 'text', title: 'Explique', statement: 'Explique ponteiros.', points: 5 },
  ],
}

const SOLUTIONS = {
  version: 1,
  solutions: [
    { questionId: 'q1', type: 'code', reference: { lang: 'c', code: `/* ${CANARY.reference} */ int main(void){return 0;}` }, tests: [{ stdin: `${HIDDEN_IN}\n`, stdout: `${HIDDEN_OUT}\n`, points: 5 }, { stdin: '10 20\n', stdout: '30\n', points: 5 }] },
    { questionId: 'q2', type: 'code', reference: { lang: 'cpp', code: 'int main(){return 0;}' }, tests: [{ stdin: '21\n', stdout: '42\n', points: 10 }] },
    { questionId: 'q3', type: 'choice', correct: ['b'] },
    { questionId: 'q4', type: 'text', rubric: CANARY.rubric },
  ],
}

const SUM_OK = '#include <stdio.h>\nint main(void) {\n  long long a, b;\n  scanf("%lld %lld", &a, &b);\n  printf("%lld\\n", a + b);\n  return 0;\n}\n'
const SUM_WRONG = '#include <stdio.h>\nint main(void) {\n  printf("0\\n");\n  return 0;\n}\n'
const SUM_BROKEN = 'int main( {\n'
const SUM_LOOP = 'int main(void) {\n  volatile int x = 0;\n  for (;;) x++;\n  return 0;\n}\n'
const DOUBLE_OK = '#include <iostream>\n#include <vector>\nint main() {\n  std::vector<int> v(1);\n  std::cin >> v[0];\n  std::cout << v[0] * 2 << std::endl;\n  return 0;\n}\n'

const ALERT_KINDS = ['fullscreen-exit', 'focus-lost', 'tab-hidden', 'devtools', 'devtools-shortcut', 'blocked-shortcut', 'share-ended', 'share-invalid', 'internet-back', 'multi-monitor', 'paste', 'reload', 'signal-lost', 'disconnected', 'beacon-missing']

// ---- montagem

async function world(h, o = {}) {
  await h.closeAll()
  const t = await h.participant('prof')
  const info = await t.call((o, exam, sol, addr, token) => T.createRoom(o, exam, sol, addr, token), o, EXAM, o.solutions === false ? null : SOLUTIONS, h.hubLocal, TOKEN)
  const w = { t, ...info, sum: () => t.call(() => T.summary()) }
  w.student = (cid) => w.sum().then((s) => s.students.find((x) => x.clientId === cid))
  w.team = (cid) => t.call((c) => T.team(c), cid)
  return w
}

async function student(h, name, status = {}) {
  const p = await h.participant(name)
  await p.call((st) => T.newStudent(st), status)
  p.view = () => p.call(() => T.view())
  p.live = (timeout = 15_000) =>
    p.until(() => T.s.welcomed && T.s.linkState === 'online' && !T.s.refused && !!T.s.channel, [], { timeout, what: `${name} conectado` }).catch(async (err) => {
      const v = await p.view().catch(() => null)
      throw new Error(`${err.message} | ${JSON.stringify({ link: v?.linkState, err: v?.connectError, refused: v?.refused, ch: v?.hasChannel, has: v?.hasLink })} | exc ${JSON.stringify(p.exceptions).slice(0, 300)}`)
    })
  return p
}

const join = (h, p, name, password = '', enrollment) => p.call((a, n, pw, en) => T.join(a, n, pw, en ?? undefined), h.hubLan, name, password, enrollment ?? null)

async function joined(h, name, status, password = '', enrollment) {
  const p = await student(h, name, status)
  await join(h, p, name, password, enrollment)
  await p.live()
  p.cid = (await p.view()).clientId
  return p
}

const start = (w) => w.t.call(() => T.room.start())
const waitExam = (p, timeout = 15_000) => p.until(() => !!T.s.exam && !!T.s.doc.snapshot('q1'), [], { timeout, what: `${p.name} com prova e documento` })

async function teamUp(p, name) {
  await p.call((n) => T.s.createTeam(n), name)
  return (await p.until(() => T.s.team, [], { what: `${p.name} com equipe` }))
}

async function joinTeam(p, code) {
  await p.call((c) => T.s.joinTeam(c), code)
  return p.until(() => T.s.team, [], { what: `${p.name} entrou na equipe` })
}

const alertCount = (sum, cid, kind) => sum.alerts.filter((a) => a.clientId === cid && a.kind === kind).length
const countOf = (text, ch) => text.split(ch).length - 1

function clean(...ps) {
  for (const p of ps) eq(p.exceptions, [], `${p.name}: exceções na página`)
}

async function sane(w) {
  const s = await w.t.call(() => T.sane())
  eq(s.protoKeys, [], 'Object.prototype poluído')
  eq(s.polluted, null, 'Object.prototype poluído')
}

// Espera todos os documentos ficarem iguais, e devolve o texto.
async function converge(ps, w, teamKey, q, file, timeout = 12_000) {
  const end = Date.now() + timeout
  let texts = []
  while (Date.now() < end) {
    texts = await Promise.all(ps.map((p) => p.call((q, f) => T.code(q, f), q, file)))
    const doc = await w.t.call((k, q, f) => T.room.docs.get(k)?.files(q).get(f)?.toString() ?? null, teamKey, q, file)
    if (doc !== null && texts.every((x) => x === doc)) return doc
    await sleep(100)
  }
  throw new Error(`não convergiu: ${texts.map((x) => `${x?.length}`).join(', ')}`)
}

// ---- 1. aperto de mão

async function s1(h) {
  let w = await world(h)
  await h.case('sem senha: entra só com o IP', async () => {
    const a = await joined(h, 'Ana')
    const v = await a.view()
    eq(v.refused, null, 'recusa')
    eq(v.roomCode, w.code, 'o código vem no hi')
    eq(v.config.title, EXAM.title, 'título na configuração')
    assert(v.token && v.token.length === 64, 'token de 256 bits')
    const sum = await w.sum()
    eq(sum.students.length, 1, 'alunos')
    assert(sum.students[0].online && sum.students[0].name === 'Ana', 'professor vê a aluna')
    assert((await a.call(() => T.s.link.kind)) === 'hub', 'pelo hub')
    clean(w.t, a)
  })

  w = await world(h, { password: 'segredo-1' })
  const a = await student(h, 'Ana')
  await h.case('com senha: em branco é recusado, sem derivar nada', async () => {
    await join(h, a, 'Ana', '')
    await a.until(() => T.s.refused, [], { what: 'recusa' })
    const v = await a.view()
    eq(v.refused, 'password-required', 'motivo')
    eq(v.needsPassword, true, 'needsPassword')
    eq(v.hasLink, false, 'conexão fechada')
    eq((await w.sum()).students.length, 0, 'ninguém entrou')
  })
  await h.case('com senha: errada é recusada', async () => {
    await join(h, a, 'Ana', 'errada')
    await a.until(() => T.s.refused, [], { what: 'recusa' })
    const v = await a.view()
    eq(v.refused, 'password', 'motivo')
    eq(v.needsPassword, false, 'needsPassword')
    eq((await w.sum()).students.length, 0, 'ninguém entrou')
    // Quem foi recusado não fica batendo na porta.
    await sleep(2000)
    eq((await a.view()).linkState, 'idle', 'sem reconexão')
    await w.t.until(() => T.room.links.size === 0, [], { what: 'link do recusado limpo', timeout: 3000 })
  })
  await h.case('depois de recusado, a certa entra sem recarregar', async () => {
    await join(h, a, 'Ana', 'segredo-1')
    await a.live()
    const v = await a.view()
    eq(v.refused, null, 'recusa limpa')
    eq(v.needsPassword, false, 'needsPassword limpo')
    eq((await w.sum()).students.map((s) => s.name), ['Ana'], 'aluna na sala')
  })
  await h.case('senha errada de outro não atrapalha quem já entrou', async () => {
    const b = await student(h, 'Beto')
    await join(h, b, 'Beto', 'nada')
    await b.until(() => T.s.refused, [], { what: 'recusa' })
    eq((await b.view()).refused, 'password', 'motivo')
    eq((await a.view()).linkState, 'online', 'a primeira segue')
    assert((await w.sum()).students[0].online, 'professor ainda a vê')
    clean(w.t, a, b)
  })
}

// ---- 2. confidencialidade

async function s2(h) {
  await h.hubReset()
  const w = await world(h, { password: CANARY.password, mode: 'group', maxTeamSize: 2, recordScreen: true })
  let a, b, c
  let aCode, cCode
  await h.case('fluxo completo com textos marcados', async () => {
    a = await joined(h, 'Ana', { }, CANARY.password, CANARY.enrollment)
    b = await joined(h, CANARY.name, {}, CANARY.password)
    c = await joined(h, 'Caio', {}, CANARY.password)
    aCode = (await teamUp(a, CANARY.team)).code
    await joinTeam(b, aCode)
    cCode = (await teamUp(c, 'Outra')).code
    await start(w)
    await Promise.all([waitExam(a), waitExam(b), waitExam(c)])
    await a.call((text) => T.s.doc.files('q1').get('main.c').insert(0, `/* ${text} */\n`), CANARY.code)
    await a.call((text) => T.s.setAnswer('q4', { type: 'text', text }), CANARY.text)
    await a.call((text) => T.part(0, 0, true, text), CANARY.rec)
    await w.t.call((cid, text) => T.room.warn(cid, text), a.cid, CANARY.warn)
    await a.until(() => T.s.warning)
    await a.until(() => T.s.pendingUploads() === 0, [], { what: 'gravação confirmada' })
    await sleep(1000)
    await a.call((code) => {
      T.setCode('q1', 'main.c', code)
      T.s.runTest('q1')
    }, `/* ${CANARY.code} */ ${SUM_OK}`)
    await a.until(() => !!T.s.testReport, [], { timeout: 150_000, what: 'relatório do teste' })
    await a.call(() => T.s.submit('q4'))
    await sleep(800)
  }, 200_000)

  await h.case('o hub nunca viu nada em claro', async () => {
    const secret = [CANARY.statement, CANARY.extraField, CANARY.code, CANARY.name, CANARY.enrollment, CANARY.password, CANARY.text, CANARY.team, CANARY.warn, CANARY.rec, CANARY.reference, CANARY.rubric, HIDDEN_IN, HIDDEN_OUT, aCode]
    const res = await h.hubSearch([...secret, w.code])
    for (const n of secret) eq(res.hits[n], { up: 0, down: 0 }, `"${n}" em claro no hub`)
    // Sem isto a busca poderia estar passando por estar olhando para o nada.
    assert(res.hits[w.code].down > 0, 'o código da sala vai em claro no hi: a gravação precisa enxergar')
    assert(res.up > 1000 && res.down > 1000, `gravação vazia: ${res.up}/${res.down}`)
  })

  await h.case('a senha não está no disco de ninguém', async () => {
    for (const p of [w.t, a, b, c]) {
      const dump = await p.call(() => T.dumpIdb())
      assert(dump.length > 100, 'dump vazio')
      assert(!dump.includes(CANARY.password), `${p.name}: senha no IndexedDB`)
      assert(!dump.includes(btoa(CANARY.password)), `${p.name}: senha em base64 no IndexedDB`)
    }
    const snap = await w.t.call((id) => T.idb.get('kv', `room:${id}`), w.roomId)
    assert(snap.roomKey && snap.hasPassword === true, 'guarda só a chave derivada')
    assert(!('password' in snap), 'sem campo de senha')
  })

  await h.case('nenhuma mensagem ao aluno leva gabarito ou teste oculto', async () => {
    const banned = [HIDDEN_IN, HIDDEN_OUT, CANARY.reference, CANARY.rubric, CANARY.extraField, '"reference"', '"tests"', '"rubric"', '"correct"', '"solutions"']
    for (const p of [a, b, c]) {
      const hits = await p.call((n) => T.rxFind(n), banned)
      for (const n of banned) eq(hits[n], 0, `${p.name} recebeu ${n}`)
    }
    const seen = await a.call((n) => T.rxFind(n), [CANARY.statement])
    assert(seen[CANARY.statement] > 0, 'o gancho precisa enxergar o enunciado')
    eq((await a.view()).testReport.hidden, { passed: 2, total: 2 }, 'só a contagem')
  })

  await h.case('config sem códigos e sem lista de equipes', async () => {
    const allowed = ['compiler', 'durationMin', 'flow', 'maxTeamSize', 'mode', 'recordScreen', 'requireIsolation', 'timing', 'title']
    for (const p of [a, b, c]) {
      const welcome = await p.call(() => T.rxAll('welcome')[0])
      eq(Object.keys(welcome.config).sort(), allowed, `${p.name}: campos da configuração`)
    }
    eq((await c.call((n) => T.rxFind(n), [aCode, CANARY.team]))[aCode], 0, 'código de outra equipe')
    eq((await c.call((n) => T.rxFind(n), [CANARY.team]))[CANARY.team], 0, 'nome de outra equipe')
    eq((await a.call((n) => T.rxFind(n), [cCode]))[cCode], 0, 'código de outra equipe')
    clean(w.t, a, b, c)
  })
}

// ---- 3. identidade

async function s3(h) {
  const w = await world(h)
  const a = await joined(h, 'Ana')
  const first = await a.view()
  const impostor = (addr, cid, token) => {
    T.s.saved = { via: { kind: 'hub', address: addr }, roomCode: '', name: 'Impostor', clientId: cid, token: token ?? undefined, answers: {}, eventSeq: 0, recSeq: 0, segment: 0, lastHash: '', active: true }
    T.s.closing = false
    T.s.refused = null
    return T.s.connect()
  }
  await h.case('reconecta com o token', async () => {
    const before = await w.student(a.cid)
    await a.call(() => T.s.link.close())
    await w.t.until((c) => !T.room.students.get(c).online, [a.cid], { what: 'caiu' })
    await w.t.until((c) => T.room.students.get(c).online, [a.cid], { what: 'voltou' })
    await a.live()
    const after = await w.student(a.cid)
    assert(after.peer !== before.peer, 'outra conexão')
    eq((await w.sum()).students.length, 1, 'mesmo lugar')
    eq((await a.view()).refused, null, 'sem recusa')
    eq((await a.view()).token, first.token, 'o token não muda')
  })
  await h.case('mesmo clientId sem token é recusado, e a dona fica', async () => {
    const before = await w.student(a.cid)
    const x = await student(h, 'Impostor')
    await x.call(impostor, h.hubLan, a.cid, null)
    await x.until(() => T.s.refused, [], { what: 'recusa' })
    eq((await x.view()).refused, 'identity', 'motivo')
    const after = await w.student(a.cid)
    eq(after.peer, before.peer, 'a conexão da dona é a mesma')
    assert(after.online, 'a dona segue online')
    eq(after.name, 'Ana', 'nome intacto')
    await sleep(600)
    eq((await a.view()).linkState, 'online', 'a dona nem percebeu')
    eq((await w.sum()).students.length, 1, 'ninguém novo')
  })
  await h.case('mesmo clientId com token errado é recusado, e a dona fica', async () => {
    const before = await w.student(a.cid)
    const x = await student(h, 'Impostor2')
    await x.call(impostor, h.hubLan, a.cid, 'f'.repeat(64))
    await x.until(() => T.s.refused, [], { what: 'recusa' })
    eq((await x.view()).refused, 'identity', 'motivo')
    const after = await w.student(a.cid)
    eq(after.peer, before.peer, 'a conexão da dona é a mesma')
    // A dona continua funcionando de verdade, não só no papel.
    await a.call(() => T.s.raise('paste', 'depois do ataque'))
    await a.until(() => T.s.pendingUploads() === 0)
    assert((await w.sum()).alerts.some((al) => al.detail === 'depois do ataque' && al.clientId === a.cid), 'alerta da dona chegou')
    clean(w.t, a)
  })
}

// O aluno fixa a chave do professor na primeira conexão, e prova quem é sem mandar o token.
async function s3b(h) {
  const w = await world(h)
  const a = await joined(h, 'Ana')
  const b = await joined(h, 'Beto')
  const c = await joined(h, 'Caio')
  await start(w)
  await Promise.all([waitExam(a), waitExam(b), waitExam(c)])
  const alive = async (p) => {
    await p.call(() => T.s.raise('paste', 'ainda-vivo'))
    await p.until(() => T.s.pendingUploads() === 0, [], { what: `${p.name} funcionando`, timeout: 5000 })
    const v = await p.view()
    eq(v.refused, null, `${p.name}: recusa`)
    eq(v.linkState, 'online', `${p.name}: conexão`)
  }

  await h.case('o token nunca cruza a rede: vai só a prova', async () => {
    await a.call(() => T.s.link.close())
    await sleep(100)
    await a.live()
    const { hellos, token } = await a.call(() => ({ hellos: T.hellos, token: T.s.saved.token }))
    assert(hellos.length >= 2, 'precisa ter reconectado')
    eq(hellos[0].proof ?? null, null, 'na primeira vez não há o que provar')
    const last = hellos[hellos.length - 1]
    assert(typeof last.proof === 'string' && last.proof.length > 20, 'prova no segundo hello')
    assert(!('token' in last), 'campo token')
    assert(!JSON.stringify(hellos).includes(token), 'token em claro no hello')
    assert(new Set(hellos.filter((x) => x.proof).map((x) => x.proof)).size === hellos.filter((x) => x.proof).length, 'prova presa à conexão')
    await alive(a)
  })

  await h.case('prova repetida em outra conexão dá identity', async () => {
    const before = await w.student(a.cid)
    const stolen = await a.call(() => T.hellos[T.hellos.length - 1].proof)
    const x = await student(h, 'Replay')
    await x.call((cid, proof) => T.helloWith({ clientId: cid, proof }), a.cid, stolen)
    await join(h, x, 'Replay')
    await x.until(() => T.s.refused, [], { what: 'recusa' })
    eq((await x.view()).refused, 'identity', 'motivo')
    const after = await w.student(a.cid)
    eq(after.peer, before.peer, 'a dona continua na mesma conexão')
    assert(after.online, 'a dona segue online')
    await alive(a)
    clean(w.t, a)
  })

  await h.case('prova de tipo errado também dá identity', async () => {
    const x = await student(h, 'Replay2')
    for (const proof of [5, {}, 'nao-e-base64!', '']) {
      await x.call((cid, proof) => T.helloWith({ clientId: cid, proof }), a.cid, proof)
      await join(h, x, 'Replay2')
      await x.until(() => T.s.refused, [], { what: `recusa de ${JSON.stringify(proof)}` })
      eq((await x.view()).refused, 'identity', 'motivo')
    }
    clean(w.t)
  })

  await h.case('hi com assinatura ruim é ignorado', async () => {
    await b.call(() => T.spyLink())
    await b.call(async () => {
      T.inject(await T.badSigHi())
      T.inject({ ...T.lastHi, sig: 'AAAA' })
      T.inject({ ...T.lastHi, sig: 'nao-e-base64!' })
      T.inject({ ...T.lastHi, signPub: 'AAAA' })
      const { sig, ...noSig } = T.lastHi
      T.inject(noSig)
    })
    await sleep(400)
    eq(await b.call(() => T.txPlain()), 0, 'não mandou nenhuma chave')
    await alive(b)
    clean(b, w.t)
  })

  await h.case('refused em claro depois do welcome é ignorado', async () => {
    const inject = () => {
      T.inject({ t: 'refused', reason: 'password' })
      T.inject({ t: 'refused', reason: 'impostor' })
      T.inject({ t: 'refused' })
    }
    await b.call(inject)
    await sleep(300)
    const saved = await b.call(() => T.s.saved.active)
    eq(saved, true, 'sessão ativa')
    await alive(b)
    clean(b, w.t)
  })

  await h.case('hi de versão diferente, sem assinatura, não derruba quem já entrou', async () => {
    await b.call(() => T.inject({ t: 'hi', v: 99 }))
    await sleep(300)
    eq(await b.call(() => T.s.saved.active), true, 'sessão ativa')
    await alive(b)
    clean(b, w.t)
  })

  await h.case('hi legítimo repetido na rede não prende o aluno', async () => {
    await c.call(() => T.inject(T.lastHi))
    await sleep(300)
    await c.live(10_000)
    await alive(c)
    clean(c, w.t)
  })

  await h.case('hi forjado com outra chave depois de fixar: impostor, sem mandar nada', async () => {
    await c.live()
    await c.call(() => T.spyLink())
    const before = await c.call(() => T.s.teacherFp)
    assert(before, 'chave fixada')
    await c.call(async () => T.inject(await T.forgeHi()))
    await c.until(() => T.s.refused, [], { what: 'recusa' })
    eq((await c.view()).refused, 'impostor', 'motivo')
    eq(await c.call(() => T.txPlain()), 0, 'nada saiu para o impostor')
    eq(await c.call(() => T.s.saved.teacherFp), before, 'a chave fixada não muda')
    eq((await c.view()).hasLink, false, 'conexão fechada')
    // Não é asserção: fica visível no log o que a recusa faz com a sessão de quem foi alvo.
    console.log(`        nota: depois do hi forjado, sessão ativa = ${await c.call(() => T.s.saved.active)}, restore() = ${await c.call(() => new T.StudentSession().restore())}`)
    clean(c, w.t)
  })

  await h.case('outro painel de verdade no hub: o aluno recusa e não fala com ele', async () => {
    const rogue = await h.participant('impostor')
    await rogue.call((exam, addr, token) => T.createRoom({}, exam, null, addr, token), EXAM, h.hubLocal, TOKEN)
    await a.until(() => T.s.refused, [], { what: 'Ana recusa', timeout: 10_000 })
    eq((await a.view()).refused, 'impostor', 'motivo')
    await b.until(() => T.s.refused, [], { what: 'Beto recusa', timeout: 10_000 })
    eq((await b.view()).refused, 'impostor', 'motivo')
    const seen = await rogue.call(() => ({ students: T.room.students.size, keyed: [...T.room.links.values()].filter((l) => l.channel).length }))
    eq(seen, { students: 0, keyed: 0 }, 'o impostor não recebeu nada')
    clean(a, b)
  })

  await h.case('o professor verdadeiro recarregado passa pela chave fixada', async () => {
    const w2 = await world(h)
    const d = await joined(h, 'Dani')
    await start(w2)
    await waitExam(d)
    const fp = await d.call(() => T.s.teacherFp)
    eq(await w2.t.call(() => T.room.fingerprint), fp, 'impressão digital igual à do painel')
    await w2.t.reload()
    await w2.t.call((id, addr, token) => T.loadRoom(id, addr, token), w2.roomId, h.hubLocal, TOKEN)
    await w2.t.until((cid) => T.room.students.get(cid)?.online, [d.cid], { what: 'Dani de volta' })
    eq((await d.view()).refused, null, 'recusa')
    eq(await d.call(() => T.s.teacherFp), fp, 'mesma chave')
    clean(d, w2.t)
  })
}

// ---- 4. policy e cliente adulterado

async function s4(h) {
  const w = await world(h, { recordScreen: true })
  const a = await joined(h, 'Ana', { fullscreen: false })
  const honest = await joined(h, 'Beto')

  const forbidden = (update) => {
    T.raw({ t: 'submit', seq: 1, questionId: 'q3', answer: { type: 'choice', selected: ['b'] }, at: Date.now() })
    T.raw({ t: 'run', reqId: 'r1', lang: 'c', files: { 'main.c': 'int main(void){return 0;}' }, stdin: '' })
    T.raw({ t: 'test', reqId: 't1', questionId: 'q1', lang: 'c', files: { 'main.c': 'int main(void){return 0;}' } })
    T.rawBin({ t: 'y-update' }, update)
    T.rawBin({ t: 'y-sync' }, [0])
    T.raw({ t: 'draft', questionId: 'q4', answer: { type: 'text', text: 'antes' }, rev: 1 })
    T.raw({ t: 'finish', seq: 2, at: 123 })
  }
  const checkForbidden = async () => {
    await sleep(500)
    const sum = await w.sum()
    const st = sum.students.find((s) => s.clientId === a.cid)
    const team = await w.team(a.cid)
    eq(team.submissions, {}, 'nenhuma entrega')
    eq(team.answers, {}, 'nenhum rascunho')
    eq(st.finishedAt ?? null, null, 'não terminou')
    eq(st.examGranted, false, 'sem prova')
    eq(Object.keys(sum.docs), [], 'documento nem existe')
    eq(sum.gradeQueue + sum.gradeRunning, 0, 'nada na fila')
    eq((await a.call((t) => T.rxCount(t), 'run-result')) + (await a.call((t) => T.rxCount(t), 'test-result')), 0, 'sem resultado')
    eq((await a.call((t) => T.rxCount(t), 'exam')), 0, 'sem prova')
  }

  await h.case('tudo proibido antes da prova, no lobby', async () => {
    const update = await a.call(() => T.foreignUpdate('q1', 'main.c', 'INVASAO'))
    await a.call(forbidden, update)
    await checkForbidden()
    await a.call((text) => T.rawText(text), '{"t":"clock-in"}')
    await sane(w)
    clean(w.t)
  })

  await h.case('tipos desconhecidos e __proto__', async () => {
    await a.call(() => {
      T.raw({ t: '__proto__' })
      T.raw({ t: 'constructor' })
      T.raw({ t: 'toString' })
      T.raw({ t: 123 })
      T.raw({ t: null })
      T.raw({})
      T.rawText('null')
      T.rawText('[]')
      T.rawText('"texto"')
      T.rawText('{"t":"status","__proto__":{"polluted":1},"status":{"__proto__":{"screen":true},"screen":false}}')
      T.rawText('{"t":"beat","constructor":{"prototype":{"polluted":1}},"status":{"focused":true}}')
    })
    await sleep(300)
    await sane(w)
    assert((await a.view()).linkState === 'online', 'nada disso derruba')
    await a.call(() => T.raw({ t: 'zzz' }))
    // Tipo sem regra derruba só quem mandou.
    await w.t.until((c) => !T.room.students.get(c).online, [a.cid], { what: 'derrubou', timeout: 3000 })
    await w.t.until((c) => T.room.students.get(c).online, [a.cid], { what: 'voltou' })
    await a.live()
    assert((await w.student(honest.cid)).online, 'o outro aluno nem notou')
    await sane(w)
    clean(w.t)
  })

  await h.case('JSON quebrado e tag inválida só derrubam o autor', async () => {
    for (const send of [() => T.rawText('{nao e json'), () => T.rawBytes([9, 1, 2, 3]), () => T.rawBytes([]), () => T.rawBytes([2, 255, 255, 255, 255, 1])]) {
      const before = (await w.student(a.cid)).peer
      await a.call(send)
      await w.t.until((c, p) => T.room.students.get(c).online && T.room.students.get(c).peer !== p, [a.cid, before], { what: 'caiu e voltou' })
      await a.live()
    }
    assert((await w.student(honest.cid)).online, 'o outro aluno nem notou')
    await sane(w)
    clean(w.t)
  }, 45_000)

  await h.case('hello com tipos errados', async () => {
    const b = await student(h, 'Bruto')
    const count = async () => (await w.sum()).students.length
    const base = await count()
    const refusedBy = [{ v: '1' }, { v: 99 }, { v: null }]
    const dropped = [{ clientId: 123 }, { clientId: {} }, { clientId: '../../etc/passwd' }, { clientId: '__proto__' }, { clientId: '' }, { clientId: null }, { name: '' }, { name: 123 }, { name: {} }, { name: null }, { name: '    ' }]
    for (const patch of refusedBy) {
      await b.call((p) => T.helloWith(p), patch)
      await join(h, b, 'Bruto')
      await b.until(() => T.s.refused, [], { what: `recusa de ${JSON.stringify(patch)}` })
      eq((await b.view()).refused, 'version', 'motivo')
    }
    for (const patch of dropped) {
      await b.call((p) => T.helloWith(p), patch)
      await join(h, b, 'Bruto')
      await sleep(350)
      eq((await b.view()).welcomed, false, `${JSON.stringify(patch)} não pode entrar`)
      await b.call(() => T.goOffline())
    }
    eq(await count(), base, 'ninguém entrou')
    // Campos opcionais com lixo não impedem a entrada, mas também não entram como vieram.
    const odd = [
      { clientId: 'ab'.repeat(8), enrollment: { x: 1 } },
      { clientId: 'cd'.repeat(8), name: 'x'.repeat(5000) },
      { clientId: 'ef'.repeat(8), lastEvent: 'x', lastRec: {}, resumed: 'sim', token: { a: 1 } },
    ]
    for (const patch of odd) {
      await b.call((p) => T.helloWith(p), patch)
      await join(h, b, 'Bruto')
      await b.until(() => T.s.welcomed, [], { what: `${JSON.stringify(patch).slice(0, 40)} entrando` })
      await b.call(() => T.goOffline())
      await sleep(100)
    }
    const sum = await w.sum()
    eq(sum.students.find((s) => s.clientId === 'ab'.repeat(8)).enrollment ?? null, null, 'matrícula de lixo')
    eq(sum.students.find((s) => s.clientId === 'cd'.repeat(8)).name.length, 60, 'nome cortado')
    await sane(w)
    clean(w.t)
  }, 60_000)

  await h.case('tudo proibido sem prova, com a sala rodando', async () => {
    await start(w)
    await waitExam(honest)
    const update = await a.call(() => T.foreignUpdate('q1', 'main.c', 'INVASAO'))
    await a.call(forbidden, update)
    await sleep(500)
    const team = await w.team(a.cid)
    eq(team.submissions, {}, 'nenhuma entrega')
    eq(team.answers, {}, 'nenhum rascunho')
    eq((await w.student(a.cid)).examGranted, false, 'sem prova')
    eq((await a.call((t) => T.rxCount(t), 'exam')), 0, 'sem prova')
    eq((await w.sum()).docs[`s:${a.cid}`] ?? null, null, 'documento do aluno sem prova')
    await sane(w)
    clean(w.t)
  })

  const c = await joined(h, 'Caio')
  await h.case('lixo em cada tipo de mensagem, durante a prova', async () => {
    await waitExam(c)
    await c.call(() => {
      const list = [
        { t: 'event' }, { t: 'event', event: null }, { t: 'event', event: { seq: 'x' } }, { t: 'event', event: 5 },
        { t: 'status' }, { t: 'status', status: null }, { t: 'status', status: 5 }, { t: 'beat' }, { t: 'beat', status: 'x' },
        { t: 'submit' }, { t: 'submit', seq: {}, questionId: 'q3', answer: null },
        { t: 'draft' }, { t: 'draft', questionId: '__proto__', answer: { type: 'text', text: 'x' }, rev: 1 }, { t: 'draft', questionId: 'constructor', answer: { type: 'text', text: 'x' }, rev: 1 },
        { t: 'draft', questionId: 'q3', answer: { type: 'choice', selected: 'x' }, rev: 1 }, { t: 'draft', questionId: 'q4', answer: { type: 'text', text: 5 }, rev: 1 }, { t: 'draft', questionId: 'q4', answer: { type: 'text', text: 'ok' }, rev: 'x' },
        { t: 'finish' }, { t: 'finish', seq: {} },
        { t: 'team-create', name: {} }, { t: 'team-join', code: 5 }, { t: 'team-leave' },
        { t: 'clock-in' }, { t: 'time-sync' }, { t: 'time-sync', c: 'x' },
        { t: 'frame' }, { t: 'beacon-frame', code: 'x' }, { t: 'rec' }, { t: 'rec', seq: 'x' }, { t: 'y-aware' }, { t: 'y-sync' }, { t: 'y-update' },
        { t: 'test' }, { t: 'test', reqId: {}, questionId: 'q1', lang: 'python', files: {} }, { t: 'test', reqId: 't', questionId: '__proto__', lang: 'c', files: { 'a.c': '' } }, { t: 'test', reqId: 't', questionId: 'q1', lang: 'c', files: null },
        { t: 'run' }, { t: 'run', reqId: 'r', lang: 'c', files: { '../evil.c': '' }, stdin: '' },
      ]
      list.forEach((m) => T.raw(m))
      T.rawBin({ t: 'frame', at: 'x', focus: 'y' }, [1, 2, 3])
      T.rawBin({ t: 'beacon-frame', code: 1 }, [1, 2, 3])
    })
    await sleep(600)
    assert((await c.view()).linkState === 'online', 'nada disso derruba')
    const sum = await w.sum()
    const st = sum.students.find((s) => s.clientId === c.cid)
    eq(st.finishedAt ?? null, null, 'não terminou')
    eq(st.lastEvent, 0, 'número inválido não anda')
    await sane(w)
    clean(w.t, honest)
  })

  await h.case('evento com tipo inventado não vira alerta', async () => {
    const cur = (await w.student(c.cid)).lastEvent
    await c.call((seq) => T.raw({ t: 'event', event: { seq, kind: '<img src=x>', at: 'lixo', hash: 'h' } }), cur + 1)
    await c.call((seq) => T.raw({ t: 'event', event: { seq, kind: 'paste', at: 'lixo', detail: { a: 1 }, hash: 5 } }), cur + 2)
    await c.call((seq) => T.raw({ t: 'event', event: { seq, kind: '__proto__', at: 1, hash: 'h' } }), cur + 3)
    await c.call((seq) => T.raw({ t: 'event', event: { seq, kind: 'constructor', at: 1, hash: 'h' } }), cur + 4)
    await sleep(400)
    const sum = await w.sum()
    eq((await w.student(c.cid)).lastEvent, cur + 4, 'o número avança mesmo com lixo')
    assert(!sum.alerts.some((al) => ['__proto__', 'constructor'].includes(al.kind)), 'tipo do protótipo virou alerta')
    for (const al of sum.alerts) {
      assert(ALERT_KINDS.includes(al.kind), `tipo de alerta inválido: ${al.kind}`)
      assert(typeof al.at === 'number', `horário inválido: ${al.at}`)
      assert(al.detail === undefined || al.detail === null || typeof al.detail === 'string', 'detalhe inválido')
    }
    await sane(w)
    clean(w.t)
  })

  await h.case('rec com segmento __proto__ não polui o protótipo', async () => {
    const seq = (await w.student(c.cid)).lastRec + 1
    const bad = [
      { segment: '__proto__', part: 0, startedAt: 0, last: true, mime: 'video/webm' },
      { segment: 'constructor', part: 0, startedAt: 0, last: true, mime: 'video/webm' },
      { segment: 0, part: '../../x', startedAt: 'x', last: 'y', mime: 'video/webm' },
      { segment: -1, part: -1, startedAt: 0, last: false, mime: 'video/webm' },
      { segment: 0, part: 0, startedAt: 0, last: false, mime: { a: 1 } },
      { segment: 0, part: 0, startedAt: 0, last: false, mime: '../../x' },
    ]
    // Cada um numa conexão: o primeiro já pode derrubar quem mandou, e os outros nem chegariam.
    for (const header of bad) {
      await c.live()
      await c.call((m) => T.rawBin(m, [1, 2, 3]), { t: 'rec', seq, ...header })
      await sleep(250)
      await sane(w)
      eq(Object.keys((await w.student(c.cid)).segments).length, 0, `segmento de lixo: ${JSON.stringify(header)}`)
    }
    await c.live()
    await c.call((seq) => T.raw({ t: 'rec', seq, segment: 0, part: 0, startedAt: 0, last: false, mime: 'video/webm' }), seq)
    await sleep(200)
    await sane(w)
    await c.live()
    const res = await w.t.call(() => ({ parts: {}.parts ?? null, size: {}.size ?? null, complete: {}.complete ?? null }))
    eq(res, { parts: null, size: null, complete: null }, 'protótipo')
    // E o fluxo honesto do mesmo aluno segue.
    await c.call(() => T.part(0, 0, true, 'honesto'))
    await c.until(() => T.s.pendingUploads() === 0, [], { what: 'parte honesta confirmada' })
    const st = await w.student(c.cid)
    eq(st.segments[0]?.parts, 1, 'parte honesta guardada')
    eq(st.segments[0]?.complete, true, 'segmento completo')
    clean(w.t)
  })

  await h.case('run com entrada de tipo errado não vira exceção', async () => {
    await w.t.call(() => T.room.lastRun.clear())
    await c.call(() => T.raw({ t: 'run', reqId: 'r2', lang: 'c', files: { 'main.c': 'int main(void){return 0;}' }, stdin: 5 }))
    await sleep(500)
    await w.t.call(() => T.room.lastRun.clear())
    await c.call(() => T.raw({ t: 'run', reqId: 'r3', lang: 'python', files: { 'main.c': 'int main(void){return 0;}' }, stdin: '' }))
    await w.t.until(() => (T.room.queue?.pending ?? 0) === 0, [], { timeout: 120_000, what: 'fila vazia' })
    await sane(w)
    clean(w.t)
  }, 150_000)

  await h.case('tamanhos acima do limite', async () => {
    const seed = await w.t.call((c) => T.room.docs.get(`s:${c}`).encodeState().length, c.cid)
    await c.call(() => T.rawBinSize({ t: 'y-aware' }, 70 * 1024))
    await c.call(() => T.rawBinSize({ t: 'beacon-frame', code: 1 }, 300 * 1024))
    await sleep(300)
    assert((await c.view()).linkState === 'online', 'aware e selo grandes são só ignorados')
    const before = (await w.student(c.cid)).peer
    await c.call(() => T.rawBinSize({ t: 'y-update' }, 600 * 1024))
    await w.t.until((id, p) => T.room.students.get(id).online && T.room.students.get(id).peer !== p, [c.cid, before], { what: 'caiu e voltou' })
    await c.live()
    eq(await w.t.call((c) => T.room.docs.get(`s:${c}`).encodeState().length, c.cid), seed, 'documento intacto')
    await sane(w)
    clean(w.t, c)
  })

  await h.case('update de lixo só derruba o autor', async () => {
    const before = (await w.student(c.cid)).peer
    await c.call(() => T.rawBin({ t: 'y-update' }, [255, 255, 255, 255, 1, 2, 3, 4, 5]))
    await w.t.until((id, p) => T.room.students.get(id).online && T.room.students.get(id).peer !== p, [c.cid, before], { what: 'caiu e voltou' })
    await c.live()
    await waitExam(c)
    await sane(w)
    clean(w.t)
  })

  await h.case('enxurrada de run é cortada, sem derrubar nada', async () => {
    await w.t.call(() => T.room.lastRun.clear())
    const before = (await w.student(c.cid)).peer
    await c.call(() => {
      for (let i = 0; i < 80; i++) T.raw({ t: 'run', reqId: `f${i}`, lang: 'c', files: { 'main.c': 'int main(void){return 0;}' }, stdin: '' })
    })
    await w.t.until((id, p) => T.room.students.get(id).peer !== p, [c.cid, before], { what: 'limite derrubou o autor', timeout: 5000 })
    const sum = await w.sum()
    assert(sum.gradeQueue + sum.gradeRunning <= 1, `só uma execução por vez na fila: ${sum.gradeQueue}+${sum.gradeRunning}`)
    await c.live()
    assert((await w.student(honest.cid)).online, 'o outro aluno nem notou')
    await w.t.until(() => (T.room.queue?.pending ?? 0) === 0, [], { timeout: 60_000, what: 'fila vazia' })
    await sane(w)
    clean(w.t, honest)
  }, 80_000)

  await h.case('enxurrada de batimentos, status e sync', async () => {
    const send = () => {
      for (let i = 0; i < 300; i++) {
        T.raw({ t: 'beat', at: 0, status: { focused: true, screen: true, fullscreen: true, isolated: true } })
        T.raw({ t: 'status', status: { focused: true, screen: true, fullscreen: true, isolated: true } })
      }
    }
    await c.call(send)
    await sleep(500)
    await c.live()
    await sane(w)
    clean(w.t, honest)
  })

  const d = await joined(h, 'Dani')
  await h.case('finish com horário de lixo não quebra o CSV', async () => {
    await waitExam(d)
    await d.call(() => T.raw({ t: 'finish', seq: 1, at: 'lixo' }))
    await d.until(() => T.rxCount('ack') > 0, [], { what: 'ack' })
    await sleep(100)
    await sane(w)
    clean(w.t)
  })

  await h.case('documento adulterado não derruba o professor, nem o fim da prova', async () => {
    await waitExam(c)
    await c.call(() => {
      T.s.doc.files('q1').set('nulo.c', null)
      T.s.doc.files('q1').set('numero.c', 5)
      T.s.doc.files('q1').set('../fora.c', new T.Y.Text('x'))
      T.s.doc.doc.getMap('meta:q2').set('lang', 'python')
    })
    await sleep(900)
    clean(w.t)
    await c.call(() => T.s.submit('q1'))
    await c.call(() => T.s.submit('q2'))
    await sleep(500)
    clean(w.t)
    const team = await w.team(c.cid)
    for (const q of ['q1', 'q2']) {
      for (const name of Object.keys(team.submissions[q]?.answer.files ?? {})) assert(/^[\w.-]+$/.test(name) && !name.includes('..'), `nome de arquivo na entrega: ${name}`)
    }
    assert(!Object.keys(team.answers.q1?.answer.files ?? {}).some((n) => n.includes('..')), 'nome de arquivo no rascunho')
    await w.t.call(() => T.room.end())
    const sum = await w.sum()
    assert(sum.teams.filter((x) => x.key.startsWith('s:')).every((x) => x.closed), 'todas as equipes fecharam')
    await honest.until(() => T.s.phase === 'ended', [], { what: 'o honesto foi avisado' })
    await w.t.until(() => (T.room.queue?.pending ?? 0) === 0, [], { timeout: 150_000, what: 'fila de correção vazia' })
    await sane(w)
    clean(w.t, honest)
  }, 180_000)
}

// O envenenamento de uma equipe não pode impedir o fim das outras.
async function s4b(h) {
  const w = await world(h, { mode: 'group', maxTeamSize: 2 })
  const a = await joined(h, 'Ana')
  const b = await joined(h, 'Beto')
  const c = await joined(h, 'Caio')
  const alfa = await teamUp(a, 'Alfa')
  await joinTeam(b, alfa.code)
  const beta = await teamUp(c, 'Beta')
  await start(w)
  await Promise.all([waitExam(a), waitExam(b), waitExam(c)])

  await h.case('entrada null em files:q1 não derruba o professor', async () => {
    await a.call(() => {
      T.s.doc.files('q1').set('nulo.c', null)
      T.s.doc.files('q1').set('numero.c', 5)
      T.s.doc.files('q1').set('objeto.c', { a: 1 })
    })
    await b.until(() => T.s.doc.files('q1').has('nulo.c'), [], { what: 'o colega recebeu o lixo' })
    await sleep(800)
    clean(w.t, b)
    await sane(w)
    const answer = (await w.team(a.cid)).answers.q1.answer
    eq(Object.keys(answer.files), ['main.c'], 'só o arquivo de verdade')
  })

  await h.case('colega honesto da equipe envenenada segue trabalhando', async () => {
    const snap = await b.call(() => T.s.answerOf('q1'))
    eq(Object.keys(snap.files), ['main.c'], 'o colega lê a resposta')
    await b.call(() => T.s.doc.files('q1').get('main.c').insert(0, '/*DO_BETO*/'))
    await w.t.until((cid) => T.team(cid).answers.q1?.answer.files['main.c'].includes('DO_BETO'), [a.cid], { what: 'edição depois do lixo', timeout: 3000 })
    await b.call(() => T.s.link.close())
    await sleep(100)
    await b.live()
    await w.t.until((cid) => T.room.students.get(cid).examSent, [b.cid], { what: 'prova de volta' })
    clean(w.t, b)
  })

  await h.case('end() fecha todas as equipes e corrige a outra', async () => {
    await c.call(() => T.s.setAnswer('q3', { type: 'choice', selected: ['b'] }))
    await sleep(1000)
    await w.t.call(() => T.room.end())
    const sum = await w.sum()
    eq(sum.phase, 'ended', 'fase')
    const closed = sum.teams.filter((t) => t.key.startsWith('g:'))
    eq(closed.map((t) => t.closed), [true, true], 'as duas fecharam')
    await c.until(() => T.s.phase === 'ended' && T.s.saved.finished, [], { what: 'Caio avisado' })
    await a.until(() => T.s.phase === 'ended', [], { what: 'Ana avisada' })
    await w.t.until((id) => T.room.teams.get(id).grades.q3?.status === 'done', [`g:${beta.id}`], { what: 'nota da outra equipe', timeout: 150_000, every: 200 })
    eq((await w.sum()).teams.find((t) => t.key === `g:${beta.id}`).grades.q3.points, 5, 'pontos')
    await w.t.until(() => (T.room.queue?.pending ?? 0) === 0, [], { timeout: 150_000, what: 'fila vazia' })
    await sane(w)
    clean(w.t, b, c)
  }, 180_000)
}

// ---- 5. liberação da prova e tempo

async function s5(h) {
  let w = await world(h, { requireIsolation: true })
  await h.case('quem não está pronto não recebe a prova', async () => {
    const a = await joined(h, 'Ana', { fullscreen: false })
    const b = await joined(h, 'Beto', { screen: false })
    const c = await joined(h, 'Caio', { extended: true })
    const d = await joined(h, 'Dani', { isolated: null })
    const e = await joined(h, 'Eva', { isolated: false })
    await start(w)
    await sleep(2500)
    for (const p of [a, b, c, d, e]) {
      eq((await p.call((t) => T.rxCount(t), 'exam')), 0, `${p.name}: prova antes de estar pronto`)
      eq((await p.view()).hasExam, false, `${p.name}: prova`)
      eq((await p.view()).phase, 'running', `${p.name}: sala rodando`)
    }
    await a.call(() => T.setStatus({ fullscreen: true }))
    await waitExam(a)
    const sum = await w.sum()
    eq((await a.view()).endsAt, sum.endsAt, 'mesmo fim da sala')
    await d.call(() => T.setStatus({ isolated: true }))
    await waitExam(d)
    eq((await b.view()).hasExam, false, 'os outros seguem esperando')
    const qs = (await a.view()).exam.questions
    assert(qs.every((q) => !('notes' in q)), 'campo desconhecido não vai')
    clean(w.t, a, b, c, d, e)
  })

  w = await world(h)
  let a, b
  await h.case('global: todos com o mesmo fim, inclusive quem chega depois', async () => {
    a = await joined(h, 'Ana')
    await start(w)
    await waitExam(a)
    const sum = await w.sum()
    assert(Math.abs(sum.endsAt - (Date.now() + 3600_000)) < 10_000, 'duração de 60 min')
    b = await joined(h, 'Beto')
    await waitExam(b)
    eq((await a.view()).endsAt, sum.endsAt, 'Ana')
    eq((await b.view()).endsAt, sum.endsAt, 'Beto, que chegou depois')
  })
  await h.case('relógio: serverNow fica colado no do professor, com Date.now adiantado 1 h', async () => {
    const delta = async () => {
      const t0 = await w.t.call(() => Date.now())
      const s = await a.call(() => T.s.serverNow())
      const t1 = await w.t.call(() => Date.now())
      return s < t0 ? s - t0 : s > t1 ? s - t1 : 0
    }
    await a.until(() => T.s.clockAt > 0, [], { what: 'primeira medida' })
    assert(Math.abs(await delta()) < 100, `antes do ajuste: ${await delta()} ms`)
    await a.call(() => {
      const real = Date.now.bind(Date)
      Date.now = () => real() + 3600_000
    })
    assert(Math.abs(await delta()) < 100, `logo depois: ${await delta()} ms`)
    // A próxima sincronia não pode trazer o ajuste de volta.
    await a.call(() => T.s.syncClock())
    await sleep(300)
    assert(Math.abs(await delta()) < 100, `depois de sincronizar: ${await delta()} ms`)
    await sleep(16_000)
    assert(Math.abs(await delta()) < 100, `depois do ciclo de 15 s: ${await delta()} ms`)
    const rem = await a.call(() => T.s.remaining())
    const sum = await w.sum()
    assert(Math.abs(rem - (sum.endsAt - Date.now())) < 200, `tempo restante ${rem}`)
  }, 40_000)
  await h.case('estender manda o novo fim a todos', async () => {
    const before = (await w.sum()).endsAt
    await w.t.call(() => T.room.extend(5))
    await a.until((e) => T.s.saved.endsAt === e, [before + 300_000], { what: 'novo fim' })
    await b.until((e) => T.s.saved.endsAt === e, [before + 300_000], { what: 'novo fim' })
    clean(w.t, b)
  })

  w = await world(h, { timing: 'clock-in' })
  await h.case('clock-in: sem bater o ponto não há prova; cada um com seu fim', async () => {
    a = await joined(h, 'Ana')
    b = await joined(h, 'Beto')
    const c = await joined(h, 'Caio', { fullscreen: false })
    await start(w)
    await sleep(800)
    eq((await a.view()).hasExam, false, 'antes do ponto')
    eq((await w.sum()).endsAt, null, 'sem fim global')
    await c.call(() => T.s.clockIn())
    await sleep(500)
    eq((await c.view()).hasExam, false, 'sem estar pronto, o ponto é ignorado')
    eq((await w.team(c.cid)).endsAt, null, 'sem fim')
    await a.call(() => T.s.clockIn())
    await waitExam(a)
    const endA = (await a.view()).endsAt
    assert(Math.abs(endA - (Date.now() + 3600_000)) < 10_000, 'fim pessoal')
    eq((await w.team(a.cid)).endsAt, endA, 'mesmo fim no professor')
    await sleep(1200)
    eq((await b.view()).hasExam, false, 'o ponto de Ana não libera Beto')
    await b.call(() => T.s.clockIn())
    await waitExam(b)
    const endB = (await b.view()).endsAt
    assert(endB - endA >= 1000, `fins diferentes: ${endB - endA}`)
    clean(w.t, a, b, c)
  })
  await h.case('clock-in: o tempo de um acaba e só ele é encerrado', async () => {
    await w.t.call((c) => {
      T.room.teams.get(`s:${c}`).endsAt = Date.now() - 1
    }, a.cid)
    await a.until(() => T.s.phase === 'ended', [], { what: 'Ana encerrada', timeout: 5000 })
    await a.until(() => T.s.pendingUploads() === 0, [], { what: 'envios zerados' })
    eq((await b.view()).phase, 'running', 'Beto segue')
    assert((await w.student(a.cid)).finishedAt, 'professor registra o fim')
    clean(w.t, a, b)
  })

  w = await world(h, { timing: 'clock-in', mode: 'group' })
  await h.case('clock-in em equipe: o relógio é um só', async () => {
    a = await joined(h, 'Ana')
    b = await joined(h, 'Beto')
    const code = (await teamUp(a, 'Time')).code
    await joinTeam(b, code)
    await start(w)
    await a.call(() => T.s.clockIn())
    await waitExam(a)
    const endA = (await a.view()).endsAt
    await sleep(1200)
    await b.call(() => T.s.clockIn())
    await waitExam(b)
    eq((await b.view()).endsAt, endA, 'mesmo fim na equipe')
    clean(w.t, a, b)
  })
  await h.case('clock-in: movido para equipe sem ponto mantém o relógio e ganha o documento novo', async () => {
    const c = await joined(h, 'Caio')
    const other = await teamUp(c, 'Segunda')
    const endA = (await a.view()).endsAt
    await b.call(() => T.s.doc.files('q1').get('main.c').insert(0, '/*DA_PRIMEIRA*/'))
    await sleep(300)
    await w.t.call((cid, gid) => T.room.moveToGroup(cid, gid), b.cid, other.id)
    await b.until((id) => T.s.team?.id === id, [other.id], { what: 'Beto movido' })
    await b.until((text) => T.code('q1', 'main.c') === text, [STARTER_Q1], { what: 'documento da equipe nova' })
    eq((await b.view()).endsAt, endA, 'relógio')
    eq((await w.team(b.cid)).endsAt, endA, 'relógio no professor')
    clean(w.t, a, b, c)
  })
}

// ---- 6. equipes

async function s6(h) {
  const w = await world(h, { mode: 'group', maxTeamSize: 2 })
  const a = await joined(h, 'Ana')
  const b = await joined(h, 'Beto')
  const c = await joined(h, 'Caio')
  let code

  await h.case('criar: o código volta só para os integrantes', async () => {
    const team = await teamUp(a, 'Alfa')
    code = team.code
    assert(/^[A-Z2-9]{6}$/.test(code), `código ${code}`)
    eq(team.name, 'Alfa', 'nome')
    eq(team.members.map((m) => m.name), ['Ana'], 'integrantes')
    await sleep(200)
    for (const p of [b, c]) {
      const hits = await p.call((n) => T.rxFind(n), [code, 'Alfa'])
      eq(hits[code], 0, `${p.name} não pode ver o código`)
      eq(hits.Alfa, 0, `${p.name} não pode ver a equipe`)
      eq((await p.view()).team, null, `${p.name} sem equipe`)
    }
    const welcome = await b.call(() => T.rxAll('welcome')[0])
    assert(!('groups' in welcome.config), 'sem lista de equipes')
  })
  await h.case('nome vazio é recusado', async () => {
    await c.call(() => T.s.createTeam('   '))
    await c.until(() => T.s.teamError, [], { what: 'erro' })
    eq((await c.view()).teamError, 'name', 'motivo')
  })
  await h.case('código errado', async () => {
    await b.call(() => T.s.joinTeam('ZZZZZZ'))
    await b.until(() => T.s.teamError, [], { what: 'erro' })
    eq((await b.view()).teamError, 'code', 'motivo')
    eq((await b.view()).team, null, 'sem equipe')
  })
  await h.case('entra com o código, e o código aceita minúsculas', async () => {
    await b.call(() => { T.s.teamError = null })
    const team = await joinTeam(b, code.toLowerCase())
    eq(team.id, (await a.view()).team.id, 'mesma equipe')
    await a.until(() => T.s.team.members.length === 2, [], { what: 'Ana vê Beto' })
  })
  await h.case('equipe cheia', async () => {
    await c.call(() => { T.s.teamError = null })
    await c.call((co) => T.s.joinTeam(co), code)
    await c.until(() => T.s.teamError, [], { what: 'erro' })
    eq((await c.view()).teamError, 'full', 'motivo')
    eq((await c.view()).team, null, 'sem equipe')
  })
  await h.case('sair e voltar', async () => {
    await b.call(() => T.s.leaveTeam())
    await b.until(() => T.s.team === null, [], { what: 'saiu' })
    await a.until(() => T.s.team.members.length === 1, [], { what: 'Ana vê a saída' })
    await b.call(() => { T.s.teamError = null })
    await joinTeam(b, code)
    await a.until(() => T.s.team.members.length === 2, [], { what: 'Ana vê a volta' })
  })
  await h.case('equipe vazia some junto com o código', async () => {
    await c.call(() => { T.s.teamError = null })
    const team = await teamUp(c, 'Passageira')
    await sleep(2500)
    await c.call(() => T.s.leaveTeam())
    await c.until(() => T.s.team === null, [], { what: 'saiu' })
    await sleep(300)
    const sum = await w.sum()
    assert(!sum.config.groups.some((g) => g.id === team.id), 'grupo sobrou')
    assert(!sum.codes.some(([id]) => id === team.id), 'código sobrou')
    assert(!sum.teams.some((t) => t.key === `g:${team.id}`), 'equipe fantasma sobrou')
    await c.call((co) => T.s.joinTeam(co), team.code)
    await c.until(() => T.s.teamError, [], { what: 'erro' })
    eq((await c.view()).teamError, 'code', 'o código morreu junto')
  })
  await h.case('sem equipe não há prova', async () => {
    await start(w)
    await Promise.all([waitExam(a), waitExam(b)])
    await sleep(800)
    eq((await c.call((t) => T.rxCount(t), 'exam')), 0, 'sem equipe')
    eq((await c.view()).hasExam, false, 'sem equipe')
  })
  await h.case('com a prova liberada ninguém sai sozinho', async () => {
    await b.call(() => T.s.leaveTeam())
    await sleep(400)
    assert((await b.view()).team, 'Beto segue na equipe')
    assert((await w.student(b.cid)).groupId, 'professor também')
  })
  await h.case('quem entra numa equipe depois recebe a prova', async () => {
    await c.call(() => { T.s.teamError = null })
    const created = await teamUp(c, 'Tardia')
    assert(created.code, 'código')
    await waitExam(c)
  })
  await h.case('professor move antes da prova da pessoa', async () => {
    const d = await joined(h, 'Dani', { fullscreen: false })
    const beta = (await c.view()).team
    await w.t.call((cid, gid) => T.room.moveToGroup(cid, gid), d.cid, beta.id)
    await d.until(() => T.s.team, [], { what: 'Dani movida' })
    eq((await d.view()).team.id, beta.id, 'equipe')
    await c.until(() => T.s.team.members.length === 2, [], { what: 'Caio vê Dani' })
    eq((await d.view()).hasExam, false, 'não pronta, sem prova')
    await d.call(() => T.setStatus({ fullscreen: true }))
    await waitExam(d)
    clean(d)
  })
  await h.case('professor move para grupo inexistente é ignorado', async () => {
    const before = (await w.student(a.cid)).groupId
    await w.t.call((cid) => T.room.moveToGroup(cid, 'nao-existe'), a.cid)
    await sleep(200)
    eq((await w.student(a.cid)).groupId, before, 'continua onde estava')
  })
  await h.case('professor move no meio da prova: a pessoa troca de documento', async () => {
    // Cada equipe com o seu texto, e o movido não pode levar o da antiga para a nova.
    await a.call(() => T.s.doc.files('q1').get('main.c').insert(0, '/*MARCA_ALFA*/'))
    await c.call(() => T.s.doc.files('q1').get('main.c').insert(0, '/*MARCA_BETA*/'))
    const alfa = (await a.view()).team
    const beta = (await c.view()).team
    await sleep(600)
    await w.t.call((cid, gid) => T.room.moveToGroup(cid, gid), b.cid, beta.id)
    await b.until((id) => T.s.team?.id === id, [beta.id], { what: 'Beto na nova equipe' })
    await b.until(() => (T.code('q1', 'main.c') ?? '').includes('MARCA_BETA'), [], { what: 'Beto com o documento novo' })
    const moved = await b.call(() => T.code('q1', 'main.c'))
    assert(!moved.includes('MARCA_ALFA'), 'levou o texto da equipe antiga')
    eq(countOf(moved, 'STARTER_Q1'), 1, 'código inicial duplicado')
    await b.call(() => T.s.doc.files('q1').get('main.c').insert(0, '/*DO_BETO*/'))
    await c.until(() => T.code('q1', 'main.c').includes('DO_BETO'), [], { what: 'Caio vê Beto' })
    await sleep(700)
    const docs = (await w.sum()).docs
    const betaDoc = docs[`g:${beta.id}`].q1.files['main.c']
    const alfaDoc = docs[`g:${alfa.id}`].q1.files['main.c']
    assert(betaDoc.includes('DO_BETO') && !betaDoc.includes('MARCA_ALFA'), 'documento da nova equipe')
    assert(alfaDoc.includes('MARCA_ALFA') && !alfaDoc.includes('DO_BETO'), 'documento da antiga')
    await a.until(() => T.s.team.members.length === 1, [], { what: 'Ana vê a saída' })
    clean(w.t, a, b, c)
  })
}

// ---- 7. edição colaborativa

async function s7(h) {
  const w = await world(h, { mode: 'group', maxTeamSize: 3 })
  const a = await joined(h, 'Ana')
  const b = await joined(h, 'Beto')
  const c = await joined(h, 'Caio')
  const d = await joined(h, 'Dani', { fullscreen: false })
  const alfa = await teamUp(a, 'Alfa')
  await joinTeam(b, alfa.code)
  await joinTeam(d, alfa.code)
  await teamUp(c, 'Beta')
  const key = `g:${alfa.id}`

  await h.case('prova chega junto para os dois, e o código inicial não duplica', async () => {
    await start(w)
    await Promise.all([waitExam(a), waitExam(b), waitExam(c)])
    await a.until(() => T.code('q2', 'main.cpp') !== null)
    await b.until(() => T.code('q2', 'main.cpp') !== null)
    for (const p of [a, b]) {
      eq(await p.call(() => T.code('q1', 'main.c')), STARTER_Q1, `${p.name}: q1`)
      eq(await p.call(() => T.code('q2', 'main.cpp')), STARTER_Q2, `${p.name}: q2`)
    }
    eq((await a.view()).hasExam, true, 'prova')
  })

  await h.case('colega que não está pronto não recebe texto da equipe', async () => {
    await a.call(() => T.s.doc.files('q1').get('main.c').insert(0, '/*ANTES_DA_DANI*/'))
    await sleep(500)
    eq(await d.call((t) => T.rxCount(t), 'y-update'), 0, 'documento sem estar pronta')
    eq((await d.call((n) => T.rxFind(n), ['ANTES_DA_DANI'])).ANTES_DA_DANI, 0, 'texto da equipe')
    eq((await d.view()).hasExam, false, 'sem prova')
  })

  await h.case('quem fica pronto depois recebe tudo, sem duplicar', async () => {
    await d.call(() => T.setStatus({ fullscreen: true }))
    await waitExam(d)
    await d.until(() => (T.code('q1', 'main.c') ?? '').includes('ANTES_DA_DANI'))
    eq(countOf(await d.call(() => T.code('q1', 'main.c')), 'STARTER_Q1'), 1, 'código inicial')
    await a.call(() => T.s.doc.files('q1').get('main.c').delete(0, '/*ANTES_DA_DANI*/'.length))
    await converge([a, b, d], w, key, 'q1', 'main.c')
  })

  await h.case('dois digitando ao mesmo tempo convergem, professor junto', async () => {
    await Promise.all([a.call(() => T.type('q1', 'main.c', '§', 150)), b.call(() => T.type('q1', 'main.c', '¤', 150))])
    const text = await converge([a, b], w, key, 'q1', 'main.c')
    eq(countOf(text, '§'), 150, 'marcas da Ana')
    eq(countOf(text, '¤'), 150, 'marcas do Beto')
    eq(text.length, STARTER_Q1.length + 300, 'nada a mais')
    await w.t.until((c, t) => T.team(c).answers.q1?.answer.files['main.c'] === t, [a.cid, text], { what: 'answers do professor', timeout: 3000 })
    const answers = (await w.team(a.cid)).answers
    eq(answers.q1.answer.type, 'code', 'forma')
    eq(answers.q1.answer.lang, 'c', 'linguagem')
    eq(answers.q2.answer.files['main.cpp'], STARTER_Q2, 'q2 intacta')
  })

  await h.case('o que a equipe digita não vaza para a outra', async () => {
    eq((await c.call((n) => T.rxFind(n), ['§', '¤']))['§'], 0, 'texto de outra equipe')
    eq((await c.call((n) => T.rxFind(n), ['¤']))['¤'], 0, 'texto de outra equipe')
    await c.call(() => T.s.doc.files('q1').get('main.c').insert(0, '/*DA_BETA*/'))
    await sleep(500)
    eq((await a.call((n) => T.rxFind(n), ['DA_BETA'])).DA_BETA, 0, 'Beta não chega na Alfa')
    assert(!(await a.call(() => T.code('q1', 'main.c'))).includes('DA_BETA'), 'documento da Alfa')
  })

  await h.case('awareness passa só dentro da equipe, com o nome', async () => {
    await a.call(() => T.s.awareness.setLocalStateField('cursor', { anchor: 'CURSOR_DA_ANA' }))
    await b.until(() => [...T.s.awareness.getStates().values()].some((x) => x.cursor?.anchor === 'CURSOR_DA_ANA' && x.user?.name === 'Ana'), [], { what: 'Beto vê o cursor da Ana' })
    await sleep(300)
    eq((await c.call((n) => T.rxFind(n), ['CURSOR_DA_ANA'])).CURSOR_DA_ANA, 0, 'cursor em outra equipe')
    eq(await c.call(() => [...T.s.awareness.getStates().values()].filter((x) => x.user?.name !== 'Caio').length), 0, 'estados de outra equipe')
    const dump = await w.t.call((id) => T.idb.get('kv', `room:${id}`), w.roomId)
    assert(!JSON.stringify(dump).includes('CURSOR_DA_ANA'), 'cursor não é salvo')
  })

  await h.case('lixo no awareness não vira exceção no colega', async () => {
    await a.call(() => T.rawBin({ t: 'y-aware' }, [255, 255, 255, 255, 255]))
    await sleep(400)
    clean(w.t, b)
  })

  await h.case('adicionar, renomear e apagar arquivo chegam em todos', async () => {
    await a.call(() => T.s.doc.addFile('q1', 'util.h', '// UTIL\n'))
    await b.until(() => T.code('q1', 'util.h') === '// UTIL\n', [], { what: 'novo arquivo no Beto' })
    await w.t.until((c) => T.team(c).answers.q1?.answer.files['util.h'] === '// UTIL\n', [a.cid], { what: 'novo arquivo no professor', timeout: 3000 })
    await b.call(() => T.s.doc.renameFile('q1', 'util.h', 'lib.h'))
    await a.until(() => T.code('q1', 'lib.h') === '// UTIL\n' && T.code('q1', 'util.h') === null, [], { what: 'renomeado na Ana' })
    await w.t.until((c) => {
      const f = T.team(c).answers.q1?.answer.files
      return f && f['lib.h'] === '// UTIL\n' && !('util.h' in f)
    }, [a.cid], { what: 'renomeado no professor', timeout: 3000 })
    await a.call(() => T.s.doc.removeFile('q1', 'lib.h'))
    await b.until(() => T.code('q1', 'lib.h') === null, [], { what: 'apagado no Beto' })
    await w.t.until((c) => !('lib.h' in T.team(c).answers.q1.answer.files), [a.cid], { what: 'apagado no professor', timeout: 3000 })
  })

  await h.case('quem fica sem rede edita, volta e tudo se mescla', async () => {
    await b.call(() => T.goOffline())
    await w.t.until((c) => !T.room.students.get(c).online, [b.cid], { what: 'Beto fora' })
    await b.call(() => T.s.doc.files('q1').get('main.c').insert(0, '/*OFFLINE_BETO*/'))
    await a.call(() => T.s.doc.files('q1').get('main.c').insert(0, '/*ONLINE_ANA*/'))
    await a.until(() => T.code('q1', 'main.c').includes('ONLINE_ANA'))
    await sleep(300)
    assert(!(await b.call(() => T.code('q1', 'main.c'))).includes('ONLINE_ANA'), 'offline mesmo')
    await b.call(() => T.goOnline())
    await b.live()
    const text = await converge([a, b, d], w, key, 'q1', 'main.c')
    assert(text.includes('OFFLINE_BETO') && text.includes('ONLINE_ANA'), 'as duas edições')
    eq(await b.call(() => T.code('q2', 'main.cpp')), STARTER_Q2, 'código inicial')
    eq(countOf(text, 'OFFLINE_BETO'), 1, 'sem repetir')
  })

  await h.case('reconexão não duplica o código inicial', async () => {
    await a.call(() => T.s.link.close())
    await sleep(100)
    await a.until(() => T.s.linkState === 'online' && T.s.welcomed && !!T.s.channel)
    await sleep(800)
    for (const p of [a, b, d]) eq(await p.call(() => T.code('q2', 'main.cpp')), STARTER_Q2, `${p.name}: q2`)
    eq((await w.sum()).docs[key].q2.files['main.cpp'], STARTER_Q2, 'professor: q2')
    clean(w.t, a, b, c, d)
  })

  const w3 = await world(h, { mode: 'group', maxTeamSize: 2 })
  const g = await joined(h, 'Gil')
  const i = await joined(h, 'Iara')
  await h.case('quem termina antes não congela o código final da equipe', async () => {
    const team = await teamUp(g, 'Time')
    await joinTeam(i, team.code)
    await start(w3)
    await Promise.all([waitExam(g), waitExam(i)])
    await g.call((code) => T.setCode('q1', 'main.c', code), SUM_WRONG)
    await i.until((code) => T.code('q1', 'main.c') === code, [SUM_WRONG], { what: 'código do Gil' })
    await g.call(() => T.s.finish())
    await w3.t.until((cid) => T.room.students.get(cid).finishedAt, [g.cid], { what: 'Gil terminou' })
    await w3.t.until((cid) => T.team(cid).submissions.q1?.answer.files['main.c'] !== undefined, [g.cid], { what: 'entrega do Gil' })
    // Depois de terminar, a policy não aceita mais edição dele.
    await g.call(() => T.s.doc.files('q1').get('main.c').insert(0, '/*DEPOIS_DO_FIM*/'))
    await i.call((code) => T.setCode('q1', 'main.c', code), SUM_OK)
    await sleep(700)
    await w3.t.call(() => T.room.end())
    const key = `g:${team.id}`
    const final = (await w3.sum()).teams.find((t) => t.key === key).submissions.q1.answer.files['main.c']
    assert(!final.includes('DEPOIS_DO_FIM'), 'edição de quem já terminou entrou')
    assert(final.includes('a + b'), `congelou o código de quando o colega terminou: ${final.slice(0, 80)}`)
    const grade = await w3.t.until((k) => {
      const g = T.room.teams.get(k).grades.q1
      return g && !['pending', 'running'].includes(g.status) ? g : null
    }, [key], { what: 'nota final', timeout: 150_000, every: 200 })
    eq([grade.status, grade.points], ['done', 10], 'nota do código final')
    clean(w3.t, g, i)
  }, 180_000)

  const w2 = await world(h)
  const e = await joined(h, 'Eva')
  const f = await joined(h, 'Fabi')
  await h.case('prova individual: documento próprio, sem cursor', async () => {
    await start(w2)
    await Promise.all([waitExam(e), waitExam(f)])
    await e.call(() => T.s.doc.files('q1').get('main.c').insert(0, '/*SO_EVA*/'))
    await w2.t.until((c) => T.team(c).answers.q1?.answer.files['main.c'].includes('SO_EVA'), [e.cid], { what: 'professor com o texto', timeout: 3000 })
    await e.call(() => T.s.awareness.setLocalStateField('cursor', { anchor: 'X' }))
    await sleep(300)
    eq((await f.call((n) => T.rxFind(n), ['SO_EVA'])).SO_EVA, 0, 'nada chega no outro')
    eq(await f.call((t) => T.rxCount(t), 'y-aware'), 0, 'sem awareness')
    eq((await w2.team(f.cid)).answers.q1.answer.files['main.c'], STARTER_Q1, 'Fabi intacta')
    await e.call(() => T.s.link.close())
    await sleep(100)
    await e.until(() => T.s.linkState === 'online' && T.s.welcomed && !!T.s.channel)
    await sleep(800)
    eq(countOf(await e.call(() => T.code('q1', 'main.c')), 'STARTER_Q1'), 1, 'sem duplicar')
    eq(await e.call(() => T.code('q2', 'main.cpp')), STARTER_Q2, 'q2')
    clean(w2.t, e, f)
  })
}

// ---- 8. confiabilidade

async function s8(h) {
  const PASS = 'senha-confiavel'
  const w = await world(h, { password: PASS, mode: 'group', maxTeamSize: 2, recordScreen: true })
  const a = await joined(h, 'Ana', {}, PASS)
  const b = await joined(h, 'Beto', {}, PASS)
  const c = await joined(h, 'Caio', {}, PASS)
  const alfa = await teamUp(a, 'Alfa')
  await joinTeam(b, alfa.code)
  await teamUp(c, 'Beta')
  const key = `g:${alfa.id}`
  await start(w)
  await Promise.all([waitExam(a), waitExam(b), waitExam(c)])
  await a.until(() => T.code('q2', 'main.cpp') !== null)
  await b.until(() => T.code('q2', 'main.cpp') !== null)
  const stream = (s) => s.alerts.filter((x) => ['disconnected', 'signal-lost', 'reload'].includes(x.kind)).length

  await h.case('o painel salva mesmo com atividade sem parar', async () => {
    // Com a turma mexendo o tempo todo, um adiamento a cada toque nunca salvaria.
    await a.call(() => T.busy('¶', 50))
    // Cada equipe tem o documento numa chave própria (roomStore): room:<id>:doc:<equipe>.
    const read = () => w.t.call(async (id, team) => (await T.idb.get('kv', `room:${id}:doc:${team}`))?.byteLength ?? 0, w.roomId, key)
    const pump = setInterval(() => w.t.call(() => T.room.touch()).catch(() => {}), 100)
    try {
      const first = await read()
      await sleep(3000)
      const second = await read()
      assert(second > first, `snapshot parado em ${first} bytes`)
    } finally {
      clearInterval(pump)
      await a.call(() => T.calm())
    }
    await converge([a, b], w, key, 'q2', 'main.cpp')
  })

  await h.case('painel recarrega (dispose + load) com todos digitando', async () => {
    const before = await w.sum()
    await a.call(() => { T.link0 = T.s.link; T.busy('¤', 25) })
    await b.call(() => { T.link0 = T.s.link; T.busy('¦', 25) })
    await sleep(400)
    await w.t.call((addr, token) => T.reloadRoom(addr, token), h.hubLocal, TOKEN)
    await sleep(1500)
    const na = await a.call(() => T.calm())
    const nb = await b.call(() => T.calm())
    for (const p of [a, b, c]) {
      const v = await p.view()
      eq(v.refused, null, `${p.name}: recusado`)
      eq(v.phase, 'running', `${p.name}: fase`)
      eq(v.hasExam, true, `${p.name}: prova`)
    }
    assert(await a.call(() => T.s.link === T.link0), 'Ana não pode ter reconectado')
    assert(await b.call(() => T.s.link === T.link0), 'Beto não pode ter reconectado')
    const text = await converge([a, b], w, key, 'q2', 'main.cpp')
    assert(countOf(text, '¤') >= na, `perdeu digitação da Ana: ${countOf(text, '¤')} de ${na}`)
    assert(countOf(text, '¦') >= nb, `perdeu digitação do Beto: ${countOf(text, '¦')} de ${nb}`)
    const after = await w.sum()
    eq(stream(after), stream(before), 'nenhum alerta novo de queda')
    eq(after.phase, 'running', 'fase')
    assert(after.students.every((s) => s.online), 'todos online')
    await w.t.until((cid) => T.room.students.get(cid).examSent, [a.cid], { what: 'prova reenviada' })
    clean(w.t, a, b, c)
  })

  await h.case('depois da recarga: fluxos, relay e documento seguem', async () => {
    await a.call(() => T.s.raise('paste', 'pos-recarga'))
    await a.until(() => T.s.pendingUploads() === 0, [], { what: 'alerta confirmado' })
    assert((await w.sum()).alerts.some((x) => x.detail === 'pos-recarga'), 'alerta chegou')
    await a.call(() => T.s.doc.files('q1').get('main.c').insert(0, '/*POS_RECARGA*/'))
    await b.until(() => T.code('q1', 'main.c').includes('POS_RECARGA'), [], { what: 'relay' })
    await w.t.until((cid) => T.team(cid).answers.q1?.answer.files['main.c'].includes('POS_RECARGA'), [a.cid], { timeout: 3000, what: 'answers' })
    await sleep(600)
    eq((await w.student(a.cid)).chainBroken, false, 'cadeia intacta')
  })

  await h.case('F5 de verdade no painel, com alerta recém-confirmado', async () => {
    const seen = async () => (await w.sum()).alerts.filter((x) => x.detail === 'antes-do-f5').length
    await a.call(() => T.s.raise('paste', 'antes-do-f5'))
    await a.until(() => T.s.pendingUploads() === 0, [], { what: 'confirmado', every: 5, timeout: 5000 })
    await w.t.reload()
    await w.t.call((id, addr, token) => T.loadRoom(id, addr, token), w.roomId, h.hubLocal, TOKEN)
    await w.t.until((cid) => T.room.students.get(cid)?.online, [a.cid], { what: 'Ana de volta' })
    eq(await seen(), 1, 'o alerta confirmado não pode sumir')
    await a.call(() => T.s.raise('paste', 'depois-do-f5'))
    await a.until(() => T.s.pendingUploads() === 0, [], { what: 'fluxo destravado', timeout: 5000 })
    const sum = await w.sum()
    eq(sum.alerts.filter((x) => x.detail === 'depois-do-f5').length, 1, 'alerta novo')
    eq(sum.students.find((s) => s.clientId === a.cid).chainBroken, false, 'cadeia intacta')
    clean(w.t, a, b, c)
  })

  await h.case('F5 do painel no meio de uma correção não a deixa presa', async () => {
    await a.call((code) => T.setCode('q1', 'main.c', code), SUM_OK)
    await a.call(() => T.s.submit('q1'))
    await w.t.until((cid) => ['pending', 'running'].includes(T.gradeOf(cid, 'q1')?.status), [a.cid], { what: 'correção começou' })
    await sleep(800)
    await w.t.reload()
    await w.t.call((id, addr, token) => T.loadRoom(id, addr, token), w.roomId, h.hubLocal, TOKEN)
    const grade = await w.t.until((cid) => {
      const g = T.gradeOf(cid, 'q1')
      return g && !['pending', 'running'].includes(g.status) ? g : null
    }, [a.cid], { what: 'nota depois da recarga', timeout: 120_000 })
    eq(grade.status, 'done', 'status')
    eq(grade.points, 10, 'pontos')
    clean(w.t)
  }, 150_000)

  await h.case('F5 do aluno: entra sem senha, documento volta, um alerta de reload', async () => {
    await a.call(() => T.s.doc.files('q1').get('main.c').insert(0, '/*ANTES_DO_F5*/'))
    await sleep(1300)
    const before = await w.sum()
    const text = await a.call(() => T.code('q1', 'main.c'))
    await a.reload()
    await a.call(() => T.newStudent())
    const restored = await a.call(async () => {
      const ok = await T.s.restore()
      // Antes de qualquer rede: o que está aqui veio do disco.
      return { ok, code: T.code('q1', 'main.c'), exam: !!T.s.exam, phase: T.s.phase, resumed: T.s.resumed }
    })
    eq(restored.ok, true, 'restaurou')
    eq(restored.code, text, 'documento do disco')
    eq(restored.exam, true, 'prova do disco')
    eq(restored.phase, 'running', 'fase')
    await a.live()
    eq((await a.view()).refused, null, 'sem pedir senha')
    await w.t.until((cid, n) => T.room.alerts.filter((x) => x.clientId === cid && x.kind === 'reload').length > n, [a.cid, alertCount(before, a.cid, 'reload')], { what: 'alerta de reload' })
    await sleep(800)
    const after = await w.sum()
    eq(alertCount(after, a.cid, 'reload'), alertCount(before, a.cid, 'reload') + 1, 'um reload só')
    eq(after.students.length, 3, 'mesmo lugar')
    eq(countOf(await a.call(() => T.code('q1', 'main.c')), 'ANTES_DO_F5'), 1, 'sem duplicar')
    eq(await a.call(() => T.code('q2', 'main.cpp')), await b.call(() => T.code('q2', 'main.cpp')), 'q2 igual')
    await a.call(() => T.s.doc.files('q1').get('main.c').insert(0, '/*DEPOIS_DO_F5*/'))
    await b.until(() => T.code('q1', 'main.c').includes('DEPOIS_DO_F5'), [], { what: 'relay' })
    clean(a, b, w.t)
  })

  await h.case('hub reinicia: todos voltam sozinhos, sem senha', async () => {
    const before = await w.sum()
    await h.hubDown()
    await w.t.until(() => T.room.busState === 'down', [], { what: 'painel viu a queda' })
    await a.until(() => T.s.linkState !== 'online', [], { what: 'Ana viu a queda' })
    await c.until(() => T.s.linkState !== 'online', [], { what: 'Caio viu a queda' })
    await a.call(() => T.s.doc.files('q1').get('main.c').insert(0, '/*SEM_HUB*/'))
    await h.hubUp()
    // O painel volta por gesto (ou pelo reforço do Dashboard); os alunos, sozinhos.
    assert(await w.t.call((addr, token) => T.reattach(addr, token), h.hubLocal, TOKEN), 'painel não voltou')
    for (const p of [a, b, c]) await p.live(20_000)
    await w.t.until((ids) => ids.every((id) => T.room.students.get(id).online && T.room.students.get(id).examSent), [[a.cid, b.cid, c.cid]], { what: 'todos de volta' })
    const text = await converge([a, b], w, key, 'q1', 'main.c')
    assert(text.includes('SEM_HUB'), 'edição feita com o hub fora')
    eq(countOf(await b.call(() => T.code('q2', 'main.cpp')), 'STARTER_Q2'), 1, 'código inicial')
    await sleep(500)
    const after = await w.sum()
    eq(after.alerts.filter((x) => x.kind === 'signal-lost').length, before.alerts.filter((x) => x.kind === 'signal-lost').length, 'sem sinal é alerta falso aqui')
    for (const p of [a, b, c]) eq((await p.view()).refused, null, `${p.name}: recusa`)
    clean(a, b, c, w.t)
  }, 60_000)

  await h.case('rec: cai no meio, os acks alcançam, nada se perde nem repete', async () => {
    const total = 12
    await c.call(() => {
      for (let i = 0; i < 6; i++) void T.part(7, i, false, `parte-${i}|`)
    })
    await sleep(120)
    await c.call(() => T.goOffline())
    await c.call(async () => {
      for (let i = 6; i < 12; i++) await T.part(7, i, i === 11, `parte-${i}|`)
    })
    assert((await c.view()).rec > 0, 'precisa ter ficado pendente')
    await c.call(() => T.goOnline())
    await c.until(() => T.s.pendingUploads() === 0, [], { what: 'envios zerados', timeout: 20_000 })
    const st = await w.student(c.cid)
    eq(st.segments[7].parts, total, 'partes')
    eq(st.segments[7].complete, true, 'completo')
    const expected = Array.from({ length: total }, (_, i) => `parte-${i}|`).join('')
    const got = await w.t.call(async (cid) => {
      const seg = T.room.students.get(cid).segments[7]
      return (await T.room.segmentBlob(cid, seg)).text()
    }, c.cid)
    eq(got, expected, 'bytes do segmento')
    eq(st.segments[7].size, expected.length, 'tamanho')
    assert(!(await w.t.call(() => Object.keys(Object.prototype).length)), 'protótipo')
    clean(c, w.t)
  })

  await h.case('rec: pedaço sumido do disco não trava o fluxo', async () => {
    await c.call(() => T.goOffline())
    const lost = await c.call(async () => {
      await T.part(8, 0, false, 'a|')
      await T.part(8, 1, false, 'b|')
      await T.part(8, 2, true, 'c|')
      const key = T.s.recQueue[1].key
      await T.idb.del('chunks', key)
      return key
    })
    assert(lost, 'chave')
    await c.call(() => T.goOnline())
    await c.until(() => T.s.pendingUploads() === 0, [], { what: 'envios zerados', timeout: 10_000 })
    const got = await w.t.call(async (cid) => (await T.room.segmentBlob(cid, T.room.students.get(cid).segments[8])).text(), c.cid)
    eq(got, 'a|c|', 'o resto chegou')
    await c.call(() => T.part(9, 0, true, 'depois|'))
    await c.until(() => T.s.pendingUploads() === 0, [], { what: 'o seguinte também', timeout: 5000 })
  })

  await h.case('eventos: rajada com queda no meio chega inteira, em ordem', async () => {
    await b.call(() => {
      for (let i = 0; i < 15; i++) void T.s.raise('paste', `rajada-${i}`)
    })
    await sleep(30)
    await b.call(() => T.goOffline())
    await b.call(async () => {
      for (let i = 15; i < 30; i++) await T.s.raise('paste', `rajada-${i}`)
    })
    await b.call(() => T.goOnline())
    await b.until(() => T.s.pendingUploads() === 0, [], { what: 'envios zerados', timeout: 15_000 })
    const sum = await w.sum()
    const details = sum.alerts.filter((x) => x.clientId === b.cid && x.detail?.startsWith('rajada-')).map((x) => x.detail).reverse()
    eq(details, Array.from({ length: 30 }, (_, i) => `rajada-${i}`), 'alertas')
    await sleep(300)
    eq((await w.student(b.cid)).chainBroken, false, 'cadeia intacta')
    clean(b, w.t)
  })

  await h.case('eventos: rajada sem queda não acusa cadeia quebrada', async () => {
    await a.call(() => {
      for (let i = 0; i < 25; i++) void T.s.raise('paste', `limpa-${i}`)
    })
    await a.until(() => T.s.pendingUploads() === 0, [], { what: 'envios zerados', timeout: 10_000 })
    await sleep(300)
    eq((await w.student(a.cid)).chainBroken, false, 'cadeia intacta')
  })

  await h.case('número pulado no fluxo não trava', async () => {
    await b.call(async () => {
      T.s.saved.eventSeq += 5
      await T.s.raise('paste', 'depois-do-buraco')
    })
    await b.until(() => T.s.pendingUploads() === 0, [], { what: 'confirmado', timeout: 5000 })
    assert((await w.sum()).alerts.some((x) => x.detail === 'depois-do-buraco'), 'alerta chegou')
  })

  await h.case('entrega logo depois de um alerta não fura a fila', async () => {
    await a.call(() => T.s.setAnswer('q3', { type: 'choice', selected: ['b'] }))
    await a.call(async () => {
      const raising = T.s.raise('paste', 'junto-da-entrega')
      await new Promise((r) => setTimeout(r, 0))
      const submit = T.s.submit('q3')
      await Promise.all([raising, submit])
    })
    await a.until(() => T.s.pendingUploads() === 0, [], { what: 'sem precisar reconectar', timeout: 5000 })
    assert((await w.team(a.cid)).submissions.q3, 'entrega chegou')
    assert((await w.sum()).alerts.some((x) => x.detail === 'junto-da-entrega'), 'alerta chegou')
  })

  await h.case('submit e finish com a equipe fechada não travam o fluxo', async () => {
    await c.call(() => T.s.setAnswer('q3', { type: 'choice', selected: ['a'] }))
    await sleep(1000)
    await w.t.call((k) => T.room.closeTeam(T.room.teams.get(k)), `g:${(await c.view()).team.id}`)
    await c.until(() => T.s.phase === 'ended' && T.s.saved.finished, [], { what: 'Caio encerrado' })
    await c.until(() => T.s.pendingUploads() === 0, [], { what: 'envios zerados', timeout: 5000 })
    await c.call(() => T.s.submit('q3'))
    await c.call(() => T.s.raise('paste', 'depois-de-fechar'))
    await c.until(() => T.s.pendingUploads() === 0, [], { what: 'envios zerados de novo', timeout: 5000 })
    const st = await w.student(c.cid)
    assert(st.finishedAt, 'fim registrado')
    const team = await w.team(c.cid)
    eq(team.closed, true, 'fechada')
    eq(team.submissions.q3.answer.selected, ['a'], 'rascunho virou entrega')
    clean(c, w.t)
  })

  await h.case('prova encerrada para quem nunca recebeu a prova: nada fica pendente', async () => {
    const d = await joined(h, 'Dani', { fullscreen: false }, PASS)
    await d.until(() => T.s.phase === 'running', [], { what: 'Dani na sala' })
    await w.t.call(() => T.room.end())
    await d.until(() => T.s.phase === 'ended' && T.s.saved.finished, [], { what: 'Dani encerrada' })
    await d.until(() => T.s.pendingUploads() === 0, [], { what: 'envios zerados', timeout: 5000 })
    for (const p of [a, b]) {
      await p.until(() => T.s.phase === 'ended' && T.s.saved.finished, [], { what: `${p.name} encerrado` })
      await p.until(() => T.s.pendingUploads() === 0, [], { what: `${p.name} sem pendências`, timeout: 5000 })
    }
    clean(d, a, b, w.t)
  }, 60_000)

  const w2 = await world(h)
  const e = await joined(h, 'Eva')
  await h.case('F5 do painel logo depois de liberar: fase salva e código inicial único', async () => {
    await start(w2)
    await waitExam(e)
    await w2.t.reload()
    await w2.t.call((id, addr, token) => T.loadRoom(id, addr, token), w2.roomId, h.hubLocal, TOKEN)
    eq(await w2.t.call(() => T.room.phase), 'running', 'fase')
    await w2.t.until((c) => T.room.students.get(c)?.examSent, [e.cid], { what: 'prova de novo' })
    await sleep(800)
    eq(await e.call(() => T.code('q1', 'main.c')), STARTER_Q1, 'q1 no aluno')
    eq((await w2.sum()).docs[`s:${e.cid}`].q1.files['main.c'], STARTER_Q1, 'q1 no professor')
    clean(w2.t, e)
  })
}

// ---- 9. correção

async function s9(h) {
  const w = await world(h)
  const a = await joined(h, 'Ana')
  const b = await joined(h, 'Beto')
  const c = await joined(h, 'Caio')
  await start(w)
  await Promise.all([waitExam(a), waitExam(b), waitExam(c)])

  const submitCode = async (p, q, file, code) => {
    await p.call((q, f, code) => T.setCode(q, f, code), q, file, code)
    await p.call((q) => T.s.submit(q), q)
  }
  const gradeDone = (p, q, timeout = 150_000) =>
    w.t.until((cid, q) => {
      const g = T.gradeOf(cid, q)
      return g && !['pending', 'running'].includes(g.status) ? g : null
    }, [p.cid, q], { what: `nota de ${p.name}`, timeout, every: 200 })

  await h.case('correto: todos os testes ocultos passam', async () => {
    await submitCode(a, 'q1', 'main.c', SUM_OK)
    const g = await gradeDone(a, 'q1')
    eq(g.status, 'done', 'status')
    eq(g.points, 10, 'pontos')
    eq(g.tests.map((t) => t.passed), [true, true], 'testes')
    eq((await w.team(a.cid)).submissions.q1.answer.files['main.c'], SUM_OK, 'corrige o que está no documento')
  }, 180_000)

  await h.case('errado: zero, sem travar', async () => {
    await submitCode(b, 'q1', 'main.c', SUM_WRONG)
    const g = await gradeDone(b, 'q1')
    eq(g.status, 'done', 'status')
    eq(g.points, 0, 'pontos')
    eq(g.tests.map((t) => t.passed), [false, false], 'testes')
  }, 180_000)

  await h.case('erro de compilação vira compile-error, com o log', async () => {
    await submitCode(c, 'q1', 'main.c', SUM_BROKEN)
    const g = await gradeDone(c, 'q1')
    eq(g.status, 'compile-error', 'status')
    assert(g.compileLog && g.compileLog.includes('error'), 'log do compilador')
    eq(g.points, 0, 'pontos')
  }, 180_000)

  await h.case('laço infinito estoura o tempo e a fila anda', async () => {
    const started = Date.now()
    await submitCode(c, 'q1', 'main.c', SUM_LOOP)
    await w.t.until((cid) => T.gradeOf(cid, 'q1')?.status !== 'compile-error', [c.cid], { what: 'nova correção' })
    const g = await gradeDone(c, 'q1')
    eq(g.status, 'done', 'status')
    eq(g.points, 0, 'pontos')
    assert(g.tests.every((t) => t.timedOut && !t.passed), 'estourou o tempo')
    assert(Date.now() - started >= 3500, 'dois testes de 2 s')
    eq((await w.sum()).gradeRunning, 0, 'fila vazia')
  }, 180_000)

  await h.case('múltipla escolha e texto', async () => {
    await a.call(() => {
      T.s.setAnswer('q3', { type: 'choice', selected: ['b'] })
      T.s.setAnswer('q4', { type: 'text', text: 'Ponteiro guarda endereço.' })
    })
    await b.call(() => T.s.setAnswer('q3', { type: 'choice', selected: ['a'] }))
    await sleep(900)
    await a.call(async () => {
      await T.s.submit('q3')
      await T.s.submit('q4')
    })
    await b.call(() => T.s.submit('q3'))
    const ok = await gradeDone(a, 'q3', 5000)
    eq([ok.status, ok.points], ['done', 5], 'certa')
    const bad = await gradeDone(b, 'q3', 5000)
    eq([bad.status, bad.points], ['done', 0], 'errada')
    eq((await gradeDone(a, 'q4', 5000)).status, 'manual', 'texto é manual')
    await w.t.call((cid) => T.room.setManualGrade(`s:${cid}`, 'q4', 99), a.cid)
    const manual = await w.t.call((cid) => T.gradeOf(cid, 'q4'), a.cid)
    eq([manual.points, manual.graded], [5, true], 'nota manual limitada ao máximo')
  })

  await h.case('testar: amostras completas, ocultos só em contagem', async () => {
    await a.call(() => T.s.runTest('q1'))
    const report = await a.until(() => T.s.testReport, [], { timeout: 120_000, what: 'relatório' })
    eq(report.status, 'done', 'status')
    eq(report.hidden, { passed: 2, total: 2 }, 'contagem')
    eq(report.samples.map((s) => [s.passed, s.stdin, s.expected]), [[true, '1 2\n', '3\n']], 'amostra')
    eq(Object.keys(report).sort(), ['hidden', 'log', 'nextInMs', 'questionId', 'reqId', 'samples', 'status'], 'campos do relatório')
    eq(Object.keys(report.hidden).sort(), ['passed', 'total'], 'campos do oculto')
    assert(report.nextInMs > 0 && report.nextInMs <= 60_000, `próximo em ${report.nextInMs}`)
    const hits = await a.call((n) => T.rxFind(n), [HIDDEN_IN, HIDDEN_OUT])
    eq([hits[HIDDEN_IN], hits[HIDDEN_OUT]], [0, 0], 'entrada e saída ocultas')
  }, 150_000)

  await h.case('o limite de 1 por minuto é do professor', async () => {
    // Direto pelo canal, sem o contador da tela: é o que um cliente adulterado faria.
    await a.call((code) => T.raw({ t: 'test', reqId: 'denovo', questionId: 'q1', lang: 'c', files: { 'main.c': code } }), SUM_OK)
    const limited = await a.until(() => T.rxAll('test-result').find((m) => m.result.reqId === 'denovo')?.result, [], { what: 'resposta', timeout: 5000 })
    eq(limited.status, 'limited', 'status')
    assert(limited.retryInMs > 0 && limited.retryInMs <= 60_000, `espera ${limited.retryInMs}`)
    // Só o mapa privado é adiantado, para não esperar o minuto.
    await w.t.call((cid) => T.room.lastTest.set(`s:${cid}`, Date.now() - 60_001), a.cid)
    await a.call(() => {
      T.s.testReport = null
      T.s.nextTestAt = 0
    })
    await a.call(() => T.s.runTest('q1'))
    const again = await a.until(() => T.s.testReport, [], { timeout: 120_000, what: 'relatório' })
    eq(again.status, 'done', 'passado o minuto, roda')
  }, 150_000)

  await h.case('testar com erro de compilação devolve o log', async () => {
    await b.call((code) => T.setCode('q1', 'main.c', code), SUM_BROKEN)
    await b.call(() => T.s.runTest('q1'))
    const report = await b.until(() => T.s.testReport, [], { timeout: 120_000, what: 'relatório' })
    eq(report.status, 'compile-error', 'status')
    assert(report.log.includes('error'), 'log')
  }, 150_000)

  await h.case('testar com arquivos fora do limite não deixa o botão preso', async () => {
    await w.t.call((cid) => T.room.lastTest.delete(`s:${cid}`), b.cid)
    await b.call(() => {
      T.s.nextTestAt = 0
      T.s.testReport = null
      T.setCode('q1', 'main.c', 'x'.repeat(300 * 1024))
    })
    await b.call(() => T.s.runTest('q1'))
    await b.until(() => !T.s.testing, [], { what: 'botão livre', timeout: 5000 })
    await b.call((code) => T.setCode('q1', 'main.c', code), SUM_WRONG)
  })

  await h.case('rodar no aluno em WebAssembly', async () => {
    await a.call((code) => T.setCode('q1', 'main.c', code), SUM_OK)
    await a.call(() => T.s.runProgram('q1', '5 6\n'))
    const out = (await a.view()).runOutput
    eq(out.where, 'local', 'onde')
    eq(out.state, 'done', 'estado')
    eq(out.stdout, '11\n', 'saída')
    eq(out.exitCode, 0, 'código de saída')
    eq((await a.view()).running, false, 'livre')
  }, 180_000)

  await h.case('rodar com laço infinito no aluno para no limite', async () => {
    await c.call(() => T.s.runProgram('q1', ''))
    const out = (await c.view()).runOutput
    eq(out.state, 'done', 'estado')
    assert(out.error, 'avisa o motivo')
    eq((await c.view()).running, false, 'livre')
  }, 180_000)

  await h.case('rodar na máquina do professor, com limite', async () => {
    const answer = (code) => ({ type: 'code', lang: 'c', files: { 'main.c': code } })
    await b.call((ans) => {
      T.s.running = true
      T.s.runOnHost(ans, '2 3\n')
    }, answer(SUM_OK))
    await b.until(() => !T.s.running, [], { timeout: 120_000, what: 'resultado' })
    const out = (await b.view()).runOutput
    eq(out.where, 'host', 'onde')
    eq(out.state, 'done', 'estado')
    eq(out.stdout, '5\n', 'saída')
    await b.call((ans) => {
      T.s.running = true
      T.s.runOnHost(ans, '2 3\n')
    }, answer(SUM_OK))
    await b.until(() => !T.s.running, [], { timeout: 5000, what: 'recusa' })
    assert(/Espere/.test((await b.view()).runOutput.error ?? ''), 'limite de 1 a cada 5 s')
    await w.t.call((cid) => T.room.lastRun.clear(), b.cid)
    await b.call((ans) => {
      T.s.running = true
      T.s.runOnHost(ans, '')
    }, answer(SUM_BROKEN))
    await b.until(() => !T.s.running, [], { timeout: 120_000, what: 'erro de compilação' })
    eq((await b.view()).runOutput.state, 'compile-error', 'estado')
    await w.t.call((cid) => T.room.lastRun.clear(), b.cid)
    await b.call((ans) => {
      T.s.running = true
      T.s.runOnHost(ans, 'nada')
    }, answer(SUM_LOOP))
    await b.until(() => !T.s.running, [], { timeout: 30_000, what: 'estouro' })
    assert((await b.view()).runOutput.error, 'avisa o estouro')
  }, 180_000)

  await h.case('C++ com STL é corrigido', async () => {
    await submitCode(a, 'q2', 'main.cpp', DOUBLE_OK)
    const g = await gradeDone(a, 'q2')
    eq([g.status, g.points], ['done', 10], 'nota')
    clean(w.t, a, b, c)
  }, 180_000)

  const w2 = await world(h, { mode: 'group' })
  await h.case('em equipe o limite é da equipe', async () => {
    const d = await joined(h, 'Dani')
    const e = await joined(h, 'Eva')
    const team = await teamUp(d, 'Time')
    await joinTeam(e, team.code)
    await start(w2)
    await Promise.all([waitExam(d), waitExam(e)])
    await d.call(() => T.s.runTest('q1'))
    await d.until(() => T.rxCount('test-result') > 0, [], { what: 'na fila', timeout: 5000 })
    await e.call((code) => T.raw({ t: 'test', reqId: 'colega', questionId: 'q1', lang: 'c', files: { 'main.c': code } }), SUM_OK)
    const res = await e.until(() => T.rxAll('test-result').find((m) => m.result.reqId === 'colega')?.result, [], { what: 'resposta', timeout: 5000 })
    // Com o teste da Dani ainda na fila, o do colega é recusado como ocupado; depois dele, pelo minuto.
    assert(res.status === 'busy' || res.status === 'limited', `colega dentro do mesmo minuto: ${res.status}`)

    // Fila cheia de propósito: o teste da equipe espera, avisa a posição, e um segundo é recusado.
    await d.until(() => !T.s.testing, [], { what: 'teste da Dani terminou', timeout: 120_000 })
    await w2.t.call((cid) => {
      const r = T.room
      r.lastTest.delete(r.teamKey(r.students.get(cid)))
      for (let i = 0; i < r.jobs.limits.running; i++) r.jobs.push({ lane: 'test', key: `ocupa${i}`, compile: false, run: () => new Promise((ok) => setTimeout(ok, 4000)) })
    }, e.cid)
    await e.call((code) => T.raw({ t: 'test', reqId: 'fila1', questionId: 'q1', lang: 'c', files: { 'main.c': code } }), SUM_OK)
    const queued = await e.until(() => T.rxAll('test-result').find((m) => m.result.reqId === 'fila1')?.result, [], { what: 'na fila', timeout: 5000 })
    eq(queued.status, 'queued', 'primeiro entra na fila')
    assert(queued.position >= 1, `posição ${queued.position}`)
    const spent = await w2.t.call((cid) => T.room.lastTest.get(T.room.teamKey(T.room.students.get(cid))), e.cid)
    await d.call((code) => T.raw({ t: 'test', reqId: 'fila2', questionId: 'q1', lang: 'c', files: { 'main.c': code } }), SUM_OK)
    const busy = await d.until(() => T.rxAll('test-result').find((m) => m.result.reqId === 'fila2')?.result, [], { what: 'recusa', timeout: 5000 })
    eq(busy.status, 'busy', 'segundo da mesma equipe')
    eq(await w2.t.call((cid) => T.room.lastTest.get(T.room.teamKey(T.room.students.get(cid))), e.cid), spent, 'o segundo não gasta o minuto')
    const started = await e.until(() => T.rxAll('test-result').find((m) => m.result.reqId === 'fila1' && m.result.position === 0)?.result, [], { what: 'começou', timeout: 20_000 })
    eq(started.status, 'queued', 'aviso de que começou')
    const done = await e.until(() => T.rxAll('test-result').find((m) => m.result.reqId === 'fila1' && m.result.status === 'done')?.result, [], { what: 'resultado', timeout: 120_000 })
    eq(done.hidden.total > 0, true, 'rodou')
    clean(w2.t, d, e)
  }, 200_000)

  await h.case('executável do aluno: malformado é recusado sem gastar o minuto, válido roda', async () => {
    const f = await joined(h, 'Fabi')
    const g = await joined(h, 'Gil')
    const team = await teamUp(f, 'Bin')
    await joinTeam(g, team.code)
    await Promise.all([waitExam(f), waitExam(g)])
    const key = await w2.t.call((cid) => T.room.teamKey(T.room.students.get(cid)), f.cid)
    // Memória sem máximo: o compilador nunca gera, o professor tem de recusar antes de instanciar.
    const bad = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 5, 3, 1, 0, 1]
    await f.call((bytes) => T.rawBin({ t: 'test-wasm', reqId: 'ruim', questionId: 'q1', lang: 'c' }, bytes), bad)
    const refused = await f.until(() => T.rxAll('test-result').find((m) => m.result.reqId === 'ruim')?.result, [], { what: 'recusa', timeout: 5000 })
    eq(refused.status, 'invalid', 'recusado')
    assert(/máximo/.test(refused.log), refused.log)
    eq(await w2.t.call((k) => T.room.lastTest.has(k), key), false, 'minuto não gasto')
    await f.call((code) => T.setCode('q1', 'main.c', code), SUM_OK)
    await f.call(() => T.s.runTest('q1'))
    const report = await f.until(() => T.s.testReport, [], { timeout: 120_000, what: 'relatório' })
    eq([report.status, report.log], ['done', ''], 'roda o executável, sem log do professor')
    eq(report.hidden, { passed: 2, total: 2 }, 'contagem')
    clean(w2.t, f, g)
  }, 200_000)
}

// ---- 10. estado e selo

async function s10(h) {
  let w = await world(h)
  const a = await joined(h, 'Ana')
  const b = await joined(h, 'Beto')
  const c = await joined(h, 'Caio')
  await start(w)
  await Promise.all([waitExam(a), waitExam(b), waitExam(c)])
  const alerts = async (p, kind) => alertCount(await w.sum(), p.cid, kind)

  await h.case('desfoque só no batimento, sem evento, gera um alerta', async () => {
    await a.call(() => T.setStatus({ focused: false }, false))
    await w.t.until((cid) => T.room.alerts.some((x) => x.clientId === cid && x.kind === 'focus-lost'), [a.cid], { what: 'alerta', timeout: 5000 })
    await sleep(4500)
    eq(await alerts(a, 'focus-lost'), 1, 'exatamente um, mesmo com vários batimentos')
    await a.call(() => T.setStatus({ focused: true }, false))
    await sleep(2500)
    eq(await alerts(a, 'focus-lost'), 1, 'voltar não é alerta')
    await a.call(() => T.setStatus({ focused: false }, false))
    await w.t.until((cid) => T.room.alerts.filter((x) => x.clientId === cid && x.kind === 'focus-lost').length === 2, [a.cid], { what: 'segunda saída', timeout: 5000 })
    await a.call(() => T.setStatus({ focused: true }, false))
  })

  await h.case('evento e batimento juntos não dobram', async () => {
    await b.call(async () => {
      T.proctor.focused = false
      await T.s.raise('focus-lost')
      T.s.onStatus(T.s.proctor.status())
    })
    await sleep(3000)
    eq(await alerts(b, 'focus-lost'), 1, 'evento antes do estado')
    await c.call(async () => {
      T.setStatus({ fullscreen: false })
      await T.s.raise('fullscreen-exit')
    })
    await sleep(3000)
    eq(await alerts(c, 'fullscreen-exit'), 1, 'estado antes do evento')
    await b.call(() => T.setStatus({ focused: true }))
    await c.call(() => T.setStatus({ fullscreen: true }))
    await b.until(() => T.s.pendingUploads() === 0)
    await c.until(() => T.s.pendingUploads() === 0)
    await sleep(200)
    eq(await alerts(b, 'focus-lost'), 1, 'continua um')
  })

  await h.case('outros estados também geram alerta só pelo batimento', async () => {
    await a.call(() => T.setStatus({ screen: false, extended: true, isolated: false }, false))
    await w.t.until((cid) => ['share-ended', 'multi-monitor', 'internet-back'].every((k) => T.room.alerts.some((x) => x.clientId === cid && x.kind === k)), [a.cid], { what: 'os três', timeout: 5000 })
    await a.call(() => T.setStatus({ screen: true, extended: false, isolated: true }, false))
    await sleep(2300)
    for (const k of ['share-ended', 'multi-monitor', 'internet-back']) eq(await alerts(a, k), 1, k)
    clean(w.t, a, b, c)
  })

  w = await world(h)
  const d = await joined(h, 'Dani')
  await start(w)
  await waitExam(d)
  const state = (cid) => w.t.call((c) => {
    const b = T.room.beacons.get(c)
    return b ? { fails: b.fails, everOk: b.everOk, codes: b.codes.length } : null
  }, cid)

  await h.case('miniaturas chegam pelo caminho real de sendFrame', async () => {
    await w.t.until((cid) => T.room.thumbs.has(cid), [d.cid], { what: 'miniatura', timeout: 8000 })
    await w.t.call((cid) => T.room.setFocus(cid), d.cid)
    await w.t.until((cid) => T.room.liveFrame.has(cid), [d.cid], { what: 'quadro ao vivo', timeout: 5000 })
    await w.t.call(() => T.room.setFocus(null))
    await d.until(() => !T.s.focusOn, [], { what: 'foco desligado' })
  })

  await h.case('selo: PNG real decodificado pelo professor', async () => {
    await w.t.until((cid) => T.room.students.get(cid).beaconOk === true, [d.cid], { what: 'selo aceito', timeout: 10_000 })
    const st = await state(d.cid)
    eq(st.everOk, true, 'já leu')
    eq(st.fails, 0, 'sem falhas')
    // Dois códigos diferentes, para não ser sorte de um só.
    const seen = await d.call(() => T.beaconSeen.size)
    await d.until((n) => T.beaconSeen.size > n, [seen], { what: 'outro código', timeout: 5000 })
    await sleep(1200)
    assert((await w.student(d.cid)).beaconOk, 'continua aceito')
    eq(alertCount(await w.sum(), d.cid, 'beacon-missing'), 0, 'sem alerta')
  })

  await h.case('selo: código errado, duas vezes depois da carência, um alerta só', async () => {
    await d.call(() => { T.beaconMode = 'wrong' })
    await w.t.until((cid) => T.room.alerts.some((x) => x.clientId === cid && x.kind === 'beacon-missing'), [d.cid], { what: 'alerta', timeout: 15_000 })
    eq((await w.student(d.cid)).beaconOk, false, 'marcado')
    await sleep(6500)
    eq(alertCount(await w.sum(), d.cid, 'beacon-missing'), 1, 'não repete')
  })

  await h.case('selo: volta ao normal quando lê certo, e acusa de novo se cair', async () => {
    await d.call(() => { T.beaconMode = 'right' })
    await w.t.until((cid) => T.room.students.get(cid).beaconOk === true, [d.cid], { what: 'recuperou', timeout: 10_000 })
    eq((await state(d.cid)).fails, 0, 'zerou')
    await d.call(() => { T.beaconMode = 'garbage' })
    await w.t.until((cid) => T.room.alerts.filter((x) => x.clientId === cid && x.kind === 'beacon-missing').length === 2, [d.cid], { what: 'segundo alerta', timeout: 15_000 })
    await d.call(() => { T.beaconMode = 'right' })
    await w.t.until((cid) => T.room.students.get(cid).beaconOk === true, [d.cid], { what: 'recuperou', timeout: 10_000 })
  })

  await h.case('selo: sem quadro nenhum também é falha', async () => {
    await d.call(() => { T.beaconMode = 'none' })
    await w.t.until((cid) => T.room.alerts.filter((x) => x.clientId === cid && x.kind === 'beacon-missing').length === 3, [d.cid], { what: 'terceiro alerta', timeout: 15_000 })
    await d.call(() => { T.beaconMode = 'right' })
    await w.t.until((cid) => T.room.students.get(cid).beaconOk === true, [d.cid], { what: 'recuperou', timeout: 10_000 })
  })

  await h.case('selo: fora de tela cheia a falha não conta', async () => {
    await d.call(() => {
      T.beaconMode = 'none'
      T.setStatus({ fullscreen: false })
    })
    await sleep(7000)
    eq(alertCount(await w.sum(), d.cid, 'beacon-missing'), 3, 'já tem outro alerta dizendo isso')
    eq((await state(d.cid)).fails, 0, 'não contou')
    await d.call(() => {
      T.beaconMode = 'right'
      T.setStatus({ fullscreen: true })
    })
    clean(w.t, d)
  })

  await h.case('selo: na carência não acusa; passada a carência, acusa', async () => {
    const e = await student(h, 'Eva')
    await e.call(() => { T.beaconMode = 'wrong' })
    await join(h, e, 'Eva')
    await e.live()
    e.cid = (await e.view()).clientId
    await waitExam(e)
    await w.t.until((cid) => T.room.beacons.get(cid)?.fails >= 2, [e.cid], { what: 'duas falhas', timeout: 15_000 })
    eq(alertCount(await w.sum(), e.cid, 'beacon-missing'), 0, 'na carência, nada')
    eq((await state(e.cid)).everOk, false, 'nunca leu')
    // Só o início da contagem é recuado, para não esperar os 15 s.
    await w.t.call((cid) => { T.room.beacons.get(cid).sinceAt -= 16_000 }, e.cid)
    await w.t.until((cid) => T.room.alerts.some((x) => x.clientId === cid && x.kind === 'beacon-missing'), [e.cid], { what: 'alerta depois da carência', timeout: 10_000 })
    await sleep(3500)
    eq(alertCount(await w.sum(), e.cid, 'beacon-missing'), 1, 'um só')
    clean(w.t, e)
  }, 45_000)
}

// ---- 11. modo manual

async function s11(h) {
  const w = await world(h, { flow: 'manual', mode: 'individual' })
  const ids = (p) => p.call(() => T.s.exam.questions.map((q) => q.id))
  let a, b

  await h.case('manual: nada chega antes de liberar', async () => {
    a = await joined(h, 'Ana')
    await start(w)
    await a.until(() => !!T.s.exam, [], { what: 'prova vazia' })
    eq(await ids(a), [], 'nenhuma questão')
    eq((await w.sum()).endsAt, null, 'sem relógio geral')
    eq(await a.call(() => T.snap('q1')), null, 'código inicial fora do documento')
    const dump = await a.call(() => T.dumpIdb())
    for (const leak of [CANARY.statement, 'STARTER_Q1', 'Soma', 'Explique', 'Capital']) assert(!dump.includes(leak), `vazou ${leak}`)
    clean(w.t, a)
  })

  await h.case('durante a contagem o conteúdo ainda não saiu do professor', async () => {
    await w.t.call(() => T.room.releaseQuestion('q1'))
    await a.until(() => T.s.countdownEnds > performance.now(), [], { what: 'contagem no aluno', timeout: 2500 })
    eq(await ids(a), [], 'nada ainda')
    assert(!(await a.call(() => T.dumpIdb())).includes(`Soma`), 'título não vazou')
    eq(await w.t.call(() => T.room.clocks.q1 ?? null), null, 'relógio só começa na revelação')
    await w.t.call(() => T.room.releaseQuestion('q1'))
    eq(await w.t.call(() => T.room.releasing.size), 1, 'clique duplo não libera duas vezes')
  })

  await h.case('liberar entrega só a escolhida, com o código inicial uma vez', async () => {
    await a.until(() => T.s.exam.questions.length === 1 && !!T.s.doc.snapshot('q1'), [], { what: 'q1 liberada' })
    eq(await ids(a), ['q1'], 'só q1')
    eq(countOf(await a.call(() => T.code('q1', 'main.c')), 'STARTER_Q1'), 1, 'código inicial uma vez')
    eq(await a.call(() => T.snap('q2')), null, 'q2 continua fora')
    const dump = await a.call(() => T.dumpIdb())
    for (const leak of ['Dobro', 'STARTER_Q2', 'Capital']) assert(!dump.includes(leak), `vazou ${leak}`)
  })

  await h.case('quem chega depois recebe só o que está liberado', async () => {
    b = await joined(h, 'Beto')
    await b.until(() => !!T.s.exam && !!T.s.doc.snapshot('q1'), [], { what: 'Beto com q1' })
    eq(await ids(b), ['q1'], 'só q1')
  })

  await h.case('retirar congela a resposta, e editar depois não muda a nota', async () => {
    await a.call((c) => T.setCode('q1', 'main.c', c), SUM_OK)
    await w.t.until((cid, c) => T.room.teamOf(T.room.students.get(cid)).answers.q1?.answer.files['main.c'] === c, [a.cid, SUM_OK], { what: 'professor com o código', timeout: 8000 })
    await w.t.call(() => T.room.withdrawQuestion('q1'))
    await a.until(() => T.s.exam.questions.length === 0, [], { what: 'q1 some do aluno' })
    await a.call((c) => T.setCode('q1', 'main.c', c), SUM_WRONG)
    await sleep(1500)
    const team = await w.team(a.cid)
    eq(team.submissions.q1.answer.files['main.c'], SUM_OK, 'entrega congelada')
    const grade = await w.t.until((cid) => { const g = T.gradeOf(cid, 'q1'); return g?.status === 'done' ? g : null }, [a.cid], { what: 'corrigida', timeout: 60_000 })
    eq(grade.points, 10, 'nota da versão congelada')
  }, 90_000)

  await h.case('liberar de novo volta com o que tinha', async () => {
    await w.t.call(() => T.room.releaseQuestion('q1'))
    await a.until(() => T.s.exam.questions.length === 1, [], { what: 'q1 de volta' })
    eq(await a.call(() => T.code('q1', 'main.c')), SUM_WRONG, 'mantém o texto')
    eq(await a.call(() => T.s.questionOpen('q1')), true, 'aberta')
  })

  await h.case('tempo esgotado fecha, mantém visível e nega rascunho', async () => {
    await w.t.call(() => T.room.releaseQuestion('q4', 1))
    await a.until(() => T.s.exam.questions.some((q) => q.id === 'q4'), [], { what: 'q4 liberada' })
    await a.call(() => T.s.setAnswer('q4', { type: 'text', text: 'dentro do tempo' }))
    await w.t.until((cid) => T.room.teamOf(T.room.students.get(cid)).answers.q4?.answer.text === 'dentro do tempo', [a.cid], { what: 'rascunho', timeout: 8000 })
    await w.t.call(() => { T.room.clocks = { ...T.room.clocks, q4: { ...T.room.clocks.q4, endsAt: Date.now() + 200 } } })
    await w.t.until(() => T.room.clocks.q4.closed === true, [], { what: 'fechou', timeout: 8000 })
    await a.until(() => T.s.saved.clocks.q4?.closed === true, [], { what: 'aluno sabe' })
    assert((await ids(a)).includes('q4'), 'continua visível')
    eq(await a.call(() => T.s.questionOpen('q4')), false, 'fechada no aluno')
    await a.call(() => T.raw({ t: 'draft', questionId: 'q4', answer: { type: 'text', text: 'fora do tempo' }, rev: 999 }))
    await sleep(800)
    const team = await w.team(a.cid)
    eq(team.answers.q4.answer.text, 'dentro do tempo', 'rascunho negado')
    eq(team.submissions.q4.answer.text, 'dentro do tempo', 'entrega congelada')
  })

  await h.case('somar tempo reabre', async () => {
    await w.t.call(() => T.room.addQuestionTime('q4', 1))
    await a.until(() => T.s.questionOpen('q4'), [], { what: 'reabriu' })
  })

  await h.case('teste de questão fechada é recusado sem gastar o minuto', async () => {
    await w.t.call(() => T.room.withdrawQuestion('q1'))
    await a.until(() => !T.s.exam.questions.some((q) => q.id === 'q1'), [], { what: 'q1 fora' })
    await a.call(() => T.raw({ t: 'test', reqId: 'x', questionId: 'q1', lang: 'c', files: { 'main.c': 'int main(void){return 0;}' } }))
    await a.until(() => T.s.testReport?.log === 'Esta questão está fechada', [], { what: 'recusa', timeout: 6000 })
    eq(await w.t.call(() => T.room.lastTest.size), 0, 'minuto não gasto')
  })

  await h.case('F5 do painel mantém os relógios', async () => {
    const before = await w.t.call(() => JSON.stringify(T.room.clocks))
    await sleep(1300)
    await w.t.call((addr, token) => T.reloadRoom(addr, token), h.hubLocal, TOKEN)
    eq(await w.t.call(() => JSON.stringify(T.room.clocks)), before, 'relógios iguais')
    await a.live()
    await a.until(() => T.s.exam.questions.some((q) => q.id === 'q4'), [], { what: 'q4 depois de recarregar' })
    await sane(w)
    clean(w.t, a, b)
  })

  await h.case('encerrar mantém a versão congelada do que já fechou', async () => {
    await w.t.call(() => T.room.end())
    await sleep(800)
    const team = await w.team(a.cid)
    // q1 foi retirada de novo com o texto errado: é essa versão que vale, e encerrar não a refaz.
    eq(team.submissions.q1.answer.files['main.c'], SUM_WRONG, 'última versão congelada')
    assert(!!team.closed, 'fechada')
    await sane(w)
  })
}

export const scenarios = [
  ['1 aperto de mão', s1],
  ['2 confidencialidade', s2],
  ['3 identidade', s3],
  ['3b chave do professor', s3b],
  ['4 policy', s4],
  ['4b equipe envenenada', s4b],
  ['5 liberação e tempo', s5],
  ['6 equipes', s6],
  ['7 edição colaborativa', s7],
  ['8 confiabilidade', s8],
  ['9 correção', s9],
  ['10 estado e selo', s10],
  ['11 modo manual', s11],
]
