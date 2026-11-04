// Só em desenvolvimento (/sala/<id>?demo=100): uma sala de mentira, sem rede e sem disco, para ver o
// painel cheio. O Dashboard só importa isto atrás de import.meta.env.DEV, então não vai para o build.
import type { Exam } from '../../shared/exam'
import type { AlertKind, Group, RoomConfig } from '../../shared/protocol'
import { openRoom, registerRoom, Room, type AlertEntry, type Grade, type Student } from './room'

const FIRST = ['Ana', 'João', 'Júlia', 'Lucas', 'Mariana', 'Pedro', 'Beatriz', 'Gabriel', 'Letícia', 'Rafael', 'Camila', 'Thiago', 'Ângela', 'Vinícius', 'Larissa', 'Matheus', 'Sofia', 'Caio', 'Isabela', 'André', 'Lívia', 'Otávio', 'Débora', 'Henrique', 'Íris']
const LAST = ['Souza', 'Oliveira', 'Conceição', 'Araújo', 'Lima', 'Gonçalves', 'Ribeiro', 'Simões', 'Carvalho', 'Fernandes', 'Brandão', 'Assunção', 'Pereira', 'Magalhães', 'Castro']
const TEAMS = ['Azul', 'Verde', 'Laranja', 'Índigo', 'Coral', 'Âmbar', 'Lima', 'Cobalto', 'Ébano', 'Jade', 'Ônix', 'Rubi', 'Safira', 'Topázio', 'Turquesa', 'Vinho', 'Marfim', 'Prata', 'Ouro', 'Bronze', 'Cobre', 'Ferro', 'Grafite', 'Neve', 'Areia']
const KINDS: AlertKind[] = ['focus-lost', 'fullscreen-exit', 'tab-hidden', 'paste', 'devtools-shortcut']
const THUMB_HUES = [255, 150, 70, 320, 200, 25]

const exam: Exam = {
  version: 1,
  title: 'Prova de demonstração',
  durationMin: 90,
  questions: [
    { id: 'q1', type: 'code', title: 'Soma de vetores', statement: '.', points: 3, languages: ['cpp'], starter: { cpp: 'int main() {}\n' } },
    { id: 'q2', type: 'code', title: 'Pilha com lista ligada', statement: '.', points: 3, languages: ['cpp'] },
    { id: 'q3', type: 'choice', title: 'Complexidade', statement: '.', points: 2, options: [{ id: 'a', text: 'O(n)' }, { id: 'b', text: 'O(n²)' }] },
    { id: 'q4', type: 'text', title: 'Explique a recursão', statement: '.', points: 2 },
  ],
}

// Sempre a mesma turma: dá para comparar capturas de tela.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
}

function thumb(hue: number, seed: number) {
  const r = rng(seed)
  const lines = Array.from({ length: 11 }, (_, i) => {
    const w = 40 + Math.floor(r() * 200)
    const x = 24 + Math.floor(r() * 3) * 16
    return `<rect x="${x}" y="${30 + i * 14}" width="${w}" height="6" rx="3" fill="oklch(0.7 0.12 ${(hue + i * 37) % 360})" opacity="0.8"/>`
  }).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#1e1e24"/><rect width="320" height="18" fill="#2b2b33"/><rect x="8" y="6" width="60" height="6" rx="3" fill="oklch(0.6 0.15 ${hue})"/>${lines}</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

class DemoRoom extends Room {
  private random = rng(7)

  // A sala de mentira não tem disco: nada dos relógios de salvar e de conferir sinal pode rodar.
  override holdTab() {
    return Promise.resolve(true)
  }

  pulse() {
    const now = Date.now()
    const r = this.random
    const list = [...this.students.values()]
    if (!list.length) return
    for (const s of list) if (s.online) s.lastBeat = now
    for (let i = 0; i < 12; i++) {
      const s = list[Math.floor(r() * list.length)]
      const roll = r()
      if (roll < 0.15) s.online = !s.online
      else if (roll < 0.3) s.status = { ...s.status, screen: !s.status.screen }
      else if (roll < 0.38 && s.online) this.alert(s, KINDS[Math.floor(r() * KINDS.length)], now)
      else this.thumbs.set(s.clientId, thumb(THUMB_HUES[Math.floor(r() * THUMB_HUES.length)], Math.floor(r() * 1e6)))
    }
    this.changed()
  }

  alert(s: Student, kind: AlertKind, at: number) {
    const entry: AlertEntry = { id: `${s.clientId}:${at}:${kind}`, clientId: s.clientId, name: s.name, kind, at, severe: kind === 'devtools-shortcut', thumb: this.thumbs.get(s.clientId) }
    s.alerts++
    s.lastAlert = entry
    this.alerts = [entry, ...this.alerts]
  }
}

function build(roomId: string, count: number, mode: 'group' | 'individual') {
  const r = rng(42)
  const now = Date.now()
  const room = new DemoRoom()
  const teamCount = Math.ceil(count / 4)
  const groups: Group[] = mode === 'group' ? Array.from({ length: teamCount }, (_, i) => ({ id: `t${i}`, name: `Equipe ${TEAMS[i % TEAMS.length]}${i >= TEAMS.length ? ` ${Math.floor(i / TEAMS.length) + 1}` : ''}` })) : []
  const config: RoomConfig = { roomId, title: exam.title, mode, flow: 'free', timing: 'global', compiler: true, requireIsolation: false, recordScreen: true, maxTeamSize: 4, groups }
  room.config = config
  room.exam = exam
  room.phase = 'running'
  room.endsAt = now + 47 * 60_000
  room.roomCode = 'DEMO42'
  room.fingerprint = 'DEM-042'
  room.busState = 'hub'
  room.hubAddresses = ['192.168.0.10']

  for (let i = 0; i < count; i++) {
    const name = `${FIRST[Math.floor(r() * FIRST.length)]} ${LAST[Math.floor(r() * LAST.length)]}`
    const roll = r()
    const s: Student = {
      clientId: Array.from({ length: 16 }, () => Math.floor(r() * 16).toString(16)).join(''),
      name,
      enrollment: r() < 0.85 ? String(2023000 + Math.floor(r() * 999)).padStart(7, '0') : undefined,
      tokenHash: '',
      examGranted: true,
      groupId: mode === 'group' && r() < 0.95 ? groups[i % teamCount].id : undefined,
      peer: null,
      online: roll > 0.12,
      examSent: true,
      status: { screen: roll > 0.2, fullscreen: true, focused: r() > 0.1, isolated: true, extended: false },
      lastBeat: roll > 0.12 ? now : now - Math.floor(r() * 90 * 60_000),
      signalLost: false,
      alerts: 0,
      finishedAt: r() < 0.08 ? now - Math.floor(r() * 20 * 60_000) : undefined,
      lastEvent: 0,
      lastRec: 0,
      chainBroken: false,
      segments: {},
    }
    room.students.set(s.clientId, s)
    if (r() < 0.85) room.thumbs.set(s.clientId, thumb(THUMB_HUES[i % THUMB_HUES.length], i))
    for (let a = Math.floor(r() * r() * 6); a > 0; a--) room.alert(s, KINDS[Math.floor(r() * KINDS.length)], now - Math.floor(r() * 40 * 60_000))
  }
  room.alerts.sort((a, b) => b.at - a.at)
  // Privado na sala de verdade; aqui só para a parede mostrar o código como mostraria.
  for (const g of groups) room['teamCodes'].set(g.id, `${g.name.slice(7, 10).toUpperCase()}-${String(Math.floor(r() * 900) + 100)}`)

  // Notas da equipe: cada uma num ponto diferente da correção.
  for (const s of room.students.values()) {
    const team = room.teamOf(s)
    if (Object.keys(team.grades).length || Object.keys(team.answers).length) continue
    // Uma parte da turma ainda não respondeu nada.
    if (r() < 0.25) continue
    for (const q of exam.questions) {
      const roll = r()
      if (roll < 0.15) continue
      if (q.type === 'text') team.answers[q.id] = { answer: { type: 'text', text: 'Uma função que chama a si mesma.' }, rev: 1 }
      else if (q.type === 'choice') team.answers[q.id] = { answer: { type: 'choice', selected: ['a'] }, rev: 1 }
      else team.answers[q.id] = { answer: { type: 'code', lang: 'cpp', files: { 'main.cpp': `int main() { return ${Math.floor(roll * 100)}; }\n` } }, rev: 1 }
      const grade: Grade | null =
        roll < 0.3 || (s.finishedAt === undefined && r() < 0.4) ? null
        : roll < 0.38 ? { questionId: q.id, status: 'pending', points: 0, max: q.points }
        : roll < 0.48 && q.type === 'text' ? { questionId: q.id, status: 'manual', points: 0, max: q.points }
        : roll < 0.52 && q.type === 'code' ? { questionId: q.id, status: 'compile-error', points: 0, max: q.points }
        : { questionId: q.id, status: 'done', points: Math.round(r() * q.points * 2) / 2, max: q.points }
      if (grade) team.grades[q.id] = grade
    }
  }
  return room
}

export async function openDemoRoom(roomId: string, count: number, mode: 'group' | 'individual') {
  const live = await openRoom(roomId)
  if (live) return live
  const room = build(roomId, Math.max(0, Math.min(500, count)), mode)
  registerRoom(room)
  // Para medir com mais pressão pelo console: setInterval(() => oblitaDemo.pulse(), 20).
  Object.assign(window, { oblitaDemo: room })
  window.setInterval(() => room.pulse(), 1000)
  return room
}
