// Instalação da página: uma visita com internet e ela passa a abrir sozinha, sem rede.
import { useEffect, useState } from 'react'
import { requestPersistence } from './idb'

export type OfflineState = { status: 'unsupported' | 'installing' | 'ready' | 'error'; done: number; total: number; update: string | null }

// A versão desta aba, gravada no build (vite.config.ts). O service worker guarda a de cada cache.
export const BUILD = __BUILD__

export interface CachedBuild {
  build: string
  protocol: number
  version: string
  at: number
}

let state: OfflineState = { status: 'installing', done: 0, total: 0, update: null }
const listeners = new Set<(s: OfflineState) => void>()

function set(next: OfflineState) {
  state = next
  for (const fn of listeners) fn(next)
}

export function startOffline() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return set({ ...state, status: 'unsupported' })
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const m = e.data
    if (m?.type === 'precache') set({ ...state, status: m.done >= m.total ? 'ready' : 'installing', done: m.done, total: m.total })
    if (m?.type === 'precache-error') set({ ...state, status: 'error' })
    // Versão nova baixada: esta aba continua na dela até recarregar.
    if (m?.type === 'updated' && typeof m.build === 'string' && m.build !== BUILD.id) set({ ...state, update: m.build })
    // O service worker só apaga a versão de uma aba que não respondeu.
    if (m?.type === 'which-build') e.ports[0]?.postMessage({ build: BUILD.id })
  })
  void navigator.serviceWorker
    .register('/sw.js')
    .then(async (reg) => {
      await navigator.serviceWorker.ready
      void requestPersistence()
      // Abas abertas antes da instalação pedem o estado para refletir a verdade.
      ;(reg.active ?? navigator.serviceWorker.controller)?.postMessage({ type: 'precache-status' })
      const [newest] = (await cachedBuilds()) ?? []
      if (newest && newest.build !== BUILD.id && !(await pinnedBuild())) set({ ...state, update: newest.build })
    })
    .catch(() => set({ ...state, status: 'error' }))
}

// Pergunta ao service worker e espera a resposta por um canal próprio. Sem ele, devolve null.
async function ask<T>(msg: unknown): Promise<T | null> {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return null
  try {
    const sw = navigator.serviceWorker.controller ?? (await navigator.serviceWorker.getRegistration())?.active
    if (!sw) return null
    return await new Promise<T | null>((resolve) => {
      const channel = new MessageChannel()
      const timer = setTimeout(() => resolve(null), 3000)
      channel.port1.onmessage = (e) => {
        clearTimeout(timer)
        resolve(e.data as T)
      }
      sw.postMessage(msg, [channel.port2])
    })
  } catch {
    return null
  }
}

export const cachedBuilds = () => ask<CachedBuild[]>({ type: 'builds' })
export const pinnedBuild = () => ask<{ build: string; reason: 'exam' | 'version'; at: number } | null>({ type: 'pin-status' })

// Durante a prova, um F5 abre esta mesma versão, mesmo que uma nova tenha sido baixada.
export const pinBuild = (build: string, reason: 'exam' | 'version') => ask<boolean>({ type: 'pin', build, reason })
export const unpinBuild = () => ask<boolean>({ type: 'unpin' })

export type VersionFix = { kind: 'switch'; build: CachedBuild } | { kind: 'update' } | { kind: 'teacher-old' }

// O que fazer quando o professor fala outro protocolo: usar a versão em cache que fala o dele,
// ou, se não houver, dizer quem precisa atualizar.
export async function versionFix(teacherProtocol: number): Promise<VersionFix> {
  const builds = (await cachedBuilds()) ?? []
  const match = builds.find((b) => b.protocol === teacherProtocol && b.build !== BUILD.id)
  if (match) return { kind: 'switch', build: match }
  return teacherProtocol > BUILD.protocol ? { kind: 'update' } : { kind: 'teacher-old' }
}

// Fixa a versão escolhida (ou desfaz, se ela já é a mais nova) e recarrega nela.
export async function switchBuild(target: CachedBuild) {
  const [newest] = (await cachedBuilds()) ?? []
  const ok = newest?.build === target.build ? await unpinBuild() : await pinBuild(target.build, 'version')
  if (!ok) return false
  try {
    sessionStorage.setItem('oblita-switched', JSON.stringify({ from: BUILD.id, to: target.build }))
  } catch {
    // Só o aviso depois de recarregar se perde.
  }
  location.reload()
  return true
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
