import { AnimatePresence, motion } from 'motion/react'
import { ArrowRight, Check, CloudDownload, GraduationCap, Presentation, TriangleAlert } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { idb } from '../lib/idb'
import { unpinBuild, useOffline } from '../lib/offline'
import { parseAddress } from '../net/link'
import { BuildVersion } from '../ui/BuildVersion'
import { Logo, Pill } from '../ui/kit'

// O lucide não traz mais logos de marca: o do GitHub vai aqui, em 16 px.
function GithubMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
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

export function Home() {
  const nav = useNavigate()
  const [role, setRole] = useState<'student' | null>(null)
  const [ip, setIp] = useState('')
  const [invalid, setInvalid] = useState(false)

  // Sem prova em andamento neste computador, nenhuma versão precisa ficar fixada.
  useEffect(() => {
    void idb
      .get<{ active?: boolean }>('kv', 'student')
      .then((s) => !s?.active && unpinBuild())
      .catch(() => {})
  }, [])

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
        <div className="row">
          <BuildVersion offerUpdate />
          <OfflineStatus />
        </div>
      </header>
      <main className="home-hero">
        <h1 className="home-title">
          provas online de código <span className="home-word">sem cola.</span>
        </h1>
        <p className="home-lede">C e C++ sem internet: o aluno digita o IP do professor e faz a prova em tela cheia, com a tela gravada. Tudo fica no computador do professor.</p>
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
      <footer className="home-foot">
        <span>
          by:{' '}
          <a href="https://giuli.dev" target="_blank" rel="noopener noreferrer">
            giuliano
          </a>
        </span>
        <a href="https://github.com/giulianoo0/oblita" target="_blank" rel="noopener noreferrer" aria-label="Código no GitHub">
          <GithubMark /> GitHub
        </a>
      </footer>
    </div>
  )
}
