/**
 * Point of sale, sales history, voids, customers, receipts, returns/credit notes and register sessions.
 *
 * Checkout is one Firestore transaction: idempotency key -> pricing & GST (computed here, never taken from the
 * page) -> stock deduction / copies sold -> gapless invoice number per outlet & year -> payments -> balanced
 * journal -> register-session and daily totals. Either all of it is saved or none of it.
 */
import { limit, orderBy, where } from 'firebase/firestore'
import { cancelPending, createApproval, pendingFor, registerApproval } from './approvals'
import { getBook } from './catalog'
import type { Ctx } from './ctx'
import {
  Conflict, D, Forbidden, NotFound, ValidationFailed, ZERO, amountInWords, clean, daysBetween, fieldError, financialYear, int, isoRange, lc, localDate, matches, newId,
  paginate, r2, s2, s2n, sum, type Decimal, type Num,
} from './core'
import { BillingError, STATE_CODES, allocate, bumpBoth, computeBill, post, prorateReturn, reverse, validGstin, type BillResult, type Leg } from './ledger'
import { route } from './router'
import { getOrg, getPolicy } from './settings'
import { StockTx, balancesAt, moveCopy, pickCopies } from './stock'
import { all, byId, entries, entry, find, findScoped, getOne, shardPath, tx, type Row, type Uow } from './store'

const payNumber = () => `PAY-${Date.now().toString(36).toUpperCase()}${newId().slice(0, 3).toUpperCase()}`

// ================================================================ payment methods & registers
route('GET', '/payment-methods', async (_r, ctx) => {
  ctx.requireAny('pos.sell', 'finance.view', 'returns.create', 'expenses.create')
  return (await all('payment_methods')).sort((a, b) => a.sort_order - b.sort_order).map((m) => ({ id: m.id, code: m.code, name: m.name, kind: m.kind, requires_reference: !!m.requires_reference, is_active: !!m.is_active }))
})

async function openSessionOf(registerId: string): Promise<Row | null> {
  return (await find('register_sessions', where('register_id', '==', registerId), where('status', '==', 'OPEN'), limit(1)))[0] ?? null
}
route('GET', '/registers', async ({ query }, ctx) => {
  ctx.requireAny('registers.operate', 'registers.manage')
  if (query.location_id) ctx.ensureLocation(query.location_id)
  const locs = new Map((await all('locations')).map((l) => [l.id, l.name]))
  const regs = (await all('registers')).filter((r) => ctx.canAccess(r.location_id) && (!query.location_id || r.location_id === query.location_id))
    .sort((a, b) => String(locs.get(a.location_id)).localeCompare(String(locs.get(b.location_id))) || a.name.localeCompare(b.name))
  const out = []
  for (const r of regs) {
    const s = await openSessionOf(r.id)
    out.push({ id: r.id, location_id: r.location_id, location_name: locs.get(r.location_id) ?? '', name: r.name, is_active: !!r.is_active,
      open_session: s ? { id: s.id, opened_at: s.opened_at, opened_by: s.opened_by_name, opened_by_id: s.opened_by, opening_float: s.opening_float } : null })
  }
  return out
})
route('POST', '/registers', async ({ body }, ctx) => {
  ctx.require('registers.manage')
  const loc = await byId('locations', String(body.location_id ?? ''))
  ctx.ensureLocation(String(body.location_id ?? ''))
  if (!loc || loc.type !== 'OUTLET') throw Conflict('Registers can only be added to outlets')
  const name = clean(body.name)
  if (!name) throw fieldError('name', 'String should have at least 1 character')
  return tx(async (u) => {
    const id = u.add('registers', { location_id: loc.id, name, is_active: body.is_active !== false })
    ctx.audit(u, 'register.created', { entity_type: 'register', entity_id: id, location_id: loc.id, details: { name } })
    return { id }
  })
})
route('PUT', '/registers/:id', async ({ params, body }, ctx) => {
  ctx.require('registers.manage')
  const reg = await byId('registers', params.id)
  if (!reg) throw NotFound('Register not found')
  ctx.ensureResource(reg.location_id)
  const name = clean(body.name)
  if (!name) throw fieldError('name', 'String should have at least 1 character')
  return tx(async (u) => {
    await u.update(`registers/${reg.id}`, { name, is_active: body.is_active !== false })
    ctx.audit(u, 'register.updated', { entity_type: 'register', entity_id: reg.id, location_id: reg.location_id })
    return { id: reg.id }
  })
})
route('DELETE', '/registers/:id', async ({ params }, ctx) => {
  ctx.require('registers.manage')
  const reg = await byId('registers', params.id)
  if (!reg) throw NotFound('Register not found')
  ctx.ensureResource(reg.location_id)
  if ((await find('register_sessions', where('register_id', '==', reg.id), limit(1))).length) throw Conflict('This register has sessions; deactivate it instead')
  await tx(async (u) => {
    u.delete(`registers/${reg.id}`)
    ctx.audit(u, 'register.deleted', { entity_type: 'register', entity_id: reg.id, location_id: reg.location_id, details: { name: reg.name } })
  })
  return undefined
})

route('POST', '/register-sessions', async ({ body }, ctx) => {
  ctx.require('registers.operate')
  const reg = await byId('registers', String(body.register_id ?? ''))
  if (!reg || !reg.is_active) throw NotFound('Register not found or inactive')
  ctx.ensureLocation(reg.location_id)
  const float = Number(body.opening_float)
  if (!(float >= 0)) throw fieldError('opening_float', 'Input should be greater than or equal to 0')
  return tx(async (u) => {
    // the register document doubles as the lock: one open session per register
    const r = await u.need(`registers/${reg.id}`, 'Register')
    if (r.open_session_id) {
      const s = await u.get(`register_sessions/${r.open_session_id}`)
      if (s && s.status === 'OPEN') throw Conflict('This register already has an open session')
    }
    const id = u.add('register_sessions', {
      register_id: reg.id, register_name: reg.name, location_id: reg.location_id, status: 'OPEN', opened_by: ctx.uid, opened_by_name: ctx.name, opened_at: u.at, opening_float: s2(float),
      closed_by: null, closed_by_name: null, closed_at: null, expected_cash: null, counted_cash: null, variance: null, closing_notes: null, journal_entry_id: null,
      totals: {}, cash_in: '0.00', cash_out: '0.00', cash_expenses: '0.00', sales_count: 0, sales_total: '0.00', voided_count: 0,
    })
    await u.update(`registers/${reg.id}`, { open_session_id: id })
    ctx.audit(u, 'register.opened', { entity_type: 'register_session', entity_id: id, location_id: reg.location_id, details: { register: reg.name, opening_float: s2(float) } })
    return { id, status: 'OPEN' }
  })
})

export function sessionSummary(s: Row) {
  const expected = D(s.opening_float).plus(D(s.cash_in)).minus(D(s.cash_out)).minus(D(s.cash_expenses))
  return {
    opening_float: s.opening_float, cash_in: s2(s.cash_in), cash_out: s2(s.cash_out), cash_expenses: s2(s.cash_expenses), expected_cash: s2(expected),
    sales_count: s.sales_count ?? 0, sales_total: s2(s.sales_total), voided_count: s.voided_count ?? 0,
    by_method: Object.values((s.totals ?? {}) as Record<string, Row>).map((m) => ({ code: m.code, name: m.name, kind: m.kind, in: s2(m.in), out: s2(m.out), count: m.count, net: s2(D(m.in).minus(D(m.out))) })),
  }
}
/** Add a payment (or cash expense) to the running totals of its register session. */
export async function sessionAdd(u: Uow, sessionId: string, o: { method?: Row; direction?: 'IN' | 'OUT'; amount?: Num; expense?: Num; sale?: Num; voided?: boolean }) {
  const s = await u.need(`register_sessions/${sessionId}`, 'Register session')
  const totals = { ...(s.totals ?? {}) }
  const patch: Record<string, unknown> = {}
  if (o.method && o.amount !== undefined) {
    const m = o.method
    const t = { code: m.code, name: m.name, kind: m.kind, in: '0.00', out: '0.00', count: 0, ...(totals[m.code] ?? {}) }
    if (o.direction === 'OUT') t.out = s2(D(t.out).plus(D(o.amount)))
    else t.in = s2(D(t.in).plus(D(o.amount)))
    t.count += 1
    totals[m.code] = t
    patch.totals = totals
    if (m.kind === 'CASH') {
      if (o.direction === 'OUT') patch.cash_out = s2(D(s.cash_out).plus(D(o.amount)))
      else patch.cash_in = s2(D(s.cash_in).plus(D(o.amount)))
    }
  }
  if (o.expense !== undefined) patch.cash_expenses = s2(D(s.cash_expenses).plus(D(o.expense)))
  if (o.sale !== undefined) {
    patch.sales_count = (s.sales_count ?? 0) + (D(o.sale).lt(0) ? -1 : 1)
    patch.sales_total = s2(D(s.sales_total).plus(D(o.sale)))
  }
  if (o.voided) patch.voided_count = (s.voided_count ?? 0) + 1
  await u.update(`register_sessions/${sessionId}`, patch)
}
function sessionOut(s: Row, withSummary: boolean) {
  return {
    id: s.id, register_id: s.register_id, register_name: s.register_name, location_id: s.location_id, location_name: s.location_name ?? '', status: s.status, opened_by: s.opened_by_name,
    opened_at: s.opened_at, closed_by: s.closed_by_name, closed_at: s.closed_at, opening_float: s.opening_float, expected_cash: s.expected_cash, counted_cash: s.counted_cash,
    variance: s.variance, closing_notes: s.closing_notes, summary: withSummary ? sessionSummary(s) : null,
  }
}
async function withLocName(s: Row) {
  return { ...s, location_name: (await byId('locations', s.location_id))?.name ?? '' }
}
route('GET', '/register-sessions', async ({ query }, ctx) => {
  ctx.requireAny('registers.operate', 'registers.manage')
  if (query.location_id) ctx.ensureLocation(query.location_id)
  let rows = await findScoped('register_sessions', query.location_id ? [query.location_id] : ctx.scope(), 'location_id', orderBy('opened_at', 'desc'), limit(1000))
  if (!ctx.has('registers.manage')) rows = rows.filter((s) => s.opened_by === ctx.uid)
  rows = rows.filter((s) => (!query.status || s.status === query.status) && (query.discrepancy !== 'true' || (s.variance !== null && !D(s.variance).eq(0))))
  const page = paginate(rows, Number(query.page), Number(query.page_size))
  return { ...page, items: await Promise.all(page.items.map(async (s) => sessionOut(await withLocName(s), false))) }
})
route('GET', '/register-sessions/:id', async ({ params }, ctx) => {
  ctx.requireAny('registers.operate', 'registers.manage')
  const s = await getOne(`register_sessions/${params.id}`)
  if (!s) throw NotFound('Session not found')
  ctx.ensureResource(s.location_id)
  if (!ctx.has('registers.manage') && s.opened_by !== ctx.uid && s.status !== 'OPEN') throw NotFound('Session not found')
  return sessionOut(await withLocName(s), true)
})
route('POST', '/register-sessions/:id/close', async ({ params, body }, ctx) => {
  ctx.require('registers.operate')
  const counted = Number(body.counted_cash)
  if (!(counted >= 0)) throw fieldError('counted_cash', 'Input should be greater than or equal to 0')
  const s = await tx(async (u) => {
    const s = await u.get(`register_sessions/${params.id}`)
    if (!s) throw NotFound('Register session not found')
    ctx.ensureResource(s.location_id)
    if (s.status !== 'OPEN') throw Conflict('Session is already closed')
    if (s.opened_by !== ctx.uid && !ctx.has('registers.manage')) throw ValidationFailed('Only the cashier who opened the session or a manager can close it')
    const expected = D(sessionSummary(s).expected_cash)
    const variance = r2(counted).minus(expected)
    let je: string | null = null
    if (!variance.eq(0)) je = await post(u, { source_type: 'REGISTER_CLOSE', source_id: s.id, location_id: s.location_id, actor_id: ctx.uid, memo: `Cash ${variance.gt(0) ? 'over' : 'short'} — ${s.register_name}`, legs: [{ account: 'CASH', amount: variance }, { account: 'CASH_OVER_SHORT', amount: variance.neg() }] })
    const patch = { expected_cash: s2(expected), counted_cash: s2(counted), variance: s2(variance), status: 'CLOSED', closed_by: ctx.uid, closed_by_name: ctx.name, closed_at: u.at, closing_notes: clean(body.notes), journal_entry_id: je }
    await u.update(`register_sessions/${s.id}`, patch)
    await u.update(`registers/${s.register_id}`, { open_session_id: null })
    ctx.audit(u, 'register.closed', { entity_type: 'register_session', entity_id: s.id, location_id: s.location_id, details: { expected: s2(expected), counted: s2(counted), variance: s2(variance) } })
    return { ...s, ...patch }
  })
  return sessionOut(await withLocName(s), true)
})

// ================================================================ pricing
interface CartLine { book: Row; qty: number; unit_price: string; tax_rate: string; line_discount: Decimal; copy_id: string | null }

const taxRateFor = async (org: Row, book: Row) => (org.gst_registration_type !== 'REGULAR' ? '0' : String((await byId('tax_classes', book.tax_class_id))?.rate ?? '0'))
const docTypeFor = (org: Row, lines: CartLine[]) => (org.gst_registration_type !== 'REGULAR' ? 'BILL_OF_SUPPLY' : lines.some((l) => D(l.tax_rate).gt(0)) ? 'TAX_INVOICE' : 'BILL_OF_SUPPLY')

async function buildCart(locationId: string, items: Record<string, unknown>[], org: Row): Promise<CartLine[]> {
  if (!items?.length) throw ValidationFailed('Cart is empty')
  if (items.length > 300) throw ValidationFailed('Too many lines in one bill')
  const bals = await balancesAt(locationId)
  const lines: CartLine[] = []
  for (const it of items) {
    const qty = int(it.qty ?? 1)
    if (qty <= 0 || qty > 10000) throw ValidationFailed('Invalid quantity')
    const copyId = (it.copy_id as string) || null
    let book: Row
    if (copyId) {
      const copy = await getOne(`copies/${copyId}`)
      if (!copy) throw NotFound('Copy not found')
      book = await getBook(copy.book_id)
      if (qty !== 1) throw ValidationFailed('An individual copy is always quantity 1')
    } else {
      const b = await entry('books', String(it.book_id ?? ''))
      if (!b) throw NotFound('Book not found')
      book = b
    }
    if (book.status === 'ARCHIVED' || book.merged_into_id) throw ValidationFailed(`'${book.title}' is archived and cannot be sold`)
    const price = bals.get(book.id)?.price_override ?? book.selling_price
    const disc = r2(it.line_discount as Num)
    if (disc.lt(0)) throw ValidationFailed('Line discount must be between 0 and the line amount')
    const rate = await taxRateFor(org, book)
    if (book.tracking_mode === 'COPY' && !copyId && qty > 1) {
      for (const d of allocate(disc, Array.from({ length: qty }, () => D(1)))) lines.push({ book, qty: 1, unit_price: price, tax_rate: rate, line_discount: d, copy_id: null })
    } else lines.push({ book, qty, unit_price: price, tax_rate: rate, line_discount: disc, copy_id: copyId })
  }
  const copies = lines.map((l) => l.copy_id).filter(Boolean)
  if (copies.length !== new Set(copies).size) throw ValidationFailed('The same copy is in the cart twice')
  return lines
}

async function quote(o: { location_id: string; items: Record<string, unknown>[]; customer_id?: string | null; bill_discount?: Num; place_of_supply?: string | null }) {
  const org = (await getOrg())!
  const loc = await byId('locations', o.location_id)
  if (!loc) throw NotFound('Location not found')
  const customer = o.customer_id ? await entry('customers', o.customer_id) : null
  const policy = await getPolicy()
  const lines = await buildCart(o.location_id, o.items, org)
  let pos: string
  if (o.place_of_supply) {
    if (!(o.place_of_supply in STATE_CODES)) throw ValidationFailed('Unknown place-of-supply state code')
    pos = o.place_of_supply
  } else pos = customer?.gstin ? String(customer.gstin).slice(0, 2) : loc.state_code
  let bill: BillResult
  try {
    bill = computeBill(lines.map((l) => ({ unit_price: l.unit_price, qty: l.qty, tax_rate: l.tax_rate, line_discount: l.line_discount })), { prices_include_tax: policy.prices_include_tax, interstate: pos !== loc.state_code, bill_discount: o.bill_discount, rounding: policy.rounding })
  } catch (e) {
    if (e instanceof BillingError) throw ValidationFailed(e.message)
    throw e
  }
  return { lines, bill, org, loc, customer, policy, meta: { place_of_supply: pos, interstate: pos !== loc.state_code, doc_type: docTypeFor(org, lines), prices_include_tax: policy.prices_include_tax } }
}

function quotePayload(lines: CartLine[], bill: BillResult, meta: Record<string, unknown>) {
  return {
    ...meta,
    lines: lines.map((l, i) => {
      const r = bill.lines[i]
      return { book_id: l.book.id, copy_id: l.copy_id, title: l.book.title, sku: l.book.sku, qty: l.qty, unit_price: s2(l.unit_price), mrp: l.book.mrp, tax_rate: s2(l.tax_rate), min_selling_price: l.book.min_selling_price ?? null,
        gross: s2(r.gross), line_discount: s2(r.line_discount), bill_discount_alloc: s2(r.bill_discount_alloc), taxable_value: s2(r.taxable_value), cgst: s2(r.cgst), sgst: s2(r.sgst), igst: s2(r.igst), line_total: s2(r.line_total) }
    }),
    gross: s2(bill.gross), line_discount_total: s2(bill.line_discount_total), bill_discount: s2(bill.bill_discount), discount_total: s2(bill.discount_total), taxable_total: s2(bill.taxable_total),
    cgst_total: s2(bill.cgst_total), sgst_total: s2(bill.sgst_total), igst_total: s2(bill.igst_total), tax_total: s2(bill.tax_total), round_off: s2(bill.round_off), grand_total: s2(bill.grand_total),
    discount_pct: bill.gross.gt(0) ? s2(bill.discount_total.div(bill.gross).times(100)) : '0.00',
  }
}
const quoteInput = (b: Record<string, unknown>) => {
  if (b.place_of_supply && !/^\d{2}$/.test(String(b.place_of_supply))) throw fieldError('place_of_supply', 'String should match pattern ^\\d{2}$')
  if (Number(b.bill_discount ?? 0) < 0) throw fieldError('bill_discount', 'Input should be greater than or equal to 0')
  return { location_id: String(b.location_id ?? ''), items: (b.items ?? []) as Record<string, unknown>[], customer_id: (b.customer_id as string) || null, bill_discount: (b.bill_discount as Num) ?? 0, place_of_supply: (b.place_of_supply as string) || null }
}

route('POST', '/pos/quote', async ({ body }, ctx) => {
  ctx.require('pos.sell')
  const q = quoteInput(body)
  ctx.ensureLocation(q.location_id)
  const { lines, bill, meta } = await quote(q)
  return quotePayload(lines, bill, meta)
})
route('POST', '/pos/discount-approvals', async ({ body }, ctx) => {
  ctx.require('pos.sell')
  const q = quoteInput(body)
  const reason = String(body.reason ?? '')
  if (reason.length < 3) throw fieldError('reason', 'String should have at least 3 characters')
  ctx.ensureLocation(q.location_id)
  const { lines, bill } = await quote(q)
  const pct = bill.gross.gt(0) ? r2(bill.discount_total.div(bill.gross).times(100)) : ZERO
  return tx(async (u) => {
    const id = createApproval(u, ctx, {
      type: 'DISCOUNT', location_id: q.location_id, title: `Discount ${pct.toFixed(2)}% (₹${s2(bill.discount_total)}) on bill of ₹${s2(bill.gross)}`, amount: bill.discount_total, reason,
      payload: { discount_pct: pct.toFixed(2), discount_amount: s2(bill.discount_total), gross: s2(bill.gross), items: lines.map((l) => ({ title: l.book.title, qty: l.qty, price: s2(l.unit_price) })) },
    })
    return { id, status: 'PENDING' }
  })
})
registerApproval('DISCOUNT', null, null)
route('GET', '/pos/discount-approvals/:id', async ({ params }, ctx) => {
  ctx.require('pos.sell')
  const req = await getOne(`approvals/${params.id}`)
  if (!req || req.type !== 'DISCOUNT') throw NotFound('Approval not found')
  ctx.ensureResource(req.location_id)
  return { id: req.id, status: req.status, decision_note: req.decision_note, consumed: !!req.consumed_at, payload: req.payload }
})

// ================================================================ checkout
async function checkDiscounts(u: Uow, ctx: Ctx, policy: Awaited<ReturnType<typeof getPolicy>>, locationId: string, lines: CartLine[], bill: BillResult, approvalId: string | null): Promise<Row | null> {
  const discount = bill.discount_total
  const pct = bill.gross.gt(0) ? discount.div(bill.gross).times(100) : ZERO
  const belowMin: string[] = []
  lines.forEach((l, i) => {
    const r = bill.lines[i]
    if (l.book.min_selling_price !== null && l.book.min_selling_price !== undefined && r.gross.minus(r.line_discount).minus(r.bill_discount_alloc).div(l.qty).lt(D(l.book.min_selling_price))) belowMin.push(l.book.title)
  })
  const within = discount.eq(0) || (ctx.has('pos.discount') && pct.lte(D(policy.max_discount_pct)))
  if (within && !belowMin.length) return null
  if (ctx.has('pos.discount_override')) return null
  if (!approvalId) {
    const detail = !within ? `discount ${pct.toFixed(2)}% exceeds your limit` : `price below minimum for ${belowMin.join(', ')}`
    throw Forbidden(`Approval required: ${detail}`, { code: 'discount_approval_required', details: { discount_pct: s2(pct), below_min: belowMin } })
  }
  const req = await u.get(`approvals/${approvalId}`)
  if (!req || req.type !== 'DISCOUNT' || req.status !== 'APPROVED' || req.consumed_at || req.location_id !== locationId) throw Forbidden('Discount approval is not valid, not approved, or already used', { code: 'invalid_approval' })
  if (pct.gt(D(req.payload?.discount_pct).plus('0.01')) && discount.gt(D(req.payload?.discount_amount))) throw Forbidden('Discount exceeds the approved amount', { code: 'invalid_approval' })
  await u.update(`approvals/${req.id}`, { consumed_at: u.at })
  return req
}

/** Per-day/month sales metrics (a negative sign undoes a sale, e.g. on void). */
async function bumpSale(u: Uow, sale: Row, sign: 1 | -1, date: string) {
  const books = await entries('books')
  const add: Record<string, Num> = {
    's.count': sign, 's.gross': D(sale.gross_amount).times(sign), 's.discount': D(sale.discount_total).times(sign), 's.taxable': D(sale.taxable_total).times(sign),
    's.cgst': D(sale.cgst_total).times(sign), 's.sgst': D(sale.sgst_total).times(sign), 's.igst': D(sale.igst_total).times(sign), 's.round_off': D(sale.round_off).times(sign),
    's.total': D(sale.grand_total).times(sign), 's.cogs': D(sale.cogs_total).times(sign), 's.units': sign * (sale.lines as Row[]).reduce((a, l) => a + l.qty, 0),
    [`cashier.${sale.created_by}.count`]: sign, [`cashier.${sale.created_by}.total`]: D(sale.grand_total).times(sign),
  }
  if (sale.cost_complete === false) add['s.cost_incomplete'] = sign
  for (const l of sale.lines as Row[]) {
    add[`book.${l.book_id}.qty`] = (Number(add[`book.${l.book_id}.qty`] ?? 0)) + sign * l.qty
    add[`book.${l.book_id}.net`] = D(add[`book.${l.book_id}.net`]).plus(D(l.taxable_value).times(sign))
    add[`book.${l.book_id}.cogs`] = D(add[`book.${l.book_id}.cogs`]).plus(D(l.unit_cost).times(l.qty).times(sign))
    const cat = books.get(l.book_id)?.category_id ?? 'NONE'
    add[`cat.${cat}.qty`] = (Number(add[`cat.${cat}.qty`] ?? 0)) + sign * l.qty
    add[`cat.${cat}.net`] = D(add[`cat.${cat}.net`]).plus(D(l.taxable_value).times(sign))
    add[`cat.${cat}.cogs`] = D(add[`cat.${cat}.cogs`]).plus(D(l.unit_cost).times(l.qty).times(sign))
    const rateKey = `${(l.hsn_code ?? '').replace(/\./g, '')}|${D(l.tax_rate).toFixed(2).replace('.', '_')}`
    add[`gst.${rateKey}.taxable`] = D(add[`gst.${rateKey}.taxable`]).plus(D(l.taxable_value).times(sign))
    add[`gst.${rateKey}.cgst`] = D(add[`gst.${rateKey}.cgst`]).plus(D(l.cgst).times(sign))
    add[`gst.${rateKey}.sgst`] = D(add[`gst.${rateKey}.sgst`]).plus(D(l.sgst).times(sign))
    add[`gst.${rateKey}.igst`] = D(add[`gst.${rateKey}.igst`]).plus(D(l.igst).times(sign))
    add[`gst.${rateKey}.qty`] = (Number(add[`gst.${rateKey}.qty`] ?? 0)) + sign * l.qty
  }
  for (const p of (sale.payments as Row[]).filter((x) => x.direction === 'IN')) {
    add[`pay.${p.method_code}.amount`] = D(add[`pay.${p.method_code}.amount`]).plus(D(p.amount).times(sign))
    add[`pay.${p.method_code}.count`] = (Number(add[`pay.${p.method_code}.count`] ?? 0)) + sign
  }
  await bumpBoth(u, sale.location_id, date, add)
  await u.update(`daily/${sale.location_id}~${date}`, { [`names`]: { ...(((await u.get(`daily/${sale.location_id}~${date}`))?.names) ?? {}), [sale.created_by]: sale.cashier } })
}

async function customerAdd(u: Uow, customerId: string, add: Record<string, Num>, extra: Record<string, unknown> = {}) {
  const path = shardPath('customers', customerId)
  const doc = await u.get(path)
  const c = (doc?.m ?? {})[customerId]
  if (!c) throw NotFound('Customer not found')
  const next = { ...c, ...extra }
  for (const [k, v] of Object.entries(add)) next[k] = k === 'visits' || k === 'loyalty_points' ? (next[k] ?? 0) + Number(v) : s2(D(next[k]).plus(D(v)))
  await u.setEntry(path, customerId, next)
  return next
}

route('POST', '/pos/checkout', async ({ body, headers }, ctx) => {
  ctx.require('pos.sell')
  const key = String(headers['Idempotency-Key'] ?? '')
  if (key.length < 8 || key.length > 80) throw fieldError('idempotency-key', 'Idempotency-Key header is required')
  const q = quoteInput(body)
  const existingKey = await getOne(`idempotency/sale~${key}`)
  if (existingKey) {
    const sale = await getOne(`sales/${existingKey.id}`)
    if (sale) {
      ctx.ensureResource(sale.location_id)
      return { ...(await saleDetail(ctx, sale)), replayed: true }
    }
  }
  ctx.ensureLocation(q.location_id)
  const loc = await byId('locations', q.location_id)
  if (!loc || !loc.is_active || loc.type !== 'OUTLET') throw ValidationFailed('Sales can only be made at an active outlet')
  const customer = q.customer_id ? await entry('customers', q.customer_id) : null
  if (q.customer_id && (!customer || !customer.is_active)) throw ValidationFailed('Customer not found or inactive')
  const { lines, bill, meta, org, policy } = await quote(q)
  const methods = new Map((await all('payment_methods')).map((m) => [m.id, m]))
  const reason = clean(body.discount_reason)
  // copies to pick (outside the transaction: query, then re-read inside)
  const sale = await tx(async (u) => {
    if (await u.get(`idempotency/sale~${key}`)) throw Conflict('This sale was already submitted', { code: 'duplicate' })
    const session = await u.get(`register_sessions/${String(body.register_session_id ?? '')}`)
    if (!session || session.location_id !== q.location_id || session.status !== 'OPEN') throw Conflict('Open a register session at this outlet before selling', { code: 'register_closed' })
    const approval = await checkDiscounts(u, ctx, policy, q.location_id, lines, bill, (body.discount_approval_id as string) || null)
    if (bill.discount_total.gt(0) && !reason && (approval || bill.discount_total.div(bill.gross.gt(1) ? bill.gross : D(1)).times(100).gt(D(policy.max_discount_pct)))) throw ValidationFailed('A reason is required for this discount')

    // payments, validated before anything is written
    let paid = ZERO
    const payRows: { m: Row; amt: Decimal; tendered: Decimal | null; change: Decimal | null; reference: string | null }[] = []
    for (const p of (body.payments ?? []) as Record<string, unknown>[]) {
      const m = methods.get(String(p.payment_method_id))
      if (!m || (!m.is_active && m.kind !== 'EXCHANGE')) throw ValidationFailed('Payment method not available')
      const amt = r2(p.amount as Num)
      if (amt.lte(0)) throw ValidationFailed('Payment amounts must be positive')
      if (m.kind === 'CREDIT') throw ValidationFailed('Credit is not a tender; leave the balance unpaid to create a credit sale')
      const reference = clean(p.reference)
      if (m.requires_reference && !reference) throw ValidationFailed(`${m.name} payments need a reference (transaction ID)`)
      const tendered = p.tendered === null || p.tendered === undefined || p.tendered === '' ? null : r2(p.tendered as Num)
      let change: Decimal | null = null
      if (m.kind === 'CASH' && tendered !== null) {
        if (tendered.lt(amt)) throw ValidationFailed('Cash tendered is less than the amount')
        change = tendered.minus(amt)
      } else if (tendered !== null && !tendered.eq(amt)) throw ValidationFailed('Only cash payments can return change')
      paid = paid.plus(amt)
      payRows.push({ m, amt, tendered, change, reference })
    }
    if (paid.gt(bill.grand_total)) throw ValidationFailed(`Payments (${paid.toFixed(2)}) exceed the bill total (${bill.grand_total.toFixed(2)})`)
    const balance = bill.grand_total.minus(paid)
    let cust: Row | null = null
    if (customer) cust = ((await u.get(shardPath('customers', customer.id)))?.m ?? {})[customer.id] ?? null
    if (balance.gt(0)) {
      if (!policy.credit_sales_enabled) throw ValidationFailed(`Payment incomplete: ${balance.toFixed(2)} still due`, { code: 'payment_incomplete' })
      if (!ctx.has('pos.credit_sale')) throw Forbidden('You are not allowed to create credit sales')
      if (!cust) throw ValidationFailed('Credit sales require a registered customer')
      if (D(cust.outstanding).plus(balance).gt(D(cust.credit_limit))) throw Conflict('Customer credit limit exceeded', { code: 'credit_limit' })
    }
    const creditUsed = sum(payRows.filter((p) => p.m.kind === 'STORE_CREDIT').map((p) => p.amt))
    if (creditUsed.gt(0)) {
      if (!cust) throw ValidationFailed('Store credit requires a customer')
      if (D(cust.store_credit).lt(creditUsed)) throw Conflict('Insufficient store credit', { code: 'insufficient_store_credit' })
    }
    const exAmt = sum(payRows.filter((p) => p.m.kind === 'EXCHANGE').map((p) => p.amt))
    let exchange: Row | null = null
    if (body.exchange_return_id || exAmt.gt(0)) {
      exchange = body.exchange_return_id ? await u.get(`returns/${body.exchange_return_id}`) : null
      if (!exchange || exchange.status !== 'COMPLETED' || exchange.refund_method_kind !== 'EXCHANGE' || exchange.location_id !== q.location_id) throw ValidationFailed('Exchange credit not found for this outlet')
      if (!exAmt.eq(D(exchange.refund_total))) throw ValidationFailed(`Apply the full exchange credit of ${s2(exchange.refund_total)}`)
      if (exchange.exchange_sale_id) throw Conflict('This exchange credit has already been used')
    }

    // stock
    const st = new StockTx(u, { uid: ctx.uid, name: ctx.name })
    const saleId = newId()
    const ref = { type: 'SALE', id: saleId, number: null as string | null }
    const need = new Map<string, number>()
    for (const l of lines) need.set(l.book.id, (need.get(l.book.id) ?? 0) + l.qty)
    for (const [bookId, qty] of need) {
      const b = await st.bal(q.location_id, bookId)
      if (b.on_hand - b.reserved < qty) throw Conflict(`Insufficient stock for '${lines.find((l) => l.book.id === bookId)!.book.title}': available ${b.on_hand - b.reserved}, requested ${qty}`, { code: 'insufficient_stock', details: { book_id: bookId } })
    }
    const copies = new Map<string, Row>()
    for (const l of lines) {
      if (l.book.tracking_mode !== 'COPY') continue
      const c = l.copy_id ? await u.get(`copies/${l.copy_id}`) : (await pickCopies(u, { book_id: l.book.id, location_id: q.location_id, qty: 1 }).then((x) => x.find((cc) => !copies.has(cc.id)) ?? x[0]))
      if (!c) throw NotFound('Copy not found')
      if (c.book_id !== l.book.id || c.location_id !== q.location_id || c.status !== 'AVAILABLE' || copies.has(c.id)) throw Conflict(`Copy ${c.copy_code} is not available for sale here (status ${String(c.status).toLowerCase()})`, { code: 'copy_unavailable' })
      l.copy_id = c.id
      copies.set(c.id, c)
    }
    const fy = financialYear(localDate())
    const number = await u.nextNumber('SALES_INVOICE', { scope: q.location_id, prefix: loc.invoice_prefix, fy, width: 6 })
    ref.number = number
    let cogs = ZERO
    let costComplete = true
    const saleLines: Row[] = []
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i], r = bill.lines[i]
      const b = await st.bal(q.location_id, l.book.id)
      const unitCost = b.avg_cost
      if (unitCost === null) costComplete = false
      else cogs = cogs.plus(r2(D(unitCost).times(l.qty)))
      saleLines.push({
        id: `${saleId}-${i + 1}`, line_no: i + 1, book_id: l.book.id, copy_id: l.copy_id, copy_code: l.copy_id ? copies.get(l.copy_id)?.copy_code ?? null : null, title: String(l.book.title).slice(0, 300), hsn_code: l.book.hsn_code ?? null, qty: l.qty,
        unit_price: s2(l.unit_price), mrp: l.book.mrp, line_discount: s2(r.line_discount), bill_discount_alloc: s2(r.bill_discount_alloc), taxable_value: s2(r.taxable_value), tax_rate: s2(l.tax_rate),
        cgst: s2(r.cgst), sgst: s2(r.sgst), igst: s2(r.igst), line_total: s2(r.line_total), unit_cost: unitCost,
      } as Row)
      await st.apply(b, { bucket: 'ON_HAND', delta: -l.qty, movement_type: 'SALE', ref, unit_cost: unitCost, copy_id: l.copy_id, check_available: true })
      if (l.copy_id) await moveCopy(u, copies.get(l.copy_id)!, { event: 'SOLD', to_status: 'SOLD', ref, actor: ctx })
    }
    await st.commit()

    const legs: Leg[] = []
    const payments: Row[] = []
    for (const p of payRows) {
      const pid = newId()
      const pay = { number: payNumber(), direction: 'IN', purpose: 'SALE', payment_method_id: p.m.id, method: p.m.name, method_code: p.m.code, method_kind: p.m.kind, account_id: p.m.account_id, amount: s2(p.amt),
        tendered: s2n(p.tendered as Num), change_given: s2n(p.change as Num), reference: p.reference, location_id: q.location_id, register_session_id: session.id, customer_id: customer?.id ?? null,
        created_by: ctx.uid, created_at: u.at, allocations: [{ sale_id: saleId, amount: s2(p.amt) }], sale_ids: [saleId] }
      u.set(`payments/${pid}`, pay)
      payments.push({ ...pay, id: pid } as Row)
      legs.push({ account: p.m.account_id, amount: p.amt })
      await sessionAdd(u, session.id, { method: p.m, direction: 'IN', amount: p.amt })
      if (p.m.kind === 'STORE_CREDIT') u.add('customer_ledger', { customer_id: customer!.id, kind: 'STORE_CREDIT', delta: s2(p.amt.neg()), ref_type: 'SALE', ref_id: saleId, note: `Used on ${number}`, actor_id: ctx.uid, actor_name: ctx.name })
    }
    if (balance.gt(0)) legs.push({ account: 'AR', amount: balance })
    legs.push({ account: 'SALES', amount: bill.taxable_total.neg() }, { account: 'OUTPUT_CGST', amount: bill.cgst_total.neg() }, { account: 'OUTPUT_SGST', amount: bill.sgst_total.neg() }, { account: 'OUTPUT_IGST', amount: bill.igst_total.neg() }, { account: 'ROUND_OFF', amount: bill.round_off.neg() })
    if (!cogs.eq(0)) legs.push({ account: 'COGS', amount: cogs }, { account: 'INVENTORY', amount: cogs.neg() })
    const je = await post(u, { source_type: 'SALE', source_id: saleId, location_id: q.location_id, actor_id: ctx.uid, memo: `Sale ${number}`, legs })

    const seller = {
      legal_name: org.legal_name, trade_name: org.trade_name, gstin: loc.gstin || org.gstin, registration_type: org.gst_registration_type, pan: org.pan, location_name: loc.name,
      address: [loc.address_line1, loc.address_line2, loc.city, loc.state, loc.pincode].filter(Boolean).join(', '), state_code: loc.state_code, state: STATE_CODES[loc.state_code] ?? null, phone: loc.phone ?? null, email: loc.email ?? null,
    }
    const buyer = cust ? { name: cust.name, phone: cust.phone ?? null, email: cust.email ?? null, gstin: cust.gstin ?? null, address: cust.billing_address ?? null, state_code: cust.state_code ?? null } : { name: 'Walk-in customer' }
    const doc: Row = {
      id: saleId, location_id: q.location_id, register_session_id: session.id, customer_id: customer?.id ?? null, customer_name: cust?.name ?? null, status: 'COMPLETED',
      prices_include_tax: meta.prices_include_tax, is_interstate: meta.interstate, place_of_supply: meta.place_of_supply, gross_amount: s2(bill.gross), line_discount_total: s2(bill.line_discount_total),
      bill_discount: s2(bill.bill_discount), discount_total: s2(bill.discount_total), taxable_total: s2(bill.taxable_total), cgst_total: s2(bill.cgst_total), sgst_total: s2(bill.sgst_total), igst_total: s2(bill.igst_total),
      tax_total: s2(bill.tax_total), round_off: s2(bill.round_off), grand_total: s2(bill.grand_total), amount_paid: s2(paid), balance_due: s2(balance), has_balance: balance.gt(0),
      cogs_total: costComplete ? s2(cogs) : (cogs.gt(0) ? s2(cogs) : null), cost_complete: costComplete, discount_reason: reason, discount_approval_id: approval?.id ?? null,
      exchange_return_id: exchange?.id ?? null, notes: clean(body.notes), idempotency_key: key, created_by: ctx.uid, cashier: ctx.name, created_at: u.at, journal_entry_id: je,
      invoice_number: number, invoice: { id: saleId, number, doc_type: meta.doc_type, issued_at: u.at, seller, buyer, place_of_supply: meta.place_of_supply, status: 'ISSUED', financial_year: fy },
      lines: saleLines, payments: payments.map((p) => ({ id: p.id, number: p.number, direction: p.direction, purpose: p.purpose, method: p.method, method_code: p.method_code, method_kind: p.method_kind, payment_method_id: p.payment_method_id, amount: p.amount, tendered: p.tendered, change_given: p.change_given, reference: p.reference, created_at: p.created_at })),
      payment_method_ids: [...new Set(payRows.map((p) => p.m.id))], returned: {}, items: lines.reduce((a, l) => a + l.qty, 0), cancelled_by: null, cancelled_at: null, cancel_reason: null,
    }
    u.set(`sales/${saleId}`, doc)
    u.set(`idempotency/sale~${key}`, { kind: 'sale', id: saleId, created_at: u.at })
    if (exchange) await u.update(`returns/${exchange.id}`, { exchange_sale_id: saleId })
    await sessionAdd(u, session.id, { sale: bill.grand_total })
    await bumpSale(u, doc, 1, localDate())
    if (customer) {
      const add: Record<string, Num> = { spend: bill.grand_total, visits: 1, outstanding: balance, store_credit: creditUsed.neg() }
      if (policy.loyalty_enabled && D(policy.loyalty_points_per_100).gt(0)) {
        const points = Math.floor(bill.taxable_total.div(100).times(D(policy.loyalty_points_per_100)).toNumber())
        if (points > 0) {
          add.loyalty_points = points
          u.add('customer_ledger', { customer_id: customer.id, kind: 'LOYALTY', delta: String(points), ref_type: 'SALE', ref_id: saleId, note: `Earned on ${number}`, actor_id: ctx.uid, actor_name: ctx.name })
          await u.update(`sales/${saleId}`, { loyalty_earned: points })
        }
      }
      await customerAdd(u, customer.id, add, { last_purchase_at: u.at })
    }
    ctx.audit(u, 'pos.sale_completed', { entity_type: 'sale', entity_id: saleId, location_id: q.location_id, details: { invoice: number, total: s2(bill.grand_total), discount: s2(bill.discount_total), approval: approval?.id ?? null } })
    return doc
  })
  return { ...(await saleDetail(ctx, sale)), replayed: false }
})

// ================================================================ sales history
function taxSummary(lines: Row[]) {
  const g = new Map<string, Row>()
  for (const l of lines) {
    const k = `${l.hsn_code ?? ''}|${l.tax_rate}`
    const x = g.get(k) ?? ({ hsn_code: l.hsn_code ?? '', tax_rate: l.tax_rate, taxable_value: ZERO, cgst: ZERO, sgst: ZERO, igst: ZERO } as unknown as Row)
    x.taxable_value = (x.taxable_value as Decimal).plus(D(l.taxable_value)); x.cgst = (x.cgst as Decimal).plus(D(l.cgst)); x.sgst = (x.sgst as Decimal).plus(D(l.sgst)); x.igst = (x.igst as Decimal).plus(D(l.igst))
    g.set(k, x)
  }
  return [...g.values()].sort((a, b) => String(a.hsn_code).localeCompare(String(b.hsn_code)) || D(a.tax_rate).cmp(D(b.tax_rate)))
    .map((x) => ({ ...x, taxable_value: s2(x.taxable_value), cgst: s2(x.cgst), sgst: s2(x.sgst), igst: s2(x.igst) }))
}
export async function saleDetail(ctx: Ctx, sale: Row) {
  const loc = await byId('locations', sale.location_id)
  const returns = await find('returns', where('sale_id', '==', sale.id))
  const showCost = ctx.has('reports.financial')
  const returned = (sale.returned ?? {}) as Record<string, Row>
  return {
    id: sale.id, status: sale.status, location_id: sale.location_id, location_name: loc?.name ?? '', register_session_id: sale.register_session_id, customer_id: sale.customer_id, customer_name: sale.customer_name,
    invoice: sale.invoice ?? null, prices_include_tax: sale.prices_include_tax, is_interstate: sale.is_interstate,
    lines: (sale.lines as Row[]).map((l) => ({ ...l, qty_returned: returned[l.id]?.qty ?? 0, unit_cost: showCost ? l.unit_cost : null })),
    tax_summary: taxSummary(sale.lines as Row[]), gross_amount: sale.gross_amount, line_discount_total: sale.line_discount_total, bill_discount: sale.bill_discount, discount_total: sale.discount_total,
    taxable_total: sale.taxable_total, cgst_total: sale.cgst_total, sgst_total: sale.sgst_total, igst_total: sale.igst_total, tax_total: sale.tax_total, round_off: sale.round_off, grand_total: sale.grand_total,
    amount_in_words: amountInWords(sale.grand_total), amount_paid: sale.amount_paid, balance_due: s2(D(sale.grand_total).minus(D(sale.amount_paid))), discount_reason: sale.discount_reason,
    cogs_total: showCost ? sale.cogs_total : null, cost_complete: sale.cost_complete, payments: sale.payments ?? [],
    returns: returns.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map((r) => ({ id: r.id, number: r.number, status: r.status, refund_total: r.refund_total, created_at: r.created_at })),
    cashier: sale.cashier, created_at: sale.created_at, cancelled_at: sale.cancelled_at, cancel_reason: sale.cancel_reason, notes: sale.notes,
  }
}

export async function salesIn(ctx: Ctx, o: { location_id?: string | null; from?: string | null; to?: string | null; max?: number; extra?: Parameters<typeof where>[] }): Promise<Row[]> {
  if (o.location_id) ctx.ensureLocation(o.location_id)
  const cs = []
  if (o.from || o.to) {
    const [a, b] = isoRange(o.from ?? '2000-01-01', o.to ?? '2999-12-31')
    cs.push(where('created_at', '>=', a), where('created_at', '<', b))
  }
  return findScoped('sales', o.location_id ? [o.location_id] : ctx.scope(), 'location_id', ...cs, orderBy('created_at', 'desc'), limit(o.max ?? 2000))
}

route('GET', '/sales', async ({ query }, ctx) => {
  ctx.require('sales.view')
  let rows = await salesIn(ctx, { location_id: query.location_id, from: query.date_from, to: query.date_to })
  const custs = await entries('customers').catch(() => new Map<string, Row>())
  rows = rows.filter((s) => (!query.customer_id || s.customer_id === query.customer_id) && (!query.status || s.status === query.status)
    && (!query.register_session_id || s.register_session_id === query.register_session_id) && (!query.payment_method_id || (s.payment_method_ids ?? []).includes(query.payment_method_id))
    && (query.has_balance !== 'true' || (s.status === 'COMPLETED' && D(s.grand_total).gt(D(s.amount_paid))))
    && (!query.q || matches(query.q, s.invoice_number, s.customer_name, custs.get(s.customer_id)?.phone)))
  return paginate(rows.map((s) => ({
    id: s.id, invoice_number: s.invoice_number, doc_type: s.invoice?.doc_type ?? null, location_id: s.location_id, location_name: '', customer_id: s.customer_id, customer_name: s.customer_name, status: s.status,
    grand_total: s.grand_total, discount_total: s.discount_total, tax_total: s.tax_total, amount_paid: s.amount_paid, balance_due: s2(D(s.grand_total).minus(D(s.amount_paid))), items: s.items, cashier: s.cashier, created_at: s.created_at,
  })), Number(query.page), Number(query.page_size))
})

async function getSale(ctx: Ctx, id: string): Promise<Row> {
  const s = await getOne(`sales/${id}`)
  if (!s) throw NotFound('Sale not found')
  ctx.ensureResource(s.location_id)
  return s
}
route('GET', '/sales/by-invoice/:number*', async ({ params }, ctx) => {
  ctx.requireAny('sales.view', 'returns.create')
  const number = params.number.trim().toUpperCase()
  const rows = ctx.all_locations ? await find('sales', where('invoice_number', '==', number), limit(1)) : await findScoped('sales', ctx.location_ids, 'location_id', where('invoice_number', '==', number), limit(1))
  if (!rows.length) throw NotFound('Invoice not found')
  return saleDetail(ctx, rows[0])
})
route('GET', '/sales/:id', async ({ params }, ctx) => {
  ctx.requireAny('sales.view', 'returns.create')
  return saleDetail(ctx, await getSale(ctx, params.id))
})

async function voidSale(u: Uow, ctx: Ctx, saleId: string, reason: string) {
  const sale = await u.get(`sales/${saleId}`)
  if (!sale) throw NotFound('Sale not found')
  if (sale.status !== 'COMPLETED') throw Conflict('Sale is already cancelled')
  if ((await find('returns', where('sale_id', '==', sale.id))).some((r) => r.status !== 'REJECTED')) throw Conflict('Sale has returns; use the returns workflow instead')
  if (sale.exchange_return_id) throw Conflict('Exchange sales cannot be voided; process a return instead')
  const session = await u.need(`register_sessions/${sale.register_session_id}`, 'Register session')
  if (session.status !== 'OPEN') throw Conflict('The register session is closed; use the returns workflow instead')
  if (!D(sale.amount_paid).eq(D(sale.grand_total))) throw Conflict('Sales with partial payments or receivables cannot be voided')
  const ref = { type: 'SALE_VOID', id: sale.id, number: sale.invoice_number }
  const st = new StockTx(u, { uid: ctx.uid, name: ctx.name })
  for (const l of sale.lines as Row[]) {
    const b = await st.bal(sale.location_id, l.book_id)
    st.receiveCost(b, l.qty, l.unit_cost)
    await st.apply(b, { bucket: 'ON_HAND', delta: l.qty, movement_type: 'SALE_VOID', ref, unit_cost: l.unit_cost, copy_id: l.copy_id })
    if (l.copy_id) {
      const c = await u.need(`copies/${l.copy_id}`, 'Copy')
      if (c.status !== 'SOLD') throw Conflict(`Copy ${c.copy_code} is not in sold state`)
      await moveCopy(u, c, { event: 'SALE_VOIDED', to_status: 'AVAILABLE', ref, actor: ctx })
    }
  }
  await st.commit()
  const methods = new Map((await all('payment_methods')).map((m) => [m.id, m]))
  const refunds: Row[] = []
  for (const p of (sale.payments as Row[]).filter((x) => x.direction === 'IN')) {
    const m = methods.get(p.payment_method_id)!
    const pid = newId()
    const refund = { number: payNumber(), direction: 'OUT', purpose: 'SALE_VOID', payment_method_id: m.id, method: m.name, method_code: m.code, method_kind: m.kind, account_id: m.account_id, amount: p.amount,
      reference: p.reference, location_id: sale.location_id, register_session_id: session.id, customer_id: sale.customer_id, created_by: ctx.uid, created_at: u.at, notes: `Void of ${ref.number}`,
      allocations: [{ sale_id: sale.id, amount: p.amount }], sale_ids: [sale.id], tendered: null, change_given: null }
    u.set(`payments/${pid}`, refund)
    refunds.push({ id: pid, number: refund.number, direction: 'OUT', purpose: 'SALE_VOID', method: m.name, method_code: m.code, method_kind: m.kind, payment_method_id: m.id, amount: p.amount, tendered: null, change_given: null, reference: p.reference, created_at: u.at } as Row)
    await sessionAdd(u, session.id, { method: m, direction: 'OUT', amount: p.amount })
    if (m.kind === 'STORE_CREDIT') u.add('customer_ledger', { customer_id: sale.customer_id, kind: 'STORE_CREDIT', delta: s2(p.amount), ref_type: 'SALE_VOID', ref_id: sale.id, note: `Void of ${ref.number}`, actor_id: ctx.uid, actor_name: ctx.name })
  }
  if (sale.loyalty_earned) u.add('customer_ledger', { customer_id: sale.customer_id, kind: 'LOYALTY', delta: String(-sale.loyalty_earned), ref_type: 'SALE_VOID', ref_id: sale.id, note: 'Reversed on void', actor_id: ctx.uid, actor_name: ctx.name })
  if (sale.journal_entry_id) {
    const je = await u.get(`journals/${sale.journal_entry_id}`)
    if (je) await reverse(u, je, { actor_id: ctx.uid, memo: `Void of ${ref.number}`, source_type: 'SALE_VOID' })
  }
  await sessionAdd(u, session.id, { sale: D(sale.grand_total).neg(), voided: true })
  await bumpSale(u, sale, -1, localDate(sale.created_at))
  if (sale.customer_id) {
    const creditBack = sum((sale.payments as Row[]).filter((p) => p.method_kind === 'STORE_CREDIT').map((p) => p.amount))
    await customerAdd(u, sale.customer_id, { spend: D(sale.grand_total).neg(), visits: -1, store_credit: creditBack, loyalty_points: -(sale.loyalty_earned ?? 0) })
  }
  await u.update(`sales/${sale.id}`, { status: 'CANCELLED', cancelled_by: ctx.uid, cancelled_at: u.at, cancel_reason: reason, invoice: { ...sale.invoice, status: 'CANCELLED' }, payments: [...(sale.payments as Row[]), ...refunds] })
  ctx.audit(u, 'pos.sale_voided', { entity_type: 'sale', entity_id: sale.id, location_id: sale.location_id, details: { invoice: ref.number, reason, total: sale.grand_total } })
}
registerApproval('VOID', async (u, ctx, req) => voidSale(u, ctx, req.entity_id, req.reason || 'Approved void'), null)

route('POST', '/sales/:id/void', async ({ params, body }, ctx) => {
  ctx.require('pos.sell')
  const reason = String(body.reason ?? '')
  if (reason.length < 3) throw fieldError('reason', 'String should have at least 3 characters')
  const sale = await getSale(ctx, params.id)
  if (ctx.has('pos.void')) {
    await tx((u) => voidSale(u, ctx, sale.id, reason))
    return { status: 'CANCELLED' }
  }
  if (await pendingFor('sale', sale.id)) throw Conflict('A void request is already pending for this sale')
  if (sale.status !== 'COMPLETED') throw Conflict('Sale is already cancelled')
  const id = await tx(async (u) => createApproval(u, ctx, { type: 'VOID', location_id: sale.location_id, title: `Void invoice ${sale.invoice_number} (₹${sale.grand_total})`, entity_type: 'sale', entity_id: sale.id, amount: sale.grand_total, reason }))
  return { status: 'PENDING_APPROVAL', approval_request_id: id }
})

// ================================================================ customers
function segment(spend: Decimal, visits: number, last: string | null): string {
  if (visits <= 0) return 'NEW'
  if (last && daysBetween(localDate(last), localDate()) > 180) return 'LAPSED'
  if (spend.gte(20000) || visits >= 15) return 'VIP'
  if (visits >= 3) return 'REGULAR'
  return 'OCCASIONAL'
}
function customerOut(c: Row) {
  const spend = D(c.spend)
  return {
    id: c.id, code: c.code, name: c.name, phone: c.phone ?? null, email: c.email ?? null, gstin: c.gstin ?? null, billing_address: c.billing_address ?? null, state_code: c.state_code ?? null, notes: c.notes ?? null,
    marketing_consent: !!c.marketing_consent, credit_limit: s2(c.credit_limit), is_active: c.is_active !== false, created_at: c.created_at, lifetime_spend: s2(spend), visits: c.visits ?? 0,
    last_purchase_at: c.last_purchase_at ?? null, store_credit: s2(c.store_credit), loyalty_points: s2(c.loyalty_points ?? 0), outstanding: s2(c.outstanding), segment: segment(spend, c.visits ?? 0, c.last_purchase_at ?? null),
  }
}
function customerIn(b: Record<string, unknown>) {
  const name = clean(b.name) ?? ''
  if (!name) throw fieldError('name', 'String should have at least 1 character')
  const phone = clean(b.phone)
  if (phone && !/^\+?\d{7,15}$/.test(phone)) throw fieldError('phone', 'String should match pattern ^\\+?\\d{7,15}$')
  const email = clean(b.email)?.toLowerCase() ?? null
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fieldError('email', 'value is not a valid email address')
  let gstin = clean(b.gstin)?.toUpperCase() ?? null
  if (gstin && !validGstin(gstin)) throw fieldError('gstin', 'Invalid GSTIN (format or checksum)')
  gstin = gstin || null
  const state = clean(b.state_code)
  if (state && !/^\d{2}$/.test(state)) throw fieldError('state_code', 'String should match pattern ^\\d{2}$')
  const limitV = Number(b.credit_limit ?? 0)
  if (!(limitV >= 0)) throw fieldError('credit_limit', 'Input should be greater than or equal to 0')
  return { name, phone, email, gstin, billing_address: clean(b.billing_address), state_code: state ?? (gstin ? gstin.slice(0, 2) : null), notes: clean(b.notes), marketing_consent: !!b.marketing_consent, credit_limit: s2(limitV), is_active: b.is_active !== false }
}
async function getCustomer(id: string): Promise<Row> {
  const c = await entry('customers', id)
  if (!c) throw NotFound('Customer not found')
  return c
}
route('GET', '/customers', async ({ query }, ctx) => {
  ctx.requireAny('customers.view', 'pos.sell')
  const rows = [...(await entries('customers')).values()].map(customerOut)
    .filter((c) => matches(query.q, c.name, c.phone, c.email, c.code, c.gstin) && (query.with_balance !== 'true' || D(c.outstanding).gt(0)) && (!query.segment || c.segment === query.segment))
    .sort((a, b) => a.name.localeCompare(b.name))
  return paginate(rows, Number(query.page), Number(query.page_size))
})
route('POST', '/customers/check-duplicates', async ({ body }, ctx) => {
  ctx.requireAny('customers.view', 'pos.sell')
  const v = customerIn(body)
  const { similarity } = await import('./catalog')
  return [...(await entries('customers')).values()].filter((c) => similarity(c.name, v.name) > 0.55 || (v.phone && c.phone === v.phone) || (v.email && lc(c.email) === v.email) || (v.gstin && c.gstin === v.gstin)).slice(0, 10).map(customerOut)
})
route('POST', '/customers', async ({ body, query }, ctx) => {
  ctx.require('customers.manage')
  const v = customerIn(body)
  if (D(v.credit_limit).gt(0) && !ctx.has('finance.manage') && !ctx.has('registers.manage')) throw ValidationFailed('Only managers can set a credit limit')
  if (v.phone && [...(await entries('customers')).values()].some((c) => c.phone === v.phone)) throw Conflict('A customer with this phone number already exists')
  if (query.location_id) ctx.ensureLocation(query.location_id)
  return tx(async (u) => {
    const id = newId()
    const c = { ...v, code: await u.nextCode('CUSTOMER', 'C', 6), consent_updated_at: v.marketing_consent ? u.at : null, home_location_id: query.location_id ?? null, created_by: ctx.uid, created_at: u.at,
      spend: '0.00', visits: 0, outstanding: '0.00', store_credit: '0.00', loyalty_points: 0, last_purchase_at: null }
    await u.setEntry(shardPath('customers', id), id, c)
    ctx.audit(u, 'customers.created', { entity_type: 'customer', entity_id: id, location_id: query.location_id ?? null, details: { name: c.name } })
    return customerOut({ ...c, id })
  })
})
route('GET', '/customers/:id', async ({ params }, ctx) => {
  ctx.requireAny('customers.view', 'pos.sell')
  return customerOut(await getCustomer(params.id))
})
route('PUT', '/customers/:id', async ({ params, body }, ctx) => {
  ctx.require('customers.manage')
  const c = await getCustomer(params.id)
  const v = customerIn(body)
  if (v.credit_limit !== s2(c.credit_limit) && !ctx.has('finance.manage') && !ctx.has('registers.manage')) throw ValidationFailed('Only managers can change a credit limit')
  if (v.phone && v.phone !== c.phone && [...(await entries('customers')).values()].some((x) => x.phone === v.phone)) throw Conflict('A customer with this phone number already exists')
  return tx(async (u) => {
    const cur = ((await u.get(shardPath('customers', c.id)))?.m ?? {})[c.id]
    const next = { ...cur, ...v, consent_updated_at: v.marketing_consent !== !!cur.marketing_consent ? u.at : (cur.consent_updated_at ?? null) }
    await u.setEntry(shardPath('customers', c.id), c.id, next)
    ctx.audit(u, 'customers.updated', { entity_type: 'customer', entity_id: c.id, details: { before: customerOut({ ...cur, id: c.id }), after: v } })
    return customerOut({ ...next, id: c.id })
  })
})
route('DELETE', '/customers/:id', async ({ params }, ctx) => {
  ctx.require('customers.manage')
  const c = await getCustomer(params.id)
  if ((c.visits ?? 0) > 0 || !D(c.outstanding).eq(0) || !D(c.store_credit).eq(0) || (await find('sales', where('customer_id', '==', c.id), limit(1)).catch(() => [])).length) {
    throw Conflict('This customer has bills or balances; deactivate them instead')
  }
  await tx(async (u) => {
    await u.setEntry(shardPath('customers', c.id), c.id, null)
    ctx.audit(u, 'customers.deleted', { entity_type: 'customer', entity_id: c.id, details: { name: c.name } })
  })
  return undefined
})
route('GET', '/customers/:id/history', async ({ params }, ctx) => {
  ctx.requireAny('customers.view', 'pos.sell')
  const c = await getCustomer(params.id)
  const scope = ctx.scope()
  const sales = (await findScoped('sales', scope, 'location_id', where('customer_id', '==', c.id), limit(200))).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  const rets = (await findScoped('returns', scope, 'location_id', where('customer_id', '==', c.id), limit(200))).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  const ledger = ctx.has('customers.view') || ctx.has('finance.view') ? (await find('customer_ledger', where('customer_id', '==', c.id), limit(500))).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 200) : []
  const locs = new Map((await all('locations')).map((l) => [l.id, l.name]))
  return {
    sales: sales.map((s) => ({ id: s.id, invoice_number: s.invoice_number, location: locs.get(s.location_id) ?? '', status: s.status, grand_total: s.grand_total, balance_due: s2(D(s.grand_total).minus(D(s.amount_paid))), items: s.items, created_at: s.created_at })),
    returns: rets.map((r) => ({ id: r.id, number: r.number, status: r.status, refund_total: r.refund_total, created_at: r.created_at })),
    ledger: ledger.map((l) => ({ kind: l.kind, delta: l.delta, note: l.note, ref_type: l.ref_type, by: l.actor_name, created_at: l.created_at })),
  }
})
route('POST', '/customers/:id/ledger', async ({ params, body, query }, ctx) => {
  ctx.require('customers.manage')
  const c = await getCustomer(params.id)
  const kind = String(body.kind ?? ''), note = String(body.note ?? ''), delta = r2(body.delta as Num)
  if (!['STORE_CREDIT', 'LOYALTY'].includes(kind)) throw fieldError('kind', 'Invalid kind')
  if (note.length < 3) throw fieldError('note', 'String should have at least 3 characters')
  if (delta.eq(0)) throw ValidationFailed('Adjustment cannot be zero')
  await tx(async (u) => {
    const cur = ((await u.get(shardPath('customers', c.id)))?.m ?? {})[c.id]
    if (kind === 'STORE_CREDIT') {
      if (!ctx.has('finance.manage')) throw ValidationFailed('Store credit adjustments require finance permission')
      if (D(cur.store_credit).plus(delta).lt(0)) throw Conflict('Store credit cannot become negative')
      await post(u, { source_type: 'STORE_CREDIT_ADJ', source_id: c.id, actor_id: ctx.uid, location_id: query.location_id ?? null, memo: `Store credit adjustment — ${c.name}: ${note}`, legs: [{ account: 'LOYALTY_EXPENSE', amount: delta }, { account: 'STORE_CREDIT', amount: delta.neg() }] })
      await customerAdd(u, c.id, { store_credit: delta })
    } else {
      if (!delta.isInteger()) throw ValidationFailed('Loyalty points must be whole numbers')
      if (D(cur.loyalty_points ?? 0).plus(delta).lt(0)) throw Conflict('Loyalty points cannot become negative')
      await customerAdd(u, c.id, { loyalty_points: delta.toNumber() })
    }
    u.add('customer_ledger', { customer_id: c.id, kind, delta: kind === 'LOYALTY' ? delta.toFixed(0) : s2(delta), ref_type: 'MANUAL', ref_id: null, note, actor_id: ctx.uid, actor_name: ctx.name })
    ctx.audit(u, 'customers.ledger_adjusted', { entity_type: 'customer', entity_id: c.id, details: { kind, delta: s2(delta), note } })
  })
  return { message: 'Adjusted' }
})
route('POST', '/customers/:id/redeem-points', async ({ params, query }, ctx) => {
  ctx.require('pos.sell')
  const policy = await getPolicy()
  if (!policy.loyalty_enabled) throw ValidationFailed('Loyalty programme is disabled')
  const points = int(query.points)
  if (points <= 0 || points > 1_000_000) throw fieldError('points', 'Input should be greater than 0')
  const c = await getCustomer(params.id)
  const value = r2(D(points).times(D(policy.loyalty_point_value)))
  if (value.lte(0)) throw ValidationFailed('Point value is zero')
  await tx(async (u) => {
    const cur = ((await u.get(shardPath('customers', c.id)))?.m ?? {})[c.id]
    if ((cur.loyalty_points ?? 0) < points) throw Conflict('Not enough points')
    u.add('customer_ledger', { customer_id: c.id, kind: 'LOYALTY', delta: String(-points), ref_type: 'REDEEM', ref_id: null, note: 'Redeemed', actor_id: ctx.uid, actor_name: ctx.name })
    u.add('customer_ledger', { customer_id: c.id, kind: 'STORE_CREDIT', delta: s2(value), ref_type: 'REDEEM', ref_id: null, note: `${points} points redeemed`, actor_id: ctx.uid, actor_name: ctx.name })
    await post(u, { source_type: 'LOYALTY_REDEEM', source_id: c.id, actor_id: ctx.uid, memo: `Loyalty redemption — ${c.name}`, legs: [{ account: 'LOYALTY_EXPENSE', amount: value }, { account: 'STORE_CREDIT', amount: value.neg() }] })
    await customerAdd(u, c.id, { loyalty_points: -points, store_credit: value })
    ctx.audit(u, 'customers.points_redeemed', { entity_type: 'customer', entity_id: c.id, details: { points, value: s2(value) } })
  })
  return { store_credit_added: s2(value) }
})
route('POST', '/customers/:id/receipts', async ({ params, body, headers }, ctx) => {
  ctx.require('pos.sell')
  const key = String(headers['Idempotency-Key'] ?? '')
  if (key.length < 8) throw fieldError('idempotency-key', 'Idempotency-Key header is required')
  const prior = await getOne(`idempotency/receipt~${key}`)
  if (prior) return { id: prior.id, number: prior.number, amount: prior.amount, replayed: true }
  const locationId = String(body.location_id ?? '')
  ctx.ensureLocation(locationId)
  const c = await getCustomer(params.id)
  const m = await byId('payment_methods', String(body.payment_method_id ?? ''))
  if (!m || ['CREDIT', 'STORE_CREDIT', 'EXCHANGE'].includes(m.kind)) throw ValidationFailed('Payment method not allowed for receipts')
  const reference = clean(body.reference)
  if (m.requires_reference && !reference) throw ValidationFailed('Reference required')
  const amount = r2(body.amount as Num)
  const allocs = ((body.allocations ?? []) as Record<string, unknown>[]).map((a) => ({ sale_id: String(a.sale_id), amount: r2(a.amount as Num) }))
  if (!sum(allocs.map((a) => a.amount)).eq(amount)) throw ValidationFailed('Allocations must equal the amount received')
  return tx(async (u) => {
    let sessionId: string | null = null
    if (m.kind === 'CASH') {
      if (!body.register_session_id) throw ValidationFailed('Cash receipts must be recorded in an open register session')
      const s = await u.get(`register_sessions/${body.register_session_id}`)
      if (!s || s.status !== 'OPEN' || s.location_id !== locationId) throw Conflict('Register session is not open at this location')
      sessionId = s.id
    }
    const pid = newId()
    const number = payNumber()
    for (const a of [...allocs].sort((x, y) => x.sale_id.localeCompare(y.sale_id))) {
      const sale = await u.get(`sales/${a.sale_id}`)
      if (!sale || sale.customer_id !== c.id || sale.status !== 'COMPLETED') throw ValidationFailed('Sale not found for this customer')
      ctx.ensureResource(sale.location_id)
      const due = D(sale.grand_total).minus(D(sale.amount_paid))
      if (a.amount.lte(0) || a.amount.gt(due)) throw ValidationFailed(`Allocation exceeds balance due (${s2(due)})`)
      const paid = D(sale.amount_paid).plus(a.amount)
      await u.update(`sales/${sale.id}`, { amount_paid: s2(paid), balance_due: s2(D(sale.grand_total).minus(paid)), has_balance: D(sale.grand_total).gt(paid),
        payments: [...(sale.payments ?? []), { id: pid, number, direction: 'IN', purpose: 'CUSTOMER_RECEIPT', method: m.name, method_code: m.code, method_kind: m.kind, payment_method_id: m.id, amount: s2(a.amount), tendered: null, change_given: null, reference, created_at: u.at }] })
    }
    u.set(`payments/${pid}`, { number, direction: 'IN', purpose: 'CUSTOMER_RECEIPT', payment_method_id: m.id, method: m.name, method_code: m.code, method_kind: m.kind, account_id: m.account_id, amount: s2(amount), reference,
      location_id: locationId, register_session_id: sessionId, customer_id: c.id, idempotency_key: key, created_by: ctx.uid, created_at: u.at, allocations: allocs.map((a) => ({ sale_id: a.sale_id, amount: s2(a.amount) })), sale_ids: allocs.map((a) => a.sale_id) })
    if (sessionId) await sessionAdd(u, sessionId, { method: m, direction: 'IN', amount })
    const je = await post(u, { source_type: 'CUSTOMER_RECEIPT', source_id: pid, location_id: locationId, actor_id: ctx.uid, memo: `Receipt ${number} from ${c.name}`, legs: [{ account: m.account_id, amount }, { account: 'AR', amount: amount.neg() }] })
    await u.update(`payments/${pid}`, { journal_entry_id: je })
    await customerAdd(u, c.id, { outstanding: amount.neg() })
    u.set(`idempotency/receipt~${key}`, { id: pid, number, amount: s2(amount), created_at: u.at })
    ctx.audit(u, 'finance.customer_receipt', { entity_type: 'payment', entity_id: pid, location_id: locationId, details: { customer: c.name, amount: s2(amount) } })
    return { id: pid, number, amount: s2(amount), replayed: false }
  })
})

// ================================================================ returns & credit notes
const DISPOSITION_BUCKET = { RESTOCK: 'ON_HAND', QUARANTINE: 'QUARANTINED', DAMAGED: 'DAMAGED' } as const
const DISPOSITION_COPY: Record<string, string> = { RESTOCK: 'AVAILABLE', QUARANTINE: 'QUARANTINED', DAMAGED: 'DAMAGED' }

async function completeReturn(u: Uow, ctx: Ctx, ret: Row) {
  const sale = await u.need(`sales/${ret.sale_id}`, 'Sale')
  const method = (await byId('payment_methods', ret.refund_method_id))!
  const ref = { type: 'RETURN', id: ret.id, number: ret.number }
  const st = new StockTx(u, { uid: ctx.uid, name: ctx.name })
  let costBack = ZERO
  for (const l of ret.lines as Row[]) {
    const b = await st.bal(ret.location_id, l.book_id)
    st.receiveCost(b, l.qty, l.unit_cost)
    await st.apply(b, { bucket: DISPOSITION_BUCKET[l.disposition as keyof typeof DISPOSITION_BUCKET], delta: l.qty, movement_type: 'SALE_RETURN', ref, unit_cost: l.unit_cost, copy_id: l.copy_id, note: `${l.disposition} (${l.condition})` })
    if (l.copy_id) {
      const c = await u.need(`copies/${l.copy_id}`, 'Copy')
      if (c.status !== 'SOLD') throw Conflict(`Copy ${c.copy_code} is not in sold state; cannot accept return`)
      await moveCopy(u, c, { event: 'RETURNED_BY_CUSTOMER', to_status: DISPOSITION_COPY[l.disposition], ref, actor: ctx, to_location_id: ret.location_id, condition: l.condition })
    }
    if (l.unit_cost !== null && l.unit_cost !== undefined) costBack = costBack.plus(r2(D(l.unit_cost).times(l.qty)))
  }
  await st.commit()
  const loc = (await byId('locations', ret.location_id))!
  const fy = financialYear(localDate())
  const cnNumber = await u.nextNumber('CREDIT_NOTE', { scope: ret.location_id, prefix: `${loc.invoice_prefix}C`, fy, width: 5 })
  const creditNote = { id: ret.id, number: cnNumber, issued_at: u.at, seller: sale.invoice?.seller ?? null, buyer: sale.invoice?.buyer ?? null, place_of_supply: sale.place_of_supply, original_invoice_number: sale.invoice_number }
  const legs: Leg[] = [{ account: 'SALES_RETURNS', amount: ret.taxable_total }, { account: 'OUTPUT_CGST', amount: ret.cgst_total }, { account: 'OUTPUT_SGST', amount: ret.sgst_total }, { account: 'OUTPUT_IGST', amount: ret.igst_total }, { account: 'ROUND_OFF', amount: ret.round_off }]
  if (['STORE_CREDIT', 'EXCHANGE'].includes(method.kind)) {
    legs.push({ account: method.account_id, amount: D(ret.refund_total).neg() })
    if (method.kind === 'STORE_CREDIT') {
      u.add('customer_ledger', { customer_id: sale.customer_id, kind: 'STORE_CREDIT', delta: s2(ret.refund_total), ref_type: 'RETURN', ref_id: ret.id, note: `Refund ${ret.number}`, actor_id: ctx.uid, actor_name: ctx.name })
      await customerAdd(u, sale.customer_id, { store_credit: ret.refund_total })
    }
  } else if (D(ret.refund_total).gt(0)) {
    if (method.kind === 'CASH') {
      const s = ret.register_session_id ? await u.get(`register_sessions/${ret.register_session_id}`) : null
      if (!s || s.status !== 'OPEN') throw Conflict('Cash refunds need an open register session; reopen and retry', { code: 'register_closed' })
      await sessionAdd(u, s.id, { method, direction: 'OUT', amount: ret.refund_total })
    }
    u.add('payments', { number: payNumber(), direction: 'OUT', purpose: 'SALE_REFUND', payment_method_id: method.id, method: method.name, method_code: method.code, method_kind: method.kind, account_id: method.account_id,
      amount: s2(ret.refund_total), reference: ret.refund_reference, location_id: ret.location_id, register_session_id: method.kind === 'CASH' ? ret.register_session_id : null, customer_id: sale.customer_id,
      created_by: ctx.uid, created_at: u.at, allocations: [{ return_id: ret.id, amount: s2(ret.refund_total) }], sale_ids: [], tendered: null, change_given: null })
    legs.push({ account: method.account_id, amount: D(ret.refund_total).neg() })
  }
  if (!costBack.eq(0)) legs.push({ account: 'INVENTORY', amount: costBack }, { account: 'COGS', amount: costBack.neg() })
  const je = await post(u, { source_type: 'RETURN', source_id: ret.id, location_id: ret.location_id, actor_id: ctx.uid, memo: `Return ${ret.number} / credit note ${cnNumber}`, legs })
  if (sale.loyalty_earned && D(sale.taxable_total).gt(0)) {
    const back = Math.ceil(D(sale.loyalty_earned).times(D(ret.taxable_total)).div(D(sale.taxable_total)).toNumber())
    if (back > 0) {
      u.add('customer_ledger', { customer_id: sale.customer_id, kind: 'LOYALTY', delta: String(-back), ref_type: 'RETURN', ref_id: ret.id, note: `Reversed on ${ret.number}`, actor_id: ctx.uid, actor_name: ctx.name })
      await customerAdd(u, sale.customer_id, { loyalty_points: -back })
    }
  }
  if (sale.customer_id) await customerAdd(u, sale.customer_id, { spend: D(ret.refund_total).neg() })
  const today = localDate()
  await bumpBoth(u, ret.location_id, today, { 'r.count': 1, 'r.taxable': ret.taxable_total, 'r.tax': D(ret.cgst_total).plus(D(ret.sgst_total)).plus(D(ret.igst_total)), 'r.total': ret.refund_total, 'r.cogs': costBack,
    ...Object.fromEntries((ret.lines as Row[]).flatMap((l) => [[`book.${l.book_id}.ret_qty`, l.qty], [`book.${l.book_id}.ret_net`, l.taxable_value]])) })
  const patch = { status: 'COMPLETED', approved_by: ctx.uid, completed_at: u.at, cogs_reversed: s2(costBack), journal_entry_id: je, credit_note: creditNote }
  await u.update(`returns/${ret.id}`, patch)
  return { ...ret, ...patch }
}
registerApproval('REFUND', async (u, ctx, req) => {
  const ret = await u.get(`returns/${req.entity_id}`)
  if (!ret || ret.status !== 'PENDING_APPROVAL') throw Conflict('Return is not pending approval')
  await completeReturn(u, ctx, ret)
}, async (u, _ctx, req) => {
  const ret = await u.get(`returns/${req.entity_id}`)
  if (ret && ret.status === 'PENDING_APPROVAL') {
    await u.update(`returns/${ret.id}`, { status: 'REJECTED' })
    const sale = await u.get(`sales/${ret.sale_id}`)
    if (sale) {
      const returned = { ...(sale.returned ?? {}) }
      for (const l of ret.lines as Row[]) {
        const prev = returned[l.sale_line_id]
        if (prev) returned[l.sale_line_id] = { qty: prev.qty - l.qty, amounts: (prev.amounts as string[]).map((a: string, i: number) => s2(D(a).minus(D([l.taxable_value, l.cgst, l.sgst, l.igst][i])))), copies: (prev.copies ?? []).filter((x: string) => x !== l.copy_id) }
      }
      await u.update(`sales/${sale.id}`, { returned })
    }
  }
})

async function returnOut(r: Row) {
  const loc = await byId('locations', r.location_id)
  return {
    id: r.id, number: r.number, status: r.status, sale_id: r.sale_id, original_invoice_number: r.original_invoice_number, credit_note: r.credit_note ?? null, location_id: r.location_id, location_name: loc?.name ?? '',
    reason: r.reason, refund_method: r.refund_method, refund_method_kind: r.refund_method_kind, refund_reference: r.refund_reference, taxable_total: r.taxable_total, cgst_total: r.cgst_total, sgst_total: r.sgst_total,
    igst_total: r.igst_total, round_off: r.round_off, refund_total: r.refund_total, amount_in_words: amountInWords(r.refund_total), customer_name: r.customer_name,
    lines: (r.lines as Row[]).map((l) => ({ sale_line_id: l.sale_line_id, title: l.title, hsn_code: l.hsn_code, qty: l.qty, disposition: l.disposition, condition: l.condition, taxable_value: l.taxable_value, tax_rate: l.tax_rate, cgst: l.cgst, sgst: l.sgst, igst: l.igst, line_total: l.line_total })),
    created_by: r.created_by_name, created_at: r.created_at, completed_at: r.completed_at ?? null, approval_request_id: r.approval_request_id ?? null,
  }
}

route('POST', '/returns', async ({ body, headers }, ctx) => {
  ctx.require('returns.create')
  const key = String(headers['Idempotency-Key'] ?? '')
  if (key.length < 8) throw fieldError('idempotency-key', 'Idempotency-Key header is required')
  const prior = await getOne(`idempotency/return~${key}`)
  if (prior) {
    const r = await getOne(`returns/${prior.id}`)
    if (r) { ctx.ensureResource(r.location_id); return { ...(await returnOut(r)), replayed: true } }
  }
  const reason = String(body.reason ?? '')
  if (reason.length < 3) throw fieldError('reason', 'String should have at least 3 characters')
  const lines = (body.lines ?? []) as Record<string, unknown>[]
  if (!lines.length) throw ValidationFailed('Select at least one item to return')
  const policy = await getPolicy()
  const method = await byId('payment_methods', String(body.refund_method_id ?? ''))
  const ret = await tx(async (u) => {
    const sale = await u.get(`sales/${String(body.sale_id ?? '')}`)
    if (!sale) throw NotFound('Sale not found')
    ctx.ensureResource(sale.location_id)
    if (sale.status !== 'COMPLETED') throw Conflict('Only completed sales can be returned')
    if (D(sale.grand_total).gt(D(sale.amount_paid))) throw Conflict('Collect the outstanding balance on this sale before processing a return')
    if (daysBetween(localDate(sale.created_at), localDate()) > policy.return_window_days && !ctx.has('returns.approve')) throw Forbidden(`Return window of ${policy.return_window_days} days has passed; a manager must process it`, { code: 'return_window' })
    if (!method || method.kind === 'CREDIT') throw ValidationFailed('Refund method not allowed')
    if (method.kind === 'STORE_CREDIT' && !sale.customer_id) throw ValidationFailed('Store credit refunds require a customer on the original sale')
    const refundRef = clean(body.refund_reference)
    if (method.requires_reference && !refundRef) throw ValidationFailed(`${method.name} refunds need a reference`)
    let sessionId: string | null = null
    if (method.kind === 'CASH') {
      if (!body.register_session_id) throw ValidationFailed('Cash refunds must be made from an open register session')
      const s = await u.get(`register_sessions/${body.register_session_id}`)
      if (!s || s.status !== 'OPEN' || s.location_id !== sale.location_id) throw Conflict('Register session is not open at this outlet', { code: 'register_closed' })
      sessionId = s.id
    }
    const saleLines = new Map((sale.lines as Row[]).map((l) => [l.id, l]))
    const returned: Record<string, Row> = structuredClone(sale.returned ?? {})
    const prepared: Row[] = []
    const reqQty = new Map<string, number>()
    for (const ln of lines) {
      const sl = saleLines.get(String(ln.sale_line_id))
      if (!sl) throw ValidationFailed('Line does not belong to this sale')
      const qty = int(ln.qty)
      reqQty.set(sl.id, (reqQty.get(sl.id) ?? 0) + qty)
      const prev = returned[sl.id] ?? ({ qty: 0, amounts: ['0', '0', '0', '0'], copies: [] } as unknown as Row)
      if (qty <= 0 || prev.qty + qty > sl.qty) throw Conflict(`Return quantity for '${sl.title}' exceeds quantity sold (${sl.qty} sold, ${prev.qty} already returned)`, { code: 'excess_return' })
      const disposition = String(ln.disposition ?? 'RESTOCK')
      if (!(disposition in DISPOSITION_BUCKET)) throw ValidationFailed('Invalid disposition')
      const condition = String(ln.condition ?? (disposition === 'DAMAGED' ? 'DAMAGED' : 'GOOD'))
      if (disposition === 'RESTOCK' && ['POOR', 'DAMAGED'].includes(condition)) throw ValidationFailed(`'${sl.title}' in ${condition.toLowerCase()} condition cannot be restocked as sellable`)
      if (sl.copy_id) {
        if (ln.copy_id && ln.copy_id !== sl.copy_id) throw ValidationFailed('Returned copy does not match the copy sold on this line')
        if ((prev.copies ?? []).includes(sl.copy_id)) throw Conflict('This copy has already been returned', { code: 'excess_return' })
      }
      const [t, c, s, i] = prorateReturn({ sale_qty: sl.qty, return_qty: qty, taxable: sl.taxable_value, cgst: sl.cgst, sgst: sl.sgst, igst: sl.igst, already_qty: prev.qty, already: prev.amounts as [Num, Num, Num, Num] })
      returned[sl.id] = { qty: prev.qty + qty, amounts: (prev.amounts as string[]).map((a, k) => s2(D(a).plus([t, c, s, i][k]))), copies: sl.copy_id ? [...(prev.copies ?? []), sl.copy_id] : (prev.copies ?? []) } as unknown as Row
      prepared.push({ sale_line_id: sl.id, book_id: sl.book_id, copy_id: sl.copy_id ?? null, title: sl.title, hsn_code: sl.hsn_code, tax_rate: sl.tax_rate, qty, disposition, condition, taxable_value: s2(t), cgst: s2(c), sgst: s2(s), igst: s2(i), line_total: s2(t.plus(c).plus(s).plus(i)), unit_cost: sl.unit_cost } as unknown as Row)
    }
    const tt = sum(prepared.map((p) => p.taxable_value)), ct = sum(prepared.map((p) => p.cgst)), stt = sum(prepared.map((p) => p.sgst)), it = sum(prepared.map((p) => p.igst))
    const fully = (sale.lines as Row[]).every((l) => (returned[l.id]?.qty ?? 0) === l.qty)
    let roundOff = fully ? D(sale.round_off) : ZERO
    let refund = tt.plus(ct).plus(stt).plus(it).plus(roundOff)
    if (refund.lt(0)) { roundOff = ZERO; refund = tt.plus(ct).plus(stt).plus(it) }
    const needs = D(policy.refund_approval_threshold).gt(0) && refund.gte(D(policy.refund_approval_threshold)) && !ctx.has('returns.approve')
    const id = newId()
    const doc: Row = {
      id, number: await u.nextNumber('RET'), sale_id: sale.id, original_invoice_number: sale.invoice_number, location_id: sale.location_id, register_session_id: sessionId, customer_id: sale.customer_id, customer_name: sale.customer_name,
      status: needs ? 'PENDING_APPROVAL' : 'COMPLETED', reason, refund_method_id: method.id, refund_method: method.name, refund_method_kind: method.kind, refund_reference: refundRef,
      taxable_total: s2(tt), cgst_total: s2(ct), sgst_total: s2(stt), igst_total: s2(it), round_off: s2(roundOff), refund_total: s2(refund), idempotency_key: key, created_by: ctx.uid, created_by_name: ctx.name, created_at: u.at,
      lines: prepared, credit_note: null, approval_request_id: null, exchange_sale_id: null,
    }
    u.set(`returns/${id}`, doc)
    await u.update(`sales/${sale.id}`, { returned })
    u.set(`idempotency/return~${key}`, { id, created_at: u.at })
    let out = doc
    if (needs) {
      const reqId = createApproval(u, ctx, { type: 'REFUND', location_id: sale.location_id, title: `Refund ${doc.number}: ₹${s2(refund)} via ${method.name}`, entity_type: 'return', entity_id: id, amount: refund, reason })
      await u.update(`returns/${id}`, { approval_request_id: reqId })
      out = { ...doc, approval_request_id: reqId }
    } else out = await completeReturn(u, ctx, doc)
    ctx.audit(u, 'returns.created', { entity_type: 'return', entity_id: id, location_id: sale.location_id, details: { number: doc.number, refund: s2(refund), status: out.status } })
    return out
  })
  return { ...(await returnOut(ret)), replayed: false }
})
route('GET', '/returns', async ({ query }, ctx) => {
  ctx.requireAny('returns.create', 'sales.view')
  if (query.location_id) ctx.ensureLocation(query.location_id)
  const cs = []
  if (query.date_from || query.date_to) {
    const [a, b] = isoRange(query.date_from ?? '2000-01-01', query.date_to ?? '2999-12-31')
    cs.push(where('created_at', '>=', a), where('created_at', '<', b))
  }
  const rows = (await findScoped('returns', query.location_id ? [query.location_id] : ctx.scope(), 'location_id', ...cs, orderBy('created_at', 'desc'), limit(1000))).filter((r) => !query.status || r.status === query.status)
  const page = paginate(rows, Number(query.page), Number(query.page_size))
  return { ...page, items: await Promise.all(page.items.map(returnOut)) }
})
route('GET', '/returns/:id', async ({ params }, ctx) => {
  ctx.requireAny('returns.create', 'sales.view')
  const r = await getOne(`returns/${params.id}`)
  if (!r) throw NotFound('Return not found')
  ctx.ensureResource(r.location_id)
  return returnOut(r)
})
route('GET', '/exchange-method', async (_r, ctx) => {
  ctx.require('returns.create')
  return { id: (await all('payment_methods')).find((m) => m.kind === 'EXCHANGE')?.id ?? null }
})

void cancelPending
