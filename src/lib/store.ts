import { useSyncExternalStore } from 'react'

// As sessões do aluno e do professor vivem fora do React e sobrevivem à troca de rota.
export class Observable {
  private listeners = new Set<() => void>()
  private version = 0

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  getVersion = () => this.version

  protected changed() {
    this.version++
    for (const fn of this.listeners) fn()
  }
}

export function useObservable<T extends Observable>(obj: T): T {
  useSyncExternalStore(obj.subscribe, obj.getVersion)
  return obj
}

export const randomId = (bytes = 16) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('')

export const formatClock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`
}
