// Message history in IndexedDB, per radio. Radios keep little or no history themselves.
import type { Message } from '../model/types'

const DB = 'meshmash'
const STORE = 'messages'

interface Row extends Message {
  key: string
  radio: string
}

let dbp: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE, { keyPath: 'key' })
      s.createIndex('radio', 'radio')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbp
}

export async function loadMessages(radio: string): Promise<Message[]> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const req = d.transaction(STORE).objectStore(STORE).index('radio').getAll(radio)
    req.onsuccess = () =>
      resolve(
        (req.result as Row[])
          .map(({ key: _k, radio: _r, ...m }) => m as Message)
          .sort((a, b) => a.ts - b.ts),
      )
    req.onerror = () => reject(req.error)
  })
}

export async function saveMessage(radio: string, m: Message) {
  const d = await db()
  const row: Row = { ...plain(m), key: `${radio}|${m.id}`, radio }
  d.transaction(STORE, 'readwrite').objectStore(STORE).put(row)
}

/** Plain copy; Svelte state proxies cannot be structured-cloned. */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}
