import { AnimatePresence, motion } from 'motion/react'
import { ArrowRight, Check, CloudDownload, GraduationCap, Presentation, TriangleAlert } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useOffline } from '../lib/offline'
import { parseAddress } from '../net/link'
import { Logo, Pill } from '../ui/kit'

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

export function Home() {
  const nav = useNavigate()
  const [role, setRole] = useState<'student' | null>(null)
  const [ip, setIp] = useState('')
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    try {
      const saved = localStorage.getItem('oblita-last-ip')
      if (saved) setIp(saved)
    } catch {
      // Navegador sem armazenamento: só não preenche o campo.
    }
  }, [])

  const enter = (e: FormEvent) => {
    e.preventDefault()
    if (!parseAddress(ip)) return setInvalid(true)
    try {
      localStorage.setItem('oblita-last-ip', ip.trim())
    } catch {
      // Idem: o último IP é só conveniência.
    }
    nav(`/entrar?ip=${encodeURIComponent(ip.trim())}`)
  }

  return (
    <div className="home">
      <header className="home-top">
        <Logo />
        <OfflineStatus />
      </header>
      <main className="home-hero">
        <h1 className="home-title">
          provas online de código <span className="home-word">sem cola.</span>
        </h1>
        <div className="role-grid">
          <motion.button type="button" className="role-card" aria-expanded={role === 'student'} onClick={() => setRole('student')} whileTap={{ scale: 0.99 }} hidden={role === 'student'}>
            <GraduationCap size={28} />
            <b>Sou aluno</b>
          </motion.button>
          <AnimatePresence initial={false}>
            {role === 'student' && (
              <motion.form key="ip" className="role-card role-form" onSubmit={enter} initial={{ opacity: 0, scale: 0.9, filter: 'blur(8px)' }} animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }} transition={{ type: 'spring', bounce: 0.25, duration: 0.6 }}>
                <label className="field" style={{ width: '100%' }}>
                  <span>IP do professor</span>
                  <input
                    className="input mono"
                    autoFocus
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="192.168.0.10"
                    value={ip}
                    aria-invalid={invalid}
                    onChange={(e) => {
                      setIp(e.target.value)
                      setInvalid(false)
                    }}
                  />
                </label>
                {invalid && <div className="bad small">IP inválido</div>}
                <Pill tone="primary" size="lg" type="submit" style={{ width: '100%' }}>
                  Entrar <ArrowRight size={16} />
                </Pill>
                <Link to="/entrar" className="small muted">
                  Entrar com código
                </Link>
              </motion.form>
            )}
          </AnimatePresence>
          <Link to="/nova" className="role-card brand">
            <Presentation size={28} />
            <b>Sou professor</b>
          </Link>
        </div>
      </main>
    </div>
  )
}
