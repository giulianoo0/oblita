import { Check, TriangleAlert } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Modal, Pill } from '../ui/kit'
import type { ReceiptCheck as Result, Room } from './room'

const VERDICT: Record<Exclude<Result['status'], 'found'>, string> = {
  unknown: 'Nenhum comprovante desta sala tem esse ID ou checksum.',
  forged: 'A assinatura não confere: esse comprovante foi alterado.',
  'other-room': 'A assinatura é válida, mas de outra sala ou de outro professor.',
}

// O aluno traz o ID, o checksum ou o arquivo baixado, e o painel diz se foi esta sala que emitiu.
export function ReceiptCheck({ room, open, onClose }: { room: Room; open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!query.trim() || busy) return
    setBusy(true)
    try {
      setResult(await room.checkReceipt(query))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} title="Conferir comprovante" onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <textarea
          className="input mono"
          rows={3}
          autoFocus
          spellCheck={false}
          aria-label="ID, checksum ou texto do comprovante"
          placeholder="ID, checksum ou o texto do arquivo"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setResult(null)
          }}
        />
        {result && result.status !== 'found' && (
          <div className="errbox" role="alert">
            {VERDICT[result.status]}
          </div>
        )}
        {result?.status === 'found' && (
          <div className="stack receipt-result" role="status" style={{ gap: '0.25rem' }}>
            <b className="row" style={{ gap: '0.375rem' }}>
              {result.current ? <Check size={16} /> : <TriangleAlert size={16} />}
              {result.body.name}
              {result.body.enrollment ? ` (${result.body.enrollment})` : ''}
            </b>
            <span className="mono small">{result.body.id}</span>
            <span className="mono small receipt-hash">{result.body.checksum}</span>
            <span className="small muted">Recebido em {new Date(result.body.at).toLocaleString('pt-BR')}</span>
            {!result.current && <span className="small warn">A equipe mudou a entrega depois: existe um comprovante mais novo.</span>}
            {result.current && !result.matchesNow && <span className="small warn">O conteúdo guardado não bate mais com este comprovante.</span>}
            {result.current && result.matchesNow && <span className="small muted">Bate com o que está guardado nesta sala.</span>}
          </div>
        )}
        <div className="row">
          <Pill type="submit" tone="primary" disabled={!query.trim() || busy}>
            Conferir
          </Pill>
        </div>
      </form>
    </Modal>
  )
}
