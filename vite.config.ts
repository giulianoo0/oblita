import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/signal': { target: 'ws://localhost:3000', ws: true } } },
  // O pacote acha os .wasm pelo próprio caminho, e o pré-empacotamento do Vite quebraria isso.
  optimizeDeps: { exclude: ['@yowasp/clang'] },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false },
})
