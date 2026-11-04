import './build-version.css'
import { applyUpdate, BUILD, useOffline } from '../lib/offline'

// Discreto de propósito: serve para o professor conferir de longe que a sala toda está na mesma versão.
// `offerUpdate` só fora de prova: lá dentro, recarregar trocaria os arquivos da aba no meio dela.
export function BuildVersion({ offerUpdate = false }: { offerUpdate?: boolean }) {
  const offline = useOffline()
  const label = `${BUILD.id} · p${BUILD.protocol}`
  if (offerUpdate && offline.update) {
    return (
      <button type="button" className="build-version update" title={`Versão ${offline.update} baixada. Recarregue para usar.`} onClick={() => void applyUpdate()}>
        {label} · nova versão, recarregar
      </button>
    )
  }
  return (
    <span className="build-version" title={`Versão ${BUILD.id}, protocolo ${BUILD.protocol}`}>
      {label}
    </span>
  )
}
