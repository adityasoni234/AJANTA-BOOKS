/**
 * Reports, dashboard and outlet supervision, computed from the per-location daily/monthly summary documents
 * maintained inside every posting transaction (so a month of figures costs a handful of reads), plus record
 * queries where a register needs one row per document (GST register, registers, expenses).
 *
 * Metric definitions are unchanged (docs/REPORTS.md): net sales = taxable value of sales − returns, etc.
 */
import { limit, orderBy, where } from 'firebase/firestore'
import type { Ctx } from './ctx'
import { D, Forbidden, ValidationFailed, ZERO, addDays, daysBetween, isoRange, localDate, r2, s2, sum, type Decimal, type Num } from './core'
import { route } from './router'
import { getPolicy } from './settings'
import { balancesAt, valuedQty } from './stock'
import { all, entries, find, findScoped, type Row } from './store'
import { toCsv } from './catalog'

type Scope = string[] | null
const MAX_RANGE = 400

export function range(q: { date_from?: string; date_to?: string }): [string, string] {
  const today = localDate()
  const d2 = q.date_to || today
  const d1 = q.date_from || addDays(d2, -29)
  if (d1 > d2) throw ValidationFailed('Start date must be before end date')
  if (daysBetween(d1, d2) > MAX_RANGE) throw ValidationFailed(`Date range is limited to ${MAX_RANGE} days`)
  return [d1, d2]
}

// ---------------------------------------------------------------- summary documents
async function summaryDocs(coll: 'daily' | 'monthly', scope: Scope, from: string, to: string): Promise<Row[]> {
  const cs = [where('period', '>=', from), where('period', '<=', to)]
  if (scope === null) return find(coll, ...cs)
  return findScoped(coll, scope, 'location_id', ...cs)
}
/** Daily docs for [d1, d2], using monthly docs for whole months inside the range. */
async function periodDocs(scope: Scope, d1: string, d2: string): Promise<Row[]> {
  const out: Row[] = []
  let cur = d1
  const fullMonths: string[] = []
  const dayRanges: [string, string][] = []
  while (cur <= d2) {
    const monthStart = `${cur.slice(0, 7)}-01`
    const nextMonth = addDays(`${cur.slice(0, 7)}-28`, 4).slice(0, 7) + '-01'
    const monthEnd = addDays(nextMonth, -1)
    if (cur === monthStart && monthEnd <= d2) fullMonths.push(cur.slice(0, 7))
    else dayRanges.push([cur, monthEnd < d2 ? monthEnd : d2])
    cur = nextMonth
  }
  if (fullMonths.length) out.push(...(await summaryDocs('monthly', scope, fullMonths[0], fullMonths[fullMonths.length - 1])).filter((d) => fullMonths.includes(d.period)))
  for (const [a, b] of dayRanges) out.push(...(await summaryDocs('daily', scope, a, b)))
  return out
}
const n = (o: Record<string, unknown> | undefined, k: string): Decimal => D((o ?? {})[k] as Num)
function merge(docs: Row[], key: string): Map<string, Row> {
  const m = new Map<string, Row>()
  for (const d of docs) {
    for (const [id, v] of Object.entries((d[key] ?? {}) as Record<string, Row>)) {
      const cur = m.get(id) ?? ({} as Row)
      for (const [f, x] of Object.entries(v)) cur[f] = typeof x === 'number' ? ((cur[f] as number) ?? 0) + x : s2(D(cur[f] as Num).plus(D(x as Num)))
      m.set(id, cur)
    }
  }
  return m
}

// ---------------------------------------------------------------- sales
export async function salesSummary(d1: string, d2: string, scope: Scope, docs?: Row[]) {
  const ds = docs ?? (await periodDocs(scope, d1, d2))
  const s = (k: string) => sum(ds.map((d) => n(d.s, k)))
  const r = (k: string) => sum(ds.map((d) => n(d.r, k)))
  const tx = s('count').toNumber()
  const net = s('taxable').minus(r('taxable'))
  const cogs = s('cogs').minus(r('cogs'))
  const incomplete = s('cost_incomplete').toNumber()
  const voided = await voidCount(d1, d2, scope)
  return {
    transactions: tx, gross_sales: s2(s('gross')), discounts: s2(s('discount')), invoice_value: s2(s('total')), returns_count: r('count').toNumber(), returns_value: s2(r('total')),
    net_sales: s2(net), gst_collected: s2(s('cgst').plus(s('sgst')).plus(s('igst')).minus(r('tax'))), cogs: s2(cogs), gross_profit: s2(net.minus(cogs)),
    gross_margin_pct: s2(net.eq(0) ? 0 : net.minus(cogs).div(net).times(100)), cost_incomplete_sales: incomplete, profit_complete: incomplete === 0,
    avg_basket: s2(tx ? s('total').div(tx) : 0), voided, receivables_created: '0.00',
  }
}
async function voidCount(d1: string, d2: string, scope: Scope): Promise<number> {
  const [a, b] = isoRange(d1, d2)
  return (await findScoped('sales', scope, 'location_id', where('status', '==', 'CANCELLED'), where('created_at', '>=', a), where('created_at', '<', b), limit(5000)).catch(() => [])).length
}

async function salesTrend(d1: string, d2: string, scope: Scope, byLocation = false) {
  const docs = await summaryDocs('daily', scope, d1, d2)
  const locs = new Map((await all('locations')).map((l) => [l.id, l.name]))
  if (byLocation) {
    return docs.filter((d) => n(d.s, 'count').gt(0)).sort((a, b) => a.period.localeCompare(b.period))
      .map((d) => ({ date: d.period, location: locs.get(d.location_id) ?? null, transactions: n(d.s, 'count').toNumber(), net_sales: s2(n(d.s, 'taxable')), invoice_value: s2(n(d.s, 'total')) }))
  }
  const byDay = new Map<string, Row[]>()
  for (const d of docs) byDay.set(d.period, [...(byDay.get(d.period) ?? []), d])
  const rows = []
  for (let d = d1; d <= d2 && rows.length < 400; d = addDays(d, 1)) {
    const ds = byDay.get(d) ?? []
    rows.push({ date: d, location: null, transactions: sum(ds.map((x) => n(x.s, 'count'))).toNumber(), net_sales: s2(sum(ds.map((x) => n(x.s, 'taxable')))), invoice_value: s2(sum(ds.map((x) => n(x.s, 'total')))) })
  }
  return rows
}

async function salesBy(d1: string, d2: string, scope: Scope, dim: string, lim = 500, docs?: Row[]) {
  const ds = docs ?? (await periodDocs(scope, d1, d2))
  const out: Row[] = []
  if (dim === 'location') {
    const locs = new Map((await all('locations')).map((l) => [l.id, l.name]))
    const byLoc = new Map<string, Row[]>()
    for (const d of ds) if (d.location_id !== 'ORG') byLoc.set(d.location_id, [...(byLoc.get(d.location_id) ?? []), d])
    for (const [id, xs] of byLoc) {
      const tx = sum(xs.map((x) => n(x.s, 'count'))).toNumber()
      if (!tx) continue
      const net = sum(xs.map((x) => n(x.s, 'taxable'))), cogs = sum(xs.map((x) => n(x.s, 'cogs')))
      out.push({ key: id, label: locs.get(id) ?? id, transactions: tx, units: sum(xs.map((x) => n(x.s, 'units'))).toNumber(), net_sales: s2(net), invoice_value: s2(sum(xs.map((x) => n(x.s, 'total')))), cogs: s2(cogs), gross_profit: s2(net.minus(cogs)) } as unknown as Row)
    }
  } else if (dim === 'book' || dim === 'category') {
    const books = await entries('books')
    const cats = new Map((await all('categories')).map((c) => [c.id, c.name]))
    for (const [id, v] of merge(ds, dim === 'book' ? 'book' : 'cat')) {
      const units = Number(v.qty ?? 0)
      if (!units && !D(v.net as Num).gt(0)) continue
      const net = D(v.net as Num), cogs = D(v.cogs as Num)
      const row = { key: id === 'NONE' ? null : id, label: dim === 'book' ? (books.get(id)?.title ?? id) : id === 'NONE' ? 'Uncategorised' : (cats.get(id) ?? 'Uncategorised'), transactions: 0, units,
        net_sales: s2(net), invoice_value: s2(net), cogs: s2(cogs), gross_profit: s2(net.minus(cogs)) } as unknown as Row
      if (dim === 'book') row.sku = books.get(id)?.sku ?? null
      out.push(row)
    }
  } else if (dim === 'cashier') {
    const names: Record<string, string> = {}
    for (const d of ds) Object.assign(names, d.names ?? {})
    for (const [id, v] of merge(ds, 'cashier')) {
      if (!v.count) continue
      out.push({ key: id, label: names[id] ?? 'Staff', transactions: Number(v.count), units: 0, net_sales: s2(v.total as Num), invoice_value: s2(v.total as Num), cogs: null, gross_profit: null } as unknown as Row)
    }
  } else throw ValidationFailed('Unknown dimension')
  return out.sort((a, b) => D(b.net_sales).cmp(D(a.net_sales))).slice(0, lim)
}

async function paymentsByMethod(d1: string, d2: string, scope: Scope, docs?: Row[]) {
  const ds = docs ?? (await periodDocs(scope, d1, d2))
  const methods = (await all('payment_methods')).sort((a, b) => a.sort_order - b.sort_order)
  const pay = merge(ds, 'pay')
  return methods.filter((m) => pay.has(m.code)).map((m) => {
    const v = pay.get(m.code)!
    return { code: m.code, method: m.name, collected: s2(v.amount as Num), refunded: '0.00', net: s2(v.amount as Num), count: Number(v.count ?? 0) }
  })
}

// ---------------------------------------------------------------- stock
export async function locationsIn(scope: Scope) {
  return (await all('locations')).filter((l) => l.is_active && (scope === null || scope.includes(l.id))).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'WAREHOUSE' ? -1 : 1))
}
export async function inventoryValuation(scope: Scope) {
  const books = await entries('books')
  const rows = []
  for (const l of await locationsIn(scope)) {
    const bals = [...(await balancesAt(l.id)).values()]
    rows.push({
      location_id: l.id, location: l.name, type: l.type, units: bals.reduce((a, b) => a + valuedQty(b), 0), in_transit_units: bals.reduce((a, b) => a + b.in_transit, 0),
      cost_value: s2(sum(bals.map((b) => D(b.avg_cost).times(valuedQty(b))))), in_transit_value: '0.00',
      retail_value: s2(sum(bals.map((b) => D(b.price_override ?? books.get(b.book_id)?.selling_price).times(b.on_hand)))), items_missing_cost: bals.filter((b) => valuedQty(b) > 0 && b.avg_cost === null).length,
    })
  }
  const totalCost = sum(rows.map((r) => D(r.cost_value).plus(D(r.in_transit_value))))
  return { method: 'Weighted average cost', locations: rows, total_cost_value: s2(totalCost), total_retail_value: s2(sum(rows.map((r) => r.retail_value))), gl_inventory_balance: null, gl_difference: null, complete: rows.every((r) => r.items_missing_cost === 0) }
}
export async function stockBuckets(scope: Scope) {
  let on = 0, res = 0, dmg = 0, q = 0, tr = 0
  const titles = new Set<string>()
  for (const l of await locationsIn(scope)) {
    for (const b of (await balancesAt(l.id)).values()) {
      on += b.on_hand; res += b.reserved; dmg += b.damaged; q += b.quarantined; tr += b.in_transit
      if (b.on_hand - b.reserved > 0) titles.add(b.book_id)
    }
  }
  return { on_hand: on, reserved: res, available: on - res, damaged: dmg, quarantined: q, in_transit: tr, titles_available: titles.size }
}
export async function stockByCategory(scope: Scope) {
  const books = await entries('books')
  const cats = new Map((await all('categories')).map((c) => [c.id, c.name]))
  const m = new Map<string, { titles: Set<string>; units: number; retail: Decimal; cost: Decimal }>()
  for (const l of await locationsIn(scope)) {
    for (const b of (await balancesAt(l.id)).values()) {
      if (b.on_hand <= 0) continue
      const book = books.get(b.book_id)
      const k = book?.category_id ?? 'NONE'
      const g = m.get(k) ?? { titles: new Set(), units: 0, retail: ZERO, cost: ZERO }
      g.titles.add(b.book_id); g.units += b.on_hand
      g.retail = g.retail.plus(D(b.price_override ?? book?.selling_price).times(b.on_hand))
      g.cost = g.cost.plus(D(b.avg_cost).times(b.on_hand))
      m.set(k, g)
    }
  }
  return [...m].map(([k, g]) => ({ category_id: k === 'NONE' ? null : k, category: k === 'NONE' ? 'Uncategorised' : (cats.get(k) ?? 'Uncategorised'), titles: g.titles.size, units: g.units, retail_value: s2(g.retail), cost_value: s2(g.cost) }))
    .sort((a, b) => b.units - a.units)
}
export async function stockAnalysis(scope: Scope, kind: string, lim = 200) {
  const policy = await getPolicy()
  const books = await entries('books')
  const today = localDate()
  const out: Row[] = []
  const locs = await locationsIn(scope)
  if (kind === 'low' || kind === 'out') {
    for (const l of locs) {
      for (const b of (await balancesAt(l.id)).values()) {
        const book = books.get(b.book_id)
        if (!book) continue
        const avail = b.on_hand - b.reserved
        const reorder = b.reorder_level ?? book.reorder_level ?? 0
        const hit = kind === 'out' ? avail <= 0 && book.status === 'ACTIVE' : avail > 0 && reorder > 0 && avail <= reorder
        if (hit) out.push({ book_id: book.id, title: book.title, sku: book.sku, location: l.name, location_id: l.id, available: avail, on_hand: b.on_hand, reorder_level: reorder, reorder_qty: b.reorder_qty ?? book.reorder_qty ?? 0, in_transit: b.in_transit } as unknown as Row)
      }
    }
    return out.sort((a, b) => a.available - b.available || String(a.title).localeCompare(String(b.title))).slice(0, lim)
  }
  const days = ({ fast: 30, slow: policy.slow_moving_days, dead: policy.dead_stock_days, excess: 90 } as Record<string, number>)[kind]
  const since = addDays(today, -days)
  for (const l of locs) {
    const docs = await periodDocs([l.id], since, today)
    const sold = merge(docs, 'book')
    const lastSale = new Map<string, string>()
    for (const d of docs.filter((x) => x.period.length === 10)) for (const id of Object.keys(d.book ?? {})) if ((lastSale.get(id) ?? '') < d.period) lastSale.set(id, d.period)
    const bals = await balancesAt(l.id)
    const stockRows = (await import('./store')).stockAt(l.id)
    const raw = await stockRows
    for (const b of bals.values()) {
      const book = books.get(b.book_id)
      if (!book) continue
      const qty = Number(sold.get(b.book_id)?.qty ?? 0) - Number(sold.get(b.book_id)?.ret_qty ?? 0)
      const reorder = b.reorder_level ?? book.reorder_level ?? 0
      const updated = String(raw.get(b.book_id)?.updated_at ?? '')
      const hit = kind === 'fast' ? qty > 0
        : kind === 'dead' ? b.on_hand > 0 && qty <= 0 && (!updated || localDate(updated) < since)
        : kind === 'slow' ? b.on_hand > 0 && qty > 0 && qty * 4 < b.on_hand
        : b.on_hand > 0 && ((reorder > 0 && b.on_hand > reorder * policy.excess_stock_multiplier) || (qty > 0 && b.on_hand > qty * 3))
      if (hit) out.push({ book_id: book.id, title: book.title, sku: book.sku, location: l.name, location_id: l.id, on_hand: b.on_hand, [`sold_${days}d`]: qty, units_sold: qty, window_days: days, last_sale: lastSale.get(b.book_id) ?? null, stock_value: b.avg_cost !== null ? s2(D(b.avg_cost).times(b.on_hand)) : null } as unknown as Row)
    }
  }
  const sorters: Record<string, (a: Row, b: Row) => number> = { fast: (a, b) => b.units_sold - a.units_sold, dead: (a, b) => String(a.title).localeCompare(String(b.title)), slow: (a, b) => a.units_sold - b.units_sold, excess: (a, b) => b.on_hand - a.on_hand }
  return out.sort(sorters[kind]).slice(0, lim)
}

// ---------------------------------------------------------------- finance
export async function accountTotals(d1: string | null, d2: string, scope: Scope, types: string[]) {
  const accounts = await all('accounts')
  let docs: Row[]
  if (d1) docs = await periodDocs(scope, d1, d2)
  else {
    const monthStart = `${d2.slice(0, 7)}-01`
    docs = [...(await summaryDocs('monthly', scope, '0000-00', addDays(monthStart, -1).slice(0, 7))), ...(await summaryDocs('daily', scope, monthStart, d2))]
  }
  const acct = merge(docs, 'acct')
  return accounts.filter((a) => types.includes(a.type) && acct.has(a.id)).sort((a, b) => String(a.code).localeCompare(String(b.code)))
    .map((a) => ({ account_id: a.id, code: a.code, name: a.name, type: a.type, system_key: a.system_key ?? null, debit: D(acct.get(a.id)!.dr as Num), credit: D(acct.get(a.id)!.cr as Num) }))
}
export async function profitAndLoss(d1: string, d2: string, scope: Scope) {
  const rows = await accountTotals(d1, d2, scope, ['INCOME', 'EXPENSE'])
  const income = rows.filter((r) => r.type === 'INCOME').map((r) => ({ ...r, amount: r.credit.minus(r.debit) }))
  const expense = rows.filter((r) => r.type === 'EXPENSE').map((r) => ({ ...r, amount: r.debit.minus(r.credit) }))
  const revenue = sum(income.map((r) => r.amount))
  const cogs = sum(expense.filter((r) => r.system_key === 'COGS').map((r) => r.amount))
  const opex = expense.filter((r) => r.system_key !== 'COGS')
  const totalOpex = sum(opex.map((r) => r.amount))
  const s = await salesSummary(d1, d2, scope)
  const fmt = (r: { debit: Decimal; credit: Decimal; amount: Decimal }) => ({ ...r, debit: s2(r.debit), credit: s2(r.credit), amount: s2(r.amount) })
  return {
    period: { from: d1, to: d2 }, income: income.map(fmt), revenue: s2(revenue), cogs: s2(cogs), gross_profit: s2(revenue.minus(cogs)), operating_expenses: opex.map(fmt),
    total_operating_expenses: s2(totalOpex), net_profit: s2(revenue.minus(cogs).minus(totalOpex)), complete: s.profit_complete,
    warnings: s.profit_complete ? [] : [`${s.cost_incomplete_sales} sale(s) had items without cost data; COGS and profit are understated.`],
  }
}
async function cashFlow(d1: string, d2: string, scope: Scope) {
  const cashIds = new Set((await all('accounts')).filter((a) => a.is_cash_or_bank).map((a) => a.id))
  const groupsOf: Record<string, string> = { SALE: 'Receipts from customers', CUSTOMER_RECEIPT: 'Receipts from customers', RETURN: 'Refunds to customers', SALE_VOID: 'Refunds to customers', SUPPLIER_PAYMENT: 'Payments to suppliers', EXPENSE: 'Operating expenses paid', REGISTER_CLOSE: 'Cash over / short', MANUAL: 'Other / manual entries', FUND_TRANSFER: 'Transfers between accounts' }
  const [a] = isoRange(d1, d1)
  void a
  const journals = (await find('journals', where('entry_date', '>=', d1), where('entry_date', '<=', d2), limit(20000))).filter((j) => scope === null || (j.location_ids ?? []).some((l: string) => scope.includes(l)))
  const groups = new Map<string, { inflow: Decimal; outflow: Decimal }>()
  for (const j of journals) {
    for (const l of j.lines as Row[]) {
      if (!cashIds.has(l.account_id) || (scope !== null && !scope.includes(l.location_id))) continue
      const g = groups.get(groupsOf[j.source_type] ?? 'Other') ?? { inflow: ZERO, outflow: ZERO }
      g.inflow = g.inflow.plus(D(l.debit)); g.outflow = g.outflow.plus(D(l.credit))
      groups.set(groupsOf[j.source_type] ?? 'Other', g)
    }
  }
  const before = await accountTotals(null, addDays(d1, -1), scope, ['ASSET'])
  const opening = sum(before.filter((r) => cashIds.has(r.account_id)).map((r) => r.debit.minus(r.credit)))
  const lines = [...groups].sort(([x], [y]) => x.localeCompare(y)).map(([activity, v]) => ({ activity, inflow: s2(v.inflow), outflow: s2(v.outflow), net: s2(v.inflow.minus(v.outflow)) }))
  const net = sum(lines.map((l) => l.net))
  return { period: { from: d1, to: d2 }, opening_cash: s2(opening), lines, net_change: s2(net), closing_cash: s2(opening.plus(net)), method: 'Direct method from cash & bank account postings' }
}
async function balanceSheet(asOf: string) {
  const policy = await getPolicy()
  const rows = await accountTotals(null, asOf, null, ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'])
  const fmt = (r: { debit: Decimal; credit: Decimal }, amount: Decimal) => ({ ...r, debit: s2(r.debit), credit: s2(r.credit), amount: s2(amount) })
  const assets = rows.filter((r) => r.type === 'ASSET').map((r) => fmt(r, r.debit.minus(r.credit)))
  const liabilities = rows.filter((r) => r.type === 'LIABILITY').map((r) => fmt(r, r.credit.minus(r.debit)))
  const equity = rows.filter((r) => r.type === 'EQUITY').map((r) => fmt(r, r.credit.minus(r.debit)))
  const earnings = sum(rows.filter((r) => ['INCOME', 'EXPENSE'].includes(r.type)).map((r) => r.credit.minus(r.debit)))
  const ta = sum(assets.map((a) => a.amount)), tl = sum(liabilities.map((a) => a.amount)), te = sum(equity.map((a) => a.amount)).plus(earnings)
  return {
    as_of: asOf, assets, liabilities, equity, current_earnings: s2(earnings), total_assets: s2(ta), total_liabilities: s2(tl), total_equity: s2(te), balanced: ta.eq(tl.plus(te)), complete: policy.opening_balances_configured,
    warnings: policy.opening_balances_configured ? [] : ['Opening balances have not been confirmed in settings. The balance sheet reflects only transactions recorded in this system and is not a complete statement of financial position.'],
  }
}
export async function trialBalance(asOf: string) {
  const rows = (await accountTotals(null, asOf, null, ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'])).map((r) => {
    const net = r.debit.minus(r.credit)
    return { ...r, debit: s2(r.debit), credit: s2(r.credit), balance_debit: s2(net.gt(0) ? net : 0), balance_credit: s2(net.lt(0) ? net.neg() : 0) }
  })
  const td = sum(rows.map((r) => r.balance_debit)), tc = sum(rows.map((r) => r.balance_credit))
  return { as_of: asOf, rows, total_debit: s2(td), total_credit: s2(tc), balanced: td.eq(tc) }
}
export async function supplierAging(scope: Scope) {
  const today = localDate()
  const inv = (await findScoped('supplier_invoices', scope, 'location_id', limit(5000)).catch(() => [] as Row[])).filter((i) => ['OPEN', 'PARTIALLY_PAID'].includes(i.status))
  const m = new Map<string, Row>()
  for (const i of inv) {
    const due = D(i.total).minus(D(i.amount_paid))
    const age = daysBetween(i.due_date, today)
    const g = m.get(i.supplier_id) ?? ({ supplier_id: i.supplier_id, supplier: i.supplier_name, current: ZERO, d1_30: ZERO, d31_60: ZERO, d61_90: ZERO, d90_plus: ZERO, total: ZERO, oldest_due: i.due_date } as unknown as Row)
    const k = age <= 0 ? 'current' : age <= 30 ? 'd1_30' : age <= 60 ? 'd31_60' : age <= 90 ? 'd61_90' : 'd90_plus'
    g[k] = (g[k] as Decimal).plus(due); g.total = (g.total as Decimal).plus(due)
    if (i.due_date < g.oldest_due) g.oldest_due = i.due_date
    m.set(i.supplier_id, g)
  }
  return [...m.values()].sort((a, b) => (b.total as Decimal).cmp(a.total as Decimal)).map((g) => ({ ...g, current: s2(g.current), d1_30: s2(g.d1_30), d31_60: s2(g.d31_60), d61_90: s2(g.d61_90), d90_plus: s2(g.d90_plus), total: s2(g.total) }))
}
async function receivablesAging(scope: Scope) {
  const today = localDate()
  const custs = await entries('customers')
  const sales = await findScoped('sales', scope, 'location_id', where('has_balance', '==', true), limit(5000))
  const m = new Map<string, Row>()
  for (const s of sales.filter((x) => x.status === 'COMPLETED')) {
    const due = D(s.grand_total).minus(D(s.amount_paid))
    const age = daysBetween(localDate(s.created_at), today)
    const g = m.get(s.customer_id) ?? ({ customer_id: s.customer_id, customer: s.customer_name, phone: custs.get(s.customer_id)?.phone ?? null, d0_30: ZERO, d31_60: ZERO, d60_plus: ZERO, total: ZERO } as unknown as Row)
    const k = age <= 30 ? 'd0_30' : age <= 60 ? 'd31_60' : 'd60_plus'
    g[k] = (g[k] as Decimal).plus(due); g.total = (g.total as Decimal).plus(due)
    m.set(s.customer_id, g)
  }
  return [...m.values()].sort((a, b) => (b.total as Decimal).cmp(a.total as Decimal)).map((g) => ({ ...g, d0_30: s2(g.d0_30), d31_60: s2(g.d31_60), d60_plus: s2(g.d60_plus), total: s2(g.total) }))
}
export async function expenseReport(d1: string, d2: string, scope: Scope) {
  const locs = new Map((await all('locations')).map((l) => [l.id, l.name]))
  const rows = (await findScoped('expenses', scope, 'location_id', where('expense_date', '>=', d1), where('expense_date', '<=', d2), limit(10000)).catch(() => [] as Row[])).filter((e) => e.status === 'POSTED')
  const m = new Map<string, Row>()
  for (const e of rows) {
    const k = `${e.location_id}|${e.category_name}`
    const g = m.get(k) ?? ({ location: locs.get(e.location_id) ?? '', category: e.category_name, count: 0, amount: ZERO } as unknown as Row)
    g.count += 1; g.amount = (g.amount as Decimal).plus(D(e.amount))
    m.set(k, g)
  }
  return [...m.values()].sort((a, b) => String(a.location).localeCompare(String(b.location)) || (b.amount as Decimal).cmp(a.amount as Decimal)).map((g) => ({ ...g, amount: s2(g.amount) }))
}
async function registerReport(d1: string, d2: string, scope: Scope) {
  const [a, b] = isoRange(d1, d2)
  const locs = new Map((await all('locations')).map((l) => [l.id, l.name]))
  const rows = await findScoped('register_sessions', scope, 'location_id', where('opened_at', '>=', a), where('opened_at', '<', b), orderBy('opened_at', 'desc'), limit(2000))
  return rows.map((s) => ({ session_id: s.id, location: locs.get(s.location_id) ?? '', register: s.register_name, cashier: s.opened_by_name, status: s.status, opened_at: s.opened_at, closed_at: s.closed_at, opening_float: s.opening_float, expected_cash: s.expected_cash, counted_cash: s.counted_cash, variance: s.variance }))
}
export async function purchaseCommitments(scope: Scope) {
  const pos = (await findScoped('purchase_orders', scope, 'location_id', limit(5000)).catch(() => [] as Row[])).filter((p) => ['APPROVED', 'ISSUED', 'PARTIALLY_RECEIVED'].includes(p.status))
  let units = 0
  let value = ZERO
  for (const p of pos) for (const l of p.lines as Row[]) {
    const out = l.qty_ordered - l.qty_received - l.qty_cancelled
    units += out
    value = value.plus(D(out).times(D(l.unit_cost)).times(D(1).minus(D(l.discount_pct).div(100))))
  }
  return { open_orders: pos.length, units_outstanding: units, value_outstanding: s2(r2(value)) }
}
export async function pendingCounts(scope: Scope) {
  const transfers = (await findScoped('transfers', scope, 'location_ids', limit(5000)).catch(() => [] as Row[])).filter((t) => ['REQUESTED', 'APPROVED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED', 'DISCREPANCY'].includes(t.status)).length
  const approvals = (await findScoped('approvals', scope, 'location_id', where('status', '==', 'PENDING'), limit(2000)).catch(() => [] as Row[])).length
  const open = (await findScoped('register_sessions', scope, 'location_id', where('status', '==', 'OPEN'), limit(500)).catch(() => [] as Row[])).length
  return { transfers, approvals, open_register_sessions: open }
}
async function cashPositions(scope: Scope) {
  const accounts = (await all('accounts')).filter((a) => a.is_cash_or_bank)
  const locs = new Map((await all('locations')).map((l) => [l.id, l.name]))
  const monthStart = `${localDate().slice(0, 7)}-01`
  const docs = [...(await summaryDocs('monthly', scope, '0000-00', addDays(monthStart, -1).slice(0, 7))), ...(await summaryDocs('daily', scope, monthStart, localDate()))]
  const out = []
  const byLoc = new Map<string, Row[]>()
  for (const d of docs) byLoc.set(d.location_id, [...(byLoc.get(d.location_id) ?? []), d])
  for (const a of accounts) for (const [loc, ds] of byLoc) {
    const acc = merge(ds, 'acct').get(a.id)
    const bal = acc ? D(acc.dr as Num).minus(D(acc.cr as Num)) : ZERO
    if (!bal.eq(0)) out.push({ account_id: a.id, account: a.name, system_key: a.system_key, location: loc === 'ORG' ? 'Organisation' : (locs.get(loc) ?? loc), balance: s2(bal) })
  }
  return out.sort((x, y) => x.account.localeCompare(y.account) || x.location.localeCompare(y.location))
}

// ---------------------------------------------------------------- GST registers
async function gstRegister(d1: string, d2: string, scope: Scope) {
  const [a, b] = isoRange(d1, d2)
  const sales = await findScoped('sales', scope, 'location_id', where('created_at', '>=', a), where('created_at', '<', b), limit(20000))
  const rets = (await findScoped('returns', scope, 'location_id', where('completed_at', '>=', a), where('completed_at', '<', b), limit(20000)).catch(() => [] as Row[])).filter((r) => r.status === 'COMPLETED')
  const rows = []
  for (const s of sales) {
    const cancelled = s.invoice?.status === 'CANCELLED'
    const buyer = s.invoice?.buyer ?? {}
    rows.push({ invoice_number: s.invoice_number, doc_type: s.invoice?.doc_type, date: s.created_at, status: s.invoice?.status ?? 'ISSUED', customer: buyer.name ?? null, customer_gstin: buyer.gstin ?? null, supply_type: buyer.gstin ? 'B2B' : 'B2C',
      place_of_supply: s.place_of_supply, taxable_value: cancelled ? '0.00' : s.taxable_total, cgst: cancelled ? '0.00' : s.cgst_total, sgst: cancelled ? '0.00' : s.sgst_total, igst: cancelled ? '0.00' : s.igst_total, total: cancelled ? '0.00' : s.grand_total, location_id: s.location_id })
  }
  for (const r of rets) {
    const buyer = r.credit_note?.buyer ?? {}
    rows.push({ invoice_number: r.credit_note?.number, doc_type: 'CREDIT_NOTE', date: r.completed_at, status: 'ISSUED', customer: buyer.name ?? null, customer_gstin: buyer.gstin ?? null, supply_type: buyer.gstin ? 'B2B' : 'B2C',
      place_of_supply: r.credit_note?.place_of_supply, taxable_value: s2(D(r.taxable_total).neg()), cgst: s2(D(r.cgst_total).neg()), sgst: s2(D(r.sgst_total).neg()), igst: s2(D(r.igst_total).neg()), total: s2(D(r.refund_total).neg()), location_id: r.location_id })
  }
  return rows.sort((x, y) => String(x.date).localeCompare(String(y.date)))
}
async function gstSummary(d1: string, d2: string, scope: Scope) {
  const docs = await periodDocs(scope, d1, d2)
  const g = merge(docs, 'gst')
  const [a, b] = isoRange(d1, d2)
  const rets = (await findScoped('returns', scope, 'location_id', where('completed_at', '>=', a), where('completed_at', '<', b), limit(20000)).catch(() => [] as Row[])).filter((r) => r.status === 'COMPLETED')
  const acc = new Map<string, Row>()
  for (const [k, v] of g) {
    const [hsn, rate] = k.split('|')
    acc.set(k, { hsn_code: hsn, tax_rate: rate.replace('_', '.'), qty: Number(v.qty ?? 0), taxable_value: D(v.taxable as Num), cgst: D(v.cgst as Num), sgst: D(v.sgst as Num), igst: D(v.igst as Num) } as unknown as Row)
  }
  for (const r of rets) for (const l of r.lines as Row[]) {
    const k = `${(l.hsn_code ?? '').replace(/\./g, '')}|${D(l.tax_rate).toFixed(2).replace('.', '_')}`
    const x = acc.get(k) ?? ({ hsn_code: l.hsn_code ?? '', tax_rate: D(l.tax_rate).toFixed(2), qty: 0, taxable_value: ZERO, cgst: ZERO, sgst: ZERO, igst: ZERO } as unknown as Row)
    x.qty -= l.qty; x.taxable_value = (x.taxable_value as Decimal).minus(D(l.taxable_value)); x.cgst = (x.cgst as Decimal).minus(D(l.cgst)); x.sgst = (x.sgst as Decimal).minus(D(l.sgst)); x.igst = (x.igst as Decimal).minus(D(l.igst))
    acc.set(k, x)
  }
  return [...acc.values()].sort((x, y) => String(x.hsn_code).localeCompare(String(y.hsn_code)) || D(x.tax_rate).cmp(D(y.tax_rate)))
    .map((x) => ({ ...x, taxable_value: s2(x.taxable_value), cgst: s2(x.cgst), sgst: s2(x.sgst), igst: s2(x.igst), total_tax: s2(D(x.cgst).plus(D(x.sgst)).plus(D(x.igst))) }))
}

// ---------------------------------------------------------------- routes
async function exportOr(ctx: Ctx, fmt: string | undefined, rows: Row[] | Record<string, unknown>[], payload: unknown, name: string) {
  if (fmt === 'csv') {
    if (!ctx.has('reports.export')) throw Forbidden('Missing permission: reports.export', { code: 'permission_denied' })
    const cols = rows.length ? Object.keys(rows[0]).filter((k) => typeof (rows[0] as Row)[k] !== 'object' || (rows[0] as Row)[k] === null) : []
    const { tx } = await import('./store')
    await tx(async (u) => ctx.audit(u, 'reports.exported', { entity_type: 'report', entity_id: name }))
    return new Response(new Blob([toCsv([cols, ...rows.map((r) => cols.map((c) => (r as Row)[c] ?? ''))])], { type: 'text/csv' }))
  }
  return payload
}
const stripProfit = (ctx: Ctx, rows: Row[]) => {
  if (!ctx.has('reports.financial')) for (const r of rows) { r.cogs = null; r.gross_profit = null }
  return rows
}

route('GET', '/reports/sales-summary', async ({ query }, ctx) => {
  ctx.require('reports.view')
  const [d1, d2] = range(query)
  const s: Record<string, unknown> = await salesSummary(d1, d2, ctx.scope(query.location_id))
  if (!ctx.has('reports.financial')) for (const k of ['cogs', 'gross_profit', 'gross_margin_pct']) s[k] = null
  return { period: { from: d1, to: d2 }, ...s }
})
route('GET', '/reports/sales-by', async ({ query }, ctx) => {
  ctx.require('reports.view')
  if (!['location', 'category', 'book', 'cashier'].includes(query.dim ?? '')) throw ValidationFailed('Unknown dimension')
  const [d1, d2] = range(query)
  const rows = stripProfit(ctx, await salesBy(d1, d2, ctx.scope(query.location_id), query.dim!))
  return exportOr(ctx, query.format, rows, { rows }, `sales_by_${query.dim}`)
})
route('GET', '/reports/sales-trend', async ({ query }, ctx) => {
  ctx.require('reports.view')
  const [d1, d2] = range(query)
  const rows = await salesTrend(d1, d2, ctx.scope(query.location_id), query.by_location === 'true')
  return exportOr(ctx, query.format, rows, { rows }, 'sales_trend')
})
route('GET', '/reports/payments', async ({ query }, ctx) => {
  ctx.require('reports.view')
  const [d1, d2] = range(query)
  const rows = await paymentsByMethod(d1, d2, ctx.scope(query.location_id))
  return exportOr(ctx, query.format, rows, { rows }, 'payments_by_method')
})
route('GET', '/reports/gst-register', async ({ query }, ctx) => {
  ctx.requireAny('reports.financial', 'finance.view')
  const [d1, d2] = range(query)
  const rows = await gstRegister(d1, d2, ctx.scope(query.location_id))
  const totals = Object.fromEntries(['taxable_value', 'cgst', 'sgst', 'igst', 'total'].map((k) => [k, s2(sum(rows.map((r) => (r as Record<string, Num>)[k])))]))
  return exportOr(ctx, query.format, rows, { rows, totals }, 'gst_sales_register')
})
route('GET', '/reports/gst-summary', async ({ query }, ctx) => {
  ctx.requireAny('reports.financial', 'finance.view')
  const [d1, d2] = range(query)
  const rows = await gstSummary(d1, d2, ctx.scope(query.location_id))
  return exportOr(ctx, query.format, rows, { rows, disclaimer: 'Verify with your accountant before filing. No automatic GST filing is performed.' }, 'gst_rate_hsn_summary')
})
route('GET', '/reports/inventory-valuation', async ({ query }, ctx) => {
  ctx.require('reports.financial')
  const data = await inventoryValuation(ctx.scope(query.location_id))
  return exportOr(ctx, query.format, data.locations, data, 'inventory_valuation')
})
route('GET', '/reports/stock-analysis', async ({ query }, ctx) => {
  ctx.requireAny('reports.view', 'inventory.view')
  if (!['fast', 'slow', 'dead', 'excess', 'low', 'out'].includes(query.kind ?? '')) throw ValidationFailed('Unknown kind')
  const rows = await stockAnalysis(ctx.scope(query.location_id), query.kind!)
  if (!ctx.has('reports.financial')) for (const r of rows) delete r.stock_value
  return exportOr(ctx, query.format, rows, { rows }, `stock_${query.kind}`)
})
route('GET', '/reports/profit-loss', async ({ query }, ctx) => {
  ctx.require('reports.financial')
  const [d1, d2] = range(query)
  return profitAndLoss(d1, d2, ctx.scope(query.location_id))
})
route('GET', '/reports/cash-flow', async ({ query }, ctx) => {
  ctx.require('reports.financial')
  const [d1, d2] = range(query)
  return cashFlow(d1, d2, ctx.scope(query.location_id))
})
route('GET', '/reports/balance-sheet', async ({ query }, ctx) => {
  ctx.require('reports.financial', 'accounting.view')
  if (!ctx.all_locations) throw Forbidden('The balance sheet is organisation-wide')
  return balanceSheet(query.as_of || localDate())
})
route('GET', '/reports/trial-balance', async ({ query }, ctx) => {
  ctx.require('accounting.view')
  if (!ctx.all_locations) throw Forbidden('The trial balance is organisation-wide')
  const data = await trialBalance(query.as_of || localDate())
  return exportOr(ctx, query.format, data.rows, data, 'trial_balance')
})
route('GET', '/reports/supplier-aging', async ({ query }, ctx) => {
  ctx.requireAny('finance.view', 'purchasing.view')
  const rows = await supplierAging(ctx.scope(query.location_id))
  return exportOr(ctx, query.format, rows, { rows }, 'supplier_aging')
})
route('GET', '/reports/receivables-aging', async ({ query }, ctx) => {
  ctx.require('finance.view')
  const rows = await receivablesAging(ctx.scope(query.location_id))
  return exportOr(ctx, query.format, rows, { rows }, 'receivables_aging')
})
route('GET', '/reports/expenses', async ({ query }, ctx) => {
  ctx.require('expenses.view')
  const [d1, d2] = range(query)
  const rows = await expenseReport(d1, d2, ctx.scope(query.location_id))
  return exportOr(ctx, query.format, rows, { rows, total: s2(sum(rows.map((r) => r.amount))) }, 'expenses')
})
route('GET', '/reports/registers', async ({ query }, ctx) => {
  ctx.require('registers.manage')
  const [d1, d2] = range(query)
  const rows = await registerReport(d1, d2, ctx.scope(query.location_id))
  return exportOr(ctx, query.format, rows, { rows }, 'register_sessions')
})

route('GET', '/dashboard', async ({ query }, ctx) => {
  ctx.require('dashboard.view')
  const [d1, d2] = range(query)
  const scope = ctx.scope(query.location_id)
  const today = localDate()
  const fin = ctx.has('reports.financial')
  const docs = await periodDocs(scope, d1, d2)
  const todayDocs = await summaryDocs('daily', scope, today, today)
  const period: Record<string, unknown> = await salesSummary(d1, d2, scope, docs)
  const todayS: Record<string, unknown> = await salesSummary(today, today, scope, todayDocs)
  if (!fin) for (const s of [period, todayS]) for (const k of ['cogs', 'gross_profit', 'gross_margin_pct']) s[k] = null
  const low = await stockAnalysis(scope, 'low', 500)
  const out: Record<string, unknown> = {
    period: { from: d1, to: d2 }, scope: scope === null ? 'organisation' : 'locations', today: todayS, summary: period,
    trend: await salesTrend(d1, d2, scope), payments: await paymentsByMethod(d1, d2, scope, docs),
    top_books: stripProfit(ctx, await salesBy(d1, d2, scope, 'book', 8, docs)), by_category: stripProfit(ctx, await salesBy(d1, d2, scope, 'category', 8, docs)),
    outlets: stripProfit(ctx, await salesBy(d1, d2, scope, 'location', 500, docs)),
    alerts: { low: low.length, out: (await stockAnalysis(scope, 'out', 500)).length }, low_stock: low.slice(0, 8),
    dead_stock_count: (await stockAnalysis(scope, 'dead', 500)).length, slow_moving: await stockAnalysis(scope, 'slow', 5), pending: await pendingCounts(scope),
    expenses: ctx.has('expenses.view') ? s2(sum((await expenseReport(d1, d2, scope)).map((r) => r.amount))) : null,
    registers: ctx.has('registers.manage') ? (await registerReport(d1, d2, scope)).filter((r) => r.status === 'OPEN' || (r.variance && !D(r.variance).eq(0))).slice(0, 10) : null,
  }
  const inv = await inventoryValuation(scope)
  out.inventory = {
    locations: inv.locations.map((r) => (fin ? r : { ...r, cost_value: undefined, in_transit_value: undefined })), total_units: inv.locations.reduce((a, r) => a + r.units, 0),
    total_cost_value: fin ? inv.total_cost_value : null, total_retail_value: inv.total_retail_value, complete: inv.complete,
  }
  if (ctx.has('finance.view') || ctx.has('purchasing.view')) {
    const aging = await supplierAging(scope)
    out.supplier_dues = { total: s2(sum(aging.map((r) => r.total))), overdue: s2(sum(aging.map((r) => D(r.total).minus(D(r.current))))), top: aging.slice(0, 5) }
    out.purchase_commitments = await purchaseCommitments(scope)
  }
  if (fin && ctx.has('finance.view')) out.cash_positions = await cashPositions(scope)
  if (fin) {
    const pl = await profitAndLoss(d1, d2, scope)
    out.profit = { revenue: pl.revenue, cogs: pl.cogs, gross_profit: pl.gross_profit, operating_expenses: pl.total_operating_expenses, net_profit: pl.net_profit, complete: pl.complete, warnings: pl.warnings }
  }
  return out
})

// ---------------------------------------------------------------- outlet supervision
function periods(today: string) {
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7
  return { today: [today, today], week: [addDays(today, -dow), today], month: [`${today.slice(0, 8)}01`, today] } as Record<string, [string, string]>
}
async function stockValue(ctx: Ctx, ids: string[]) {
  const rows = (await inventoryValuation(ids)).locations
  const row = rows[0] ?? { units: 0, retail_value: '0.00', cost_value: '0.00', items_missing_cost: 0 }
  const fin = ctx.has('reports.financial')
  return { units: row.units, retail_value: row.retail_value, cost_value: fin ? row.cost_value : null, items_missing_cost: fin ? row.items_missing_cost : null }
}
const locOut = (l: Row) => ({ id: l.id, code: l.code, name: l.name, type: l.type, is_active: !!l.is_active, city: l.city ?? null, state: l.state ?? null, address_line1: l.address_line1 ?? null, address_line2: l.address_line2 ?? null, pincode: l.pincode ?? null, phone: l.phone ?? null, email: l.email ?? null, gstin: l.gstin ?? null })

route('GET', '/outlets/summary', async (_r, ctx) => {
  ctx.require('dashboard.view')
  const today = localDate()
  const ps = periods(today)
  const out = []
  for (const l of await locationsIn(ctx.scope())) {
    const ids = [l.id]
    const pending = await pendingCounts(ids)
    const sales: Record<string, unknown> = {}
    for (const [k, [a, b]] of Object.entries(ps)) {
      const s = await salesSummary(a, b, ids)
      sales[k] = { transactions: s.transactions, invoice_value: s.invoice_value, net_sales: s.net_sales, returns_value: s.returns_value }
    }
    out.push({
      location: locOut(l), sales, stock: { ...(await stockValue(ctx, ids)), ...(await stockBuckets(ids)) },
      alerts: { low: (await stockAnalysis(ids, 'low', 1000)).length, out: (await stockAnalysis(ids, 'out', 1000)).length },
      open_registers: pending.open_register_sessions, pending_transfers: pending.transfers, pending_approvals: pending.approvals,
    })
  }
  return { as_of: today, periods: Object.fromEntries(Object.entries(ps).map(([k, [a, b]]) => [k, { from: a, to: b }])), locations: out }
})
route('GET', '/outlets/:id/overview', async ({ params }, ctx) => {
  ctx.require('dashboard.view')
  ctx.ensureLocation(params.id)
  const l = (await all('locations')).find((x) => x.id === params.id)
  if (!l) throw ValidationFailed('Location not found')
  const ids = [l.id]
  const today = localDate()
  const ps = periods(today)
  const [monthFrom] = ps.month
  const fin = ctx.has('reports.financial')
  const sales: Record<string, unknown> = {}
  for (const [k, [a, b]] of Object.entries(ps)) {
    const s: Record<string, unknown> = await salesSummary(a, b, ids)
    if (!fin) for (const f of ['cogs', 'gross_profit', 'gross_margin_pct']) s[f] = null
    sales[k] = s
  }
  const monthDocs = await periodDocs(ids, monthFrom, today)
  const open = await find('register_sessions', where('location_id', '==', l.id), where('status', '==', 'OPEN'))
  let staff = null
  if (ctx.has('users.view')) {
    staff = (await all('users')).filter((u) => u.is_active && (u.location_ids ?? []).includes(l.id)).sort((a, b) => a.full_name.localeCompare(b.full_name))
      .map((u) => ({ id: u.id, full_name: u.full_name, email: u.email, role: u.role_name, designation: u.designation ?? null, last_login_at: u.last_login_at ?? null }))
  }
  const out: Record<string, unknown> = {
    location: locOut(l), as_of: today, periods: Object.fromEntries(Object.entries(ps).map(([k, [a, b]]) => [k, { from: a, to: b }])), sales,
    trend: await salesTrend(addDays(today, -29), today, ids), payments_month: await paymentsByMethod(monthFrom, today, ids, monthDocs),
    top_books_month: stripProfit(ctx, await salesBy(monthFrom, today, ids, 'book', 10, monthDocs)), categories_month: stripProfit(ctx, await salesBy(monthFrom, today, ids, 'category', 10, monthDocs)),
    cashiers_month: stripProfit(ctx, await salesBy(monthFrom, today, ids, 'cashier', 10, monthDocs)), stock: { ...(await stockValue(ctx, ids)), ...(await stockBuckets(ids)) },
    stock_by_category: (await stockByCategory(ids)).map((r) => ({ ...r, cost_value: fin ? r.cost_value : null })), low_stock: await stockAnalysis(ids, 'low', 15), out_of_stock: await stockAnalysis(ids, 'out', 15),
    alerts: { low: (await stockAnalysis(ids, 'low', 1000)).length, out: (await stockAnalysis(ids, 'out', 1000)).length, dead: (await stockAnalysis(ids, 'dead', 1000)).length },
    pending: await pendingCounts(ids), open_registers: open.map((s) => ({ session_id: s.id, register: s.register_name, cashier: s.opened_by_name, opened_at: s.opened_at, opening_float: s.opening_float })), staff,
  }
  if (ctx.has('purchasing.view')) out.purchase_commitments = await purchaseCommitments(ids)
  if (ctx.has('expenses.view')) out.expenses_month = s2(sum((await expenseReport(monthFrom, today, ids)).map((r) => r.amount)))
  return out
})
