import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles/tokens.css'
import './styles/app.css'
import { Component, StrictMode, lazy, Suspense, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react'
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom'
import { Toaster } from 'sonner'
import { startOffline } from './lib/offline'
import { Home } from './pages/Home'
import { SiteHeader, useSiteHeaderHidden } from './ui/SiteHeader'

const NewRoom = lazy(() => import('./teacher/NewRoom'))
const Dashboard = lazy(() => import('./teacher/Dashboard'))
const StudentDetail = lazy(() => import('./teacher/StudentDetail'))
const TeamDetail = lazy(() => import('./teacher/StudentDetail').then((m) => ({ default: m.TeamDetail })))
const Exam = lazy(() => import('./student/ExamPage'))

// Numa prova em andamento, uma tela quebrada não pode virar página em branco: os dados seguem no disco.
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.error(error)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="center-screen">
        <div className="gate">
          <h1>Algo deu errado nesta tela</h1>
          <button type="button" className="pill primary lg" onClick={() => location.reload()}>
            Recarregar
          </button>
        </div>
      </div>
    )
  }
}

// A sala e o detalhe do aluno têm barra própria; as telas de entrada dividem o mesmo cabeçalho.
const withSiteHeader = (path: string) => !path.startsWith('/sala/')

// O cabeçalho fica fora da troca de página: só o conteúdo some e entra. Sem transform nem filter
// no fim da animação, para não virar o contêiner de nada com position: fixed (o selo da prova).
function Shell() {
  const location = useLocation()
  const hidden = useSiteHeaderHidden()
  const still = useReducedMotion()
  const header = withSiteHeader(location.pathname) && !hidden
  return (
    <div className="shell">
      {header && <SiteHeader />}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={location.pathname}
          className="shell-page"
          initial={still ? { opacity: 0 } : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.16, 1, 0.3, 1] } }}
          exit={still ? { opacity: 0 } : { opacity: 0, y: -4, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }}
        >
          <Suspense fallback={null}>
            <Routes location={location}>
              <Route path="/" element={<Home />} />
              <Route path="/nova" element={<NewRoom />} />
              <Route path="/sala/:roomId" element={<Dashboard />} />
              <Route path="/sala/:roomId/aluno/:clientId" element={<StudentDetail />} />
              <Route path="/sala/:roomId/equipe/:groupId" element={<TeamDetail />} />
              <Route path="/entrar" element={<Exam />} />
              <Route path="*" element={<Home />} />
            </Routes>
          </Suspense>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

startOffline()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        {/* Com "reduzir movimento" no sistema, as animações de transform e layout do motion viram corte. */}
        <MotionConfig reducedMotion="user">
          <Shell />
        </MotionConfig>
      </ErrorBoundary>
    </BrowserRouter>
    <Toaster position="bottom-left" duration={2600} visibleToasts={4} />
  </StrictMode>,
)
