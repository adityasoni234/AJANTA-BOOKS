/** Inventory screens: balances, summary, movement ledger, reconciliation, adjustments, stocktakes, copies, labels. */
import { limit, orderBy, where } from 'firebase/firestore'
import { createApproval, registerApproval } from './approvals'
import { bookOut, canSeeCost, getBook, lookupCode, searchFilter } from './catalog'
import type { Ctx } from './ctx'
import { Conflict, D, NotFound, ValidationFailed, ZERO, clean, int, isoRange, matches, paginate, r2, s2, sum } from './core'
import { post, type Leg } from './ledger'
import { route } from './router'
import { getPolicy } from './settings'
import { BUCKET_FIELD, COPY_STATUS_FOR_BUCKET, StockTx, VALUED_BUCKETS, balancesAt, createCopies, moveCopy, movementLines, stockStatus, valuedQty, type Bal, type Bucket } from './stock'
import { all, byId, entries, find, findScoped, getOne, tx, type Row, type Uow } from './store'

void bookOut

async function scopedLocations(ctx: Ctx, requested?: string | null): Promise<Row[]> {
  if (requested) ctx.ensureLocation(requested)
  return (await all('locations')).filter((l) => l.is_active && ctx.canAccess(l.id) && (!requested || l.id === requested))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'WAREHOUSE' ? -1 : 1))
}

route('GET', '/inventory', async ({ query }, ctx) => {
  ctx.require('inventory.view')
  const locs = await scopedLocations(ctx, query.location_id)
  const books = await entries('books')
  const f = await searchFilter(query.q)
  const cost = canSeeCost(ctx)
  const rows: Record<string, unknown>[] = []
  for (const l of locs) {
    for (const bal of (await balancesAt(l.id)).values()) {
      const book = books.get(bal.book_id)
      if (!book || !f(book) || (query.category_id && book.category_id !== query.category_id)) continue
      const avail = bal.on_hand - bal.reserved
      const reorder = bal.reorder_level ?? book.reorder_level ?? 0
      const s = query.status
      const keep = s === 'OUT' ? avail <= 0 && book.status === 'ACTIVE'
        : s === 'LOW' ? avail > 0 && reorder > 0 && avail <= reorder
        : s === 'OK' ? avail > 0 && (reorder === 0 || avail > reorder)
        : s === 'IN_STOCK' ? bal.on_hand > 0
        : s === 'DAMAGED' ? bal.damaged > 0 || bal.quarantined > 0
        : s === 'IN_TRANSIT' ? bal.in_transit > 0
        : bal.on_hand !== 0 || bal.damaged !== 0 || bal.quarantined !== 0 || bal.in_transit !== 0 || book.status === 'ACTIVE'
      if (!keep) continue
      rows.push({
        location_id: l.id, location_name: l.name, book_id: book.id, sku: book.sku, barcode: book.barcode, isbn13: book.isbn13 ?? null, title: book.title, authors: book.authors ?? [],
        tracking_mode: book.tracking_mode, on_hand: bal.on_hand, reserved: bal.reserved, available: avail, damaged: bal.damaged, quarantined: bal.quarantined, in_transit: bal.in_transit,
        reorder_level: reorder, reorder_qty: bal.reorder_qty ?? book.reorder_qty ?? 0, stock_status: stockStatus(bal, book),
        selling_price: bal.price_override ?? book.selling_price, avg_cost: cost ? bal.avg_cost : null,
        stock_value: cost && bal.avg_cost !== null ? s2(D(bal.avg_cost).times(valuedQty(bal))) : null,
      })
    }
  }
  rows.sort((a, b) => String(a.title).localeCompare(String(b.title)) || String(a.location_name).localeCompare(String(b.location_name)))
  return paginate(rows, Number(query.page), Number(query.page_size))
})

route('GET', '/inventory/summary', async (_r, ctx) => {
  ctx.require('inventory.view')
  const cost = canSeeCost(ctx)
  const out = []
  for (const l of await scopedLocations(ctx)) {
    const bals = [...(await balancesAt(l.id)).values()]
    out.push({
      location_id: l.id, location_name: l.name, location_type: l.type, on_hand: bals.reduce((a, b) => a + b.on_hand, 0), reserved: bals.reduce((a, b) => a + b.reserved, 0),
      unsellable: bals.reduce((a, b) => a + b.damaged + b.quarantined, 0), in_transit: bals.reduce((a, b) => a + b.in_transit, 0), titles_in_stock: bals.filter((b) => b.on_hand > 0).length,
      value: cost ? s2(sum(bals.map((b) => D(b.avg_cost).times(valuedQty(b))))) : null,
      items_missing_cost: cost ? bals.filter((b) => valuedQty(b) > 0 && b.avg_cost === null).length : null,
    })
  }
  return out
})

route('GET', '/inventory/ledger', async ({ query }, ctx) => {
  ctx.require('inventory.view')
  if (query.location_id) ctx.ensureLocation(query.location_id)
  const range = query.date_from || query.date_to ? isoRange(query.date_from ?? '2000-01-01', query.date_to ?? '2999-12-31') : null
  const locs = new Map((await all('locations')).map((l) => [l.id, l.name]))
  const cost = canSeeCost(ctx)
  const lines = (await movementLines(ctx.scope(), { location_id: query.location_id, book_id: query.book_id, from: range?.[0], to: range?.[1] }))
    .filter((l) => (!query.movement_type || l.movement_type === query.movement_type) && (!query.ref_number || matches(query.ref_number, l.ref_number)))
  return paginate(lines.map((l) => ({ ...l, location_name: locs.get(l.location_id) ?? null, unit_cost: cost ? l.unit_cost : null })), Number(query.page), Number(query.page_size))
})

route('GET', '/inventory/reconciliation', async ({ query }, ctx) => {
  ctx.require('inventory.approve')
  const locs = await scopedLocations(ctx, query.location_id)
  const books = await entries('books')
  const issues: Record<string, unknown>[] = []
  for (const l of locs) {
    const sums = new Map<string, Record<string, number>>()
    for (const ln of await movementLines([l.id], { location_id: l.id, max: 100000 })) {
      const s = sums.get(ln.book_id) ?? {}
      s[ln.bucket] = (s[ln.bucket] ?? 0) + ln.qty_delta
      sums.set(ln.book_id, s)
    }
    const copies = await find('copies', where('location_id', '==', l.id))
    const bals = await balancesAt(l.id)
    for (const bal of bals.values()) {
      const s = sums.get(bal.book_id) ?? {}
      for (const [bucket, field] of Object.entries(BUCKET_FIELD)) {
        if (bal[field] !== (s[bucket] ?? 0)) issues.push({ location_id: l.id, book_id: bal.book_id, bucket, balance: bal[field], ledger: s[bucket] ?? 0, kind: 'LEDGER_MISMATCH' })
      }
      if (books.get(bal.book_id)?.tracking_mode === 'COPY') {
        for (const [bucket, status] of Object.entries(COPY_STATUS_FOR_BUCKET)) {
          let n = copies.filter((c) => c.book_id === bal.book_id && c.status === status).length
          if (bucket === 'ON_HAND') n += copies.filter((c) => c.book_id === bal.book_id && c.status === 'RESERVED').length
          if (n !== bal[BUCKET_FIELD[bucket as Bucket]]) issues.push({ location_id: l.id, book_id: bal.book_id, bucket, balance: bal[BUCKET_FIELD[bucket as Bucket]], copies: n, kind: 'COPY_MISMATCH' })
        }
      }
    }
    for (const [book, s] of sums) if (!bals.has(book) && Object.values(s).some((v) => v !== 0)) issues.push({ location_id: l.id, book_id: book, kind: 'MISSING_BALANCE', ledger: s })
  }
  for (const i of issues) {
    const b = books.get(i.book_id as string)
    i.title = b?.title ?? null
    i.sku = b?.sku ?? null
  }
  return { checked_at: new Date().toISOString(), issues, ok: !issues.length }
})

// ---------------------------------------------------------------- adjustments
const ADJ_REASON_BUCKETS: Record<string, [Bucket | null, Bucket | null]> = {
  OPENING: [null, 'ON_HAND'], FOUND: [null, 'ON_HAND'], LOSS: ['ON_HAND', null], DAMAGE: ['ON_HAND', 'DAMAGED'], WRITE_OFF: ['DAMAGED', null], QUARANTINE: ['ON_HAND', 'QUARANTINED'], RELEASE: ['QUARANTINED', 'ON_HAND'],
}
interface AdjLine { book_id: string; qty: number; from_bucket: Bucket | null; to_bucket: Bucket | null; unit_cost: string | null; copy_ids?: string[] | null; copy_id?: string | null }

export async function createAdjustment(u: Uow, ctx: Ctx, o: { location_id: string; reason_code: string; lines: AdjLine[]; notes: string | null; stocktake_id?: string | null }): Promise<Row> {
  ctx.ensureLocation(o.location_id)
  if (!o.lines.length) throw ValidationFailed('At least one line is required')
  const books = await entries('books')
  const norm: AdjLine[] = []
  for (const ln of o.lines) {
    let frm = ln.from_bucket ?? null, to = ln.to_bucket ?? null
    if (o.reason_code in ADJ_REASON_BUCKETS && frm === null && to === null) [frm, to] = ADJ_REASON_BUCKETS[o.reason_code]
    if (frm === null && to === null) throw ValidationFailed('Each line needs a source or destination bucket')
    for (const b of [frm, to]) if (b !== null && !VALUED_BUCKETS.includes(b)) throw ValidationFailed(`Bucket ${b} cannot be adjusted directly`)
    if (int(ln.qty) <= 0) throw ValidationFailed('Quantity must be positive')
    const book = books.get(ln.book_id)
    if (!book) throw NotFound('Book not found')
    if (book.tracking_mode === 'COPY' && frm !== null) {
      if (!ln.copy_ids?.length) throw ValidationFailed(`'${book.title}' is copy-tracked: specify the copies being adjusted`)
      if (new Set(ln.copy_ids).size !== int(ln.qty)) throw ValidationFailed('Number of copies must equal the quantity')
    }
    norm.push({ ...ln, qty: int(ln.qty), from_bucket: frm, to_bucket: to })
  }
  const bals = await balancesAt(o.location_id)
  let value = ZERO
  for (const ln of norm) {
    if (ln.from_bucket && ln.to_bucket) continue
    const cost = ln.unit_cost ?? bals.get(ln.book_id)?.avg_cost ?? '0'
    value = value.plus(D(ln.qty).times(D(cost)))
  }
  value = r2(value)
  const policy = await getPolicy()
  const needsApproval = (!ctx.has('inventory.approve') && D(policy.adjustment_approval_threshold).gt(0) && value.gte(D(policy.adjustment_approval_threshold))) || (o.reason_code === 'OPENING' && !ctx.has('inventory.approve'))
  const number = await u.nextNumber('ADJ')
  const lines: AdjLine[] = norm.flatMap((ln): AdjLine[] => (ln.copy_ids?.length && ln.from_bucket !== null
    ? ln.copy_ids.map((cid) => ({ book_id: ln.book_id, copy_id: cid, qty: 1, from_bucket: ln.from_bucket, to_bucket: ln.to_bucket, unit_cost: ln.unit_cost }))
    : [{ book_id: ln.book_id, copy_id: null, qty: ln.qty, from_bucket: ln.from_bucket, to_bucket: ln.to_bucket, unit_cost: ln.unit_cost }]))
  const adj: Row = {
    id: '', number, location_id: o.location_id, reason_code: o.reason_code, status: needsApproval ? 'PENDING_APPROVAL' : 'POSTED', notes: o.notes, value: s2(value), stocktake_id: o.stocktake_id ?? null,
    created_by: ctx.uid, created_by_name: ctx.name, created_at: u.at, approved_by: null, posted_at: null, journal_entry_id: null, lines,
  }
  adj.id = u.add('adjustments', adj)
  if (needsApproval) createApproval(u, ctx, { type: 'STOCK_ADJUSTMENT', location_id: o.location_id, title: `Stock adjustment ${number} (${o.reason_code})`, entity_type: 'stock_adjustment', entity_id: adj.id, amount: value, reason: o.notes })
  else Object.assign(adj, await postAdjustment(u, ctx, adj))
  ctx.audit(u, 'inventory.adjustment_created', { entity_type: 'stock_adjustment', entity_id: adj.id, location_id: o.location_id, details: { reason: o.reason_code, value: s2(value), status: adj.status } })
  return adj
}

async function postAdjustment(u: Uow, ctx: Ctx, adj: Row): Promise<Row> {
  const ref = { type: 'ADJUSTMENT', id: adj.id, number: adj.number }
  const st = new StockTx(u, { uid: ctx.uid, name: ctx.name })
  const books = await entries('books')
  let invDelta = ZERO, opening = ZERO
  for (const ln of adj.lines as AdjLine[]) {
    const bal = await st.bal(adj.location_id, ln.book_id)
    const book = books.get(ln.book_id)!
    const mt = `ADJ_${adj.reason_code}`
    if (ln.from_bucket === null) {
      const cost = ln.unit_cost ?? bal.avg_cost
      st.receiveCost(bal, ln.qty, cost)
      await st.apply(bal, { bucket: ln.to_bucket!, delta: ln.qty, movement_type: mt, ref, unit_cost: cost })
      const val = cost !== null ? r2(D(ln.qty).times(D(cost))) : ZERO
      if (adj.reason_code === 'OPENING') opening = opening.plus(val)
      else invDelta = invDelta.plus(val)
      if (book.tracking_mode === 'COPY') await createCopies(u, { book, location_id: adj.location_id, qty: ln.qty, status: COPY_STATUS_FOR_BUCKET[ln.to_bucket!], unit_cost: cost, ref, actor: ctx })
    } else {
      const cost = bal.avg_cost
      await st.apply(bal, { bucket: ln.from_bucket, delta: -ln.qty, movement_type: mt, ref, unit_cost: cost, copy_id: ln.copy_id, check_available: ln.from_bucket === 'ON_HAND' })
      if (ln.to_bucket !== null) await st.apply(bal, { bucket: ln.to_bucket, delta: ln.qty, movement_type: mt, ref, unit_cost: cost, copy_id: ln.copy_id })
      else invDelta = invDelta.minus(cost !== null ? r2(D(ln.qty).times(D(cost))) : ZERO)
      if (ln.copy_id) {
        const c = await u.get(`copies/${ln.copy_id}`)
        if (!c) throw NotFound('Copy not found')
        const expected = COPY_STATUS_FOR_BUCKET[ln.from_bucket]
        if (c.location_id !== adj.location_id || c.status !== expected) throw Conflict(`Copy ${c.copy_code} is not ${expected.toLowerCase()} at this location`)
        const ns = COPY_STATUS_FOR_BUCKET[ln.to_bucket ?? ''] ?? (adj.reason_code === 'LOSS' ? 'LOST' : 'WRITTEN_OFF')
        await moveCopy(u, c, { event: mt, to_status: ns, ref, actor: ctx, condition: ln.to_bucket === 'DAMAGED' ? 'DAMAGED' : null })
      }
    }
  }
  await st.commit()
  const legs: Leg[] = []
  if (!invDelta.eq(0)) legs.push({ account: 'INVENTORY', amount: invDelta }, { account: 'INVENTORY_ADJ', amount: invDelta.neg() })
  if (!opening.eq(0)) legs.push({ account: 'INVENTORY', amount: opening }, { account: 'OPENING_EQUITY', amount: opening.neg() })
  const je = await post(u, { source_type: 'STOCK_ADJUSTMENT', source_id: adj.id, legs, memo: `Stock adjustment ${adj.number} (${adj.reason_code})`, location_id: adj.location_id, actor_id: ctx.uid })
  const patch = { journal_entry_id: je, status: 'POSTED', posted_at: u.at, approved_by: ctx.uid }
  await u.update(`adjustments/${adj.id}`, patch)
  return { ...adj, ...patch }
}

registerApproval('STOCK_ADJUSTMENT', async (u, ctx, req) => {
  const adj = await u.get(`adjustments/${req.entity_id}`)
  if (!adj || adj.status !== 'PENDING_APPROVAL') throw Conflict('Adjustment is not pending approval')
  await postAdjustment(u, ctx, adj)
}, async (u, _ctx, req) => {
  const adj = await u.get(`adjustments/${req.entity_id}`)
  if (adj && adj.status === 'PENDING_APPROVAL') await u.update(`adjustments/${adj.id}`, { status: 'REJECTED' })
})

async function adjOut(a: Row, cost: boolean) {
  const loc = await byId('locations', a.location_id)
  const books = await entries('books')
  const copyCodes = new Map<string, string>()
  for (const ln of a.lines as AdjLine[]) if (ln.copy_id) { const c = await getOne(`copies/${ln.copy_id}`); if (c) copyCodes.set(ln.copy_id, c.copy_code) }
  return {
    id: a.id, number: a.number, location_id: a.location_id, location_name: loc?.name ?? '', reason_code: a.reason_code, status: a.status, notes: a.notes, value: cost ? a.value : null,
    created_by_name: a.created_by_name, created_at: a.created_at, posted_at: a.posted_at,
    lines: (a.lines as AdjLine[]).map((ln) => ({ book_id: ln.book_id, title: books.get(ln.book_id)?.title, sku: books.get(ln.book_id)?.sku, qty: ln.qty, from_bucket: ln.from_bucket, to_bucket: ln.to_bucket, copy_code: ln.copy_id ? (copyCodes.get(ln.copy_id) ?? null) : null })),
  }
}
route('GET', '/inventory/adjustments', async ({ query }, ctx) => {
  ctx.require('inventory.view')
  if (query.location_id) ctx.ensureLocation(query.location_id)
  const rows = (await findScoped('adjustments', query.location_id ? [query.location_id] : ctx.scope(), 'location_id', orderBy('created_at', 'desc'), limit(1000)))
    .filter((a) => !query.status || a.status === query.status)
  const page = paginate(rows, Number(query.page), Number(query.page_size))
  const cost = canSeeCost(ctx)
  return { ...page, items: await Promise.all(page.items.map((a) => adjOut(a, cost))) }
})
route('POST', '/inventory/adjustments', async ({ body }, ctx) => {
  ctx.require('inventory.adjust')
  const reason = String(body.reason_code ?? '')
  if (!['OPENING', 'FOUND', 'LOSS', 'DAMAGE', 'WRITE_OFF', 'QUARANTINE', 'RELEASE', 'CORRECTION'].includes(reason)) throw ValidationFailed('Invalid reason code')
  const lines: AdjLine[] = ((body.lines ?? []) as Record<string, unknown>[]).map((l) => ({
    book_id: String(l.book_id), qty: int(l.qty), from_bucket: (l.from_bucket as Bucket) ?? null, to_bucket: (l.to_bucket as Bucket) ?? null,
    unit_cost: l.unit_cost === null || l.unit_cost === undefined || l.unit_cost === '' ? null : String(l.unit_cost), copy_ids: (l.copy_ids as string[]) ?? null,
  }))
  if (!lines.length || lines.length > 500) throw ValidationFailed('Between 1 and 500 lines are required')
  if (reason === 'CORRECTION' && lines.some((l) => l.from_bucket === null && l.to_bucket === null)) throw ValidationFailed('Correction lines must specify source and/or destination buckets')
  const adj = await tx((u) => createAdjustment(u, ctx, { location_id: String(body.location_id), reason_code: reason, lines, notes: clean(body.notes) }))
  return adjOut(adj, canSeeCost(ctx))
})

// ---------------------------------------------------------------- stocktakes
async function stOut(st: Row) {
  const loc = await byId('locations', st.location_id)
  const books = await entries('books')
  const bals = await balancesAt(st.location_id)
  const lines = (st.lines as Row[]).map((ln) => {
    const system = ln.system_qty ?? bals.get(ln.book_id)?.on_hand ?? 0
    return { book_id: ln.book_id, title: books.get(ln.book_id)?.title ?? '', sku: books.get(ln.book_id)?.sku ?? '', counted_qty: ln.counted_qty, system_qty: system, variance: ln.counted_qty - system }
  }).sort((a, b) => a.title.localeCompare(b.title))
  return { id: st.id, number: st.number, location_id: st.location_id, location_name: loc?.name ?? '', status: st.status, notes: st.notes, created_at: st.created_at, posted_at: st.posted_at, lines }
}
async function getSt(ctx: Ctx, id: string): Promise<Row> {
  const st = await getOne(`stocktakes/${id}`)
  if (!st) throw NotFound('Stocktake not found')
  ctx.ensureResource(st.location_id)
  return st
}
route('GET', '/inventory/stocktakes', async ({ query }, ctx) => {
  ctx.require('inventory.view')
  if (query.location_id) ctx.ensureLocation(query.location_id)
  const rows = await findScoped('stocktakes', query.location_id ? [query.location_id] : ctx.scope(), 'location_id', orderBy('created_at', 'desc'), limit(500))
  const page = paginate(rows, Number(query.page), Number(query.page_size))
  return { ...page, items: await Promise.all(page.items.map(stOut)) }
})
route('POST', '/inventory/stocktakes', async ({ body }, ctx) => {
  ctx.require('inventory.stocktake')
  const loc = String(body.location_id ?? '')
  ctx.ensureLocation(loc)
  const st = await tx(async (u) => {
    const doc = { number: await u.nextNumber('STK'), location_id: loc, status: 'OPEN', notes: clean(body.notes), created_by: ctx.uid, created_at: u.at, posted_by: null, posted_at: null, lines: [] }
    const id = u.add('stocktakes', doc)
    ctx.audit(u, 'inventory.stocktake_started', { entity_type: 'stocktake', entity_id: id, location_id: loc })
    return { ...doc, id }
  })
  return stOut(st)
})
route('GET', '/inventory/stocktakes/:id', async ({ params }, ctx) => {
  ctx.require('inventory.view')
  return stOut(await getSt(ctx, params.id))
})
route('POST', '/inventory/stocktakes/:id/counts', async ({ params, body }, ctx) => {
  ctx.require('inventory.stocktake')
  await getSt(ctx, params.id)
  const counts = (Array.isArray(body) ? body : []) as Record<string, unknown>[]
  const resolved: { book_id: string; counted_qty: number; mode: string }[] = []
  for (const c of counts.slice(0, 1000)) {
    const qty = int(c.counted_qty)
    if (qty < 0) throw ValidationFailed('Counted quantity cannot be negative')
    const bookId = c.book_id ? (await getBook(String(c.book_id))).id : c.code ? (await lookupCode(String(c.code))).book.id : null
    if (!bookId) throw ValidationFailed('Each count needs a book_id or code')
    resolved.push({ book_id: bookId, counted_qty: qty, mode: String(c.mode ?? 'SET') })
  }
  const st = await tx(async (u) => {
    const cur = await u.need(`stocktakes/${params.id}`, 'Stocktake')
    if (cur.status !== 'OPEN') throw Conflict('Stocktake is not open')
    const lines = [...(cur.lines as Row[])]
    for (const c of resolved) {
      const ln = lines.find((l) => l.book_id === c.book_id)
      if (ln) ln.counted_qty = c.mode === 'SET' ? c.counted_qty : ln.counted_qty + c.counted_qty
      else lines.push({ book_id: c.book_id, counted_qty: c.counted_qty, system_qty: null } as unknown as Row)
    }
    await u.update(`stocktakes/${params.id}`, { lines })
    return { ...cur, lines }
  })
  return stOut(st)
})
route('POST', '/inventory/stocktakes/:id/post', async ({ params }, ctx) => {
  ctx.require('inventory.stocktake')
  await getSt(ctx, params.id)
  return tx(async (u) => {
    const st = await u.need(`stocktakes/${params.id}`, 'Stocktake')
    if (st.status !== 'OPEN') throw Conflict('Stocktake is not open')
    const stx = new StockTx(u, null)
    const books = await entries('books')
    const found: AdjLine[] = [], loss: AdjLine[] = []
    const lines = (st.lines as Row[]).map((l) => ({ ...l }))
    for (const ln of lines) {
      const bal = await stx.bal(st.location_id, ln.book_id)
      ln.system_qty = bal.on_hand
      const variance = ln.counted_qty - bal.on_hand
      const book = books.get(ln.book_id)!
      if (!variance) continue
      if (book.tracking_mode === 'COPY') throw ValidationFailed(`'${book.title}' is copy-tracked; reconcile copies individually via adjustments instead of a count`)
      if (variance > 0) found.push({ book_id: ln.book_id, qty: variance, from_bucket: null, to_bucket: 'ON_HAND', unit_cost: null })
      else {
        if (bal.reserved > ln.counted_qty) throw Conflict(`'${book.title}': counted quantity is below stock reserved for transfers`)
        loss.push({ book_id: ln.book_id, qty: -variance, from_bucket: 'ON_HAND', to_bucket: null, unit_cost: null })
      }
    }
    await u.update(`stocktakes/${st.id}`, { lines, status: 'POSTED', posted_by: ctx.uid, posted_at: u.at })
    const adj = found.length || loss.length ? await createAdjustment(u, ctx, { location_id: st.location_id, reason_code: 'STOCKTAKE', lines: [...found, ...loss], notes: `Stocktake ${st.number}`, stocktake_id: st.id }) : null
    ctx.audit(u, 'inventory.stocktake_posted', { entity_type: 'stocktake', entity_id: st.id, location_id: st.location_id, details: { adjustment: adj?.number ?? null } })
    return { status: 'POSTED', adjustment_number: adj?.number ?? null, adjustment_status: adj?.status ?? null }
  })
})
route('POST', '/inventory/stocktakes/:id/cancel', async ({ params }, ctx) => {
  ctx.require('inventory.stocktake')
  await getSt(ctx, params.id)
  return tx(async (u) => {
    const st = await u.need(`stocktakes/${params.id}`, 'Stocktake')
    if (st.status !== 'OPEN') throw Conflict('Only open stocktakes can be cancelled')
    await u.update(`stocktakes/${st.id}`, { status: 'CANCELLED' })
    ctx.audit(u, 'inventory.stocktake_cancelled', { entity_type: 'stocktake', entity_id: st.id, location_id: st.location_id })
    return { status: 'CANCELLED' }
  })
})

// ---------------------------------------------------------------- copies & labels
async function copyOut(c: Row, cost: boolean) {
  const book = (await entries('books')).get(c.book_id)
  const loc = await byId('locations', c.location_id)
  return { id: c.id, copy_code: c.copy_code, book_id: c.book_id, title: book?.title ?? '', sku: book?.sku ?? '', location_id: c.location_id, location_name: loc?.name ?? '', status: c.status, condition: c.condition,
    acquisition_cost: cost ? c.acquisition_cost : null, selling_price: book?.selling_price ?? '0.00', notes: c.notes ?? null, created_at: c.created_at }
}
route('GET', '/copies', async ({ query }, ctx) => {
  ctx.require('inventory.view')
  if (query.location_id) ctx.ensureLocation(query.location_id)
  const cs = []
  if (query.book_id) cs.push(where('book_id', '==', query.book_id))
  if (query.status) cs.push(where('status', '==', query.status))
  const books = await entries('books')
  const rows = (await findScoped('copies', query.location_id ? [query.location_id] : ctx.scope(), 'location_id', ...cs, limit(5000)))
    .filter((c) => !query.q || matches(query.q, c.copy_code, books.get(c.book_id)?.title)).sort((a, b) => String(a.copy_code).localeCompare(String(b.copy_code)))
  const page = paginate(rows, Number(query.page), Number(query.page_size))
  const cost = canSeeCost(ctx)
  return { ...page, items: await Promise.all(page.items.map((c) => copyOut(c, cost))) }
})
route('GET', '/copies/:id', async ({ params }, ctx) => {
  ctx.require('inventory.view')
  const c = await getOne(`copies/${params.id}`)
  if (!c) throw NotFound('Copy not found')
  ctx.ensureResource(c.location_id)
  const locs = new Map((await all('locations')).map((l) => [l.id, l.name]))
  return {
    copy: await copyOut(c, canSeeCost(ctx)),
    events: ((c.events ?? []) as Row[]).map((e) => ({ event_type: e.event_type, from_location: locs.get(e.from_location_id) ?? null, to_location: locs.get(e.to_location_id) ?? null, from_status: e.from_status, to_status: e.to_status, condition: e.condition, ref_type: e.ref_type, ref_id: e.ref_id, note: e.note, actor: e.actor, created_at: e.created_at })),
  }
})
route('POST', '/copies/:id/condition', async ({ params, body }, ctx) => {
  ctx.require('inventory.copies')
  const condition = String(body.condition ?? '')
  if (!['NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED'].includes(condition)) throw ValidationFailed('Invalid condition')
  if (condition === 'DAMAGED') throw ValidationFailed('Use a stock adjustment (DAMAGE) to move a copy to damaged stock')
  return tx(async (u) => {
    const c = await u.get(`copies/${params.id}`)
    if (!c) throw NotFound('Copy not found')
    ctx.ensureResource(c.location_id)
    if (!['AVAILABLE', 'QUARANTINED', 'DAMAGED'].includes(c.status)) throw Conflict(`Cannot change condition of a copy that is ${String(c.status).toLowerCase()}`)
    await moveCopy(u, c, { event: 'CONDITION', to_status: c.status, ref: { type: 'COPY', id: c.id, number: c.copy_code }, actor: ctx, condition, note: clean(body.note) })
    ctx.audit(u, 'inventory.copy_condition', { entity_type: 'copy', entity_id: c.id, location_id: c.location_id, details: { condition, note: clean(body.note) } })
    return { message: 'Condition updated' }
  })
})
route('POST', '/labels', async ({ body }, ctx) => {
  ctx.requireAny('inventory.copies', 'catalog.view')
  const out: Record<string, unknown>[] = []
  const books = await entries('books')
  const copyIds = ((body.copy_ids ?? []) as string[]).slice(0, 500)
  const bookIds = ((body.book_ids ?? []) as string[]).slice(0, 500)
  if (copyIds.length) {
    ctx.require('inventory.copies')
    for (const id of copyIds) {
      const c = await getOne(`copies/${id}`)
      const b = c && books.get(c.book_id)
      if (c && b && ctx.canAccess(c.location_id)) out.push({ code: c.copy_code, symbology: 'CODE128', title: b.title, sku: b.sku, price: b.selling_price, mrp: b.mrp })
    }
  }
  if (bookIds.length) {
    let bals: Map<string, Bal> | null = null
    if (body.location_id) {
      ctx.ensureLocation(String(body.location_id))
      bals = await balancesAt(String(body.location_id))
    }
    for (const id of bookIds) {
      const b = books.get(id)
      if (!b) continue
      out.push({ code: b.barcode, symbology: /^\d{13}$/.test(b.barcode) ? 'EAN13' : 'CODE128', title: b.title, sku: b.sku, price: bals?.get(id)?.price_override ?? b.selling_price, mrp: b.mrp })
    }
  }
  return out
})
