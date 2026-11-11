/** Suppliers, purchase orders, goods receipts (landed cost), supplier invoices, supplier payments, supplier returns. */
import { limit, orderBy, where } from 'firebase/firestore'
import { cancelPending, createApproval, decide, pendingFor, registerApproval } from './approvals'
import { canSeeCost } from './catalog'
import type { Ctx } from './ctx'
import { Conflict, D, NotFound, ValidationFailed, ZERO, addDays, clean, fieldError, int, localDate, matches, newId, paginate, r2, r4, s2, s4, sum, type Decimal, type Num } from './core'
import { allocate, post, validGstin } from './ledger'
import { route } from './router'
import { getPolicy } from './settings'
import { COPY_STATUS_FOR_BUCKET, StockTx, createCopies, moveCopy, pickCopies, type Bucket } from './stock'
import { all, byId, entries, find, findScoped, getOne, shardPath, tx, type Row, type Uow } from './store'

const payNumber = () => `PAY-${Date.now().toString(36).toUpperCase()}${newId().slice(0, 3).toUpperCase()}`

// ================================================================ suppliers
function supplierIn(b: Record<string, unknown>) {
  const name = clean(b.name) ?? ''
  if (name.length < 2) throw fieldError('name', 'String should have at least 2 characters')
  const email = clean(b.email)?.toLowerCase() ?? null
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fieldError('email', 'value is not a valid email address')
  const gstin = clean(b.gstin)?.toUpperCase() ?? null
  if (gstin && !validGstin(gstin)) throw fieldError('gstin', 'Invalid GSTIN (format or checksum)')
  const pan = clean(b.pan)
  if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) throw fieldError('pan', 'String should match pattern ^[A-Z]{5}\\d{4}[A-Z]$')
  const state = clean(b.state_code)
  if (state && !/^\d{2}$/.test(state)) throw fieldError('state_code', 'String should match pattern ^\\d{2}$')
  const terms = int(b.payment_terms_days ?? 30)
  if (terms < 0 || terms > 365) throw fieldError('payment_terms_days', 'Input should be between 0 and 365')
  if (gstin && state && gstin.slice(0, 2) !== state) throw ValidationFailed('GSTIN state code does not match supplier state')
  return {
    name, contact_person: clean(b.contact_person), phone: clean(b.phone), email, gstin, pan, address_line1: clean(b.address_line1), address_line2: clean(b.address_line2),
    city: clean(b.city), state: clean(b.state), state_code: state ?? (gstin ? gstin.slice(0, 2) : null), pincode: clean(b.pincode), payment_terms_days: terms, notes: clean(b.notes), is_active: b.is_active !== false,
  }
}
async function supplierDues(): Promise<Map<string, [Decimal, Decimal]>> {
  const today = localDate()
  const m = new Map<string, [Decimal, Decimal]>()
  for (const i of (await find('supplier_invoices', limit(10000))).filter((x) => ['OPEN', 'PARTIALLY_PAID'].includes(x.status))) {
    const due = D(i.total).minus(D(i.amount_paid))
    const cur = m.get(i.supplier_id) ?? [ZERO, ZERO]
    m.set(i.supplier_id, [cur[0].plus(due), i.due_date < today ? cur[1].plus(due) : cur[1]])
  }
  return m
}
const supplierOut = (s: Row, dues?: Map<string, [Decimal, Decimal]> | null) => ({
  ...s, email: s.email ?? null, outstanding: dues ? s2(dues.get(s.id)?.[0] ?? 0) : null, overdue: dues ? s2(dues.get(s.id)?.[1] ?? 0) : null,
})
const showMoney = (ctx: Ctx) => ctx.has('finance.view') || ctx.has('purchasing.view')

route('GET', '/suppliers', async ({ query }, ctx) => {
  ctx.require('suppliers.view')
  const dues = showMoney(ctx) ? await supplierDues().catch(() => null) : null
  const rows = (await all('suppliers')).filter((s) => matches(query.q, s.name, s.code, s.gstin, s.phone) && (query.active === undefined || String(!!s.is_active) === query.active))
    .sort((a, b) => a.name.localeCompare(b.name))
  return paginate(rows.map((s) => supplierOut(s, dues)), Number(query.page), Number(query.page_size))
})
export async function createSupplier(u: Uow, ctx: Ctx, v: Record<string, unknown>): Promise<Row> {
  const taken = new Set((await all('suppliers')).map((s) => s.code))
  let code = await u.nextCode('SUPPLIER', 'S', 4)
  while (taken.has(code)) code = await u.nextCode('SUPPLIER', 'S', 4)
  const id = u.add('suppliers', { ...v, code })
  ctx.audit(u, 'purchasing.supplier_created', { entity_type: 'supplier', entity_id: id, details: { name: v.name } })
  return { ...v, code, id, created_at: u.at } as Row
}
route('POST', '/suppliers', async ({ body }, ctx) => {
  ctx.require('suppliers.manage')
  const v = supplierIn(body)
  return tx(async (u) => supplierOut(await createSupplier(u, ctx, v)))
})
route('GET', '/suppliers/:id', async ({ params }, ctx) => {
  ctx.require('suppliers.view')
  const s = await byId('suppliers', params.id)
  if (!s) throw NotFound('Supplier not found')
  return supplierOut(s, showMoney(ctx) ? await supplierDues().catch(() => null) : null)
})
route('PUT', '/suppliers/:id', async ({ params, body }, ctx) => {
  ctx.require('suppliers.manage')
  const s = await byId('suppliers', params.id)
  if (!s) throw NotFound('Supplier not found')
  const v = supplierIn(body)
  return tx(async (u) => {
    await u.update(`suppliers/${s.id}`, v)
    ctx.audit(u, 'purchasing.supplier_updated', { entity_type: 'supplier', entity_id: s.id, details: { before: s, after: v } })
    return supplierOut({ ...s, ...v })
  })
})
route('DELETE', '/suppliers/:id', async ({ params }, ctx) => {
  ctx.require('suppliers.manage')
  const s = await byId('suppliers', params.id)
  if (!s) throw NotFound('Supplier not found')
  const used = (await find('purchase_orders', where('supplier_id', '==', s.id), limit(1))).length || (await find('goods_receipts', where('supplier_id', '==', s.id), limit(1))).length
    || (await all('authors')).some((a) => a.supplier_id === s.id)
  if (used) throw Conflict('This supplier has orders or receipts; deactivate it instead')
  await tx(async (u) => {
    u.delete(`suppliers/${s.id}`)
    ctx.audit(u, 'purchasing.supplier_deleted', { entity_type: 'supplier', entity_id: s.id, details: { name: s.name } })
  })
  return undefined
})
route('GET', '/suppliers/:id/statement', async ({ params }, ctx) => {
  ctx.requireAny('finance.view', 'purchasing.view')
  const s = await byId('suppliers', params.id)
  if (!s) throw NotFound('Supplier not found')
  const scope = ctx.scope()
  const entriesOut: Row[] = []
  for (const si of await findScoped('supplier_invoices', scope, 'location_id', where('supplier_id', '==', s.id))) entriesOut.push({ id: si.id, date: si.invoice_date, type: 'INVOICE', ref: si.invoice_number, credit: si.total, debit: '0.00', status: si.status, due_date: si.due_date } as Row)
  for (const p of (await findScoped('payments', scope, 'location_id', where('supplier_id', '==', s.id)).catch(() => [] as Row[]))) entriesOut.push({ id: p.id, date: p.payment_date, type: 'PAYMENT', ref: p.number, credit: '0.00', debit: p.amount, status: null, due_date: null } as Row)
  for (const r of await findScoped('supplier_returns', scope, 'location_id', where('supplier_id', '==', s.id))) entriesOut.push({ id: r.id, date: localDate(r.created_at), type: 'DEBIT_NOTE', ref: r.number, credit: '0.00', debit: r.value, status: null, due_date: null } as Row)
  entriesOut.sort((a, b) => String(a.date).localeCompare(String(b.date)) || Number(a.type !== 'INVOICE') - Number(b.type !== 'INVOICE'))
  let bal = ZERO
  for (const e of entriesOut) { bal = bal.plus(D(e.credit)).minus(D(e.debit)); e.balance = s2(bal) }
  return { supplier: supplierOut(s), entries: entriesOut, closing_balance: s2(bal) }
})

// ================================================================ purchase orders
function poTotals(lines: Row[]) {
  let sub = ZERO, tax = ZERO
  for (const l of lines) {
    const net = r2(D(l.qty_ordered).times(D(l.unit_cost)).times(D(1).minus(D(l.discount_pct).div(100))))
    sub = sub.plus(net)
    tax = tax.plus(r2(net.times(D(l.tax_rate)).div(100)))
  }
  return { subtotal: s2(sub), tax_total: s2(tax), total: s2(sub.plus(tax)) }
}
export async function poLines(lines: Record<string, unknown>[], prefix: string): Promise<Row[]> {
  if (!lines?.length) throw ValidationFailed('A purchase order needs at least one line')
  if (lines.length > 500) throw ValidationFailed('Too many lines')
  const books = await entries('books')
  const seen = new Set<string>()
  return lines.map((l, i) => {
    const book = books.get(String(l.book_id))
    if (!book) throw ValidationFailed('Book not found')
    if (seen.has(book.id)) throw ValidationFailed(`'${book.title}' appears more than once`)
    seen.add(book.id)
    const qty = int(l.qty)
    if (qty <= 0 || qty > 100000) throw ValidationFailed('Quantity must be positive')
    const cost = Number(l.unit_cost)
    if (!(cost >= 0)) throw ValidationFailed('Unit cost cannot be negative')
    const disc = Number(l.discount_pct ?? 0), rate = Number(l.tax_rate ?? 0)
    if (!(disc >= 0 && disc <= 100)) throw ValidationFailed('Discount must be between 0 and 100')
    if (!(rate >= 0 && rate <= 50)) throw ValidationFailed('Tax rate must be between 0 and 50')
    return { id: `${prefix}-${i + 1}`, line_no: i + 1, book_id: book.id, qty_ordered: qty, qty_received: 0, qty_cancelled: 0, unit_cost: s4(cost), discount_pct: s2(disc), tax_rate: s2(rate) } as unknown as Row
  })
}
export function newPoDoc(o: { number: string; supplier: Row; location_id: string; lines: Row[]; ctx: Ctx; at: string; expected_date?: string | null; notes?: string | null; extra?: Record<string, unknown> }) {
  return {
    number: o.number, supplier_id: o.supplier.id, supplier_name: o.supplier.name, location_id: o.location_id, status: 'DRAFT', order_date: localDate(), expected_date: o.expected_date ?? null, notes: o.notes ?? null,
    ...poTotals(o.lines), lines: o.lines, book_ids: o.lines.map((l) => l.book_id), created_by: o.ctx.uid, created_by_name: o.ctx.name, approved_by: null, approved_at: null, issued_at: null, closed_at: null,
    cancel_reason: null, school_order_id: null, school_order_number: null, author_id: null, email_opened_at: null, created_at: o.at, ...(o.extra ?? {}),
  }
}
export async function submitPo(u: Uow, ctx: Ctx, po: Row): Promise<Row> {
  if (po.status !== 'DRAFT') throw Conflict('Only draft purchase orders can be submitted')
  const threshold = D((await getPolicy()).po_approval_threshold)
  let patch: Record<string, unknown>
  if (threshold.gt(0) && D(po.total).gte(threshold) && !ctx.has('purchasing.approve')) {
    patch = { status: 'PENDING_APPROVAL' }
    createApproval(u, ctx, { type: 'PURCHASE_ORDER', location_id: po.location_id, title: `Purchase order ${po.number} — ${po.supplier_name}`, entity_type: 'purchase_order', entity_id: po.id, amount: po.total })
  } else patch = { status: 'APPROVED', approved_by: ctx.uid, approved_at: u.at }
  await u.update(`purchase_orders/${po.id}`, patch)
  return { ...po, ...patch }
}
registerApproval('PURCHASE_ORDER', async (u, ctx, req) => {
  const po = await u.get(`purchase_orders/${req.entity_id}`)
  if (!po || po.status !== 'PENDING_APPROVAL') throw Conflict('Purchase order is not pending approval')
  await u.update(`purchase_orders/${po.id}`, { status: 'APPROVED', approved_by: ctx.uid, approved_at: u.at })
}, async (u, _ctx, req) => {
  const po = await u.get(`purchase_orders/${req.entity_id}`)
  if (po && po.status === 'PENDING_APPROVAL') await u.update(`purchase_orders/${po.id}`, { status: 'DRAFT' })
})

export async function poOut(po: Row, detail = true) {
  const books = await entries('books')
  const loc = await byId('locations', po.location_id)
  const author = po.author_id ? await byId('authors', po.author_id) : null
  const lines = detail ? (po.lines as Row[]).map((l) => {
    const b = books.get(l.book_id)
    return { id: l.id, line_no: l.line_no, book_id: l.book_id, title: b?.title ?? '', sku: b?.sku ?? '', isbn13: b?.isbn13 ?? null, qty_ordered: l.qty_ordered, qty_received: l.qty_received, qty_cancelled: l.qty_cancelled,
      qty_outstanding: l.qty_ordered - l.qty_received - l.qty_cancelled, unit_cost: l.unit_cost, discount_pct: l.discount_pct, tax_rate: l.tax_rate, tracking_mode: b?.tracking_mode ?? 'QUANTITY' }
  }) : []
  const receipts = detail ? (await find('goods_receipts', where('po_id', '==', po.id))).sort((a, b) => String(a.received_at).localeCompare(String(b.received_at)))
    .map((g) => ({ id: g.id, number: g.number, received_at: g.received_at, total_landed: g.total_landed, invoiced: !!g.supplier_invoice_id })) : []
  const pending = po.status === 'PENDING_APPROVAL' ? await pendingFor('purchase_order', po.id) : null
  return {
    id: po.id, number: po.number, supplier_id: po.supplier_id, supplier_name: po.supplier_name, location_id: po.location_id, location_name: loc?.name ?? '', status: po.status, order_date: po.order_date, expected_date: po.expected_date,
    notes: po.notes, subtotal: po.subtotal, tax_total: po.tax_total, total: po.total, created_by_name: po.created_by_name, approved_at: po.approved_at, issued_at: po.issued_at, created_at: po.created_at, lines, receipts,
    approval_request_id: pending?.id ?? null, school_order_id: po.school_order_id ?? null, school_order_number: po.school_order_number ?? null, author_id: po.author_id ?? null,
    author_name: author?.name ?? null, author_email: author?.email ?? null, email_opened_at: po.email_opened_at ?? null,
  }
}
async function getPo(ctx: Ctx, id: string): Promise<Row> {
  const po = await getOne(`purchase_orders/${id}`)
  if (!po) throw NotFound('Purchase order not found')
  ctx.ensureResource(po.location_id)
  return po
}

route('GET', '/purchase-orders', async ({ query }, ctx) => {
  ctx.require('purchasing.view')
  if (query.location_id) ctx.ensureLocation(query.location_id)
  const statuses = query.status ? query.status.split(',') : null
  const rows = (await findScoped('purchase_orders', query.location_id ? [query.location_id] : ctx.scope(), 'location_id', orderBy('created_at', 'desc'), limit(2000)))
    .filter((p) => (!statuses || statuses.includes(p.status)) && (!query.supplier_id || p.supplier_id === query.supplier_id) && (!query.q || matches(query.q, p.number)))
  const page = paginate(rows, Number(query.page), Number(query.page_size))
  return { ...page, items: await Promise.all(page.items.map((p) => poOut(p, false))) }
})
route('POST', '/purchase-orders', async ({ body }, ctx) => {
  ctx.require('purchasing.create')
  const loc = String(body.location_id ?? '')
  ctx.ensureLocation(loc)
  const sup = await byId('suppliers', String(body.supplier_id ?? ''))
  if (!sup || !sup.is_active) throw ValidationFailed('Supplier not found or inactive')
  const id = newId()
  const lines = await poLines(body.lines, id)
  const po = await tx(async (u) => {
    const doc = newPoDoc({ number: await u.nextNumber('PO'), supplier: sup, location_id: loc, lines, ctx, at: u.at, expected_date: clean(body.expected_date), notes: clean(body.notes) })
    u.set(`purchase_orders/${id}`, doc)
    ctx.audit(u, 'purchasing.po_created', { entity_type: 'purchase_order', entity_id: id, location_id: loc, details: { number: doc.number, total: doc.total } })
    return { ...doc, id }
  })
  return poOut(po)
})
route('GET', '/purchase-orders/:id', async ({ params }, ctx) => {
  ctx.require('purchasing.view')
  return poOut(await getPo(ctx, params.id))
})
route('PUT', '/purchase-orders/:id', async ({ params, body }, ctx) => {
  ctx.require('purchasing.create')
  await getPo(ctx, params.id)
  const loc = String(body.location_id ?? '')
  ctx.ensureLocation(loc)
  const sup = await byId('suppliers', String(body.supplier_id ?? ''))
  if (!sup) throw ValidationFailed('Supplier not found or inactive')
  const lines = await poLines(body.lines, params.id)
  const po = await tx(async (u) => {
    const cur = await u.need(`purchase_orders/${params.id}`, 'Purchase order')
    if (cur.status !== 'DRAFT') throw Conflict('Only draft purchase orders can be edited')
    const patch = { supplier_id: sup.id, supplier_name: sup.name, location_id: loc, expected_date: clean(body.expected_date), notes: clean(body.notes), lines, book_ids: lines.map((l) => l.book_id), ...poTotals(lines) }
    await u.update(`purchase_orders/${cur.id}`, patch)
    ctx.audit(u, 'purchasing.po_updated', { entity_type: 'purchase_order', entity_id: cur.id, location_id: loc })
    return { ...cur, ...patch }
  })
  return poOut(po)
})
route('DELETE', '/purchase-orders/:id', async ({ params }, ctx) => {
  ctx.require('purchasing.create')
  await getPo(ctx, params.id)
  await tx(async (u) => {
    const po = await u.need(`purchase_orders/${params.id}`, 'Purchase order')
    if (po.status !== 'DRAFT') throw Conflict('Only draft purchase orders can be deleted; cancel issued orders instead')
    u.delete(`purchase_orders/${po.id}`)
    ctx.audit(u, 'purchasing.po_deleted', { entity_type: 'purchase_order', entity_id: po.id, location_id: po.location_id, details: { number: po.number } })
  })
  return undefined
})
route('POST', '/purchase-orders/:id/submit', async ({ params }, ctx) => {
  ctx.require('purchasing.create')
  await getPo(ctx, params.id)
  const po = await tx(async (u) => {
    const out = await submitPo(u, ctx, await u.need(`purchase_orders/${params.id}`, 'Purchase order'))
    ctx.audit(u, 'purchasing.po_submitted', { entity_type: 'purchase_order', entity_id: out.id, location_id: out.location_id, details: { status: out.status } })
    return out
  })
  return poOut(po)
})
route('POST', '/purchase-orders/:id/decision', async ({ params, body }, ctx) => {
  ctx.require('purchasing.approve')
  await getPo(ctx, params.id)
  const req = await pendingFor('purchase_order', params.id)
  if (!req) throw Conflict('No pending approval for this purchase order')
  await tx((u) => decide(u, ctx, req.id, !!body.approve, clean(body.note)))
  return poOut(await getPo(ctx, params.id))
})
route('POST', '/purchase-orders/:id/issue', async ({ params }, ctx) => {
  ctx.require('purchasing.create')
  await getPo(ctx, params.id)
  const po = await tx(async (u) => {
    const cur = await u.need(`purchase_orders/${params.id}`, 'Purchase order')
    if (cur.status !== 'APPROVED') throw Conflict('Only approved purchase orders can be issued')
    await u.update(`purchase_orders/${cur.id}`, { status: 'ISSUED', issued_at: u.at })
    ctx.audit(u, 'purchasing.po_issued', { entity_type: 'purchase_order', entity_id: cur.id, location_id: cur.location_id })
    return { ...cur, status: 'ISSUED', issued_at: u.at }
  })
  return poOut(po)
})
route('POST', '/purchase-orders/:id/cancel', async ({ params, body }, ctx) => {
  ctx.require('purchasing.create')
  const reason = String(body.reason ?? '')
  if (reason.length < 3) throw fieldError('reason', 'String should have at least 3 characters')
  await getPo(ctx, params.id)
  const po = await tx(async (u) => {
    const cur = await u.need(`purchase_orders/${params.id}`, 'Purchase order')
    if (['RECEIVED', 'CLOSED', 'CANCELLED'].includes(cur.status)) throw Conflict(`Purchase order is already ${String(cur.status).toLowerCase()}`)
    const received = (cur.lines as Row[]).reduce((a, l) => a + l.qty_received, 0)
    const lines = (cur.lines as Row[]).map((l) => ({ ...l, qty_cancelled: l.qty_cancelled + (l.qty_ordered - l.qty_received - l.qty_cancelled) }))
    const patch = { lines, status: received ? 'CLOSED' : 'CANCELLED', cancel_reason: reason, closed_at: u.at }
    await u.update(`purchase_orders/${cur.id}`, patch)
    await cancelPending(u, 'purchase_order', cur.id)
    ctx.audit(u, received ? 'purchasing.po_closed' : 'purchasing.po_cancelled', { entity_type: 'purchase_order', entity_id: cur.id, location_id: cur.location_id, details: { reason } })
    return { ...cur, ...patch }
  })
  return poOut(po)
})

// ================================================================ goods receipts
async function grnOut(g: Row) {
  const books = await entries('books')
  const loc = await byId('locations', g.location_id)
  return {
    id: g.id, number: g.number, po_id: g.po_id, po_number: g.po_number ?? null, supplier_id: g.supplier_id, supplier_name: g.supplier_name, location_id: g.location_id, location_name: loc?.name ?? '',
    supplier_ref: g.supplier_ref, freight: g.freight, other_charges: g.other_charges, goods_value: g.goods_value, total_landed: g.total_landed, supplier_invoice_id: g.supplier_invoice_id ?? null,
    received_at: g.received_at, notes: g.notes, lines: (g.lines as Row[]).map((l) => ({ ...l, title: books.get(l.book_id)?.title ?? '', sku: books.get(l.book_id)?.sku ?? '' })), replayed: false,
  }
}
route('GET', '/goods-receipts', async ({ query }, ctx) => {
  ctx.require('purchasing.view')
  if (query.location_id) ctx.ensureLocation(query.location_id)
  const rows = (await findScoped('goods_receipts', query.location_id ? [query.location_id] : ctx.scope(), 'location_id', orderBy('created_at', 'desc'), limit(2000)))
    .filter((g) => (!query.supplier_id || g.supplier_id === query.supplier_id) && (query.uninvoiced !== 'true' || !g.supplier_invoice_id))
  const page = paginate(rows, Number(query.page), Number(query.page_size))
  return { ...page, items: await Promise.all(page.items.map(grnOut)) }
})
route('GET', '/goods-receipts/:id', async ({ params }, ctx) => {
  ctx.require('purchasing.view')
  const g = await getOne(`goods_receipts/${params.id}`)
  if (!g) throw NotFound('Goods receipt not found')
  ctx.ensureResource(g.location_id)
  return grnOut(g)
})
route('POST', '/goods-receipts', async ({ body, headers }, ctx) => {
  ctx.require('purchasing.receive')
  const key = String(headers['Idempotency-Key'] ?? '')
  if (key.length < 8) throw fieldError('idempotency-key', 'Idempotency-Key header is required')
  const prior = await getOne(`idempotency/grn~${key}`)
  if (prior) {
    const g = await getOne(`goods_receipts/${prior.id}`)
    if (g) { ctx.ensureResource(g.location_id); return { ...(await grnOut(g)), replayed: true } }
  }
  const locationId = String(body.location_id ?? '')
  ctx.ensureLocation(locationId)
  const loc = await byId('locations', locationId)
  if (!loc || !loc.is_active) throw ValidationFailed('Receiving location not found or inactive')
  const freight = r2(body.freight as Num), other = r2(body.other_charges as Num)
  if (freight.lt(0) || other.lt(0)) throw ValidationFailed('Charges cannot be negative')
  const books = await entries('books')
  const g = await tx(async (u) => {
    if (await u.get(`idempotency/grn~${key}`)) throw Conflict('This receipt was already submitted', { code: 'duplicate' })
    let po: Row | null = null
    let supplierId = (body.supplier_id as string) || null
    if (body.po_id) {
      po = await u.get(`purchase_orders/${body.po_id}`)
      if (!po) throw NotFound('Purchase order not found')
      if (!['ISSUED', 'PARTIALLY_RECEIVED'].includes(po.status)) throw Conflict(`Purchase order is ${String(po.status).toLowerCase().replace('_', ' ')}; it must be issued to receive goods`)
      if (po.location_id !== locationId) throw ValidationFailed("Goods must be received at the purchase order's delivery location")
      supplierId = po.supplier_id
    }
    const supplier = supplierId ? await byId('suppliers', supplierId) : null
    if (!supplier) throw ValidationFailed('Supplier is required')
    const lines = (body.lines ?? []) as Record<string, unknown>[]
    if (!lines.length) throw ValidationFailed('At least one line is required')
    const poLinesArr = po ? (po.lines as Row[]).map((l) => ({ ...l })) : []
    const prepared: { book: Row; pol: Row | null; rec: number; dmg: number; cost: Decimal }[] = []
    for (const ln of lines) {
      const rec = int(ln.qty_received ?? 0), dmg = int(ln.qty_damaged ?? 0)
      if (rec < 0 || dmg < 0 || rec + dmg === 0) throw ValidationFailed('Each line needs a positive received or damaged quantity')
      let pol: Row | null = null
      let bookId: string
      let cost: Decimal
      if (po) {
        pol = (ln.po_line_id ? poLinesArr.find((p) => p.id === ln.po_line_id) : poLinesArr.find((p) => p.book_id === ln.book_id)) ?? null
        if (!pol) throw ValidationFailed('Line does not belong to this purchase order')
        const outstanding = pol.qty_ordered - pol.qty_received - pol.qty_cancelled
        if (rec + dmg > outstanding) throw Conflict(`Over-receipt for '${books.get(pol.book_id)?.title}': outstanding ${outstanding}, receiving ${rec + dmg}`)
        bookId = pol.book_id
        cost = ln.unit_cost !== null && ln.unit_cost !== undefined && ln.unit_cost !== '' ? D(ln.unit_cost as Num) : r4(D(pol.unit_cost).times(D(1).minus(D(pol.discount_pct).div(100))))
      } else {
        bookId = String(ln.book_id ?? '')
        if (ln.unit_cost === null || ln.unit_cost === undefined || ln.unit_cost === '') throw ValidationFailed('Unit cost is required for receipts without a purchase order')
        cost = D(ln.unit_cost as Num)
      }
      const book = books.get(bookId)
      if (!book) throw ValidationFailed('Book not found')
      if (cost.lt(0)) throw ValidationFailed('Unit cost cannot be negative')
      prepared.push({ book, pol, rec, dmg, cost })
    }
    const goods = sum(prepared.map((p) => r2(D(p.rec + p.dmg).times(p.cost))))
    const extra = freight.plus(other)
    const alloc = goods.gt(0) ? allocate(extra, prepared.map((p) => D(p.rec + p.dmg).times(p.cost))) : prepared.map(() => ZERO)
    const id = newId()
    const number = await u.nextNumber('GRN')
    const ref = { type: 'GRN', id, number }
    const st = new StockTx(u, { uid: ctx.uid, name: ctx.name })
    const grnLines: Row[] = []
    for (let i = 0; i < prepared.length; i++) {
      const { book, pol, rec, dmg, cost } = prepared[i]
      const qty = rec + dmg
      const landed = r4(cost.plus(alloc[i].div(qty)))
      grnLines.push({ po_line_id: pol?.id ?? null, book_id: book.id, qty_received: rec, qty_damaged: dmg, unit_cost: s4(cost), landed_unit_cost: s4(landed) } as unknown as Row)
      const b = await st.bal(locationId, book.id)
      st.receiveCost(b, qty, landed)
      if (rec) await st.apply(b, { bucket: 'ON_HAND', delta: rec, movement_type: 'PURCHASE_RECEIPT', ref, unit_cost: landed })
      if (dmg) await st.apply(b, { bucket: 'DAMAGED', delta: dmg, movement_type: 'PURCHASE_RECEIPT_DAMAGED', ref, unit_cost: landed, note: 'Received damaged' })
      if (book.tracking_mode === 'COPY') {
        if (rec) await createCopies(u, { book, location_id: locationId, qty: rec, status: 'AVAILABLE', unit_cost: landed, ref, actor: ctx })
        if (dmg) await createCopies(u, { book, location_id: locationId, qty: dmg, status: 'DAMAGED', unit_cost: landed, ref, actor: ctx, condition: 'DAMAGED' })
      }
      if (pol) pol.qty_received += qty
      // supplier product & last purchase price on the book record
      const path = shardPath('books', book.id)
      const cur = ((await u.get(path))?.m ?? {})[book.id]
      const next = { ...cur, suppliers: { ...(cur.suppliers ?? {}), [supplier.id]: { ...((cur.suppliers ?? {})[supplier.id] ?? {}), last_cost: s2(cost), last_purchased_at: u.at } } }
      if (cur.purchase_price !== s2(cost)) {
        u.add('price_history', { book_id: book.id, location_id: null, field: 'PURCHASE_PRICE', old_value: cur.purchase_price ?? null, new_value: s2(cost), reason: `Goods receipt ${number}`, changed_by: ctx.uid, changed_by_name: ctx.name, changed_at: u.at })
        next.purchase_price = s2(cost)
      }
      await u.setEntry(path, book.id, next)
    }
    await st.commit()
    const totalLanded = goods.plus(extra)
    if (po) {
      const received = poLinesArr.reduce((a, l) => a + l.qty_received, 0)
      const outstanding = poLinesArr.reduce((a, l) => a + l.qty_ordered - l.qty_received - l.qty_cancelled, 0)
      const status = outstanding === 0 ? (poLinesArr.every((l) => l.qty_cancelled === 0) ? 'RECEIVED' : 'CLOSED') : received > 0 ? 'PARTIALLY_RECEIVED' : po.status
      await u.update(`purchase_orders/${po.id}`, { lines: poLinesArr, status, closed_at: outstanding === 0 ? u.at : null })
    }
    const je = await post(u, { source_type: 'GOODS_RECEIPT', source_id: id, location_id: locationId, actor_id: ctx.uid, memo: `GRN ${number} from ${supplier.name}`, legs: [{ account: 'INVENTORY', amount: totalLanded }, { account: 'GRNI', amount: totalLanded.neg() }] })
    const doc = { number, po_id: po?.id ?? null, po_number: po?.number ?? null, supplier_id: supplier.id, supplier_name: supplier.name, location_id: locationId, supplier_ref: clean(body.supplier_ref), freight: s2(freight), other_charges: s2(other),
      goods_value: s2(goods), total_landed: s2(totalLanded), notes: clean(body.notes), supplier_invoice_id: null, idempotency_key: key, journal_entry_id: je, created_by: ctx.uid, received_at: u.at, created_at: u.at, lines: grnLines }
    u.set(`goods_receipts/${id}`, doc)
    u.set(`idempotency/grn~${key}`, { id, created_at: u.at })
    ctx.audit(u, 'purchasing.goods_received', { entity_type: 'goods_receipt', entity_id: id, location_id: locationId, details: { number, po: po?.number ?? null, value: s2(totalLanded) } })
    return { ...doc, id }
  })
  return grnOut(g)
})

// ================================================================ supplier invoices & payments
async function siOut(si: Row) {
  const grns = await find('goods_receipts', where('supplier_invoice_id', '==', si.id))
  return { ...si, balance_due: s2(D(si.total).minus(D(si.amount_paid))), grns: grns.map((g) => ({ id: g.id, number: g.number, total_landed: g.total_landed })),
    overdue: ['OPEN', 'PARTIALLY_PAID'].includes(si.status) && si.due_date < localDate() }
}
route('GET', '/supplier-invoices', async ({ query }, ctx) => {
  ctx.requireAny('finance.view', 'purchasing.view')
  const statuses = query.status ? query.status.split(',') : null
  const today = localDate()
  const rows = (await findScoped('supplier_invoices', ctx.scope(), 'location_id', limit(5000))).filter((s) => (!query.supplier_id || s.supplier_id === query.supplier_id) && (!statuses || statuses.includes(s.status))
    && (query.overdue !== 'true' || (s.due_date < today && ['OPEN', 'PARTIALLY_PAID'].includes(s.status)))).sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)))
  const page = paginate(rows, Number(query.page), Number(query.page_size))
  return { ...page, items: await Promise.all(page.items.map(siOut)) }
})
route('POST', '/supplier-invoices', async ({ body }, ctx) => {
  ctx.require('finance.manage')
  const supplier = await byId('suppliers', String(body.supplier_id ?? ''))
  if (!supplier) throw NotFound('Supplier not found')
  const number = clean(body.invoice_number)
  if (!number) throw fieldError('invoice_number', 'String should have at least 1 character')
  const invDate = String(body.invoice_date ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(invDate)) throw fieldError('invoice_date', 'Input should be a valid date')
  const grnIds = [...new Set((body.grn_ids ?? []) as string[])]
  if (!grnIds.length) throw ValidationFailed('Link at least one goods receipt to the supplier invoice')
  const [taxable, cgst, sgst, igst, other] = ['taxable_amount', 'cgst', 'sgst', 'igst', 'other_charges'].map((k) => r2(body[k] as Num))
  if ([taxable, cgst, sgst, igst, other].some((x) => x.lt(0))) throw ValidationFailed('Amounts cannot be negative')
  if (!cgst.eq(sgst)) throw ValidationFailed('CGST and SGST must be equal')
  if ((cgst.gt(0) || sgst.gt(0)) && igst.gt(0)) throw ValidationFailed('An invoice carries either CGST+SGST or IGST, not both')
  if ((await find('supplier_invoices', where('supplier_id', '==', supplier.id))).some((s) => s.invoice_number === number)) throw Conflict('This supplier invoice number is already recorded')
  const si = await tx(async (u) => {
    const grns: Row[] = []
    for (const gid of grnIds) {
      const g = await u.get(`goods_receipts/${gid}`)
      if (!g) throw ValidationFailed('Goods receipt not found')
      ctx.ensureResource(g.location_id)
      if (g.supplier_id !== supplier.id) throw ValidationFailed(`${g.number} is from a different supplier`)
      if (g.supplier_invoice_id) throw Conflict(`${g.number} is already invoiced`)
      grns.push(g)
    }
    const total = taxable.plus(cgst).plus(sgst).plus(igst).plus(other)
    const id = newId()
    const doc = { supplier_id: supplier.id, supplier_name: supplier.name, invoice_number: number, invoice_date: invDate, due_date: clean(body.due_date) ?? addDays(invDate, supplier.payment_terms_days ?? 30), po_id: grns[0].po_id ?? null,
      location_id: grns[0].location_id, taxable_amount: s2(taxable), cgst: s2(cgst), sgst: s2(sgst), igst: s2(igst), other_charges: s2(other), total: s2(total), amount_paid: '0.00', status: 'OPEN', notes: clean(body.notes), created_by: ctx.uid, created_at: u.at, journal_entry_id: null as string | null }
    const grni = sum(grns.map((g) => g.total_landed))
    const variance = taxable.plus(other).minus(grni)
    for (const g of grns) await u.update(`goods_receipts/${g.id}`, { supplier_invoice_id: id })
    doc.journal_entry_id = await post(u, { source_type: 'SUPPLIER_INVOICE', source_id: id, location_id: doc.location_id, actor_id: ctx.uid, memo: `Supplier invoice ${number} — ${supplier.name}`, entry_date: invDate,
      legs: [{ account: 'GRNI', amount: grni }, { account: 'PURCHASE_VARIANCE', amount: variance }, { account: 'INPUT_CGST', amount: cgst }, { account: 'INPUT_SGST', amount: sgst }, { account: 'INPUT_IGST', amount: igst }, { account: 'AP', amount: total.neg() }] })
    u.set(`supplier_invoices/${id}`, doc)
    ctx.audit(u, 'finance.supplier_invoice_recorded', { entity_type: 'supplier_invoice', entity_id: id, location_id: doc.location_id, details: { number, total: s2(total), variance: s2(variance) } })
    return { ...doc, id }
  })
  return siOut(si)
})
route('POST', '/supplier-payments', async ({ body, headers }, ctx) => {
  ctx.require('finance.manage')
  const key = String(headers['Idempotency-Key'] ?? '')
  if (key.length < 8) throw fieldError('idempotency-key', 'Idempotency-Key header is required')
  const prior = await getOne(`idempotency/spay~${key}`)
  if (prior) return { id: prior.id, number: prior.number, amount: prior.amount, replayed: true }
  const locationId = String(body.location_id ?? '')
  ctx.ensureLocation(locationId)
  const supplier = await byId('suppliers', String(body.supplier_id ?? ''))
  if (!supplier) throw NotFound('Supplier not found')
  const method = await byId('payment_methods', String(body.payment_method_id ?? ''))
  if (!method || !['CASH', 'BANK_TRANSFER', 'UPI', 'CARD', 'OTHER'].includes(method.kind)) throw ValidationFailed('Payment method not allowed for supplier payments')
  const acc = await byId('accounts', String(body.account_id || method.account_id))
  if (!acc || !acc.is_cash_or_bank) throw ValidationFailed('Pay from a cash or bank account')
  const amount = r2(body.amount as Num)
  if (amount.lte(0)) throw ValidationFailed('Amount must be positive')
  const allocs = ((body.allocations ?? []) as Record<string, unknown>[]).map((a) => ({ id: String(a.supplier_invoice_id), amount: r2(a.amount as Num) }))
  if (!allocs.length) throw ValidationFailed('Allocate the payment to at least one invoice')
  const allocTotal = sum(allocs.map((a) => a.amount))
  if (!allocTotal.eq(amount)) throw ValidationFailed(`Allocations (${allocTotal.toFixed(2)}) must equal the payment amount (${amount.toFixed(2)})`)
  const payDate = String(body.payment_date || localDate())
  return tx(async (u) => {
    const id = newId(), number = payNumber()
    const allocOut: Row[] = []
    for (const a of [...allocs].sort((x, y) => x.id.localeCompare(y.id))) {
      const si = await u.get(`supplier_invoices/${a.id}`)
      if (!si || si.supplier_id !== supplier.id) throw ValidationFailed('Invoice not found for this supplier')
      const due = D(si.total).minus(D(si.amount_paid))
      if (a.amount.lte(0) || a.amount.gt(due)) throw ValidationFailed(`Invoice ${si.invoice_number}: allocation exceeds balance due (${s2(due)})`)
      if (si.status === 'CANCELLED') throw Conflict(`Invoice ${si.invoice_number} is cancelled`)
      const paid = D(si.amount_paid).plus(a.amount)
      await u.update(`supplier_invoices/${si.id}`, { amount_paid: s2(paid), status: paid.eq(D(si.total)) ? 'PAID' : 'PARTIALLY_PAID' })
      allocOut.push({ supplier_invoice_id: si.id, invoice_number: si.invoice_number, amount: s2(a.amount) } as unknown as Row)
    }
    const je = await post(u, { source_type: 'SUPPLIER_PAYMENT', source_id: id, location_id: locationId, actor_id: ctx.uid, entry_date: payDate, memo: `Payment ${number} to ${supplier.name}`, legs: [{ account: 'AP', amount }, { account: acc.id, amount: amount.neg() }] })
    u.set(`payments/${id}`, { number, direction: 'OUT', purpose: 'SUPPLIER_PAYMENT', payment_method_id: method.id, method: method.name, method_code: method.code, method_kind: method.kind, account_id: acc.id, amount: s2(amount), reference: clean(body.reference),
      location_id: locationId, supplier_id: supplier.id, supplier_name: supplier.name, payment_date: payDate, idempotency_key: key, notes: clean(body.notes), created_by: ctx.uid, created_at: u.at, allocations: allocOut, sale_ids: [], journal_entry_id: je })
    u.set(`idempotency/spay~${key}`, { id, number, amount: s2(amount), created_at: u.at })
    ctx.audit(u, 'finance.supplier_paid', { entity_type: 'payment', entity_id: id, location_id: locationId, details: { supplier: supplier.name, amount: s2(amount), number } })
    return { id, number, amount: s2(amount), replayed: false }
  })
})
route('GET', '/supplier-payments', async ({ query }, ctx) => {
  ctx.require('finance.view')
  const rows = (await findScoped('payments', ctx.scope(), 'location_id', where('purpose', '==', 'SUPPLIER_PAYMENT'), limit(5000))).filter((p) => !query.supplier_id || p.supplier_id === query.supplier_id)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  return paginate(rows.map((p) => ({ id: p.id, number: p.number, supplier_id: p.supplier_id, supplier_name: p.supplier_name, amount: p.amount, method: p.method, reference: p.reference, payment_date: p.payment_date,
    allocations: (p.allocations as Row[]).map((a) => ({ invoice_number: a.invoice_number, amount: a.amount })) })), Number(query.page), Number(query.page_size))
})

// ================================================================ supplier returns (debit notes)
route('POST', '/supplier-returns', async ({ body, headers }, ctx) => {
  ctx.require('purchasing.return')
  const key = String(headers['Idempotency-Key'] ?? '')
  if (key.length < 8) throw fieldError('idempotency-key', 'Idempotency-Key header is required')
  const prior = await getOne(`idempotency/sret~${key}`)
  if (prior) return { id: prior.id, number: prior.number, value: prior.value, replayed: true }
  const locationId = String(body.location_id ?? '')
  ctx.ensureLocation(locationId)
  const supplier = await byId('suppliers', String(body.supplier_id ?? ''))
  if (!supplier) throw NotFound('Supplier not found')
  const reason = String(body.reason ?? '')
  if (reason.length < 3) throw fieldError('reason', 'String should have at least 3 characters')
  const lines = (body.lines ?? []) as Record<string, unknown>[]
  if (!lines.length) throw ValidationFailed('At least one line is required')
  const books = await entries('books')
  return tx(async (u) => {
    const id = newId(), number = await u.nextNumber('PRN')
    const ref = { type: 'SUPPLIER_RETURN', id, number }
    const st = new StockTx(u, { uid: ctx.uid, name: ctx.name })
    let value = ZERO
    const out: Row[] = []
    for (const ln of lines) {
      const book = books.get(String(ln.book_id))
      if (!book) throw NotFound('Book not found')
      const qty = int(ln.qty)
      if (qty <= 0) throw ValidationFailed('Quantity must be positive')
      const bucket = String(ln.from_bucket ?? 'ON_HAND') as Bucket
      if (!['ON_HAND', 'DAMAGED', 'QUARANTINED'].includes(bucket)) throw ValidationFailed('Invalid source bucket')
      const b = await st.bal(locationId, book.id)
      const cost = b.avg_cost ?? '0'
      if (book.tracking_mode === 'COPY') {
        const copies = await pickCopies(u, { book_id: book.id, location_id: locationId, qty, status: COPY_STATUS_FOR_BUCKET[bucket], copy_ids: (ln.copy_ids as string[]) || null })
        for (const c of copies) {
          await st.apply(b, { bucket, delta: -1, movement_type: 'PURCHASE_RETURN', ref, unit_cost: cost, copy_id: c.id, check_available: bucket === 'ON_HAND' })
          await moveCopy(u, c, { event: 'RETURNED_TO_SUPPLIER', to_status: 'RETURNED_TO_SUPPLIER', ref, actor: ctx })
        }
      } else await st.apply(b, { bucket, delta: -qty, movement_type: 'PURCHASE_RETURN', ref, unit_cost: cost, check_available: bucket === 'ON_HAND' })
      value = value.plus(r2(D(qty).times(D(cost))))
      out.push({ book_id: book.id, title: book.title, qty, from_bucket: bucket, unit_cost: s4(cost) } as unknown as Row)
    }
    await st.commit()
    const je = await post(u, { source_type: 'SUPPLIER_RETURN', source_id: id, location_id: locationId, actor_id: ctx.uid, memo: `Debit note ${number} — ${supplier.name}`, legs: [{ account: 'AP', amount: value }, { account: 'INVENTORY', amount: value.neg() }] })
    u.set(`supplier_returns/${id}`, { number, supplier_id: supplier.id, supplier_name: supplier.name, location_id: locationId, grn_id: clean(body.grn_id), reason, value: s2(value), idempotency_key: key, journal_entry_id: je, created_by: ctx.uid, created_at: u.at, lines: out })
    u.set(`idempotency/sret~${key}`, { id, number, value: s2(value), created_at: u.at })
    ctx.audit(u, 'purchasing.supplier_return', { entity_type: 'supplier_return', entity_id: id, location_id: locationId, details: { number, value: s2(value) } })
    return { id, number, value: s2(value), replayed: false }
  })
})
route('GET', '/supplier-returns', async ({ query }, ctx) => {
  ctx.require('purchasing.view')
  const rows = (await findScoped('supplier_returns', ctx.scope(), 'location_id', limit(2000))).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  return paginate(rows.map((r) => ({ id: r.id, number: r.number, supplier_name: r.supplier_name, reason: r.reason, value: r.value, created_at: r.created_at, lines: (r.lines as Row[]).map((l) => ({ title: l.title, qty: l.qty, from_bucket: l.from_bucket })) })), Number(query.page), Number(query.page_size))
})

void canSeeCost
