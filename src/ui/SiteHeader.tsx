// O cabeçalho das telas de entrada (início, nova sala, entrar na prova). Fica fora da troca de página,
// então o logo não pula nem anima quando o conteúdo muda; a prova em andamento o esconde.
import { Check, CloudDownload, TriangleAlert } from 'lucide-react'
import { useEffect, useSyncExternalStore } from 'react'
import { useOffline } from '../lib/offline'
import { BuildVersion } from './BuildVersion'
import { Logo } from './kit'

let hidden = 0
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn))
const notify = () => listeners.forEach((fn) => fn())

// Telas com barra própria (a prova em andamento) chamam isto enquanto estão montadas.
export function useHideSiteHeader(hide = true) {
  useEffect(() => {
    if (!hide) return
    hidden++
    notify()
    return () => {
      hidden--
      notify()
    }
  }, [hide])
}

export function useSiteHeaderHidden() {
  return useSyncExternalStore(subscribe, () => hidden > 0)
}

function OfflineStatus() {
  const offline = useOffline()
  const pct = offline.total ? Math.round((offline.done / offline.total) * 100) : 0
  if (offline.status === 'ready')
    return (
      <div className="status-chip ok" title="A página abre mesmo sem internet">
        <Check size={14} /> Baixado neste computador
      </div>
    )
  if (offline.status === 'error')
    return (
      <div className="status-chip bad" title="Sem isso a prova não abre sem internet. Recarregue com internet.">
        <TriangleAlert size={14} /> Não foi baixado
      </div>
    )
  if (offline.status === 'unsupported')
    return (
      <div className="status-chip bad" title="Use Chrome ou Edge atualizado">
        <TriangleAlert size={14} /> Navegador sem suporte
      </div>
    )
  return (
    <div className="status-chip" title="Deixe esta página aberta até terminar">
      <CloudDownload size={14} /> Baixando {pct}%
      <i className="status-bar" style={{ width: `${pct}%` }} />
    </div>
  )
}

export function SiteHeader() {
  return (
    <header className="site-top">
      <Logo />
      <div className="row">
        <BuildVersion offerUpdate />
        <OfflineStatus />
      </div>
    </header>
  )
}
