import { AnimatePresence, motion, useDragControls } from 'motion/react'
import { GraduationCap, LoaderCircle, Presentation, X } from 'lucide-react'
import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
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

const MORPH = { type: 'spring', bounce: 0.12, duration: 0.5 } as const
const SHEET = { type: 'spring', bounce: 0, duration: 0.42 } as const
const NARROW = '(max-width: 34rem)'

function useNarrow() {
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches)
  useEffect(() => {
    const mq = matchMedia(NARROW)
    const on = () => setNarrow(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return narrow
}

// Por cima de tudo, com fundo. No computador o card do aluno vira o modal; no celular sobe uma gaveta.
function JoinOverlay({ narrow, onClose, onJoined }: { narrow: boolean; onClose: () => void; onJoined: () => void }) {
  const drag = useDragControls()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
    }
  }, [onClose])

  const body = (
    <>
      <button type="button" className="join-close" aria-label="Fechar" onClick={onClose}>
        <X size={18} />
      </button>
      <Suspense fallback={<LoaderCircle size={20} className="spin join-wait" />}>
        <JoinForm onJoined={onJoined} />
      </Suspense>
    </>
  )

  return (
    <motion.div className="join-overlay" exit={{ pointerEvents: 'none' }}>
      <motion.div className="join-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }} onClick={onClose} />
      {narrow ? (
        <motion.div
          className="join-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Entrar na prova"
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={SHEET}
          drag="y"
          dragListener={false}
          dragControls={drag}
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={{ top: 0, bottom: 0.7 }}
          onDragEnd={(_, info) => (info.offset.y > 120 || info.velocity.y > 600) && onClose()}
        >
          <div className="sheet-handle" onPointerDown={(e) => drag.start(e)} aria-hidden="true">
            <i />
          </div>
          {body}
        </motion.div>
      ) : (
        <motion.div layoutId="student-card" className="join-dialog" role="dialog" aria-modal="true" aria-label="Entrar na prova" style={{ borderRadius: 28 }} transition={MORPH}>
          <motion.div className="join-dialog-body" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: 0.12, duration: 0.2 } }} exit={{ opacity: 0, transition: { duration: 0.08 } }}>
            {body}
          </motion.div>
        </motion.div>
      )}
    </motion.div>
  )
}

export function Home() {
  const nav = useNavigate()
  const narrow = useNarrow()
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

  // No computador o card sai do lugar para virar o modal; um espaço igual segura a grade.
  const morphing = joining && !narrow

  return (
    <div className="home">
      <main className="home-hero">
        <Eagle size={112} className="home-eagle" />
        <h1 className="home-title">
          <span className="home-line">provas online de</span> <span className="home-line">código <span className="home-word">sem cola.</span></span>
        </h1>
        <div className="role-grid">
          {morphing ? (
            <div className="role-card role-ghost" aria-hidden="true" />
          ) : (
            <motion.button layoutId="student-card" type="button" className="role-card" style={{ borderRadius: 28 }} transition={MORPH} onPointerEnter={loadJoin} onFocus={loadJoin} onClick={() => setJoining(true)} whileTap={{ scale: 0.98 }}>
              <motion.span className="role-card-body" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: 0.1, duration: 0.2 } }}>
                <GraduationCap size={28} />
                <b>Sou aluno</b>
              </motion.span>
            </motion.button>
          )}
          <Link to="/nova" className="role-card brand">
            <Presentation size={28} />
            <b>Sou professor</b>
          </Link>
        </div>
      </main>
      {createPortal(<AnimatePresence>{joining && <JoinOverlay key="join" narrow={narrow} onClose={close} onJoined={joined} />}</AnimatePresence>, document.body)}
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
