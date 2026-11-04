import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createHub } from '../../server/hub'
import { connectHubBus } from './bus'

const PORT = 17788
let app: ReturnType<typeof createHub>

beforeAll(() => {
  app = createHub('tok').listen({ hostname: '127.0.0.1', port: PORT })
})

afterAll(() => app.stop())

// A aba não pode acumular sem limite: acima do teto, o aluno daquela conexão cai e reenvia ao voltar.
test('acima do teto de envio, derruba o aluno em vez de crescer a memória da aba', async () => {
  const bus = await connectHubBus(`127.0.0.1:${PORT}`, 'tok', { maxBuffered: 4 * 1024 * 1024 })
  const opened = new Promise<string>((r) => (bus.onopen = r))
  const student = new WebSocket(`ws://127.0.0.1:${PORT}/ws/student`)
  const closed = new Promise<void>((r) => (student.onclose = () => r()))
  const peer = await opened
  const big = new Uint8Array(2 * 1024 * 1024)
  let refused = 0
  for (let i = 0; i < 40; i++) if (!bus.send(peer, big)) refused++
  expect(refused).toBeGreaterThan(0)
  expect(bus.buffered(peer)).toBeLessThan(8 * 1024 * 1024)
  await closed
  bus.close()
})
