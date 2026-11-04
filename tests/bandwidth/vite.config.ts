import { mergeConfig } from 'vite'
import base from '../../vite.config.ts'

export default mergeConfig(base, {
  root: new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  cacheDir: 'node_modules/.vite-bandwidth-test',
  server: { hmr: false, watch: null },
})
