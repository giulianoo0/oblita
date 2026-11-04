// Armazenamento local. O IndexedDB guarda blobs em disco, então aguenta as gravações.
type Store = 'kv' | 'outbox' | 'chunks'

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('oblita', 1)
    req.onupgradeneeded = () => {
      for (const name of ['kv', 'outbox', 'chunks']) req.result.createObjectStore(name)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

async function tx<T>(store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode)
    const req = fn(t.objectStore(store))
    t.oncomplete = () => resolve(req.result)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
}

// Uma transação só: ou todas as chaves gravam, ou nenhuma.
async function putMany(store: Store, entries: [IDBValidKey, unknown][]) {
  const db = await open()
  return new Promise<void>((resolve, reject) => {
    const t = db.transaction(store, 'readwrite')
    const s = t.objectStore(store)
    for (const [key, value] of entries) s.put(value, key)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
}

async function entries<T>(store: Store, range: IDBKeyRange): Promise<[IDBValidKey, T][]> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readonly')
    const keys = t.objectStore(store).getAllKeys(range)
    const values = t.objectStore(store).getAll(range)
    t.oncomplete = () => resolve(keys.result.map((k, i) => [k, values.result[i] as T]))
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
}

export const idb = {
  putMany,
  entries,
  get: <T>(store: Store, key: IDBValidKey) => tx<T | undefined>(store, 'readonly', (s) => s.get(key)),
  put: (store: Store, key: IDBValidKey, value: unknown) => tx(store, 'readwrite', (s) => s.put(value, key)),
  del: (store: Store, key: IDBValidKey | IDBKeyRange) => tx(store, 'readwrite', (s) => s.delete(key)),
  keys: (store: Store, range?: IDBKeyRange) => tx<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys(range)),
  values: <T>(store: Store, range?: IDBKeyRange) => tx<T[]>(store, 'readonly', (s) => s.getAll(range)),
  prefix: (prefix: string) => IDBKeyRange.bound(prefix, `${prefix}￿`),
}

export const requestPersistence = () => navigator.storage?.persist?.().catch(() => false) ?? Promise.resolve(false)
