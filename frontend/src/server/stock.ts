/**
 * Inventory core. Every stock change goes through `StockTx.apply()`, which updates the balance and records an
 * append-only movement line in the same transaction. Balances live in per-location sharded maps; movements are
 * one `stock_moves` document per (operation, location) with its lines.
 *
 * Valuation is weighted-average cost per (location, book): receipts recompute the average, issues are costed at it.
 */
import { orderBy, where, limit } from 'firebase/firestore'
import type { Ctx } from './ctx'
import { Conflict, D, NotFound, ValidationFailed, ZERO, r2, r4, s4, type Decimal, type Num } from './core'
import { entries, find, findScoped, stockAt, stockPath, type Row, type Uow } from './store'
import { getPolicy } from './settings'

export const BUCKET_FIELD = { ON_HAND: 'on_hand', DAMAGED: 'damaged', QUARANTINED: 'quarantined', IN_TRANSIT: 'in_transit', RESERVED: 'reserved' } as const
export type Bucket = keyof typeof BUCKET_FIELD
export const VALUED_BUCKETS: Bucket[] = ['ON_HAND', 'DAMAGED', 'QUARANTINED']
export const COPY_STATUS_FOR_BUCKET: Record<string, string> = { ON_HAND: 'AVAILABLE', DAMAGED: 'DAMAGED', QUARANTINED: 'QUARANTINED' }

export interface Bal {
  location_id: string; book_id: string
  on_hand: number; reserved: number; damaged: number; quarantined: number; in_transit: number
  avg_cost: string | null; reorder_level: number | null; reorder_qty: number | null; price_override: string | null
}
export interface Ref { type: string; id?: string | null; number?: string | null }

export const emptyBal = (location_id: string, book_id: string): Bal => ({ location_id, book_id, on_hand: 0, reserved: 0, damaged: 0, quarantined: 0, in_transit: 0, avg_cost: null, reorder_level: null, reorder_qty: null, price_override: null })
export const toBal = (loc: string, r: Row | undefined | null): Bal => (r ? { ...emptyBal(loc, r.id), ...(r as unknown as Bal), location_id: loc, book_id: r.id } : emptyBal(loc, ''))
export const valuedQty = (b: Bal) => b.on_hand + b.damaged + b.quarantined

/** Balances of every book at a location (live, from memory). */
export async function balancesAt(loc: string): Promise<Map<string, Bal>> {
  const m = await stockAt(loc)
  return new Map([...m].map(([id, r]) => [id, toBal(loc, r)]))
}

async function bookTitle(id: string): Promise<string> {
  return ((await entries('books')).get(id)?.title as string) ?? id
}

/** Stock changes inside one unit of work. Call `commit()` before the unit ends. */
export class StockTx {
  private bals = new Map<string, Bal>()
  private moves = new Map<string, { location_id: string; ref: Ref; lines: Record<string, unknown>[] }>()
  private u: Uow
  private actor: { uid: string; name: string } | null
  constructor(u: Uow, actor: { uid: string; name: string } | null) {
    this.u = u
    this.actor = actor
  }

  async bal(loc: string, book: string): Promise<Bal> {
    const k = `${loc}|${book}`
    const cached = this.bals.get(k)
    if (cached) return cached
    const doc = await this.u.get(stockPath(loc, book))
    const e = (doc?.m ?? {})[book]
    const b: Bal = e ? { ...emptyBal(loc, book), ...e, location_id: loc, book_id: book } : emptyBal(loc, book)
    this.bals.set(k, b)
    return b
  }

  async apply(b: Bal, o: { bucket: Bucket; delta: number; movement_type: string; ref: Ref; unit_cost?: Num; copy_id?: string | null; note?: string | null; check_available?: boolean }) {
    if (!o.delta) return
    const f = BUCKET_FIELD[o.bucket]
    const cur = b[f]
    const next = cur + o.delta
    if (next < 0) {
      throw Conflict(`Insufficient ${o.bucket.toLowerCase().replace('_', ' ')} stock for '${await bookTitle(b.book_id)}': have ${cur}, need ${-o.delta}`, { code: 'insufficient_stock', details: { book_id: b.book_id, location_id: b.location_id, have: cur } })
    }
    if (o.check_available && o.bucket === 'ON_HAND' && o.delta < 0 && b.on_hand - b.reserved < -o.delta) {
      throw Conflict(`Insufficient available stock for '${await bookTitle(b.book_id)}': available ${b.on_hand - b.reserved}, need ${-o.delta}`, { code: 'insufficient_stock', details: { book_id: b.book_id, available: b.on_hand - b.reserved } })
    }
    if (o.bucket === 'RESERVED' && next > b.on_hand) throw Conflict('Cannot reserve more than on-hand stock', { code: 'insufficient_stock' })
    b[f] = next
    const key = `${b.location_id}|${o.ref.type}|${o.ref.id ?? ''}`
    const g = this.moves.get(key) ?? { location_id: b.location_id, ref: o.ref, lines: [] }
    g.lines.push({ book_id: b.book_id, bucket: o.bucket, qty_delta: o.delta, movement_type: o.movement_type, unit_cost: o.unit_cost === undefined || o.unit_cost === null ? null : s4(o.unit_cost), copy_id: o.copy_id ?? null, note: o.note ?? null })
    this.moves.set(key, g)
  }

  /** Weighted-average cost update before adding `qty` valued units at `unitCost`. */
  receiveCost(b: Bal, qty: number, unitCost: Num) {
    if (unitCost === null || unitCost === undefined || qty <= 0) return
    const existing = valuedQty(b)
    b.avg_cost = b.avg_cost === null || existing <= 0 ? s4(unitCost) : s4(r4(D(b.avg_cost).times(existing).plus(D(unitCost).times(qty)).div(existing + qty)))
  }

  /** Mark a balance as changed without a movement (price override, reorder settings). */
  touch(b: Bal) {
    this.bals.set(`${b.location_id}|${b.book_id}`, b)
  }

  async commit() {
    for (const b of this.bals.values()) {
      const path = stockPath(b.location_id, b.book_id)
      const { location_id: _l, book_id: _b, ...rest } = b
      void _l; void _b
      await this.u.setEntry(path, b.book_id, { ...rest, updated_at: this.u.at })
      this.u.mergeFields(path, { location_id: b.location_id })
    }
    const titles = await entries('books')
    for (const g of this.moves.values()) {
      const books = [...new Set(g.lines.map((l) => l.book_id as string))]
      this.u.add('stock_moves', {
        location_id: g.location_id, ref_type: g.ref.type, ref_id: g.ref.id ?? null, ref_number: g.ref.number ?? null,
        actor_id: this.actor?.uid ?? null, actor_name: this.actor?.name ?? null, book_ids: books,
        lines: g.lines.map((l) => ({ ...l, title: titles.get(l.book_id as string)?.title ?? null, sku: titles.get(l.book_id as string)?.sku ?? null })),
      })
    }
    this.bals.clear()
    this.moves.clear()
  }
}

// ---------------------------------------------------------------- individual copies
export async function createCopies(u: Uow, o: { book: Row; location_id: string; qty: number; status: string; unit_cost: Num; ref: Ref; actor: Ctx | null; condition?: string }): Promise<Row[]> {
  const prefix = (await getPolicy()).copy_code_prefix
  const out: Row[] = []
  for (let i = 0; i < o.qty; i++) {
    const code = await u.nextCode('COPY', prefix, 8)
    const doc = {
      copy_code: code, book_id: o.book.id, location_id: o.location_id, status: o.status, condition: o.condition ?? 'NEW',
      acquisition_cost: o.unit_cost === null || o.unit_cost === undefined ? null : s4(o.unit_cost), notes: null, updated_at: u.at,
      events: [{ event_type: 'CREATED', from_location_id: null, to_location_id: o.location_id, from_status: null, to_status: o.status, condition: o.condition ?? 'NEW', ref_type: o.ref.type, ref_id: o.ref.id ?? null, note: null, actor: o.actor?.name ?? null, created_at: u.at }],
    }
    const id = u.add('copies', doc)
    out.push({ ...doc, id, created_at: u.at })
  }
  return out
}

export async function moveCopy(u: Uow, c: Row, o: { event: string; to_status: string; ref: Ref; actor: Ctx | null; to_location_id?: string | null; condition?: string | null; note?: string | null }) {
  const ev = { event_type: o.event, from_location_id: c.location_id, to_location_id: o.to_location_id ?? c.location_id, from_status: c.status, to_status: o.to_status, condition: o.condition ?? c.condition, ref_type: o.ref.type, ref_id: o.ref.id ?? null, note: o.note ?? null, actor: o.actor?.name ?? null, created_at: u.at }
  const patch: Record<string, unknown> = { status: o.to_status, events: [...(c.events ?? []), ev], updated_at: u.at }
  if (o.to_location_id) patch.location_id = o.to_location_id
  if (o.condition) patch.condition = o.condition
  await u.update(`copies/${c.id}`, patch)
  Object.assign(c, patch)
}

/** Specific copies (if given) or the oldest copies with `status` at the location, re-read inside the unit. */
export async function pickCopies(u: Uow, o: { book_id: string; location_id: string; qty: number; status?: string; copy_ids?: string[] | null }): Promise<Row[]> {
  const status = o.status ?? 'AVAILABLE'
  if (o.copy_ids?.length) {
    if (o.copy_ids.length !== o.qty || new Set(o.copy_ids).size !== o.qty) throw ValidationFailed('Copy list must match quantity and be unique')
    const out: Row[] = []
    for (const id of [...o.copy_ids].sort()) {
      const c = await u.get(`copies/${id}`)
      if (!c) throw NotFound('Copy not found')
      if (c.book_id !== o.book_id || c.location_id !== o.location_id || c.status !== status) throw Conflict(`Copy ${c.copy_code} is not ${status.toLowerCase()} at this location`, { code: 'copy_unavailable' })
      out.push(c)
    }
    return out
  }
  const candidates = (await find('copies', where('book_id', '==', o.book_id), where('location_id', '==', o.location_id), where('status', '==', status)))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.copy_code).localeCompare(String(b.copy_code)))
  const out: Row[] = []
  for (const c of candidates) {
    if (out.length === o.qty) break
    const fresh = await u.get(`copies/${c.id}`)
    if (fresh && fresh.status === status && fresh.location_id === o.location_id) out.push(fresh)
  }
  if (out.length < o.qty) throw Conflict(`Only ${out.length} ${status.toLowerCase()} copies available`, { code: 'insufficient_stock' })
  return out
}

export async function copyByCode(code: string): Promise<Row | null> {
  return (await find('copies', where('copy_code', '==', code.toUpperCase()), limit(1)))[0] ?? null
}

// ---------------------------------------------------------------- read helpers
export function stockStatus(b: Bal, book: Row | undefined): 'OUT' | 'LOW' | 'OK' {
  const avail = b.on_hand - b.reserved
  const level = b.reorder_level ?? (book?.reorder_level as number) ?? 0
  if (avail <= 0) return 'OUT'
  if (level && avail <= level) return 'LOW'
  return 'OK'
}

export async function movementLines(scope: string[] | null, o: { location_id?: string | null; book_id?: string | null; from?: string; to?: string; max?: number } = {}): Promise<Row[]> {
  const cs = []
  if (o.book_id) cs.push(where('book_ids', 'array-contains', o.book_id))
  if (o.from) cs.push(where('created_at', '>=', o.from))
  if (o.to) cs.push(where('created_at', '<', o.to))
  cs.push(orderBy('created_at', 'desc'), limit(o.max ?? 1500))
  const docs = await findScoped('stock_moves', o.location_id ? [o.location_id] : scope, 'location_id', ...cs)
  const out: Row[] = []
  for (const d of docs) {
    (d.lines as Row[]).forEach((l, i) => {
      if (o.book_id && l.book_id !== o.book_id) return
      out.push({ ...l, id: `${d.id}:${i}`, location_id: d.location_id, ref_type: d.ref_type, ref_id: d.ref_id, ref_number: d.ref_number, actor_name: d.actor_name, created_at: d.created_at })
    })
  }
  return out
}

export function costOf(b: Bal, qty: number): Decimal {
  return b.avg_cost === null ? ZERO : r2(D(b.avg_cost).times(qty))
}
