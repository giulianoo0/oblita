import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles/tokens.css'
import './styles/app.css'
import { Component, StrictMode, lazy, Suspense, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Toaster } from 'sonner'
import { startOffline } from './lib/offline'
import { Home } from './pages/Home'

const NewRoom = lazy(() => import('./teacher/NewRoom'))
const Dashboard = lazy(() => import('./teacher/Dashboard'))
const StudentDetail = lazy(() => import('./teacher/StudentDetail'))
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

startOffline()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/nova" element={<NewRoom />} />
          <Route path="/sala/:roomId" element={<Dashboard />} />
          <Route path="/sala/:roomId/aluno/:clientId" element={<StudentDetail />} />
          <Route path="/entrar" element={<Exam />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </Suspense>
      </ErrorBoundary>
    </BrowserRouter>
    <Toaster position="bottom-left" duration={2600} visibleToasts={4} />
  </StrictMode>,
)
