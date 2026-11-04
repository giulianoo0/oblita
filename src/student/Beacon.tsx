import { BEACON, beaconCells } from '../../shared/beacon'

// Preto e branco puros, sem animação e sem transparência: quem lê é o painel, na captura da tela.
export function Beacon({ code }: { code: number | null }) {
  if (code === null) return null
  const cell = `${BEACON.cellVw}vw`
  return (
    <div
      data-beacon
      aria-hidden="true"
      title="Selo de verificação"
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        zIndex: 60,
        display: 'grid',
        gridTemplateColumns: `repeat(${BEACON.cols}, ${cell})`,
        gridAutoRows: cell,
        pointerEvents: 'none',
      }}
    >
      {beaconCells(code)
        .flat()
        .map((on, i) => (
          <span key={i} style={{ background: on ? '#fff' : '#000' }} />
        ))}
    </div>
  )
}
