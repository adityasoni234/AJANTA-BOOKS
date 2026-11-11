/** Chart of accounts, journals, cashbook, fund transfers, bank reconciliation, expense categories and expenses. */
import { limit, where } from 'firebase/firestore'
import { createApproval, registerApproval } from './approvals'
import type { Ctx } from './ctx'
import { Conflict, D, NotFound, ValidationFailed, ZERO, addDays, clean, daysBetween, fieldError, localDate, matches, paginate, r2, s2, sum, type Num } from './core'
import { bumpBoth, post, reverse, type Leg } from './ledger'
import { accountTotals } from './reports'
import { route } from './router'
import { sessionAdd } from './sales'
import { getPolicy } from './settings'
import { all, byId, find, findScoped, getOne, tx, type Row, type Uow } from './store'

// ================================================================ accounts
const accountOut = (a: Row, balance?: string | null) => ({ id: a.id, code: a.code, name: a.name, type: a.type, system_key: a.system_key ?? null, is_cash_or_bank: !!a.is_cash_or_bank, location_id: a.location_id ?? null, is_active: a.is_active !== false, description: a.description ?? null, balance: balance ?? null })

route('GET', '/accounts', async ({ query }, ctx) => {
  ctx.requireAny('accounting.view', 'finance.view', 'expenses.create')
  let rows = (await all('accounts')).sort((a, b) => String(a.code).localeCompare(String(b.code)))
  if (query.cash_or_bank !== undefined) rows = rows.filter((a) => String(!!a.is_cash_or_bank) === query.cash_or_bank)
  if (query.with_balances === 'true' && (ctx.has('accounting.view') || ctx.has('finance.view'))) {
    const tot = new Map((await accountTotals(null, localDate(), ctx.scope(), ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'])).map((r) => [r.account_id, r.debit.minus(r.credit)]))
    return rows.map((a) => accountOut(a, s2(tot.get(a.id) ?? 0)))
  }
  return rows.map((a) => accountOut(a))
})
function accountIn(b: Record<string, unknown>) {
  const code = String(b.code ?? ''), name = String(b.name ?? ''), type = String(b.type ?? '')
  if (!/^[0-9A-Z-]{3,20}$/.test(code)) throw fieldError('code', 'String should match pattern ^[0-9A-Z-]+$')
  if (name.length < 2) throw fieldError('name', 'String should have at least 2 characters')
  if (!['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'].includes(type)) throw fieldError('type', 'Invalid account type')
  const v = { code, name, type, is_cash_or_bank: !!b.is_cash_or_bank, location_id: clean(b.location_id), is_active: b.is_active !== false, description: clean(b.description) }
  if (v.is_cash_or_bank && type !== 'ASSET') throw ValidationFailed('Cash and bank accounts must be asset accounts')
  return v
}
async function hasPostings(id: string) {
  return (await find('journals', where('account_ids', 'array-contains', id), limit(1))).length > 0
}
route('POST', '/accounts', async ({ body }, ctx) => {
  ctx.require('accounting.manage')
  const v = accountIn(body)
  if ((await all('accounts')).some((a) => a.code === v.code)) throw Conflict('Account code already exists')
  return tx(async (u) => {
    const id = u.add('accounts', { ...v, system_key: null })
    ctx.audit(u, 'accounting.account_created', { entity_type: 'account', entity_id: id, details: v })
    return accountOut({ ...v, id, system_key: null } as Row)
  })
})
route('PUT', '/accounts/:id', async ({ params, body }, ctx) => {
  ctx.require('accounting.manage')
  const a = await byId('accounts', params.id)
  if (!a) throw NotFound('Account not found')
  const v = accountIn(body)
  if (a.system_key && (v.type !== a.type || !v.is_active || v.is_cash_or_bank !== !!a.is_cash_or_bank)) throw ValidationFailed('System accounts can be renamed but not retyped or deactivated')
  if (v.type !== a.type && (await hasPostings(a.id))) throw ValidationFailed('Account type cannot change once postings exist')
  if (v.code !== a.code && (await all('accounts')).some((x) => x.code === v.code)) throw Conflict('Account code already exists')
  return tx(async (u) => {
    await u.update(`accounts/${a.id}`, v)
    ctx.audit(u, 'accounting.account_updated', { entity_type: 'account', entity_id: a.id, details: { before: accountOut(a), after: v } })
    return accountOut({ ...a, ...v })
  })
})
route('DELETE', '/accounts/:id', async ({ params }, ctx) => {
  ctx.require('accounting.manage')
  const a = await byId('accounts', params.id)
  if (!a) throw NotFound('Account not found')
  if (a.system_key) throw ValidationFailed('System accounts cannot be deleted')
  if ((await hasPostings(a.id)) || (await all('expense_categories')).some((c) => c.account_id === a.id) || (await all('payment_methods')).some((m) => m.account_id === a.id)) throw Conflict('This account is in use; deactivate it instead')
  await tx(async (u) => {
    u.delete(`accounts/${a.id}`)
    ctx.audit(u, 'accounting.account_deleted', { entity_type: 'account', entity_id: a.id, details: { code: a.code } })
  })
  return undefined
})

// ================================================================ journals
async function jeOut(je: Row) {
  const locs = new Map((await all('locations')).map((l) => [l.id, l.name]))
  return {
    id: je.id, number: je.number, entry_date: je.entry_date, source_type: je.source_type, source_id: je.source_id, memo: je.memo, location_id: je.location_id, location_name: locs.get(je.location_id) ?? null,
    reversal_of_id: je.reversal_of_id ?? null, reversed_by_id: je.reversed_by_id ?? null, created_by: je.created_by_name ?? null, posted_at: je.created_at, total: je.total,
    lines: (je.lines as Row[]).map((l) => ({ account_id: l.account_id, account_code: l.account_code, account_name: l.account_name, debit: l.debit, credit: l.credit, location_name: locs.get(l.location_id) ?? null, memo: l.memo })),
  }
}
const jeVisible = (ctx: Ctx, je: Row) => ctx.all_locations || (je.lines as Row[]).some((l) => ctx.location_ids.includes(l.location_id))
route('GET', '/journals', async ({ query }, ctx) => {
  ctx.require('accounting.view')
  const cs = []
  if (query.account_id) cs.push(where('account_ids', 'array-contains', query.account_id))
  if (query.date_from) cs.push(where('entry_date', '>=', query.date_from))
  if (query.date_to) cs.push(where('entry_date', '<=', query.date_to))
  const rows = (await find('journals', ...cs, limit(3000))).filter((je) => jeVisible(ctx, je) && (!query.source_type || je.source_type === query.source_type) && (!query.q || matches(query.q, je.number, je.memo)))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  const page = paginate(rows, Number(query.page), Number(query.page_size))
  return { ...page, items: await Promise.all(page.items.map(jeOut)) }
})
route('GET', '/journals/:id', async ({ params }, ctx) => {
  ctx.require('accounting.view')
  const je = await getOne(`journals/${params.id}`)
  if (!je || !jeVisible(ctx, je)) throw NotFound('Journal entry not found')
  return jeOut(je)
})
route('POST', '/journals', async ({ body }, ctx) => {
  ctx.require('accounting.manage')
  if (!ctx.all_locations) throw ValidationFailed('Manual journals require organisation-wide access')
  const memo = String(body.memo ?? '')
  if (memo.length < 3) throw fieldError('memo', 'String should have at least 3 characters')
  const date = String(body.entry_date ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fieldError('entry_date', 'Input should be a valid date')
  const lines = (body.lines ?? []) as Record<string, unknown>[]
  if (lines.length < 2) throw ValidationFailed('At least two lines are required')
  const dr = sum(lines.map((l) => r2(l.debit as Num))), cr = sum(lines.map((l) => r2(l.credit as Num)))
  if (!dr.eq(cr) || dr.eq(0)) throw ValidationFailed(`Debits (${dr.toFixed(2)}) must equal credits (${cr.toFixed(2)}) and be non-zero`)
  for (const l of lines) if (D(l.debit as Num).gt(0) === D(l.credit as Num).gt(0)) throw ValidationFailed('Each line must have either a debit or a credit')
  const je = await tx(async (u) => {
    const id = await post(u, { source_type: 'MANUAL', actor_id: ctx.uid, entry_date: date, memo, legs: lines.map((l) => ({ account: String(l.account_id), amount: r2(l.debit as Num).minus(r2(l.credit as Num)), location_id: clean(l.location_id), memo: clean(l.memo) })) })
    await u.update(`journals/${id}`, { created_by_name: ctx.name })
    ctx.audit(u, 'accounting.manual_journal', { entity_type: 'journal_entry', entity_id: id, details: { total: dr.toFixed(2), memo } })
    return u.get(`journals/${id}`)
  })
  return jeOut(je!)
})
route('POST', '/journals/:id/reverse', async ({ params, body }, ctx) => {
  ctx.require('accounting.manage')
  const reason = String(body.reason ?? '')
  if (reason.length < 3) throw fieldError('reason', 'String should have at least 3 characters')
  const rev = await tx(async (u) => {
    const je = await u.get(`journals/${params.id}`)
    if (!je) throw NotFound('Journal entry not found')
    if (je.source_type !== 'MANUAL') throw ValidationFailed('System-generated entries are corrected through their source document (void, return, adjustment); only manual journals can be reversed here')
    const id = await reverse(u, je, { actor_id: ctx.uid, memo: `Reversal of ${je.number}: ${reason}` })
    await u.update(`journals/${id}`, { created_by_name: ctx.name })
    ctx.audit(u, 'accounting.journal_reversed', { entity_type: 'journal_entry', entity_id: je.id, details: { reason } })
    return u.get(`journals/${id}`)
  })
  return jeOut(rev!)
})

// ================================================================ cashbook, fund transfers, bank reconciliation
async function balanceOf(accountId: string, asOf: string, scope: string[] | null) {
  const r = (await accountTotals(null, asOf, scope, ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'])).find((x) => x.account_id === accountId)
  return r ? r.debit.minus(r.credit) : ZERO
}
route('GET', '/cashbook', async ({ query }, ctx) => {
  ctx.require('finance.view')
  const acc = await byId('accounts', String(query.account_id ?? ''))
  if (!acc || !acc.is_cash_or_bank) throw ValidationFailed('Select a cash or bank account')
  const d1 = String(query.date_from ?? ''), d2 = String(query.date_to ?? '')
  if (!d1 || !d2) throw ValidationFailed('Choose a date range')
  if (daysBetween(d1, d2) > 400) throw ValidationFailed('Date range is limited to 400 days')
  const scope = ctx.scope(query.location_id)
  const opening = await balanceOf(acc.id, addDays(d1, -1), scope)
  const journals = (await find('journals', where('account_ids', 'array-contains', acc.id), where('entry_date', '>=', d1), where('entry_date', '<=', d2), limit(5000)))
    .sort((a, b) => String(a.entry_date).localeCompare(String(b.entry_date)) || String(a.created_at).localeCompare(String(b.created_at)))
  let bal = opening
  const rows = []
  for (const je of journals) for (const l of je.lines as Row[]) {
    if (l.account_id !== acc.id || (scope !== null && !scope.includes(l.location_id))) continue
    bal = bal.plus(D(l.debit)).minus(D(l.credit))
    rows.push({ date: je.entry_date, number: je.number, source_type: je.source_type, memo: je.memo, receipt: l.debit, payment: l.credit, balance: s2(bal), journal_id: je.id })
  }
  return { account: accountOut(acc), opening_balance: s2(opening), closing_balance: s2(bal), total_receipts: s2(sum(rows.map((r) => r.receipt))), total_payments: s2(sum(rows.map((r) => r.payment))), entries: rows }
})
route('POST', '/fund-transfers', async ({ body }, ctx) => {
  ctx.require('finance.manage')
  const from = await byId('accounts', String(body.from_account_id ?? '')), to = await byId('accounts', String(body.to_account_id ?? ''))
  if (body.from_account_id === body.to_account_id) throw ValidationFailed('Choose two different accounts')
  if (!from || !to || !from.is_cash_or_bank || !to.is_cash_or_bank) throw ValidationFailed('Transfers are only between cash/bank accounts')
  const loc = clean(body.location_id)
  if (loc) ctx.ensureLocation(loc)
  const amount = r2(body.amount as Num)
  if (amount.lte(0)) throw ValidationFailed('Amount must be positive')
  return tx(async (u) => {
    const id = await post(u, { source_type: 'FUND_TRANSFER', actor_id: ctx.uid, location_id: loc, entry_date: String(body.entry_date || localDate()), memo: clean(body.memo) || `Transfer ${from.name} → ${to.name}`, legs: [{ account: to.id, amount }, { account: from.id, amount: amount.neg() }] })
    const je = await u.get(`journals/${id}`)
    ctx.audit(u, 'finance.fund_transfer', { entity_type: 'journal_entry', entity_id: id, location_id: loc, details: { from: from.name, to: to.name, amount: s2(amount) } })
    return { journal_number: je?.number }
  })
})
route('POST', '/bank-reconciliations', async ({ body }, ctx) => {
  ctx.require('finance.manage')
  const acc = await byId('accounts', String(body.account_id ?? ''))
  if (!acc || !acc.is_cash_or_bank) throw ValidationFailed('Select a cash or bank account')
  const date = String(body.statement_date ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fieldError('statement_date', 'Input should be a valid date')
  const book = await balanceOf(acc.id, date, null)
  const stmt = r2(body.statement_balance as Num)
  return tx(async (u) => {
    const id = u.add('bank_reconciliations', { account_id: acc.id, account: acc.name, statement_date: date, statement_balance: s2(stmt), book_balance: s2(book), difference: s2(stmt.minus(book)), notes: clean(body.notes), created_by: ctx.uid })
    ctx.audit(u, 'finance.bank_reconciliation', { entity_type: 'account', entity_id: acc.id, details: { statement: s2(stmt), book: s2(book) } })
    return { id, book_balance: s2(book), statement_balance: s2(stmt), difference: s2(stmt.minus(book)) }
  })
})
route('GET', '/bank-reconciliations', async ({ query }, ctx) => {
  ctx.require('finance.view')
  return (await find('bank_reconciliations', limit(500))).filter((r) => !query.account_id || r.account_id === query.account_id).sort((a, b) => String(b.statement_date).localeCompare(String(a.statement_date))).slice(0, 100)
    .map((r) => ({ id: r.id, account: r.account, statement_date: r.statement_date, statement_balance: r.statement_balance, book_balance: r.book_balance, difference: r.difference, notes: r.notes, created_at: r.created_at }))
})

// ================================================================ expenses
route('GET', '/expense-categories', async (_r, ctx) => {
  ctx.requireAny('expenses.view', 'expenses.create')
  return (await all('expense_categories')).sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ id: c.id, name: c.name, account_id: c.account_id, is_active: c.is_active !== false }))
})
async function categoryIn(b: Record<string, unknown>) {
  const name = String(b.name ?? '')
  if (name.length < 2) throw fieldError('name', 'String should have at least 2 characters')
  const acc = await byId('accounts', String(b.account_id ?? ''))
  if (!acc || acc.type !== 'EXPENSE') throw ValidationFailed('Expense categories must map to an expense account')
  return { name, account_id: acc.id, is_active: b.is_active !== false }
}
route('POST', '/expense-categories', async ({ body }, ctx) => {
  ctx.require('accounting.manage')
  const v = await categoryIn(body)
  return tx(async (u) => {
    const id = u.add('expense_categories', v)
    ctx.audit(u, 'finance.expense_category_created', { entity_type: 'expense_category', entity_id: id, details: v })
    return { id, ...v }
  })
})
route('PUT', '/expense-categories/:id', async ({ params, body }, ctx) => {
  ctx.require('accounting.manage')
  const c = await byId('expense_categories', params.id)
  if (!c) throw NotFound('Expense category not found')
  const v = await categoryIn(body)
  return tx(async (u) => {
    await u.update(`expense_categories/${c.id}`, v)
    ctx.audit(u, 'finance.expense_category_updated', { entity_type: 'expense_category', entity_id: c.id, details: v })
    return { id: c.id, ...v }
  })
})
route('DELETE', '/expense-categories/:id', async ({ params }, ctx) => {
  ctx.require('accounting.manage')
  const c = await byId('expense_categories', params.id)
  if (!c) throw NotFound('Expense category not found')
  if ((await find('expenses', where('category_id', '==', c.id), limit(1))).length) throw Conflict('This category has expenses; deactivate it instead')
  await tx(async (u) => {
    u.delete(`expense_categories/${c.id}`)
    ctx.audit(u, 'finance.expense_category_deleted', { entity_type: 'expense_category', entity_id: c.id, details: { name: c.name } })
  })
  return undefined
})

async function expOut(e: Row) {
  const loc = await byId('locations', e.location_id)
  return { id: e.id, number: e.number, location_id: e.location_id, location_name: loc?.name ?? '', category: e.category_name, expense_date: e.expense_date, amount: e.amount, description: e.description, vendor: e.vendor,
    paid_from: e.paid_from_name, reference: e.reference, status: e.status, has_receipt: !!e.has_receipt, created_by: e.created_by_name, approved_by: e.approved_by_name ?? null, rejection_reason: e.rejection_reason ?? null, created_at: e.created_at }
}
async function postExpense(u: Uow, ctx: Ctx, e: Row) {
  if (e.register_session_id) {
    const s = await u.need(`register_sessions/${e.register_session_id}`, 'Register session')
    if (s.status !== 'OPEN') throw Conflict('The register session for this cash expense is closed; record it against a new session')
    await sessionAdd(u, s.id, { expense: e.amount })
  }
  const cat = (await byId('expense_categories', e.category_id))!
  const je = await post(u, { source_type: 'EXPENSE', source_id: e.id, location_id: e.location_id, actor_id: ctx.uid, entry_date: e.expense_date, memo: `Expense ${e.number}: ${String(e.description).slice(0, 100)}`,
    legs: [{ account: cat.account_id, amount: e.amount }, { account: e.paid_from_account_id, amount: D(e.amount).neg() }] as Leg[] })
  await bumpBoth(u, e.location_id, e.expense_date, { 'x.amount': e.amount, 'x.count': 1 })
  const patch = { journal_entry_id: je, status: 'POSTED', approved_by: ctx.uid, approved_by_name: ctx.name, approved_at: u.at }
  await u.update(`expenses/${e.id}`, patch)
  return { ...e, ...patch }
}
registerApproval('EXPENSE', async (u, ctx, req) => {
  const e = await u.get(`expenses/${req.entity_id}`)
  if (!e || e.status !== 'PENDING_APPROVAL') throw Conflict('Expense is not pending approval')
  await postExpense(u, ctx, e)
}, async (u, _ctx, req) => {
  const e = await u.get(`expenses/${req.entity_id}`)
  if (e && e.status === 'PENDING_APPROVAL') await u.update(`expenses/${e.id}`, { status: 'REJECTED', rejection_reason: req.decision_note ?? null })
})

route('GET', '/expenses', async ({ query }, ctx) => {
  ctx.require('expenses.view')
  if (query.location_id) ctx.ensureLocation(query.location_id)
  const cs = []
  if (query.date_from) cs.push(where('expense_date', '>=', query.date_from))
  if (query.date_to) cs.push(where('expense_date', '<=', query.date_to))
  const rows = (await findScoped('expenses', query.location_id ? [query.location_id] : ctx.scope(), 'location_id', ...cs, limit(3000)))
    .filter((e) => (!query.category_id || e.category_id === query.category_id) && (!query.status || e.status === query.status))
    .sort((a, b) => String(b.expense_date).localeCompare(String(a.expense_date)) || String(b.created_at).localeCompare(String(a.created_at)))
  const page = paginate(rows, Number(query.page), Number(query.page_size))
  return { ...page, items: await Promise.all(page.items.map(expOut)) }
})
route('POST', '/expenses', async ({ body, headers }, ctx) => {
  ctx.require('expenses.create')
  const key = headers['Idempotency-Key'] ? String(headers['Idempotency-Key']) : null
  if (key) {
    const prior = await getOne(`idempotency/exp~${key}`)
    if (prior) { const e = await getOne(`expenses/${prior.id}`); if (e) return expOut(e) }
  }
  const loc = String(body.location_id ?? '')
  ctx.ensureLocation(loc)
  const cat = await byId('expense_categories', String(body.category_id ?? ''))
  if (!cat || cat.is_active === false) throw ValidationFailed('Expense category not found')
  const acc = await byId('accounts', String(body.paid_from_account_id ?? ''))
  if (!acc || !acc.is_cash_or_bank || acc.is_active === false) throw ValidationFailed('Expenses must be paid from a cash or bank account')
  const desc = String(body.description ?? '')
  if (desc.length < 3) throw fieldError('description', 'String should have at least 3 characters')
  const date = String(body.expense_date ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fieldError('expense_date', 'Input should be a valid date')
  const amount = r2(body.amount as Num)
  if (amount.lte(0)) throw ValidationFailed('Amount must be positive')
  const policy = await getPolicy()
  const needs = D(policy.expense_approval_threshold).gt(0) && amount.gte(D(policy.expense_approval_threshold)) && !ctx.has('expenses.approve')
  const e = await tx(async (u) => {
    let sessionId: string | null = null
    if (body.register_session_id) {
      const s = await u.get(`register_sessions/${body.register_session_id}`)
      if (!s || s.status !== 'OPEN' || s.location_id !== loc) throw Conflict('Register session is not open at this location')
      if (acc.system_key !== 'CASH') throw ValidationFailed('Register expenses must be paid from Cash on Hand')
      sessionId = s.id
    }
    const doc: Row = { id: '', number: await u.nextNumber('EXP'), location_id: loc, category_id: cat.id, category_name: cat.name, expense_date: date, amount: s2(amount), description: desc, vendor: clean(body.vendor),
      paid_from_account_id: acc.id, paid_from_name: acc.name, register_session_id: sessionId, reference: clean(body.reference), status: needs ? 'PENDING_APPROVAL' : 'POSTED', idempotency_key: key,
      created_by: ctx.uid, created_by_name: ctx.name, created_at: u.at, has_receipt: false, journal_entry_id: null }
    doc.id = u.add('expenses', doc)
    if (key) u.set(`idempotency/exp~${key}`, { id: doc.id, created_at: u.at })
    const out = needs ? doc : await postExpense(u, ctx, doc)
    if (needs) createApproval(u, ctx, { type: 'EXPENSE', location_id: loc, title: `Expense ${doc.number}: ${desc.slice(0, 80)} (₹${s2(amount)})`, entity_type: 'expense', entity_id: doc.id, amount })
    ctx.audit(u, 'finance.expense_created', { entity_type: 'expense', entity_id: doc.id, location_id: loc, details: { amount: s2(amount), category: cat.name, status: out.status } })
    return out
  })
  return expOut(e)
})
route('POST', '/expenses/:id/receipt', async ({ params, body }, ctx) => {
  ctx.require('expenses.create')
  const e = await getOne(`expenses/${params.id}`)
  if (!e) throw NotFound('Expense not found')
  ctx.ensureResource(e.location_id)
  const file = body instanceof FormData ? (body.get('file') as Blob | null) : null
  if (!file) throw ValidationFailed('No file uploaded')
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer())
  const pdf = String.fromCharCode(...head.slice(0, 4)) === '%PDF'
  const jpg = head[0] === 0xff && head[1] === 0xd8, png = head[0] === 0x89 && head[1] === 0x50
  if (!pdf && !jpg && !png) throw ValidationFailed('Only PDF, JPEG or PNG receipts are allowed')
  let data: string
  if (pdf) {
    if (file.size > 700 * 1024) throw ValidationFailed('PDF receipts must be under 700 KB (photos are compressed automatically)')
    data = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(file) })
  } else {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, 1400 / Math.max(bmp.width, bmp.height))
    const c = document.createElement('canvas')
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale)
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
    data = c.toDataURL('image/jpeg', 0.75)
  }
  const out = await tx(async (u) => {
    u.set(`expense_receipts/${e.id}`, { data, location_id: e.location_id, updated_at: u.at })
    await u.update(`expenses/${e.id}`, { has_receipt: true })
    ctx.audit(u, 'finance.expense_receipt', { entity_type: 'expense', entity_id: e.id, location_id: e.location_id })
    return { ...e, has_receipt: true }
  })
  return expOut(out)
})
route('GET', '/expenses/:id/receipt', async ({ params }, ctx) => {
  ctx.require('expenses.view')
  const e = await getOne(`expenses/${params.id}`)
  if (!e || !e.has_receipt) throw NotFound('Receipt not found')
  ctx.ensureResource(e.location_id)
  const r = await getOne(`expense_receipts/${e.id}`)
  if (!r) throw NotFound('Receipt not found')
  return fetch(String(r.data))
})
