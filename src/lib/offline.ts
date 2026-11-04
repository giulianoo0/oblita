// Instalação da página: uma visita com internet e ela passa a abrir sozinha, sem rede.
import { useEffect, useState } from 'react'
import { requestPersistence } from './idb'

export type OfflineState = { status: 'unsupported' | 'installing' | 'ready' | 'error'; done: number; total: number }

let state: OfflineState = { status: 'installing', done: 0, total: 0 }
const listeners = new Set<(s: OfflineState) => void>()

function set(next: OfflineState) {
  state = next
  for (const fn of listeners) fn(next)
}

export function startOffline() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return set({ status: 'unsupported', done: 0, total: 0 })
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const m = e.data
    if (m?.type === 'precache') set({ status: m.done >= m.total ? 'ready' : 'installing', done: m.done, total: m.total })
    if (m?.type === 'precache-error') set({ ...state, status: 'error' })
  })
  void navigator.serviceWorker
    .register('/sw.js')
    .then(async (reg) => {
      await navigator.serviceWorker.ready
      void requestPersistence()
      // Abas abertas antes da instalação pedem o estado para refletir a verdade.
      ;(reg.active ?? navigator.serviceWorker.controller)?.postMessage({ type: 'precache-status' })
    })
    .catch(() => set({ ...state, status: 'error' }))
}

export function useOffline() {
  const [s, setS] = useState(state)
  useEffect(() => {
    listeners.add(setS)
    setS(state)
    return () => void listeners.delete(setS)
  }, [])
  return s
}
