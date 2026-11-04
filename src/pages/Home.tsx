import { AnimatePresence, motion } from 'motion/react'
import { GraduationCap, LoaderCircle, Presentation, X } from 'lucide-react'
import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { idb } from '../lib/idb'
import { unpinBuild } from '../lib/offline'
import { Eagle } from '../ui/Eagle'

// O lucide não traz mais logos de marca: o do GitHub vai aqui, em 16 px.
function GithubMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

// O formulário mora no pacote da prova: abrir o card já começa a baixar o que o aluno vai usar.
const JoinForm = lazy(() => import('../student/ExamPage').then((m) => ({ default: m.JoinForm })))
const loadJoin = () => void import('../student/ExamPage')

const FADE = {
  initial: { opacity: 0, filter: 'blur(10px)', scale: 0.98 },
  animate: { opacity: 1, filter: 'blur(0px)', scale: 1, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] } },
  exit: { opacity: 0, filter: 'blur(10px)', scale: 0.98, transition: { duration: 0.2 } },
} as const
const MORPH = { type: 'spring', bounce: 0.18, duration: 0.55 } as const

export function Home() {
  const nav = useNavigate()
  const [joining, setJoining] = useState(false)
  const close = useCallback(() => setJoining(false), [])
  const joined = useCallback(() => nav('/entrar'), [nav])

  // Sem prova em andamento neste computador, nenhuma versão precisa ficar fixada.
  useEffect(() => {
    void idb
      .get<{ active?: boolean }>('kv', 'student')
      .then((s) => !s?.active && unpinBuild())
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!joining) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [joining, close])

  return (
    <div className="home">
      <main className="home-hero">
        <AnimatePresence mode="popLayout" initial={false}>
          {!joining && (
            <motion.div key="intro" className="home-intro" {...FADE}>
              <Eagle size={112} className="home-eagle" />
              <h1 className="home-title">
                <span className="home-line">provas online de</span> <span className="home-line">código <span className="home-word">sem cola.</span></span>
              </h1>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="role-grid" data-joining={joining || undefined}>
          {joining ? (
            <motion.div layoutId="student-card" className="role-card join-panel" style={{ borderRadius: 28 }} transition={MORPH}>
              <motion.div className="join-panel-body" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: 0.18, duration: 0.25 } }}>
                <button type="button" className="join-close" aria-label="Voltar" onClick={close}>
                  <X size={18} />
                </button>
                <Suspense fallback={<LoaderCircle size={20} className="spin join-wait" />}>
                  <JoinForm onJoined={joined} />
                </Suspense>
              </motion.div>
            </motion.div>
          ) : (
            <motion.button layoutId="student-card" type="button" className="role-card" style={{ borderRadius: 28 }} transition={MORPH} onPointerEnter={loadJoin} onFocus={loadJoin} onClick={() => setJoining(true)} whileTap={{ scale: 0.99 }}>
              <motion.span className="role-card-body" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: 0.15 } }}>
                <GraduationCap size={28} />
                <b>Sou aluno</b>
              </motion.span>
            </motion.button>
          )}
          <AnimatePresence mode="popLayout" initial={false}>
            {!joining && (
              <motion.div key="teacher" className="role-slot" {...FADE}>
                <Link to="/nova" className="role-card brand">
                  <Presentation size={28} />
                  <b>Sou professor</b>
                </Link>
              </motion.div>
            )}
          </AnimatePresence>
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
