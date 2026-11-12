// Message history and per-node data in IndexedDB, per radio. Radios keep little or no
// history themselves.
import type { CoverageSpan, PacketRecord } from '../model/analytics'
import type { Message, NodeData } from '../model/types'

const DB = 'meshmash'
const STORE = 'messages'
const NODES = 'nodeData'
const PACKETS = 'packets'
const COVERAGE = 'coverage'

interface Row extends Message {
  key: string
  radio: string
}

let dbp: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 3)
    req.onupgradeneeded = (e) => {
      const d = req.result
      if (e.oldVersion < 1) d.createObjectStore(STORE, { keyPath: 'key' }).createIndex('radio', 'radio')
      if (e.oldVersion < 2) d.createObjectStore(NODES, { keyPath: 'key' }).createIndex('radio', 'radio')
      if (e.oldVersion < 3) {
        d.createObjectStore(PACKETS, { autoIncrement: true }).createIndex('radio_ts', ['radio', 'ts'])
        d.createObjectStore(COVERAGE, { keyPath: 'key' }).createIndex('radio_end', ['radio', 'end'])
      }
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

export async function deleteMessages(radio: string, ids: string[]) {
  const d = await db()
  const store = d.transaction(STORE, 'readwrite').objectStore(STORE)
  for (const id of ids) store.delete(`${radio}|${id}`)
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

// Analytics: packet records and the spans of time a radio was connected.

const done = (t: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })

export async function addPackets(radio: string, recs: PacketRecord[]) {
  const t = (await db()).transaction(PACKETS, 'readwrite')
  const store = t.objectStore(PACKETS)
  for (const r of recs) store.add({ ...r, radio })
  await done(t)
}

/** Records from `since` on, oldest first. */
export async function loadPackets(radio: string, since: number): Promise<PacketRecord[]> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound([radio, since], [radio, Infinity])
    const req = d.transaction(PACKETS).objectStore(PACKETS).index('radio_ts').getAll(range)
    req.onsuccess = () => resolve((req.result as (PacketRecord & { radio?: string })[]).map(({ radio: _r, ...p }) => p))
    req.onerror = () => reject(req.error)
  })
}

/** Deletes records older than `before`, then the oldest beyond `cap`. */
export async function prunePackets(radio: string, before: number, cap: number) {
  const t = (await db()).transaction(PACKETS, 'readwrite')
  const index = t.objectStore(PACKETS).index('radio_ts')
  const all = IDBKeyRange.bound([radio, -Infinity], [radio, Infinity])
  index.count(all).onsuccess = (e) => {
    let excess = Math.max(0, ((e.target as IDBRequest<number>).result) - cap)
    index.openCursor(all).onsuccess = (ev) => {
      const c = (ev.target as IDBRequest<IDBCursorWithValue | null>).result
      if (!c) return
      if (excess > 0 || (c.value as PacketRecord).ts < before) {
        c.delete()
        excess--
        c.continue()
      }
    }
  }
  await done(t)
}

export async function deletePackets(radio: string) {
  const t = (await db()).transaction([PACKETS, COVERAGE], 'readwrite')
  const all = IDBKeyRange.bound([radio, -Infinity], [radio, Infinity])
  const del = (store: IDBObjectStore, index: string) =>
    (store.index(index).openCursor(all).onsuccess = (ev) => {
      const c = (ev.target as IDBRequest<IDBCursorWithValue | null>).result
      if (!c) return
      c.delete()
      c.continue()
    })
  del(t.objectStore(PACKETS), 'radio_ts')
  del(t.objectStore(COVERAGE), 'radio_end')
  await done(t)
}

export async function saveCoverage(radio: string, span: CoverageSpan) {
  const t = (await db()).transaction(COVERAGE, 'readwrite')
  t.objectStore(COVERAGE).put({ ...span, key: `${radio}|${span.start}`, radio })
  await done(t)
}

/** Spans ending at or after `since`. */
export async function loadCoverage(radio: string, since: number): Promise<CoverageSpan[]> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound([radio, since], [radio, Infinity])
    const req = d.transaction(COVERAGE).objectStore(COVERAGE).index('radio_end').getAll(range)
    req.onsuccess = () =>
      resolve((req.result as (CoverageSpan & { radio: string })[]).map((s) => ({ start: s.start, end: s.end })).sort((a, b) => a.start - b.start))
    req.onerror = () => reject(req.error)
  })
}

export async function pruneCoverage(radio: string, before: number) {
  const t = (await db()).transaction(COVERAGE, 'readwrite')
  t.objectStore(COVERAGE).index('radio_end').openCursor(IDBKeyRange.bound([radio, -Infinity], [radio, before], false, true)).onsuccess = (ev) => {
    const c = (ev.target as IDBRequest<IDBCursorWithValue | null>).result
    if (!c) return
    c.delete()
    c.continue()
  }
  await done(t)
}

/** Plain copy; Svelte state proxies cannot be structured-cloned. */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}
