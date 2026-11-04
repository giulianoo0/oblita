import { expect, test } from 'bun:test'
import { keepConnected } from './reconnect'

// Relógio de mentira: guarda cada espera pedida e roda o passo seguinte na hora.
function clock() {
  const waits: number[] = []
  let next: (() => void) | null = null
  return {
    waits,
    schedule: (fn: () => void, ms: number) => {
      waits.push(ms)
      next = fn
      return 0
    },
    async step() {
      const fn = next
      next = null
      fn?.()
      await new Promise((r) => setTimeout(r, 0))
    },
  }
}

test('tenta de novo com espera crescente e volta ao normal ao conectar', async () => {
  const c = clock()
  let down = true
  const results = [false, false, false, true]
  let tries = 0
  const stop = keepConnected({
    wanted: async () => down,
    connect: async () => {
      const ok = results[tries++]
      if (ok) down = false
      return ok
    },
    schedule: c.schedule,
    cancel: () => {},
  })
  for (let i = 0; i < 6; i++) await c.step()
  expect(tries).toBe(4)
  expect(c.waits.slice(0, 5)).toEqual([0, 1000, 2000, 4000, 1000])
  stop()
})

test('erro ao conectar conta como falha, e parar interrompe o laço', async () => {
  const c = clock()
  let tries = 0
  const stop = keepConnected({
    wanted: async () => true,
    connect: async () => {
      tries++
      throw new Error('programa fechado')
    },
    schedule: c.schedule,
    cancel: () => {},
  })
  for (let i = 0; i < 8; i++) await c.step()
  expect(c.waits.at(-1)).toBe(15000)
  stop()
  const before = tries
  await c.step()
  await c.step()
  expect(tries).toBe(before)
})
