import { mergeConfig } from 'vite'
import base from '../../vite.config'

// Sem recarregar a aba: outros estão editando src/ enquanto o teste roda.
export default mergeConfig(base, {
  root: new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  cacheDir: 'node_modules/.vite-engine-test',
  server: { hmr: false, watch: null },
})
