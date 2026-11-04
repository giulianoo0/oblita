// Guarda o site inteiro na primeira visita. Depois disso nada aqui depende de rede.
// Só instala quando tudo foi baixado: um cache pela metade falharia no meio da prova.
const PREFIX = 'oblita-'
const META = 'oblita-meta'
const KEEP_VERSIONS = 2
const CONCURRENCY = 6
const RETRIES = 3
// Fixação esquecida (aluno fechou a aba no meio) não pode prender a página numa versão velha.
const PIN_TTL_MS = 12 * 60 * 60 * 1000
const NO_CACHE = new Set(['/signal', '/healthz', '/precache.json', '/sw.js'])

let progress = { done: 0, total: 0 }

async function broadcast(msg) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true })
  for (const client of clients) client.postMessage(msg)
}

async function fetchRetry(url) {
  let lastError
  for (let i = 0; i < RETRIES; i++) {
    try {
      const res = await fetch(url, { cache: 'reload' })
      // O Workers responde a página inicial, com status 200, para o que não existe.
      const isFallback = url !== '/' && new URL(url, location.origin).pathname.startsWith('/assets/') && (res.headers.get('content-type') ?? '').includes('text/html')
      if (res.ok && !isFallback && !res.redirected) return res
      lastError = new Error(`${url}: ${res.status}`)
    } catch (err) {
      lastError = err
    }
    await new Promise((r) => setTimeout(r, 500 * (i + 1)))
  }
  throw lastError
}

// O Workers limita cada arquivo a 25 MiB, então o compilador é publicado em gzip e abre aqui.
async function fetchEntry(entry) {
  if (!entry.gz) return fetchRetry(entry.url)
  const res = await fetchRetry(`${entry.url}.gz`)
  const stream = res.body.pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream, { headers: { 'Content-Type': entry.type, 'Cache-Control': 'public, immutable' } })
}

async function precache() {
  const manifest = await (await fetchRetry('/precache.json')).json()
  const cache = await caches.open(`${PREFIX}${manifest.version}`)
  progress = { done: 0, total: manifest.files.length }
  const queue = [...manifest.files]
  const worker = async () => {
    for (;;) {
      const entry = queue.shift()
      if (!entry) return
      if (!(await cache.match(entry.url))) {
        // Só o que tem hash no nome (/assets/) é igual entre versões e pode ser copiado. A página,
        // o llms.txt e os ícones têm o mesmo endereço em toda versão e vêm sempre da rede.
        const previous = entry.url.startsWith('/assets/') ? await caches.match(entry.url) : undefined
        await cache.put(entry.url, previous ?? (await fetchEntry(entry)))
      }
      progress.done++
      await broadcast({ type: 'precache', ...progress })
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  await cache.put('/__manifest', new Response(JSON.stringify({ ...manifest, at: Date.now() })))
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    precache()
      .then(() => self.skipWaiting())
      .catch(async (err) => {
        await broadcast({ type: 'precache-error', message: String(err) })
        throw err
      }),
  )
})

// Da mais nova para a mais antiga. `build` e `protocol` só existem a partir da versão que os grava.
async function datedCaches() {
  const names = (await caches.keys()).filter((n) => n.startsWith(PREFIX) && n !== META)
  const dated = await Promise.all(
    names.map(async (name) => {
      const res = await (await caches.open(name)).match('/__manifest')
      const m = res ? await res.json() : {}
      return { name, at: m.at ?? 0, build: m.build ?? null, protocol: m.protocol ?? 1, version: m.version ?? null }
    }),
  )
  return dated.sort((a, b) => b.at - a.at)
}

async function readPin() {
  const res = await (await caches.open(META)).match('/__pin')
  if (!res) return null
  const pin = await res.json().catch(() => null)
  if (!pin || Date.now() - pin.at > PIN_TTL_MS) return null
  return pin
}

async function writePin(pin) {
  const meta = await caches.open(META)
  if (pin) await meta.put('/__pin', new Response(JSON.stringify(pin)))
  else await meta.delete('/__pin')
}

// A página tem de vir da versão fixada, se houver; senão, da mais nova.
// caches.match procura da versão mais antiga para a mais nova, então isto não pode ser caches.match.
async function pageCache() {
  const dated = await datedCaches()
  const pin = await readPin()
  const pinned = pin && dated.find((d) => d.build === pin.build)
  const pick = pinned ?? dated[0]
  return pick ? caches.open(pick.name) : null
}

// Pergunta a cada aba aberta qual versão ela está rodando: essas não podem sumir do cache.
async function buildsInUse() {
  const clients = await self.clients.matchAll({ type: 'window' })
  const answers = await Promise.all(
    clients.map(
      (client) =>
        new Promise((resolve) => {
          const channel = new MessageChannel()
          const timer = setTimeout(() => resolve(null), 1000)
          channel.port1.onmessage = (e) => {
            clearTimeout(timer)
            resolve(e.data?.build ?? null)
          }
          client.postMessage({ type: 'which-build' }, [channel.port2])
        }),
    ),
  )
  return new Set(answers.filter(Boolean))
}

async function prune() {
  const dated = await datedCaches()
  const pin = await readPin()
  const used = await buildsInUse()
  // Mantém as mais novas, a fixada e qualquer uma que uma aba aberta (em plena prova) ainda use.
  const drop = dated.slice(KEEP_VERSIONS).filter((d) => !d.build || (d.build !== pin?.build && !used.has(d.build)))
  await Promise.all(drop.map(({ name }) => caches.delete(name)))
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await prune()
      await self.clients.claim()
      await broadcast({ type: 'precache', done: progress.total || 1, total: progress.total || 1 })
      const [newest] = await datedCaches()
      if (newest?.build) await broadcast({ type: 'updated', build: newest.build, protocol: newest.protocol })
    })(),
  )
})

const reply = (event, data) => event.ports[0]?.postMessage(data)

self.addEventListener('message', (event) => {
  const m = event.data
  if (m?.type === 'precache-status') {
    const total = progress.total || 1
    event.source?.postMessage({ type: 'precache', done: progress.total ? progress.done : total, total })
    return
  }
  const work = (async () => {
    if (m?.type === 'builds') return reply(event, (await datedCaches()).filter((d) => d.build).map(({ build, protocol, version, at }) => ({ build, protocol, version, at })))
    if (m?.type === 'pin-status') return reply(event, await readPin())
    if (m?.type === 'pin' && typeof m.build === 'string') {
      const exists = (await datedCaches()).some((d) => d.build === m.build)
      if (exists) await writePin({ build: m.build, reason: m.reason === 'version' ? 'version' : 'exam', at: Date.now() })
      return reply(event, exists)
    }
    if (m?.type === 'unpin') {
      await writePin(null)
      return reply(event, true)
    }
  })()
  event.waitUntil?.(work)
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== location.origin || NO_CACHE.has(url.pathname)) return
  if (request.mode === 'navigate') {
    // Abrir um arquivo do site em aba própria (o /llms.txt) também é navegação: ele vem do cache como está.
    // O resto é rota do app e recebe a página.
    event.respondWith(
      pageCache()
        .then(async (cache) => (url.pathname !== '/' && (await cache?.match(url.pathname))) || cache?.match('/'))
        .then((hit) => hit ?? fetch(request)),
    )
    return
  }
  // Com hash no nome, qualquer versão serve. O resto (ícones, card) tem o mesmo endereço em toda
  // versão, e caches.match acharia a mais antiga: vem da versão em uso.
  const hit = url.pathname.startsWith('/assets/') ? caches.match(url.pathname) : pageCache().then((cache) => cache?.match(url.pathname))
  event.respondWith(hit.then((found) => found ?? fetch(request)))
})
