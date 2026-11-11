/**
 * GST billing engine (ported 1:1 from the Python engine) and the double-entry posting engine.
 *
 * Posting writes the journal document and adds every line to per-location daily and monthly account totals
 * (`daily/{loc}~{date}`, `monthly/{loc}~{yyyy-mm}`) in the same transaction, so financial statements read a few
 * summary documents instead of every journal ever posted.
 */
import { BadRequest, Conflict, D, Decimal, ValidationFailed, ZERO, localDate, newId, r2, roundRupee, s2, sum, type Num } from './core'
import { all, type Row, type Uow } from './store'

// ================================================================ GST
export class BillingError extends Error {}
export interface LineInput { unit_price: Num; qty: number; tax_rate: Num; line_discount?: Num }
export interface LineResult { gross: Decimal; line_discount: Decimal; bill_discount_alloc: Decimal; taxable_value: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal; line_total: Decimal }
export interface BillResult {
  lines: LineResult[]; gross: Decimal; line_discount_total: Decimal; bill_discount: Decimal; taxable_total: Decimal
  cgst_total: Decimal; sgst_total: Decimal; igst_total: Decimal; round_off: Decimal; grand_total: Decimal; tax_total: Decimal; discount_total: Decimal
}
const H = new Decimal(100)

export function splitTax(amount: Num, rate: Num, o: { inclusive: boolean; interstate: boolean }): [Decimal, Decimal, Decimal, Decimal] {
  const a = r2(amount)
  const r = D(rate)
  if (r.lt(0)) throw new BillingError('Tax rate cannot be negative')
  if (r.eq(0)) return [a, ZERO, ZERO, ZERO]
  if (o.interstate) {
    const igst = o.inclusive ? r2(a.times(r).div(H.plus(r))) : r2(a.times(r).div(H))
    return [o.inclusive ? a.minus(igst) : a, ZERO, ZERO, igst]
  }
  const half = o.inclusive ? r2(a.times(r).div(H.plus(r).times(2))) : r2(a.times(r).div(200))
  return [o.inclusive ? a.minus(half.times(2)) : a, half, half, ZERO]
}

export function allocate(total: Num, weights: Decimal[]): Decimal[] {
  const t = r2(total)
  const ws = sum(weights)
  if (t.eq(0) || ws.eq(0)) return weights.map(() => ZERO)
  const parts = weights.map((w) => r2(t.times(w).div(ws)))
  const diff = t.minus(sum(parts))
  if (!diff.eq(0)) {
    let idx = 0
    weights.forEach((w, i) => { if (w.gt(weights[idx])) idx = i })
    parts[idx] = parts[idx].plus(diff)
  }
  return parts
}

export function computeBill(lines: LineInput[], o: { prices_include_tax: boolean; interstate: boolean; bill_discount?: Num; rounding?: string }): BillResult {
  if (!lines.length) throw new BillingError('A bill needs at least one line')
  const gross: Decimal[] = [], nets: Decimal[] = [], ld: Decimal[] = []
  for (const ln of lines) {
    if (ln.qty <= 0) throw new BillingError('Quantity must be positive')
    if (D(ln.unit_price).lt(0)) throw new BillingError('Price cannot be negative')
    const g = r2(D(ln.unit_price).times(ln.qty))
    const d = r2(ln.line_discount)
    if (d.lt(0) || d.gt(g)) throw new BillingError('Line discount must be between 0 and the line amount')
    gross.push(g); ld.push(d); nets.push(g.minus(d))
  }
  const bd = r2(o.bill_discount)
  if (bd.lt(0) || bd.gt(sum(nets))) throw new BillingError('Bill discount must be between 0 and the bill amount')
  const allocs = allocate(bd, nets)
  const res: BillResult = { lines: [], gross: ZERO, line_discount_total: ZERO, bill_discount: bd, taxable_total: ZERO, cgst_total: ZERO, sgst_total: ZERO, igst_total: ZERO, round_off: ZERO, grand_total: ZERO, tax_total: ZERO, discount_total: ZERO }
  lines.forEach((ln, i) => {
    const [taxable, cgst, sgst, igst] = splitTax(nets[i].minus(allocs[i]), ln.tax_rate, { inclusive: o.prices_include_tax, interstate: o.interstate })
    res.lines.push({ gross: gross[i], line_discount: ld[i], bill_discount_alloc: allocs[i], taxable_value: taxable, cgst, sgst, igst, line_total: taxable.plus(cgst).plus(sgst).plus(igst) })
    res.gross = res.gross.plus(gross[i]); res.line_discount_total = res.line_discount_total.plus(ld[i])
    res.taxable_total = res.taxable_total.plus(taxable); res.cgst_total = res.cgst_total.plus(cgst); res.sgst_total = res.sgst_total.plus(sgst); res.igst_total = res.igst_total.plus(igst)
  })
  res.tax_total = res.cgst_total.plus(res.sgst_total).plus(res.igst_total)
  res.discount_total = res.line_discount_total.plus(bd)
  const pre = res.taxable_total.plus(res.tax_total)
  if ((o.rounding ?? 'NEAREST_RUPEE') === 'NEAREST_RUPEE') res.round_off = roundRupee(pre).minus(pre)
  res.grand_total = pre.plus(res.round_off)
  return res
}

export function prorateReturn(o: { sale_qty: number; return_qty: number; taxable: Num; cgst: Num; sgst: Num; igst: Num; already_qty?: number; already?: [Num, Num, Num, Num] }): [Decimal, Decimal, Decimal, Decimal] {
  const aq = o.already_qty ?? 0
  if (o.return_qty <= 0 || aq + o.return_qty > o.sale_qty) throw new BillingError('Return quantity exceeds quantity sold')
  if (aq + o.return_qty === o.sale_qty) {
    const a = o.already ?? [0, 0, 0, 0]
    return [D(o.taxable).minus(D(a[0])), D(o.cgst).minus(D(a[1])), D(o.sgst).minus(D(a[2])), D(o.igst).minus(D(a[3]))]
  }
  const f = new Decimal(o.return_qty).div(o.sale_qty)
  return [r2(D(o.taxable).times(f)), r2(D(o.cgst).times(f)), r2(D(o.sgst).times(f)), r2(D(o.igst).times(f))]
}

export const STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
}
const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
export function gstinChecksum(first14: string): string {
  let t = 0
  for (let i = 0; i < 14; i++) {
    const p = GSTIN_CHARS.indexOf(first14[i]) * (i % 2 ? 2 : 1)
    t += Math.floor(p / 36) + (p % 36)
  }
  return GSTIN_CHARS[(36 - (t % 36)) % 36]
}
export function validGstin(gstin: string): boolean {
  const g = gstin.trim().toUpperCase()
  return /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g) && g.slice(0, 2) in STATE_CODES && gstinChecksum(g.slice(0, 14)) === g[14]
}
export const stateFromGstin = (g: string | null | undefined) => (g && g.length >= 2 ? g.slice(0, 2) : null)

// ================================================================ accounting
export const SYSTEM_ACCOUNTS: [string, string, string, string, boolean][] = [
  ['CASH', '1000', 'Cash on Hand', 'ASSET', true], ['BANK', '1010', 'Bank Account', 'ASSET', true], ['UPI_CLEARING', '1020', 'UPI Collections', 'ASSET', true],
  ['CARD_CLEARING', '1030', 'Card Settlements Clearing', 'ASSET', true], ['AR', '1100', 'Accounts Receivable', 'ASSET', false], ['INVENTORY', '1200', 'Inventory', 'ASSET', false],
  ['INPUT_CGST', '1300', 'Input CGST', 'ASSET', false], ['INPUT_SGST', '1301', 'Input SGST', 'ASSET', false], ['INPUT_IGST', '1302', 'Input IGST', 'ASSET', false],
  ['AP', '2000', 'Accounts Payable', 'LIABILITY', false], ['GRNI', '2010', 'Goods Received Not Invoiced', 'LIABILITY', false],
  ['OUTPUT_CGST', '2100', 'Output CGST', 'LIABILITY', false], ['OUTPUT_SGST', '2101', 'Output SGST', 'LIABILITY', false], ['OUTPUT_IGST', '2102', 'Output IGST', 'LIABILITY', false],
  ['STORE_CREDIT', '2200', 'Customer Store Credit', 'LIABILITY', false], ['EXCHANGE_CLEARING', '2210', 'Exchange Credit Clearing', 'LIABILITY', false],
  ['OPENING_EQUITY', '3000', 'Opening Balance Equity', 'EQUITY', false], ['OWNER_CAPITAL', '3100', "Owner's Capital", 'EQUITY', false], ['RETAINED_EARNINGS', '3200', 'Retained Earnings', 'EQUITY', false],
  ['SALES', '4000', 'Sales Revenue', 'INCOME', false], ['SALES_RETURNS', '4010', 'Sales Returns', 'INCOME', false], ['ROUND_OFF', '4900', 'Rounding Adjustments', 'INCOME', false],
  ['COGS', '5000', 'Cost of Goods Sold', 'EXPENSE', false], ['INVENTORY_ADJ', '5100', 'Inventory Shrinkage & Write-offs', 'EXPENSE', false],
  ['PURCHASE_VARIANCE', '5110', 'Purchase Price Variance', 'EXPENSE', false], ['CASH_OVER_SHORT', '5200', 'Cash Over / Short', 'EXPENSE', false], ['LOYALTY_EXPENSE', '5300', 'Loyalty Rewards', 'EXPENSE', false],
]
export const DEFAULT_EXPENSE_ACCOUNTS: [string, string, string][] = [
  ['6000', 'Rent', 'Rent'], ['6010', 'Salaries & Wages', 'Salaries'], ['6020', 'Electricity & Utilities', 'Utilities'], ['6030', 'Store Supplies', 'Store Supplies'],
  ['6040', 'Freight & Transport', 'Transport'], ['6050', 'Marketing & Advertising', 'Marketing'], ['6060', 'Repairs & Maintenance', 'Maintenance'], ['6090', 'Miscellaneous Expenses', 'Miscellaneous'],
]

export interface Leg { account: string; amount: Num; location_id?: string | null; memo?: string | null }

export async function accountByKey(key: string): Promise<Row> {
  const acc = (await all('accounts')).find((a) => a.system_key === key)
  if (!acc) throw BadRequest(`System account ${key} is not configured`, { code: 'accounting_setup' })
  return acc
}

/** Add amounts into a per-location summary document (`daily` / `monthly`). `path` keys are dot paths. */
export async function bump(u: Uow, coll: 'daily' | 'monthly', loc: string | null, period: string, add: Record<string, Num>, extra: Record<string, unknown> = {}) {
  const path = `${coll}/${loc ?? 'ORG'}~${period}`
  const cur = (await u.get(path)) ?? { location_id: loc ?? 'ORG', period }
  const next: Record<string, unknown> = { ...cur, ...extra }
  for (const [k, v] of Object.entries(add)) {
    const parts = k.split('.')
    let o = next as Record<string, unknown>
    for (const p of parts.slice(0, -1)) {
      o[p] = { ...((o[p] as Record<string, unknown>) ?? {}) }
      o = o[p] as Record<string, unknown>
    }
    const last = parts[parts.length - 1]
    const prev = o[last]
    o[last] = typeof v === 'number' && (typeof prev === 'number' || prev === undefined) ? ((prev as number) ?? 0) + v : s2(D(prev as Num).plus(D(v)))
  }
  u.set(path, next)
}
/** Same additions into both the day and the month summary. */
export async function bumpBoth(u: Uow, loc: string | null, date: string, add: Record<string, Num>) {
  await bump(u, 'daily', loc, date, add)
  await bump(u, 'monthly', loc, date.slice(0, 7), add)
}

export async function post(u: Uow, o: { source_type: string; source_id?: string | null; legs: Leg[]; memo?: string | null; location_id?: string | null; actor_id?: string | null; entry_date?: string; reversal_of_id?: string | null }): Promise<string | null> {
  const accounts = await all('accounts')
  const byKey = new Map(accounts.map((a) => [a.system_key as string, a]))
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const net = new Map<string, { acc: Row; loc: string | null; memo: string | null; amt: Decimal }>()
  for (const leg of o.legs) {
    const amt = r2(leg.amount)
    if (amt.eq(0)) continue
    const acc = byId.get(leg.account) ?? byKey.get(leg.account)
    if (!acc) {
      if (byId.size && !byKey.has(leg.account) && leg.account.length !== 24) throw BadRequest(`System account ${leg.account} is not configured`, { code: 'accounting_setup' })
      throw ValidationFailed('Account not found or inactive')
    }
    if (acc.is_active === false) throw ValidationFailed('Account not found or inactive')
    const loc = leg.location_id !== undefined && leg.location_id !== null ? leg.location_id : (o.location_id ?? null)
    const k = `${acc.id}|${loc}|${leg.memo ?? ''}`
    const cur = net.get(k)
    if (cur) cur.amt = cur.amt.plus(amt)
    else net.set(k, { acc, loc, memo: leg.memo ?? null, amt })
  }
  const rows = [...net.values()].filter((r) => !r.amt.eq(0))
  if (!rows.length) return null
  const total = sum(rows.map((r) => r.amt))
  if (!total.eq(0)) throw BadRequest(`Unbalanced journal for ${o.source_type}: difference ${total.toFixed(2)}`, { code: 'unbalanced_journal' })
  const date = o.entry_date ?? localDate()
  const id = newId()
  const number = `JV-${Date.now().toString(36).toUpperCase()}${id.slice(0, 3).toUpperCase()}`
  const lines = rows.map((r) => ({ account_id: r.acc.id, account_code: r.acc.code, account_name: r.acc.name, account_type: r.acc.type, debit: s2(r.amt.gt(0) ? r.amt : ZERO), credit: s2(r.amt.lt(0) ? r.amt.neg() : ZERO), location_id: r.loc, memo: r.memo }))
  u.set(`journals/${id}`, {
    number, entry_date: date, source_type: o.source_type, source_id: o.source_id ?? null, memo: o.memo ?? null, location_id: o.location_id ?? null,
    location_ids: [...new Set(lines.map((l) => l.location_id ?? 'ORG'))], account_ids: [...new Set(lines.map((l) => l.account_id))],
    reversal_of_id: o.reversal_of_id ?? null, reversed_by_id: null, created_by: o.actor_id ?? null, created_at: u.at, lines,
    total: s2(sum(lines.map((l) => l.debit))),
  })
  if (o.reversal_of_id) await u.update(`journals/${o.reversal_of_id}`, { reversed_by_id: id })
  // per-location account movement totals
  const byLoc = new Map<string | null, Record<string, Num>>()
  for (const l of lines) {
    const add = byLoc.get(l.location_id) ?? {}
    add[`acct.${l.account_id}.dr`] = D(add[`acct.${l.account_id}.dr`]).plus(l.debit)
    add[`acct.${l.account_id}.cr`] = D(add[`acct.${l.account_id}.cr`]).plus(l.credit)
    byLoc.set(l.location_id, add)
  }
  for (const [loc, add] of byLoc) await bumpBoth(u, loc, date, add)
  return id
}

export async function reverse(u: Uow, entry: Row, o: { actor_id?: string | null; memo?: string | null; source_type?: string; source_id?: string | null }): Promise<string> {
  if (entry.reversed_by_id) throw Conflict('This journal entry has already been reversed')
  if (entry.reversal_of_id) throw Conflict('A reversal entry cannot itself be reversed; post a new entry instead')
  const legs: Leg[] = (entry.lines as Row[]).map((l) => ({ account: l.account_id, amount: D(l.credit).minus(D(l.debit)), location_id: l.location_id ?? null, memo: l.memo }))
  const id = await post(u, { source_type: o.source_type ?? entry.source_type, source_id: o.source_id ?? entry.source_id, legs, memo: o.memo ?? `Reversal of ${entry.number}`, location_id: entry.location_id, actor_id: o.actor_id, reversal_of_id: entry.id })
  return id!
}
