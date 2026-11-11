/**
 * Stock transfers: DRAFT -> REQUESTED -> APPROVED (reserved at source) -> IN_TRANSIT (out of source, in transit at
 * destination) -> PARTIALLY_RECEIVED -> COMPLETED, or DISCREPANCY -> resolved (LOST / RETURN) -> COMPLETED.
 * Each transition is one transaction on the transfer document, so double dispatch or receipt is impossible.
 */
import { limit, orderBy } from 'firebase/firestore'
import { cancelPending, createApproval, decide, pendingFor, registerApproval } from './approvals'
import type { Ctx } from './ctx'
import { Conflict, D, Forbidden, NotFound, ValidationFailed, ZERO, clean, fieldError, int, matches, newId, paginate, r2 } from './core'
import { post, type Leg } from './ledger'
import { route } from './router'
import { getPolicy } from './settings'
import { StockTx, moveCopy, pickCopies } from './stock'
import { byId, entries, findScoped, getOne, tx, type Row, type Uow } from './store'

const outstanding = (l: Row) => l.qty_dispatched - l.qty_received - l.qty_damaged - l.qty_lost - l.qty_returned

async function lines(input: Record<string, unknown>[], prefix: string): Promise<Row[]> {
  if (!input?.length) throw ValidationFailed('At least one line is required')
  const books = await entries('books')
  const seen = new Set<string>()
  return input.map((l, i) => {
    const b = books.get(String(l.book_id))
    if (!b) throw ValidationFailed('Book not found')
    if (seen.has(b.id)) throw ValidationFailed(`'${b.title}' appears more than once`)
    seen.add(b.id)
    const qty = int(l.qty)
    if (qty <= 0 || qty > 100000) throw ValidationFailed('Quantity must be positive')
    return { id: `${prefix}-${i + 1}`, line_no: i + 1, book_id: b.id, qty_requested: qty, qty_dispatched: 0, qty_received: 0, qty_damaged: 0, qty_lost: 0, qty_returned: 0, unit_cost: null, copies: [] } as unknown as Row
  })
}
async function getT(ctx: Ctx, id: string): Promise<Row> {
  const t = await getOne(`transfers/${id}`)
  if (!t) throw NotFound('Transfer not found')
  ctx.ensureResource(t.source_location_id, t.dest_location_id)
  return t
}
const ref = (t: Row) => ({ type: 'TRANSFER', id: t.id, number: t.number })

async function request(u: Uow, ctx: Ctx, t: Row): Promise<Row> {
  if (t.status !== 'DRAFT') throw Conflict('Only draft transfers can be submitted')
  const next = { ...t, status: 'REQUESTED', requested_at: u.at }
  await u.update(`transfers/${t.id}`, { status: 'REQUESTED', requested_at: u.at })
  if ((await getPolicy()).transfer_requires_approval && !(ctx.has('transfers.approve') && ctx.canAccess(t.source_location_id))) {
    const [src, dst] = [await byId('locations', t.source_location_id), await byId('locations', t.dest_location_id)]
    createApproval(u, ctx, { type: 'TRANSFER', location_id: t.source_location_id, title: `Transfer ${t.number}: ${src?.name} → ${dst?.name}`, entity_type: 'stock_transfer', entity_id: t.id,
      payload: { lines: (t.lines as Row[]).length, units: (t.lines as Row[]).reduce((a, l) => a + l.qty_requested, 0) } })
    return next
  }
  return approve(u, ctx, next)
}
async function approve(u: Uow, ctx: Ctx, t: Row): Promise<Row> {
  if (t.status !== 'REQUESTED') throw Conflict('Transfer is not awaiting approval')
  const st = new StockTx(u, { uid: ctx.uid, name: ctx.name })
  const books = await entries('books')
  for (const l of t.lines as Row[]) {
    const b = await st.bal(t.source_location_id, l.book_id)
    if (b.on_hand - b.reserved < l.qty_requested) throw Conflict(`Insufficient available stock at source for '${books.get(l.book_id)?.title}': available ${b.on_hand - b.reserved}, requested ${l.qty_requested}`, { code: 'insufficient_stock' })
    await st.apply(b, { bucket: 'RESERVED', delta: l.qty_requested, movement_type: 'TRANSFER_RESERVE', ref: ref(t) })
  }
  await st.commit()
  const patch = { status: 'APPROVED', approved_by: ctx.uid, approved_at: u.at }
  await u.update(`transfers/${t.id}`, patch)
  return { ...t, ...patch }
}
registerApproval('TRANSFER', async (u, ctx, req) => {
  const t = await u.need(`transfers/${req.entity_id}`, 'Transfer')
  await approve(u, ctx, t)
}, async (u, _ctx, req) => {
  const t = await u.get(`transfers/${req.entity_id}`)
  if (t && t.status === 'REQUESTED') await u.update(`transfers/${t.id}`, { status: 'REJECTED', rejection_reason: req.decision_note ?? null })
})

async function out(ctx: Ctx, t: Row, detail = true) {
  const books = await entries('books')
  const [src, dst] = [await byId('locations', t.source_location_id), await byId('locations', t.dest_location_id)]
  const cost = ctx.has('reports.financial') || ctx.has('purchasing.view')
  const pending = t.status === 'REQUESTED' ? await pendingFor('stock_transfer', t.id) : null
  const srcOk = ctx.canAccess(t.source_location_id), dstOk = ctx.canAccess(t.dest_location_id)
  return {
    id: t.id, number: t.number, source_location_id: t.source_location_id, source_location_name: src?.name ?? '', dest_location_id: t.dest_location_id, dest_location_name: dst?.name ?? '', status: t.status, notes: t.notes,
    created_by_name: t.created_by_name, created_at: t.created_at, requested_at: t.requested_at ?? null, approved_at: t.approved_at ?? null, dispatched_at: t.dispatched_at ?? null, completed_at: t.completed_at ?? null,
    rejection_reason: t.rejection_reason ?? null, total_units: (t.lines as Row[]).reduce((a, l) => a + l.qty_requested, 0),
    lines: (t.lines as Row[]).map((l) => {
      const b = books.get(l.book_id)
      return { id: l.id, book_id: l.book_id, title: b?.title ?? '', sku: b?.sku ?? '', isbn13: b?.isbn13 ?? null, tracking_mode: b?.tracking_mode ?? 'QUANTITY', qty_requested: l.qty_requested, qty_dispatched: l.qty_dispatched,
        qty_received: l.qty_received, qty_damaged: l.qty_damaged, qty_lost: l.qty_lost, qty_returned: l.qty_returned, qty_outstanding: outstanding(l), unit_cost: cost ? l.unit_cost : null, copies: detail ? (l.copies ?? []) : [] }
    }),
    receipts: detail ? (t.receipts ?? []) : [], approval_request_id: pending?.id ?? null,
    can: {
      edit: t.status === 'DRAFT' && ctx.has('transfers.create'), submit: t.status === 'DRAFT' && ctx.has('transfers.create'),
      approve: t.status === 'REQUESTED' && ctx.has('transfers.approve') && srcOk && (!pending || pending.requested_by !== ctx.uid),
      dispatch: t.status === 'APPROVED' && ctx.has('transfers.dispatch') && srcOk, receive: ['IN_TRANSIT', 'PARTIALLY_RECEIVED'].includes(t.status) && ctx.has('transfers.receive') && dstOk,
      resolve: ['DISCREPANCY', 'PARTIALLY_RECEIVED'].includes(t.status) && (ctx.has('transfers.approve') || ctx.has('inventory.approve')),
      cancel: ['DRAFT', 'REQUESTED', 'APPROVED'].includes(t.status) && ctx.has('transfers.create'), delete: t.status === 'DRAFT' && ctx.has('transfers.create'),
    },
  }
}

route('GET', '/transfers', async ({ query }, ctx) => {
  ctx.require('transfers.view')
  if (query.location_id) ctx.ensureLocation(query.location_id)
  const statuses = query.status ? query.status.split(',') : null
  const rows = (await findScoped('transfers', query.location_id ? [query.location_id] : ctx.scope(), 'location_ids', orderBy('created_at', 'desc'), limit(2000)))
    .filter((t) => (!statuses || statuses.includes(t.status)) && (!query.q || matches(query.q, t.number))
      && (!query.location_id || (query.direction === 'IN' ? t.dest_location_id === query.location_id : query.direction === 'OUT' ? t.source_location_id === query.location_id : true)))
  const page = paginate(rows, Number(query.page), Number(query.page_size))
  return { ...page, items: await Promise.all(page.items.map((t) => out(ctx, t, false))) }
})
route('POST', '/transfers', async ({ body }, ctx) => {
  ctx.require('transfers.create')
  const src = String(body.source_location_id ?? ''), dst = String(body.dest_location_id ?? '')
  if (src === dst) throw ValidationFailed('Source and destination must differ')
  if (!(ctx.canAccess(src) || ctx.canAccess(dst))) throw Forbidden('You must belong to the source or destination location', { code: 'location_denied' })
  for (const id of [src, dst]) {
    const l = await byId('locations', id)
    if (!l || !l.is_active) throw ValidationFailed('Location not found or inactive')
  }
  const id = newId()
  const ls = await lines(body.lines, id)
  const t = await tx(async (u) => {
    const doc: Row = { id, number: await u.nextNumber('TRF'), source_location_id: src, dest_location_id: dst, location_ids: [src, dst], status: 'DRAFT', notes: clean(body.notes), created_by: ctx.uid, created_by_name: ctx.name, created_at: u.at,
      requested_at: null, approved_at: null, approved_by: null, dispatched_at: null, dispatched_by: null, completed_at: null, rejection_reason: null, lines: ls, receipts: [] }
    u.set(`transfers/${id}`, doc)
    ctx.audit(u, 'transfers.created', { entity_type: 'stock_transfer', entity_id: id, location_id: dst, details: { number: doc.number } })
    return body.submit ? request(u, ctx, doc) : doc
  })
  return out(ctx, t)
})
route('GET', '/transfers/:id', async ({ params }, ctx) => {
  ctx.require('transfers.view')
  return out(ctx, await getT(ctx, params.id))
})
route('PUT', '/transfers/:id', async ({ params, body }, ctx) => {
  ctx.require('transfers.create')
  await getT(ctx, params.id)
  const ls = await lines(body.lines, params.id)
  const t = await tx(async (u) => {
    const cur = await u.need(`transfers/${params.id}`, 'Transfer')
    if (cur.status !== 'DRAFT') throw Conflict('Only draft transfers can be edited')
    await u.update(`transfers/${cur.id}`, { lines: ls, notes: clean(body.notes) })
    const next = { ...cur, lines: ls, notes: clean(body.notes) }
    return body.submit ? request(u, ctx, next) : next
  })
  return out(ctx, t)
})
route('DELETE', '/transfers/:id', async ({ params }, ctx) => {
  ctx.require('transfers.create')
  await getT(ctx, params.id)
  await tx(async (u) => {
    const t = await u.need(`transfers/${params.id}`, 'Transfer')
    if (t.status !== 'DRAFT') throw Conflict('Only draft transfers can be deleted; cancel submitted transfers instead')
    u.delete(`transfers/${t.id}`)
    ctx.audit(u, 'transfers.deleted', { entity_type: 'stock_transfer', entity_id: t.id, location_id: t.source_location_id, details: { number: t.number } })
  })
  return undefined
})
route('POST', '/transfers/:id/submit', async ({ params }, ctx) => {
  ctx.require('transfers.create')
  await getT(ctx, params.id)
  const t = await tx(async (u) => {
    const r = await request(u, ctx, await u.need(`transfers/${params.id}`, 'Transfer'))
    ctx.audit(u, 'transfers.requested', { entity_type: 'stock_transfer', entity_id: r.id, location_id: r.source_location_id })
    return r
  })
  return out(ctx, t)
})
route('POST', '/transfers/:id/decision', async ({ params, body }, ctx) => {
  ctx.require('transfers.approve')
  const t = await getT(ctx, params.id)
  ctx.ensureLocation(t.source_location_id)
  const req = await pendingFor('stock_transfer', t.id)
  if (!req) throw Conflict('No pending approval for this transfer')
  await tx((u) => decide(u, ctx, req.id, !!body.approve, clean(body.note)))
  return out(ctx, await getT(ctx, params.id))
})
route('POST', '/transfers/:id/dispatch', async ({ params, body }, ctx) => {
  ctx.require('transfers.dispatch')
  await getT(ctx, params.id)
  const books = await entries('books')
  const t = await tx(async (u) => {
    const t = await u.need(`transfers/${params.id}`, 'Transfer')
    if (!ctx.canAccess(t.source_location_id)) throw Forbidden('Only the source location can dispatch', { code: 'location_denied' })
    if (t.status !== 'APPROVED') throw Conflict('Transfer must be approved (and not yet dispatched) to dispatch')
    const spec = new Map(((body.lines ?? []) as Row[]).map((l) => [String(l.line_id), l]))
    const st = new StockTx(u, { uid: ctx.uid, name: ctx.name })
    let value = ZERO
    const ls = (t.lines as Row[]).map((l) => ({ ...l }))
    for (const l of ls) {
      const s = spec.get(l.id)
      const qty = s ? int(s.qty) : l.qty_requested
      const book = books.get(l.book_id)!
      if (qty < 0 || qty > l.qty_requested) throw ValidationFailed(`Dispatch quantity for '${book.title}' must be between 0 and ${l.qty_requested}`)
      const src = await st.bal(t.source_location_id, l.book_id)
      const dst = await st.bal(t.dest_location_id, l.book_id)
      await st.apply(src, { bucket: 'RESERVED', delta: -l.qty_requested, movement_type: 'TRANSFER_UNRESERVE', ref: ref(t) })
      l.qty_dispatched = qty
      l.unit_cost = src.avg_cost
      if (!qty) continue
      if (book.tracking_mode === 'COPY') {
        const copies = await pickCopies(u, { book_id: l.book_id, location_id: t.source_location_id, qty, copy_ids: (s?.copy_ids as string[]) || null })
        for (const c of copies) {
          await st.apply(src, { bucket: 'ON_HAND', delta: -1, movement_type: 'TRANSFER_OUT', ref: ref(t), unit_cost: src.avg_cost, copy_id: c.id, check_available: true })
          await st.apply(dst, { bucket: 'IN_TRANSIT', delta: 1, movement_type: 'TRANSFER_IN_TRANSIT', ref: ref(t), unit_cost: src.avg_cost, copy_id: c.id })
          await moveCopy(u, c, { event: 'TRANSFER_DISPATCHED', to_status: 'IN_TRANSIT', ref: ref(t), actor: ctx, to_location_id: t.dest_location_id })
          l.copies = [...(l.copies ?? []), { copy_id: c.id, copy_code: c.copy_code, state: 'DISPATCHED' }]
        }
      } else {
        await st.apply(src, { bucket: 'ON_HAND', delta: -qty, movement_type: 'TRANSFER_OUT', ref: ref(t), unit_cost: src.avg_cost, check_available: true })
        await st.apply(dst, { bucket: 'IN_TRANSIT', delta: qty, movement_type: 'TRANSFER_IN_TRANSIT', ref: ref(t), unit_cost: src.avg_cost })
      }
      value = value.plus(r2(D(qty).times(D(src.avg_cost))))
    }
    if (!ls.reduce((a, l) => a + l.qty_dispatched, 0)) throw ValidationFailed('Nothing to dispatch')
    await st.commit()
    await post(u, { source_type: 'TRANSFER_DISPATCH', source_id: t.id, actor_id: ctx.uid, memo: `Transfer ${t.number} dispatched`, legs: [{ account: 'INVENTORY', amount: value, location_id: t.dest_location_id }, { account: 'INVENTORY', amount: value.neg(), location_id: t.source_location_id }] })
    const patch = { lines: ls, status: 'IN_TRANSIT', dispatched_by: ctx.uid, dispatched_at: u.at }
    await u.update(`transfers/${t.id}`, patch)
    ctx.audit(u, 'transfers.dispatched', { entity_type: 'stock_transfer', entity_id: t.id, location_id: t.source_location_id, details: { units: ls.reduce((a, l) => a + l.qty_dispatched, 0) } })
    return { ...t, ...patch }
  })
  return out(ctx, t)
})
route('POST', '/transfers/:id/receive', async ({ params, body, headers }, ctx) => {
  ctx.require('transfers.receive')
  const key = String(headers['Idempotency-Key'] ?? '')
  if (key.length < 8) throw fieldError('idempotency-key', 'Idempotency-Key header is required')
  await getT(ctx, params.id)
  const books = await entries('books')
  const t = await tx(async (u) => {
    const t = await u.need(`transfers/${params.id}`, 'Transfer')
    const prior = await u.get(`idempotency/trf~${key}`)
    if (prior) {
      if (prior.id !== t.id) throw Conflict('Idempotency key already used for another transfer')
      return t
    }
    if (!ctx.canAccess(t.dest_location_id)) throw Forbidden('Only the destination location can receive', { code: 'location_denied' })
    if (!['IN_TRANSIT', 'PARTIALLY_RECEIVED'].includes(t.status)) throw Conflict('Transfer is not awaiting receipt')
    const spec = new Map(((body.lines ?? []) as Row[]).map((l) => [String(l.line_id), l]))
    const st = new StockTx(u, { uid: ctx.uid, name: ctx.name })
    const r = ref(t)
    const ls = (t.lines as Row[]).map((l) => ({ ...l, copies: [...(l.copies ?? [])] }) as Row)
    const details: Row[] = []
    for (const l of ls) {
      const s = spec.get(l.id)
      if (!s) continue
      const good = int(s.qty_received ?? 0), bad = int(s.qty_damaged ?? 0)
      if (good < 0 || bad < 0) throw ValidationFailed('Quantities cannot be negative')
      if (good + bad === 0) continue
      const book = books.get(l.book_id)!
      if (good + bad > outstanding(l)) throw Conflict(`'${book.title}': receiving ${good + bad} but only ${outstanding(l)} outstanding`)
      const bal = await st.bal(t.dest_location_id, l.book_id)
      st.receiveCost(bal, good + bad, l.unit_cost)
      if (book.tracking_mode === 'COPY') {
        const pending = (l.copies as Row[]).filter((c) => c.state === 'DISPATCHED')
        let wantGood = (s.copy_ids_received ?? []) as string[], wantBad = (s.copy_ids_damaged ?? []) as string[]
        const pend = new Set(pending.map((c) => c.copy_id))
        if (wantGood.length || wantBad.length) {
          const all = [...wantGood, ...wantBad]
          if (wantGood.length !== good || wantBad.length !== bad || !all.every((c) => pend.has(c)) || new Set(all).size !== good + bad) throw ValidationFailed(`'${book.title}': scanned copies do not match the dispatched copies`)
        } else {
          const ordered = [...pending].sort((a, b) => String(a.copy_id).localeCompare(String(b.copy_id)))
          wantGood = ordered.slice(0, good).map((c) => c.copy_id)
          wantBad = ordered.slice(good, good + bad).map((c) => c.copy_id)
        }
        for (const lc of l.copies as Row[]) {
          const state = wantGood.includes(lc.copy_id) ? 'RECEIVED' : wantBad.includes(lc.copy_id) ? 'DAMAGED' : null
          if (!state || lc.state !== 'DISPATCHED') continue
          const c = await u.need(`copies/${lc.copy_id}`, 'Copy')
          const target = state === 'RECEIVED' ? 'ON_HAND' : 'DAMAGED'
          await st.apply(bal, { bucket: 'IN_TRANSIT', delta: -1, movement_type: 'TRANSFER_IN', ref: r, unit_cost: l.unit_cost, copy_id: c.id })
          await st.apply(bal, { bucket: target, delta: 1, movement_type: 'TRANSFER_IN', ref: r, unit_cost: l.unit_cost, copy_id: c.id })
          await moveCopy(u, c, { event: 'TRANSFER_RECEIVED', to_status: target === 'ON_HAND' ? 'AVAILABLE' : 'DAMAGED', ref: r, actor: ctx, condition: target === 'DAMAGED' ? 'DAMAGED' : null })
          lc.state = state
        }
      } else {
        await st.apply(bal, { bucket: 'IN_TRANSIT', delta: -(good + bad), movement_type: 'TRANSFER_IN', ref: r, unit_cost: l.unit_cost })
        if (good) await st.apply(bal, { bucket: 'ON_HAND', delta: good, movement_type: 'TRANSFER_IN', ref: r, unit_cost: l.unit_cost })
        if (bad) await st.apply(bal, { bucket: 'DAMAGED', delta: bad, movement_type: 'TRANSFER_IN_DAMAGED', ref: r, unit_cost: l.unit_cost, note: 'Damaged in transit' })
      }
      l.qty_received += good
      l.qty_damaged += bad
      details.push({ line_id: l.id, book_id: l.book_id, received: good, damaged: bad } as unknown as Row)
    }
    if (!details.length) throw ValidationFailed('Nothing received')
    await st.commit()
    const left = ls.reduce((a, l) => a + outstanding(l), 0)
    const status = left === 0 ? 'COMPLETED' : body.final ? 'DISCREPANCY' : 'PARTIALLY_RECEIVED'
    const receipts = [...(t.receipts ?? []), { id: newId(), kind: 'RECEIPT', received_by: ctx.name, received_at: u.at, notes: clean(body.notes), details: { lines: details } }]
    const patch = { lines: ls, status, completed_at: left === 0 ? u.at : null, receipts }
    await u.update(`transfers/${t.id}`, patch)
    u.set(`idempotency/trf~${key}`, { id: t.id, created_at: u.at })
    ctx.audit(u, 'transfers.received', { entity_type: 'stock_transfer', entity_id: t.id, location_id: t.dest_location_id, details: { status } })
    return { ...t, ...patch }
  })
  return out(ctx, t)
})
route('POST', '/transfers/:id/resolve', async ({ params, body, headers }, ctx) => {
  ctx.require('transfers.view')
  const key = String(headers['Idempotency-Key'] ?? '')
  if (key.length < 8) throw fieldError('idempotency-key', 'Idempotency-Key header is required')
  await getT(ctx, params.id)
  const t = await tx(async (u) => {
    const t = await u.need(`transfers/${params.id}`, 'Transfer')
    if (await u.get(`idempotency/trf~${key}`)) return t
    if (!['DISCREPANCY', 'PARTIALLY_RECEIVED', 'IN_TRANSIT'].includes(t.status)) throw Conflict('Transfer has no outstanding quantities to resolve')
    if (!(ctx.has('transfers.approve') || ctx.has('inventory.approve'))) throw Forbidden('Resolving discrepancies requires transfer or inventory approval permission')
    const spec = new Map(((body.lines ?? []) as Row[]).map((l) => [String(l.line_id), String(l.action)]))
    const st = new StockTx(u, { uid: ctx.uid, name: ctx.name })
    const r = ref(t)
    let lost = ZERO, returned = ZERO
    const ls = (t.lines as Row[]).map((l) => ({ ...l, copies: [...(l.copies ?? [])] }) as Row)
    for (const l of ls) {
      const action = spec.get(l.id)
      const qty = outstanding(l)
      if (!action || !qty) continue
      const dst = await st.bal(t.dest_location_id, l.book_id), src = await st.bal(t.source_location_id, l.book_id)
      const copies = (l.copies as Row[]).filter((c) => c.state === 'DISPATCHED')
      if (action === 'LOST') {
        for (const lc of copies) {
          const c = await u.need(`copies/${lc.copy_id}`, 'Copy')
          await st.apply(dst, { bucket: 'IN_TRANSIT', delta: -1, movement_type: 'TRANSFER_LOSS', ref: r, unit_cost: l.unit_cost, copy_id: c.id })
          await moveCopy(u, c, { event: 'TRANSFER_LOST', to_status: 'LOST', ref: r, actor: ctx })
          lc.state = 'LOST'
        }
        if (!copies.length) await st.apply(dst, { bucket: 'IN_TRANSIT', delta: -qty, movement_type: 'TRANSFER_LOSS', ref: r, unit_cost: l.unit_cost })
        l.qty_lost += qty
        lost = lost.plus(r2(D(qty).times(D(l.unit_cost))))
      } else if (action === 'RETURN') {
        st.receiveCost(src, qty, l.unit_cost)
        for (const lc of copies) {
          const c = await u.need(`copies/${lc.copy_id}`, 'Copy')
          await st.apply(dst, { bucket: 'IN_TRANSIT', delta: -1, movement_type: 'TRANSFER_RETURN', ref: r, unit_cost: l.unit_cost, copy_id: c.id })
          await st.apply(src, { bucket: 'ON_HAND', delta: 1, movement_type: 'TRANSFER_RETURN', ref: r, unit_cost: l.unit_cost, copy_id: c.id })
          await moveCopy(u, c, { event: 'TRANSFER_RETURNED', to_status: 'AVAILABLE', ref: r, actor: ctx, to_location_id: t.source_location_id })
          lc.state = 'RETURNED'
        }
        if (!copies.length) {
          await st.apply(dst, { bucket: 'IN_TRANSIT', delta: -qty, movement_type: 'TRANSFER_RETURN', ref: r, unit_cost: l.unit_cost })
          await st.apply(src, { bucket: 'ON_HAND', delta: qty, movement_type: 'TRANSFER_RETURN', ref: r, unit_cost: l.unit_cost })
        }
        l.qty_returned += qty
        returned = returned.plus(r2(D(qty).times(D(l.unit_cost))))
      } else throw ValidationFailed('Action must be LOST or RETURN')
    }
    if (ls.some((l) => outstanding(l))) throw ValidationFailed('Resolve every outstanding line')
    await st.commit()
    const legs: Leg[] = []
    if (!lost.eq(0)) legs.push({ account: 'INVENTORY_ADJ', amount: lost, location_id: t.dest_location_id }, { account: 'INVENTORY', amount: lost.neg(), location_id: t.dest_location_id })
    if (!returned.eq(0)) legs.push({ account: 'INVENTORY', amount: returned, location_id: t.source_location_id }, { account: 'INVENTORY', amount: returned.neg(), location_id: t.dest_location_id })
    await post(u, { source_type: 'TRANSFER_RESOLUTION', source_id: t.id, actor_id: ctx.uid, memo: `Transfer ${t.number} discrepancy resolved`, legs })
    const receipts = [...(t.receipts ?? []), { id: newId(), kind: 'RESOLUTION', received_by: ctx.name, received_at: u.at, notes: clean(body.notes), details: { lines: body.lines } }]
    const patch = { lines: ls, status: 'COMPLETED', completed_at: u.at, receipts }
    await u.update(`transfers/${t.id}`, patch)
    u.set(`idempotency/trf~${key}`, { id: t.id, created_at: u.at })
    ctx.audit(u, 'transfers.resolved', { entity_type: 'stock_transfer', entity_id: t.id, location_id: t.dest_location_id, details: { lost_value: lost.toFixed(2), returned_value: returned.toFixed(2) } })
    return { ...t, ...patch }
  })
  return out(ctx, t)
})
route('POST', '/transfers/:id/cancel', async ({ params, body }, ctx) => {
  ctx.require('transfers.create')
  const reason = String(body.reason ?? '')
  if (reason.length < 3) throw fieldError('reason', 'String should have at least 3 characters')
  await getT(ctx, params.id)
  const t = await tx(async (u) => {
    const t = await u.need(`transfers/${params.id}`, 'Transfer')
    if (!['DRAFT', 'REQUESTED', 'APPROVED'].includes(t.status)) throw Conflict('Only transfers that have not been dispatched can be cancelled')
    if (t.status === 'APPROVED') {
      const st = new StockTx(u, { uid: ctx.uid, name: ctx.name })
      for (const l of t.lines as Row[]) await st.apply(await st.bal(t.source_location_id, l.book_id), { bucket: 'RESERVED', delta: -l.qty_requested, movement_type: 'TRANSFER_UNRESERVE', ref: ref(t) })
      await st.commit()
    }
    await cancelPending(u, 'stock_transfer', t.id)
    await u.update(`transfers/${t.id}`, { status: 'CANCELLED', rejection_reason: reason })
    ctx.audit(u, 'transfers.cancelled', { entity_type: 'stock_transfer', entity_id: t.id, location_id: t.source_location_id, details: { reason } })
    return { ...t, status: 'CANCELLED', rejection_reason: reason }
  })
  return out(ctx, t)
})
