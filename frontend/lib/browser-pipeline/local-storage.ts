type Entry = { key: string; value: unknown; expiresAt: number }
let database: Promise<IDBDatabase> | null = null

const open = () => {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('dunkai-browser-runtime', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('entries', { keyPath: 'key' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Close another DunkAI tab to update browser storage'))
  }).catch((error) => { database = null; throw error })
  return database
}

export async function readLocal<T>(key: string): Promise<T | null> {
  if (typeof indexedDB === 'undefined') return null
  const db = await open()
  return new Promise((resolve, reject) => {
    const request = db.transaction('entries', 'readonly').objectStore('entries').get(key)
    request.onsuccess = () => {
      const entry = request.result as Entry | undefined
      resolve(entry && entry.expiresAt > Date.now() ? entry.value as T : null)
    }
    request.onerror = () => reject(request.error)
  })
}

export async function writeLocal(key: string, value: unknown, ttlMs = 24 * 60 * 60_000): Promise<void> {
  if (typeof indexedDB === 'undefined') throw new Error('Browser storage is unavailable')
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('entries', 'readwrite')
    const store = transaction.objectStore('entries')
    store.put({ key, value, expiresAt: Date.now() + ttlMs } satisfies Entry)
    // Expired checkpoints and catalogue entries must not accumulate forever.
    const cursor = store.openCursor()
    cursor.onsuccess = () => { const current = cursor.result; if (!current) return; if ((current.value as Entry).expiresAt <= Date.now()) current.delete(); current.continue() }
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error || new Error('Browser storage write was cancelled'))
  })
}

export async function deleteLocal(key: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('entries', 'readwrite')
    transaction.objectStore('entries').delete(key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}
