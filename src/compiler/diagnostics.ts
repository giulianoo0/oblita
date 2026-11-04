// Marcadores do editor a partir das mensagens do compilador.
export function parseDiagnostics(log: string) {
  const out: { file: string; line: number; column: number; severity: 'error' | 'warning' | 'note'; message: string }[] = []
  for (const row of log.split('\n')) {
    const m = row.match(/^([^:\s]+):(\d+):(\d+): (error|warning|note|fatal error): (.*)$/)
    // Em erro dentro de header incluído o clang escreve "./util.h" ou "./lib/./util.h": o editor conhece "util.h" e "lib/util.h".
    if (m) out.push({ file: m[1].split('/').filter((part) => part !== '.').join('/'), line: +m[2], column: +m[3], severity: m[4] === 'fatal error' ? 'error' : (m[4] as 'error' | 'warning' | 'note'), message: m[5] })
  }
  return out
}
