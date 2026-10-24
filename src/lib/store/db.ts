// Message history and per-node data in IndexedDB, per radio. Radios keep little or no
// history themselves.
import type { Message, NodeData } from '../model/types'

const DB = 'meshmash'
const STORE = 'messages'
const NODES = 'nodeData'

interface Row extends Message {
  key: string
  radio: string
}

let dbp: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2)
    req.onupgradeneeded = (e) => {
      const d = req.result
      if (e.oldVersion < 1) d.createObjectStore(STORE, { keyPath: 'key' }).createIndex('radio', 'radio')
      if (e.oldVersion < 2) d.createObjectStore(NODES, { keyPath: 'key' }).createIndex('radio', 'radio')
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

interface NodeRow extends NodeData {
  key: string
  radio: string
  nodeId: string
}

export async function loadNodeData(radio: string): Promise<Record<string, NodeData>> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const req = d.transaction(NODES).objectStore(NODES).index('radio').getAll(radio)
    req.onsuccess = () =>
      resolve(Object.fromEntries((req.result as NodeRow[]).map(({ key: _k, radio: _r, nodeId, ...n }) => [nodeId, n])))
    req.onerror = () => reject(req.error)
  })
}

export async function saveNodeData(radio: string, nodeId: string, n: NodeData) {
  const d = await db()
  const row: NodeRow = { ...plain(n), key: `${radio}|${nodeId}`, radio, nodeId }
  d.transaction(NODES, 'readwrite').objectStore(NODES).put(row)
}

/** Plain copy; Svelte state proxies cannot be structured-cloned. */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}
