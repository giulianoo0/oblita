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

export const idb = {
  get: <T>(store: Store, key: IDBValidKey) => tx<T | undefined>(store, 'readonly', (s) => s.get(key)),
  put: (store: Store, key: IDBValidKey, value: unknown) => tx(store, 'readwrite', (s) => s.put(value, key)),
  del: (store: Store, key: IDBValidKey | IDBKeyRange) => tx(store, 'readwrite', (s) => s.delete(key)),
  keys: (store: Store, range?: IDBKeyRange) => tx<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys(range)),
  values: <T>(store: Store, range?: IDBKeyRange) => tx<T[]>(store, 'readonly', (s) => s.getAll(range)),
  prefix: (prefix: string) => IDBKeyRange.bound(prefix, `${prefix}￿`),
}

export const requestPersistence = () => navigator.storage?.persist?.().catch(() => false) ?? Promise.resolve(false)
