// Empacota lib.ts (e as dependências de shared/) num ESM que o Node 24 importa sem tsc.
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
await build({
  entryPoints: [join(here, 'lib.ts')],
  outfile: join(here, 'lib.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  logLevel: 'info',
})
