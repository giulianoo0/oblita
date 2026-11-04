import { mergeConfig } from 'vite'
import base from '../../vite.config.ts'

// Cache próprio: o teste de WASM pode estar rodando junto, e dois Vite no mesmo cache se atropelam.
export default mergeConfig(base, {
  root: new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  cacheDir: 'node_modules/.vite-collab-test',
  server: { hmr: false, watch: null },
})
