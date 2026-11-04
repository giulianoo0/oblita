// Guarda o site inteiro na primeira visita. Depois disso nada aqui depende de rede.
// Só instala quando tudo foi baixado: um cache pela metade falharia no meio da prova.
const PREFIX = 'oblita-'
const KEEP_VERSIONS = 2
const CONCURRENCY = 6
const RETRIES = 3
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
      if (!(await caches.match(entry.url, { cacheName: cache.name })) && !(entry.url !== '/' && (await caches.match(entry.url)))) {
        await cache.put(entry.url, await fetchEntry(entry))
      } else if (!(await cache.match(entry.url))) {
        // Arquivo com hash igual ao da versão anterior: copia sem baixar de novo.
        await cache.put(entry.url, await caches.match(entry.url))
      }
      progress.done++
      await broadcast({ type: 'precache', ...progress })
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  await cache.put('/__manifest', new Response(JSON.stringify({ ...manifest, at: Date.now() })))
}

// caches.match procura da versão mais antiga para a mais nova: a página tem de vir da mais nova.
async function newestCache() {
  const dated = await datedCaches()
  return dated[0] ? caches.open(dated[0].name) : null
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

async function datedCaches() {
  const names = (await caches.keys()).filter((n) => n.startsWith(PREFIX))
  const dated = await Promise.all(
    names.map(async (name) => {
      const res = await (await caches.open(name)).match('/__manifest')
      return { name, at: res ? (await res.json()).at : 0 }
    }),
  )
  return dated.sort((a, b) => b.at - a.at)
}

async function prune() {
  const dated = await datedCaches()
  // Mantém a versão anterior: uma aba em plena prova ainda pede os arquivos dela.
  await Promise.all(dated.slice(KEEP_VERSIONS).map(({ name }) => caches.delete(name)))
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await prune()
      await self.clients.claim()
      await broadcast({ type: 'precache', done: progress.total || 1, total: progress.total || 1 })
    })(),
  )
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'precache-status') {
    const total = progress.total || 1
    event.source?.postMessage({ type: 'precache', done: progress.total ? progress.done : total, total })
  }
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
      newestCache()
        .then(async (cache) => (url.pathname !== '/' && (await cache?.match(url.pathname))) || cache?.match('/'))
        .then((hit) => hit ?? fetch(request)),
    )
    return
  }
  event.respondWith(caches.match(url.pathname).then((hit) => hit ?? fetch(request)))
})
