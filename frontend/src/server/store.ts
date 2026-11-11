/**
 * Firestore data layer.
 *
 * - Record collections (sales, purchase_orders, …): one document per record, queried by date/location.
 * - Reference collections (locations, roles, suppliers, …): small, kept in memory by a live listener, so a
 *   screen costs no reads once loaded.
 * - Sharded maps (books, customers, stock): many small records packed into a fixed number of documents
 *   (`{coll}/{shard}` with a map field `m`), so loading 10,000 books costs ~32 reads instead of 10,000.
 *
 * Writes go through `tx()`: a unit of work over a Firestore transaction. Reads may happen at any point (they
 * see the unit's own pending writes) and all writes are applied together at the end, so a sale, its stock
 * movement, the daily totals and the audit entry either all happen or none do.
 *
 * Each business keeps its data under `orgs/{businessId}/…`. Paths in this module are relative to the signed-in
 * business; a path starting with `/` is global (`/members/{uid}`, `/orgs/{id}`, `/platform/enroll`).
 */
import {
  type DocumentData,
  type Firestore,
  type QueryConstraint,
  type Transaction,
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  setDoc,
  where,
} from 'firebase/firestore'
import { db } from './firebase'
import { BadRequest, Unauthorized, financialYear, fyShort, localDate, newId, nowIso } from './core'

export type Row = DocumentData & { id: string }

// ---------------------------------------------------------------- business (tenant)
let tenant: string | null = null
export const currentTenant = () => tenant
/** Switch the business whose data is read and written; drops cached data of the previous one. */
export function setTenant(id: string | null) {
  if (id === tenant) return
  resetLive()
  tenant = id
}
export function fullPath(path: string): string {
  if (path.startsWith('/')) return path.slice(1)
  if (!tenant) throw Unauthorized('Not authenticated', { code: 'not_authenticated' })
  return `orgs/${tenant}/${path}`
}

// ---------------------------------------------------------------- queries
export async function getOne(path: string): Promise<Row | null> {
  const s = await getDoc(doc(db(), fullPath(path)))
  return s.exists() ? ({ ...s.data(), id: s.id } as Row) : null
}
export async function find(coll: string, ...cs: QueryConstraint[]): Promise<Row[]> {
  const s = await getDocs(query(collection(db(), fullPath(coll)), ...cs))
  return s.docs.map((d) => ({ ...d.data(), id: d.id }) as Row)
}
/** Location-scoped query: unrestricted users see everything; others only their locations (rules enforce it too). */
export async function findScoped(coll: string, scope: string[] | null, field = 'location_id', ...cs: QueryConstraint[]): Promise<Row[]> {
  if (scope === null) return find(coll, ...cs)
  if (scope.length === 0) return []
  const out: Row[] = []
  for (let i = 0; i < scope.length; i += 30) {
    const chunk = scope.slice(i, i + 30)
    out.push(...(await find(coll, where(field, field.endsWith('_ids') ? 'array-contains-any' : 'in', chunk), ...cs)))
  }
  return out
}

// ---------------------------------------------------------------- live reference collections
type Listener = { rows: Map<string, Row>; ready: Promise<void>; error: Error | null; unsub: () => void }
const live = new Map<string, Listener>()

function listen(key: string, coll: string, cs: QueryConstraint[], explode: boolean): Listener {
  const existing = live.get(key)
  if (existing && !existing.error) return existing
  let resolve!: () => void
  const l: Listener = { rows: new Map(), ready: new Promise<void>((r) => (resolve = r)), error: null, unsub: () => {} }
  l.unsub = onSnapshot(
    query(collection(db(), fullPath(coll)), ...cs),
    (snap) => {
      const rows = new Map<string, Row>()
      for (const d of snap.docs) {
        const data = d.data()
        if (explode) {
          for (const [id, v] of Object.entries((data.m ?? {}) as Record<string, DocumentData>)) rows.set(id, { ...v, id, _shard: d.id } as Row)
        } else rows.set(d.id, { ...data, id: d.id } as Row)
      }
      l.rows = rows
      resolve()
    },
    (e) => {
      l.error = e
      resolve()
    },
  )
  live.set(key, l)
  return l
}

async function rowsOf(l: Listener): Promise<Map<string, Row>> {
  await l.ready
  if (l.error) throw l.error
  return l.rows
}

/** All documents of a small collection, kept current by a listener. */
export async function all(coll: string): Promise<Row[]> {
  return [...(await rowsOf(listen(coll, coll, [], false))).values()]
}
export async function byId(coll: string, id: string | null | undefined): Promise<Row | null> {
  if (!id) return null
  return (await rowsOf(listen(coll, coll, [], false))).get(id) ?? null
}
export async function indexById(coll: string): Promise<Map<string, Row>> {
  return rowsOf(listen(coll, coll, [], false))
}

// sharded maps ----------------------------------------------------
export const SHARDS: Record<string, number> = { books: 32, customers: 8, stock: 8 }
export function shardOf(id: string, n: number): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return `s${String(h % n).padStart(2, '0')}`
}
/** All entries of a sharded map collection (books, customers). */
export async function entries(coll: 'books' | 'customers'): Promise<Map<string, Row>> {
  return rowsOf(listen(coll, coll, [], true))
}
export async function entry(coll: 'books' | 'customers', id: string | null | undefined): Promise<Row | null> {
  if (!id) return null
  return (await entries(coll)).get(id) ?? null
}
export const shardPath = (coll: 'books' | 'customers', id: string) => `${coll}/${shardOf(id, SHARDS[coll])}`

// stock: one sharded map per location, doc id `{locationId}~{shard}` -----------------
export const stockPath = (locationId: string, bookId: string) => `stock/${locationId}~${shardOf(bookId, SHARDS.stock)}`
export async function stockAt(locationId: string): Promise<Map<string, Row>> {
  return rowsOf(listen(`stock:${locationId}`, 'stock', [where('location_id', '==', locationId)], true))
}

/** Stop all listeners (sign-out). */
export function resetLive() {
  for (const l of live.values()) l.unsub()
  live.clear()
}

// ---------------------------------------------------------------- unit of work
type Pending = { kind: 'set' | 'merge' | 'delete'; data?: DocumentData }

export class Uow {
  private state = new Map<string, DocumentData | null>()
  private pending = new Map<string, Pending>()
  readonly at = nowIso()
  /** Per-unit lookups (e.g. author/publisher ids created earlier in the same unit). */
  readonly memo = new Map<string, string>()
  private t: Transaction
  private fs: Firestore
  constructor(t: Transaction, fs: Firestore) {
    this.t = t
    this.fs = fs
  }

  async get(path: string): Promise<Row | null> {
    if (!this.state.has(path)) {
      const s = await this.t.get(doc(this.fs, fullPath(path)))
      this.state.set(path, s.exists() ? s.data() : null)
    }
    const d = this.state.get(path)
    return d ? ({ ...structuredClone(d), id: path.split('/').pop()! } as Row) : null
  }
  /** Read several documents in parallel (one round trip instead of one per document). */
  async prefetch(paths: (string | null | undefined)[]): Promise<void> {
    const todo = [...new Set(paths.filter((p): p is string => !!p && !this.state.has(p)))]
    await Promise.all(todo.map(async (path) => {
      const snap = await this.t.get(doc(this.fs, fullPath(path)))
      if (!this.state.has(path)) this.state.set(path, snap.exists() ? snap.data() : null)
    }))
  }
  async need(path: string, what = 'Record'): Promise<Row> {
    const r = await this.get(path)
    if (!r) throw BadRequest(`${what} not found`, { code: 'not_found' })
    return r
  }
  set(path: string, data: DocumentData) {
    const clean = strip(data)
    this.state.set(path, clean)
    this.pending.set(path, { kind: 'set', data: clean })
  }
  /** Create a new record document; returns its id. */
  add(coll: string, data: DocumentData, id = newId()): string {
    this.set(`${coll}/${id}`, { ...data, created_at: data.created_at ?? this.at })
    return id
  }
  /** Shallow field update of an existing (already read or new) document. */
  async update(path: string, patch: DocumentData) {
    const cur = (await this.get(path)) ?? {}
    const { id: _id, ...rest } = cur as Row
    void _id
    this.set(path, { ...rest, ...strip(patch) })
  }
  /** Set one entry of a sharded map document (`m.<key>`). */
  async setEntry(path: string, key: string, value: DocumentData | null) {
    const cur = ((await this.get(path)) ?? {}) as DocumentData
    const m = { ...(cur.m ?? {}) }
    if (value === null) delete m[key]
    else m[key] = strip(value)
    this.state.set(path, { ...cur, m })
    const p = this.pending.get(path)
    if (p?.kind === 'set') {
      p.data = { ...(p.data ?? {}), m }
    } else {
      const merged = p?.data?.m ?? {}
      merged[key] = value === null ? deleteField() : strip(value)
      this.pending.set(path, { kind: 'merge', data: { ...(p?.data ?? {}), m: merged } })
    }
  }
  /** Extra top-level fields to store alongside a sharded map (e.g. stock location id). */
  mergeFields(path: string, fields: DocumentData) {
    const p = this.pending.get(path)
    const cur = this.state.get(path) ?? {}
    this.state.set(path, { ...cur, ...fields })
    if (p) p.data = { ...(p.data ?? {}), ...fields }
    else this.pending.set(path, { kind: 'merge', data: fields })
  }
  delete(path: string) {
    this.state.set(path, null)
    this.pending.set(path, { kind: 'delete' })
  }

  /** Gapless numbering per (scope, doc type, financial year), e.g. `PO/2627/00001`. */
  async nextNumber(docType: string, opts: { scope?: string; prefix?: string; width?: number; fy?: string } = {}): Promise<string> {
    const fy = opts.fy ?? financialYear(localDate())
    const scope = opts.scope ?? 'ORG'
    const path = `counters/${scope}~${docType}~${fy}`
    const c = await this.get(path)
    const value = (c?.next_value as number | undefined) ?? 1
    this.set(path, { scope, doc_type: docType, financial_year: fy, next_value: value + 1 })
    return `${opts.prefix ?? docType}/${fyShort(fy)}/${String(value).padStart(opts.width ?? 5, '0')}`
  }
  /** Running code without financial year (SKU, customer codes, copy codes). */
  async nextCode(docType: string, prefix: string, width = 6): Promise<string> {
    return `${prefix}${String(await this.nextValue(docType)).padStart(width, '0')}`
  }
  async nextValue(docType: string): Promise<number> {
    const path = `counters/ORG~${docType}~ALL`
    const c = await this.get(path)
    const value = (c?.next_value as number | undefined) ?? 1
    this.set(path, { scope: 'ORG', doc_type: docType, financial_year: 'ALL', next_value: value + 1 })
    return value
  }

  /** Final state of every document this unit wrote (null = deleted). */
  written(): [string, DocumentData | null][] {
    return [...this.pending.keys()].map((p) => [p, this.state.get(p) ?? null])
  }

  flush() {
    for (const [path, p] of this.pending) {
      const ref = doc(this.fs, fullPath(path))
      if (p.kind === 'delete') this.t.delete(ref)
      else if (p.kind === 'set') this.t.set(ref, p.data!)
      else this.t.set(ref, p.data!, { merge: true })
    }
    return this.pending.size
  }
}

function strip(o: DocumentData): DocumentData {
  const out: DocumentData = {}
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || k === 'id' || k === '_shard') continue
    out[k] = v
  }
  return out
}

const commitListeners = new Set<() => void>()
export function onCommit(fn: () => void) {
  commitListeners.add(fn)
}

/**
 * Committed transaction writes reach listeners only after a server round trip; apply them to the in-memory
 * copies straight away so the next screen shows what was just saved.
 */
function applyLocal(written: [string, DocumentData | null][]) {
  for (const [path, data] of written) {
    if (path.startsWith('/')) continue
    const [coll, id] = path.split('/')
    if (coll === 'stock') {
      const l = live.get(`stock:${id.split('~')[0]}`)
      if (l && !l.error) replaceShard(l, id, data)
      continue
    }
    const l = live.get(coll)
    if (!l || l.error) continue
    if (coll === 'books' || coll === 'customers') replaceShard(l, id, data)
    else if (data) l.rows.set(id, { ...data, id } as Row)
    else l.rows.delete(id)
  }
}
function replaceShard(l: Listener, shard: string, data: DocumentData | null) {
  const rows = new Map([...l.rows].filter(([, r]) => r._shard !== shard))
  for (const [id, v] of Object.entries((data?.m ?? {}) as Record<string, DocumentData>)) rows.set(id, { ...v, id, _shard: shard } as Row)
  l.rows = rows
}

export async function tx<T>(fn: (u: Uow) => Promise<T>): Promise<T> {
  const fs = db()
  let written: [string, DocumentData | null][] = []
  const result = await runTransaction(fs, async (t) => {
    const u = new Uow(t, fs)
    const r = await fn(u)
    u.flush()
    written = u.written()
    return r
  })
  if (written.length) {
    applyLocal(written)
    for (const fn of commitListeners) fn()
  }
  return result
}

/** Non-transactional single write (activity pings). */
export function put(path: string, data: DocumentData) {
  return setDoc(doc(db(), fullPath(path)), data, { merge: true })
}
