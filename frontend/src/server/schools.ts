/**
 * School book lists: sets available per location, Excel import (all-or-nothing), school orders that raise one
 * purchase order per author, and the customisable author order email (opened in the user's mail app; nothing
 * is sent by the system).
 *
 * A set is one copy of every book on a class list (or qty_per_set copies). Sets available at a location is the
 * smallest floor(available / qty_per_set) across the list, so the scarcest book limits it.
 */
import { limit, where } from 'firebase/firestore'
import { authorIds, createBook, parseBookIn } from './catalog'
import type { Ctx } from './ctx'
import { Conflict, D, NotFound, ValidationFailed, clean, cleanIsbn, fieldError, isbn10to13, lc, localDate, matches, newId, s2, validIsbn10, validIsbn13 } from './core'
import { createSupplier, newPoDoc, poLines, submitPo } from './purchasing'
import { route } from './router'
import { getOrg } from './settings'
import { balancesAt } from './stock'
import { all, byId, entries, find, findScoped, getOne, shardPath, tx, type Row, type Uow } from './store'

const ON_ORDER = ['APPROVED', 'ISSUED', 'PARTIALLY_RECEIVED']
const MAX_QTY = 50
const cleanText = (v: unknown) => String(v ?? '').split(/\s+/).filter(Boolean).join(' ')
export const classLabel = (c: string) => (/^(class|grade|std)/i.test(c) ? c : `Class ${c}`)

export function normaliseYear(value: string): string {
  const v = cleanText(value).replace(/\//g, '-').replace(/ /g, '')
  const m = /^(\d{4})-(\d{2}|\d{4})$/.exec(v)
  if (!m) throw new Error('Academic year must look like 2026-27')
  const start = Number(m[1])
  let end = m[2].length === 4 ? Number(m[2]) : Math.floor(start / 100) * 100 + Number(m[2])
  if (m[2].length === 2 && end < start) end += 100
  if (end !== start + 1) throw new Error('Academic year must span two consecutive years, e.g. 2026-27')
  return `${start}-${String(end % 100).padStart(2, '0')}`
}
function normaliseCode(value: string): string {
  const code = cleanText(value).toUpperCase().replace(/ /g, '-')
  if (!/^[A-Z0-9-]{2,20}$/.test(code)) throw new Error('School code must be 2–20 letters, digits or hyphens')
  return code
}
function normaliseEmail(value: string): string {
  const v = value.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error(`Invalid email address: ${value}`)
  return v
}
const wrap = <T>(fn: () => T, field: string): T => {
  try { return fn() } catch (e) { throw fieldError(field, (e as Error).message) }
}

// ---------------------------------------------------------------- stock and sets
async function viewerLocations(ctx: Ctx, locationId?: string | null): Promise<Row[]> {
  if (locationId) {
    ctx.ensureLocation(locationId)
    const l = await byId('locations', locationId)
    if (!l || !l.is_active) throw NotFound('Location not found')
    return [l]
  }
  return (await all('locations')).filter((l) => l.is_active && ctx.canAccess(l.id)).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'WAREHOUSE' ? -1 : 1))
}
async function availableAt(locIds: string[]): Promise<Map<string, number>> {
  const m = new Map<string, number>()
  for (const l of locIds) for (const b of (await balancesAt(l)).values()) m.set(`${l}|${b.book_id}`, Math.max(b.on_hand - b.reserved, 0))
  return m
}
async function onOrderAt(locIds: string[]): Promise<Map<string, number>> {
  const m = new Map<string, number>()
  const pos = (await findScoped('purchase_orders', locIds, 'location_id', limit(5000)).catch(() => [] as Row[])).filter((p) => ON_ORDER.includes(p.status))
  for (const p of pos) for (const l of p.lines as Row[]) {
    const k = `${p.location_id}|${l.book_id}`
    m.set(k, (m.get(k) ?? 0) + l.qty_ordered - l.qty_received - l.qty_cancelled)
  }
  return m
}
const setsPossible = (items: Row[], qtyOf: (bookId: string) => number) => (items.length ? Math.min(...items.map((i) => Math.floor(qtyOf(i.book_id) / i.qty_per_set))) : null)

async function listAvailability(lst: Row, locations: Row[], stock?: Map<string, number>, onOrder?: Map<string, number>) {
  const ids = locations.map((l) => l.id)
  const st = stock ?? (await availableAt(ids)), oo = onOrder ?? (await onOrderAt(ids))
  const books = await entries('books')
  const pubs = new Map((await all('publishers')).map((p) => [p.id, p.name]))
  const items = (lst.items as Row[]).map((it) => {
    const b = books.get(it.book_id)
    return { id: it.id, book_id: it.book_id, title: b?.title ?? '', isbn13: b?.isbn13 ?? null, sku: b?.sku ?? '', author: (b?.authors ?? [])[0] ?? null, publisher: pubs.get(b?.publisher_id) ?? null,
      mrp: b?.mrp ?? '0.00', qty_per_set: it.qty_per_set, book_status: b?.status ?? 'ARCHIVED', stock: ids.map((l) => ({ location_id: l, available: st.get(`${l}|${it.book_id}`) ?? 0, on_order: oo.get(`${l}|${it.book_id}`) ?? 0 })) }
  })
  const sets = ids.map((l) => ({ location_id: l, available: setsPossible(lst.items, (b) => st.get(`${l}|${b}`) ?? 0), with_on_order: setsPossible(lst.items, (b) => (st.get(`${l}|${b}`) ?? 0) + (oo.get(`${l}|${b}`) ?? 0)) }))
  return { locations: locations.map((l) => ({ id: l.id, code: l.code, name: l.name, type: l.type })), items, sets }
}

async function listItems(input: { book_id: string; qty_per_set: number }[]): Promise<Row[]> {
  const books = await entries('books')
  const seen = new Set<string>()
  return input.map((i, pos) => {
    const b = books.get(i.book_id)
    if (!b || b.merged_into_id) throw ValidationFailed('Book not found')
    if (seen.has(b.id)) throw ValidationFailed(`'${b.title}' appears more than once in the list`)
    if (!(i.qty_per_set >= 1 && i.qty_per_set <= MAX_QTY)) throw ValidationFailed(`Quantity per set for '${b.title}' must be between 1 and ${MAX_QTY}`)
    seen.add(b.id)
    return { id: newId(), book_id: b.id, qty_per_set: i.qty_per_set, position: pos } as unknown as Row
  })
}

// ---------------------------------------------------------------- schools & lists
const schoolOut = (s: Row, lists: number | null = null) => ({ id: s.id, code: s.code, name: s.name, city: s.city ?? null, contact_person: s.contact_person ?? null, phone: s.phone ?? null, email: s.email ?? null, notes: s.notes ?? null, is_active: s.is_active !== false, lists })
function schoolIn(b: Record<string, unknown>) {
  const code = wrap(() => normaliseCode(String(b.code ?? '')), 'code')
  const name = cleanText(b.name)
  if (name.length < 2) throw fieldError('name', 'String should have at least 2 characters')
  const email = clean(b.email) ? wrap(() => normaliseEmail(String(b.email)), 'email') : null
  return { code, name, city: clean(b.city), contact_person: clean(b.contact_person), phone: clean(b.phone), email, notes: clean(b.notes), is_active: b.is_active !== false }
}
async function getSchool(id: string): Promise<Row> {
  const s = await byId('schools', id)
  if (!s) throw NotFound('School not found')
  return s
}

route('GET', '/schools', async ({ query }, ctx) => {
  ctx.require('schools.view')
  const lists = await all('book_lists')
  return (await all('schools')).filter((s) => (query.include_inactive === 'true' || s.is_active !== false) && matches(query.q, s.name, s.code)).sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => schoolOut(s, lists.filter((l) => l.school_id === s.id && l.is_active !== false).length))
})
route('POST', '/schools', async ({ body }, ctx) => {
  ctx.require('schools.manage')
  const v = schoolIn(body)
  if ((await all('schools')).some((s) => s.code === v.code)) throw Conflict(`School code ${v.code} is already in use`, { code: 'duplicate_school_code' })
  return tx(async (u) => {
    const id = u.add('schools', v)
    ctx.audit(u, 'schools.created', { entity_type: 'school', entity_id: id, details: { code: v.code } })
    return schoolOut({ ...v, id } as Row, 0)
  })
})
route('PUT', '/schools/:id', async ({ params, body }, ctx) => {
  ctx.require('schools.manage')
  const s = await getSchool(params.id)
  const v = schoolIn(body)
  if ((await all('schools')).some((x) => x.code === v.code && x.id !== s.id)) throw Conflict(`School code ${v.code} is already in use`, { code: 'duplicate_school_code' })
  return tx(async (u) => {
    await u.update(`schools/${s.id}`, v)
    ctx.audit(u, 'schools.updated', { entity_type: 'school', entity_id: s.id, details: { code: v.code } })
    return schoolOut({ ...s, ...v })
  })
})
route('DELETE', '/schools/:id', async ({ params }, ctx) => {
  ctx.require('schools.manage')
  const s = await getSchool(params.id)
  if ((await find('school_orders', where('school_id', '==', s.id), limit(1))).length) throw Conflict('This school has orders; mark it inactive instead')
  const lists = (await all('book_lists')).filter((l) => l.school_id === s.id)
  await tx(async (u) => {
    for (const l of lists) u.delete(`book_lists/${l.id}`)
    u.delete(`schools/${s.id}`)
    ctx.audit(u, 'schools.deleted', { entity_type: 'school', entity_id: s.id, details: { code: s.code, lists: lists.length } })
  })
  return undefined
})
route('GET', '/schools/:id', async ({ params, query }, ctx) => {
  ctx.require('schools.view')
  const s = await getSchool(params.id)
  const locations = await viewerLocations(ctx, query.location_id)
  const ids = locations.map((l) => l.id)
  const [st, oo] = [await availableAt(ids), await onOrderAt(ids)]
  const lists = []
  for (const l of (await all('book_lists')).filter((x) => x.school_id === s.id && (query.include_archived === 'true' || x.is_active !== false))
    .sort((a, b) => b.academic_year.localeCompare(a.academic_year) || a.class_name.localeCompare(b.class_name, undefined, { numeric: true }))) {
    const av = await listAvailability(l, locations, st, oo)
    lists.push({ id: l.id, academic_year: l.academic_year, class_name: l.class_name, is_active: l.is_active !== false, books: (l.items as Row[]).length, sets: av.sets })
  }
  const orders = (await findScoped('school_orders', ctx.scope(), 'location_id', where('school_id', '==', s.id), limit(50)).catch(() => [] as Row[])).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  return { school: schoolOut(s, lists.length), locations: locations.map((l) => ({ id: l.id, code: l.code, name: l.name, type: l.type })), lists, orders: await Promise.all(orders.map(orderSummary)) }
})

function listIn(b: Record<string, unknown>) {
  const academic_year = wrap(() => normaliseYear(String(b.academic_year ?? '')), 'academic_year')
  const class_name = cleanText(b.class_name)
  if (!class_name) throw fieldError('class_name', 'Class is required')
  if (class_name.length > 40) throw fieldError('class_name', 'String should have at most 40 characters')
  return { academic_year, class_name, is_active: b.is_active !== false }
}
async function ensureListUnique(schoolId: string, v: { academic_year: string; class_name: string }, exclude?: string) {
  if ((await all('book_lists')).some((l) => l.school_id === schoolId && l.academic_year === v.academic_year && lc(l.class_name) === lc(v.class_name) && l.id !== exclude)) {
    throw Conflict(`${classLabel(v.class_name)} already has a list for ${v.academic_year}`, { code: 'duplicate_list' })
  }
}
route('POST', '/schools/:id/lists', async ({ params, body }, ctx) => {
  ctx.require('schools.manage')
  const s = await getSchool(params.id)
  const v = listIn(body)
  await ensureListUnique(s.id, v)
  return tx(async (u) => {
    const id = u.add('book_lists', { ...v, school_id: s.id, items: [] })
    ctx.audit(u, 'schools.list_created', { entity_type: 'book_list', entity_id: id, details: { school: s.code, class: v.class_name, year: v.academic_year } })
    return { id }
  })
})
async function getList(id: string): Promise<Row> {
  const l = await byId('book_lists', id)
  if (!l) throw NotFound('Book list not found')
  return l
}
route('PUT', '/book-lists/:id', async ({ params, body }, ctx) => {
  ctx.require('schools.manage')
  const l = await getList(params.id)
  const v = listIn(body)
  await ensureListUnique(l.school_id, v, l.id)
  return tx(async (u) => {
    await u.update(`book_lists/${l.id}`, v)
    ctx.audit(u, 'schools.list_updated', { entity_type: 'book_list', entity_id: l.id, details: v })
    return { id: l.id }
  })
})
route('DELETE', '/book-lists/:id', async ({ params }, ctx) => {
  ctx.require('schools.manage')
  const l = await getList(params.id)
  if ((await find('school_orders', where('list_ids', 'array-contains', l.id), limit(1))).length) throw Conflict('This class list was used in an order; archive it instead')
  await tx(async (u) => {
    u.delete(`book_lists/${l.id}`)
    ctx.audit(u, 'schools.list_deleted', { entity_type: 'book_list', entity_id: l.id, details: { class: l.class_name, year: l.academic_year } })
  })
  return undefined
})
route('GET', '/book-lists/import/template', async (_r, ctx) => {
  ctx.require('schools.manage')
  return new Response(await templateWorkbook(), { headers: { 'Content-Type': XLSX } })
})
route('GET', '/book-lists/:id', async ({ params, query }, ctx) => {
  ctx.require('schools.view')
  const l = await getList(params.id)
  const av = await listAvailability(l, await viewerLocations(ctx, query.location_id))
  return { id: l.id, school: schoolOut(await getSchool(l.school_id)), academic_year: l.academic_year, class_name: l.class_name, is_active: l.is_active !== false, ...av }
})
route('PUT', '/book-lists/:id/items', async ({ params, body }, ctx) => {
  ctx.require('schools.manage')
  const l = await getList(params.id)
  const input = ((body.items ?? []) as Record<string, unknown>[]).map((i) => ({ book_id: String(i.book_id), qty_per_set: Number(i.qty_per_set) }))
  if (input.length > 300) throw ValidationFailed('A list can have at most 300 books')
  const items = await listItems(input)
  return tx(async (u) => {
    await u.update(`book_lists/${l.id}`, { items })
    ctx.audit(u, 'schools.list_items_set', { entity_type: 'book_list', entity_id: l.id, details: { books: items.length } })
    return { id: l.id, books: items.length }
  })
})

// ---------------------------------------------------------------- Excel import
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const COLUMNS: [string, string, boolean][] = [
  ['School code', 'school_code', true], ['School name', 'school_name', true], ['Academic year', 'academic_year', true], ['Class', 'class_name', true], ['Title', 'title', true],
  ['Author', 'author', true], ['Author email', 'author_email', false], ['ISBN', 'isbn', false], ['Publisher', 'publisher', false], ['Qty per set', 'qty_per_set', false],
  ['MRP', 'mrp', false], ['Purchase price', 'purchase_price', false], ['GST %', 'gst', false],
]
const HEADER_KEYS = new Map(COLUMNS.map(([h, k]) => [h.toLowerCase(), k]))
async function excel() {
  const mod = await import('exceljs')
  return (mod as unknown as { default: typeof import('exceljs') }).default ?? mod
}
function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v)
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    const o = v as { richText?: { text: string }[]; result?: unknown; text?: string; error?: string }
    if (o.richText) return o.richText.map((r) => r.text).join('').trim()
    if ('result' in o) return cellText(o.result)
    if (o.text !== undefined) return String(o.text).trim()
    if (o.error) return ''
  }
  return String(v).trim()
}
async function readWorkbook(file: Blob, name: string): Promise<[number, Record<string, string>][]> {
  if (!name.toLowerCase().endsWith('.xlsx')) throw ValidationFailed('Upload an Excel .xlsx file (Excel: File → Save As → Excel Workbook)')
  if (file.size > 5 * 1024 * 1024) throw ValidationFailed('File is larger than 5 MB')
  const ExcelJS = await excel()
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(await file.arrayBuffer())
  } catch {
    throw ValidationFailed('The file must be an Excel workbook (.xlsx). Download the template to see the format.')
  }
  const ws = wb.worksheets[0]
  if (!ws || ws.rowCount === 0) throw ValidationFailed('The first sheet is empty')
  const header = ws.getRow(1)
  const keys: (string | null)[] = []
  const unknown: string[] = [], seen = new Set<string>()
  for (let c = 1; c <= header.cellCount; c++) {
    const raw = cellText(header.getCell(c).value)
    const nm = cleanText(raw).replace(/\*+$/, '').trim().toLowerCase()
    if (!nm) { keys.push(null); continue }
    const key = HEADER_KEYS.get(nm)
    if (!key) unknown.push(raw)
    else {
      if (seen.has(key)) throw ValidationFailed(`Column '${raw}' appears twice`)
      seen.add(key)
    }
    keys.push(key ?? null)
  }
  const missing = COLUMNS.filter(([, k, req]) => req && !seen.has(k)).map(([h]) => h)
  if (unknown.length || missing.length) throw ValidationFailed("The sheet's columns don't match the template", { details: { unknown_columns: unknown, missing_columns: missing, expected: COLUMNS.map(([h]) => h) } })
  const out: [number, Record<string, string>][] = []
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r)
    const data: Record<string, string> = {}
    keys.forEach((k, i) => { if (k) data[k] = cellText(row.getCell(i + 1).value) })
    if (!Object.values(data).some(Boolean)) continue
    if (out.length >= 5000) throw ValidationFailed('Import is limited to 5000 rows per file')
    out.push([r, data])
  }
  if (!out.length) throw ValidationFailed('The sheet has no book rows')
  return out
}
async function templateWorkbook(): Promise<Blob> {
  const ExcelJS = await excel()
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Book list', { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.addRow(COLUMNS.map(([h, , req]) => (req ? `${h}*` : h)))
  ws.getRow(1).eachCell((c) => { c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } } })
  ;[12, 30, 13, 10, 40, 24, 28, 17, 22, 11, 9, 14, 7].forEach((w, i) => { ws.getColumn(i + 1).width = w })
  const help = wb.addWorksheet('Instructions')
  help.getColumn(1).width = 20
  help.getColumn(2).width = 100
  for (const r of [
    ['Column', 'How to fill it (columns marked * are required on every row)'], ['School code*', 'Short code, e.g. MMPS. Letters, digits or hyphens. Same code = same school.'],
    ['School name*', 'Full school name. Must be the same on every row of that school code.'], ['Academic year*', 'e.g. 2026-27'], ['Class*', 'e.g. 11, 12 Science. One list per school, year and class.'],
    ['Title*', 'Book title as printed.'], ['Author*', 'First author. Order emails go to this author.'], ['Author email', "Author's email for order emails. Saved on the author; optional if already saved."],
    ['ISBN', 'ISBN-10 or ISBN-13 (checked). Strongly recommended: books are matched to the catalog by ISBN; without it, by exact title and author.'], ['Publisher', 'Used only when the book is new to the catalog.'],
    ['Qty per set', 'Copies of this book in one student set. Blank means 1.'], ['MRP', 'Required when the book is new to the catalog. Ignored for books already in the catalog.'],
    ['Purchase price', 'Your cost per copy for a new book; pre-fills purchase orders.'], ['GST %', 'Required for a new book: 0, 5, 12, 18 or 28 (or a tax class code such as GST0).'], ['', ''],
    ['Re-importing', "Importing a class again replaces that class's list with the rows in the file."], ['All-or-nothing', 'If any row has an error, nothing is imported. Fix the rows shown and upload again.'],
  ]) help.addRow(r)
  help.getRow(1).font = { bold: true }
  return new Blob([await wb.xlsx.writeBuffer()], { type: XLSX })
}

interface ImportRow {
  row: number; school_code: string; school_name: string; academic_year: string; class_name: string; title: string; author: string; author_email: string | null; isbn13: string | null
  publisher: string | null; qty_per_set: number; mrp: string | null; purchase_price: string | null; tax_class: Row | null; book: Row | null; new_key: string | null; errors: string[]; warnings: string[]
}
function money(text: string, label: string): string | null {
  if (!text) return null
  const n = Number(text.replace(/[,₹\s]/g, ''))
  if (!Number.isFinite(n)) throw new Error(`${label} is not a number`)
  if (n < 0 || n > 9999999) throw new Error(`${label} must be between 0 and 99,99,999`)
  return s2(n)
}
function parseGst(text: string, taxes: Row[]): Row {
  const s = text.toUpperCase().replace(/ /g, '')
  const byCode = taxes.find((t) => t.code.toUpperCase() === s)
  if (byCode) return byCode
  const num = s.replace(/^GST/, '').replace(/%$/, '')
  if (!/^\d+(\.\d+)?$/.test(num)) throw new Error(`GST % '${text}' is not a rate or tax class code`)
  const hits = taxes.filter((t) => D(t.rate).eq(D(num)))
  if (hits.length !== 1) throw new Error(hits.length ? `Several tax classes have GST ${text}%; use the tax class code instead` : `No single active tax class has GST ${text}%`)
  return hits[0]
}
async function analyse(raw: [number, Record<string, string>][]) {
  const taxes = (await all('tax_classes')).filter((t) => t.is_active)
  const rows: ImportRow[] = raw.map(([n, d]) => {
    const r: ImportRow = { row: n, school_code: '', school_name: '', academic_year: '', class_name: '', title: '', author: '', author_email: null, isbn13: null, publisher: null, qty_per_set: 1, mrp: null, purchase_price: null, tax_class: null, book: null, new_key: null, errors: [], warnings: [] }
    const take = <T>(fn: () => T): T | null => { try { return fn() } catch (e) { r.errors.push((e as Error).message); return null } }
    r.school_code = take(() => normaliseCode(d.school_code ?? '')) ?? cleanText(d.school_code).toUpperCase()
    r.school_name = cleanText(d.school_name)
    r.academic_year = take(() => normaliseYear(d.academic_year ?? '')) ?? ''
    r.class_name = cleanText(d.class_name)
    r.title = cleanText(d.title)
    r.author = cleanText(d.author)
    r.publisher = cleanText(d.publisher) || null
    for (const [v, label, max] of [[r.school_name, 'School name', 200], [r.class_name, 'Class', 40], [r.title, 'Title', 300], [r.author, 'Author', 200]] as [string, string, number][]) {
      if (!v) r.errors.push(`${label} is required`)
      else if (v.length > max) r.errors.push(`${label} is longer than ${max} characters`)
    }
    if (r.publisher && r.publisher.length > 200) r.errors.push('Publisher is longer than 200 characters')
    if (d.author_email) r.author_email = take(() => normaliseEmail(d.author_email))
    if (d.isbn) {
      const x = cleanIsbn(d.isbn)
      if (x.length === 10 && validIsbn10(x)) r.isbn13 = isbn10to13(x)
      else if (x.length === 13 && validIsbn13(x)) r.isbn13 = x
      else r.errors.push(`ISBN '${d.isbn}' is not a valid ISBN-10 or ISBN-13`)
    }
    if (d.qty_per_set) {
      if (!/^\d+$/.test(d.qty_per_set) || Number(d.qty_per_set) < 1 || Number(d.qty_per_set) > MAX_QTY) r.errors.push(`Qty per set must be a whole number from 1 to ${MAX_QTY}`)
      else r.qty_per_set = Number(d.qty_per_set)
    }
    r.mrp = take(() => money(d.mrp ?? '', 'MRP'))
    r.purchase_price = take(() => money(d.purchase_price ?? '', 'Purchase price'))
    if (d.gst) r.tax_class = take(() => parseGst(d.gst, taxes))
    return r
  })
  const books = [...(await entries('books')).values()].filter((b) => !b.merged_into_id)
  const authorsList = await all('authors')
  const existingSchools = new Map((await all('schools')).map((s) => [s.code, s]))
  const allLists = await all('book_lists')
  const schools = new Map<string, { name: string; existing: Row | null; row: number }>()
  const lists = new Map<string, { code: string; year: string; class_name: string; rows: ImportRow[]; existing: Row | null; books: Map<string, number> }>()
  const newBooks = new Map<string, ImportRow>()
  const authorEmails = new Map<string, { name: string; email: string; current: string | null; row: number }>()
  for (const r of rows) {
    if (r.errors.length) continue
    let s = schools.get(r.school_code)
    if (!s) {
      const ex = existingSchools.get(r.school_code) ?? null
      s = { name: r.school_name, existing: ex, row: r.row }
      schools.set(r.school_code, s)
      if (ex && lc(ex.name) !== lc(r.school_name)) r.warnings.push(`School ${r.school_code} already exists as '${ex.name}'; that name is kept`)
    } else if (lc(s.name) !== lc(r.school_name)) {
      r.errors.push(`School ${r.school_code} is named '${s.name}' on row ${s.row}; use the same name`)
      continue
    }
    if (r.isbn13) r.book = books.find((b) => b.isbn13 === r.isbn13 || b.barcode === r.isbn13) ?? null
    else {
      const cands = books.filter((b) => lc(b.title) === lc(r.title))
      const named = cands.filter((b) => lc((b.authors ?? [])[0]) === lc(r.author))
      const pool = named.length ? named : cands.filter((b) => !(b.authors ?? []).length)
      if (pool.length > 1) { r.errors.push(`${pool.length} catalog books are titled '${r.title}' by ${r.author}; add the ISBN to pick one`); continue }
      r.book = pool[0] ?? null
    }
    if (r.book) {
      if (r.book.status !== 'ACTIVE') { r.errors.push(`Catalog book '${r.book.title}' (${r.book.sku}) is ${String(r.book.status).toLowerCase()}`); continue }
      const ca = (r.book.authors ?? [])[0]
      if (!ca) r.warnings.push(`Catalog book has no author; ${r.author} will be set as its author`)
      else if (lc(ca) !== lc(r.author)) r.warnings.push(`Catalog author is ${ca}; orders for this book go to ${ca}`)
      if (r.mrp !== null && r.mrp !== r.book.mrp) r.warnings.push(`MRP in file ignored; catalog MRP is ${r.book.mrp}`)
    } else {
      r.new_key = r.isbn13 ?? `${lc(r.title)}|${lc(r.author)}`
      if (r.mrp === null) r.errors.push('MRP is required for a book that is not in the catalog')
      if (r.tax_class === null) r.errors.push('GST % is required for a book that is not in the catalog')
      if (r.errors.length) continue
      const first = newBooks.get(r.new_key)
      if (!first) newBooks.set(r.new_key, r)
      else if (first.mrp !== r.mrp || first.tax_class!.id !== r.tax_class!.id || lc(first.title) !== lc(r.title)) { r.errors.push(`Same book as row ${first.row} but with a different title, MRP or GST`); continue }
    }
    if (r.author_email) {
      const a = authorEmails.get(lc(r.author))
      if (!a) authorEmails.set(lc(r.author), { name: r.author, email: r.author_email, current: authorsList.find((x) => lc(x.name) === lc(r.author))?.email ?? null, row: r.row })
      else if (a.email !== r.author_email) { r.errors.push(`${r.author} has email ${a.email} on row ${a.row}; use one email per author`); continue }
    }
    const key = `${r.school_code}|${r.academic_year}|${lc(r.class_name)}`
    const l = lists.get(key) ?? { code: r.school_code, year: r.academic_year, class_name: r.class_name, rows: [] as ImportRow[], existing: null, books: new Map<string, number>() }
    lists.set(key, l)
    const bk = r.book ? `id:${r.book.id}` : `new:${r.new_key}`
    if (l.books.has(bk)) { r.errors.push(`This book is already on row ${l.books.get(bk)} of the same class list`); continue }
    l.books.set(bk, r.row)
    l.rows.push(r)
  }
  for (const l of lists.values()) {
    const ex = existingSchools.get(l.code)
    if (ex) l.existing = allLists.find((x) => x.school_id === ex.id && x.academic_year === l.year && lc(x.class_name) === lc(l.class_name)) ?? null
  }
  const invalid = rows.filter((r) => r.errors.length).length
  const importable = new Set(rows.filter((r) => !r.errors.length).map((r) => r.school_code))
  const summary = {
    valid: rows.length - invalid, invalid, new_books: newBooks.size,
    rows: rows.map((r) => ({ row: r.row, school_code: r.school_code, academic_year: r.academic_year, class_name: r.class_name, title: r.title, author: r.author, isbn13: r.isbn13, qty_per_set: r.qty_per_set,
      action: r.errors.length ? null : r.book ? 'MATCHED' : 'NEW_BOOK', book_id: r.book?.id ?? null, book_title: r.book?.title ?? null, book_sku: r.book?.sku ?? null, errors: r.errors, warnings: r.warnings })),
    schools: [...schools].filter(([c]) => importable.has(c)).sort(([a], [b]) => a.localeCompare(b)).map(([code, s]) => ({ code, name: s.name, action: s.existing ? 'EXISTING' : 'CREATE' })),
    lists: [...lists.values()].sort((a, b) => `${a.code}|${a.year}|${a.class_name}`.localeCompare(`${b.code}|${b.year}|${b.class_name}`))
      .map((l) => ({ school_code: l.code, academic_year: l.year, class_name: l.class_name, books: l.rows.length, action: l.existing ? 'REPLACE' : 'CREATE', current_books: l.existing ? (l.existing.items as Row[]).length : 0 })),
    author_emails: [...authorEmails.values()].sort((a, b) => lc(a.name).localeCompare(lc(b.name))).map((a) => ({ author: a.name, email: a.email, current: a.current, action: a.current === a.email ? 'UNCHANGED' : a.current ? 'UPDATE' : 'SET' })),
  }
  return { rows, schools, lists, newBooks, authorEmails, invalid, summary }
}
const uploaded = (body: unknown): { file: Blob; name: string } => {
  const f = body instanceof FormData ? (body.get('file') as File | null) : null
  if (!f) throw ValidationFailed('No file uploaded')
  return { file: f, name: f.name ?? 'upload.xlsx' }
}
route('POST', '/book-lists/import/preview', async ({ body }, ctx) => {
  ctx.require('schools.manage')
  const { file, name } = uploaded(body)
  return (await analyse(await readWorkbook(file, name))).summary
})
route('POST', '/book-lists/import/commit', async ({ body }, ctx) => {
  ctx.require('schools.manage')
  const { file, name } = uploaded(body)
  const a = await analyse(await readWorkbook(file, name))
  if (a.invalid) {
    const bad = a.rows.filter((r) => r.errors.length).map((r) => ({ row: r.row, errors: r.errors }))
    throw ValidationFailed(`${bad.length} row(s) have errors; fix them and upload again. Nothing was imported.`, { details: bad.slice(0, 50) })
  }
  if (a.newBooks.size) ctx.require('catalog.create')
  return tx(async (u) => {
    const schoolIds = new Map<string, string>()
    for (const [code, s] of a.schools) schoolIds.set(code, s.existing ? s.existing.id : u.add('schools', { code, name: s.name, city: null, contact_person: null, phone: null, email: null, notes: null, is_active: true }))
    const created = new Map<string, string>()
    for (const [key, r] of a.newBooks) {
      const b = await createBook(u, ctx, parseBookIn({ title: r.title, authors: [r.author], publisher: r.publisher, isbn13: r.isbn13, tax_class_id: r.tax_class!.id, mrp: r.mrp, selling_price: r.mrp, purchase_price: r.purchase_price }), { skipChecks: true })
      created.set(key, b.id)
    }
    for (const em of a.authorEmails.values()) {
      const [id] = await authorIds(u, [em.name])
      const cur = await u.get(`authors/${id}`)
      if (cur) await u.update(`authors/${id}`, { email: em.email })
      else await u.update(`authors/${id}`, { name: em.name, email: em.email, phone: null, supplier_id: null })
    }
    for (const r of a.rows) {
      if (r.book && !(r.book.authors ?? []).length) {
        const path = shardPath('books', r.book.id)
        const cur = ((await u.get(path))?.m ?? {})[r.book.id]
        await u.setEntry(path, r.book.id, { ...cur, authors: [r.author], author_ids: await authorIds(u, [r.author]) })
      }
    }
    let written = 0
    for (const l of a.lists.values()) {
      const items = l.rows.map((r, pos) => ({ id: newId(), book_id: r.book ? r.book.id : created.get(r.new_key!)!, qty_per_set: r.qty_per_set, position: pos }))
      if (l.existing) await u.update(`book_lists/${l.existing.id}`, { items, is_active: true })
      else u.add('book_lists', { school_id: schoolIds.get(l.code), academic_year: l.year, class_name: l.class_name, is_active: true, items })
      written++
    }
    ctx.audit(u, 'schools.lists_imported', { entity_type: 'book_list', details: { schools: [...a.schools.keys()].sort(), lists: written, new_books: created.size, rows: a.rows.length } })
    return { schools_created: [...a.schools.values()].filter((s) => !s.existing).length, lists: written, books_created: created.size, rows: a.rows.length }
  })
})

// ---------------------------------------------------------------- school orders
async function resolveScope(ctx: Ctx, b: Record<string, unknown>) {
  const school = await getSchool(String(b.school_id ?? ''))
  if (school.is_active === false) throw Conflict('This school is inactive')
  const locId = String(b.location_id ?? '')
  ctx.ensureLocation(locId)
  const location = await byId('locations', locId)
  if (!location || !location.is_active) throw ValidationFailed('Delivery location not found or inactive')
  const classes = ((b.classes ?? []) as Record<string, unknown>[]).map((c) => ({ list_id: String(c.list_id), sets: Number(c.sets) }))
  if (!classes.length) throw ValidationFailed('Choose at least one class')
  if (new Set(classes.map((c) => c.list_id)).size !== classes.length) throw ValidationFailed('A class is selected more than once')
  const selections: { list: Row; sets: number }[] = []
  for (const c of classes) {
    const l = await byId('book_lists', c.list_id)
    if (!l || l.school_id !== school.id) throw ValidationFailed('A selected class list does not belong to this school')
    if (l.is_active === false) throw ValidationFailed(`${classLabel(l.class_name)} (${l.academic_year}) is archived`)
    if (!(l.items as Row[]).length) throw ValidationFailed(`${classLabel(l.class_name)} has no books on its list`)
    if (!(Number.isInteger(c.sets) && c.sets >= 1 && c.sets <= 100000)) throw ValidationFailed('Number of sets must be between 1 and 100000')
    selections.push({ list: l, sets: c.sets })
  }
  const years = new Set(selections.map((s) => s.list.academic_year))
  if (years.size !== 1) throw ValidationFailed('All selected classes must be from the same academic year')
  return { school, location, academic_year: [...years][0] as string, selections }
}
type Scope = Awaited<ReturnType<typeof resolveScope>>
async function requirements(scope: Scope) {
  const books = await entries('books')
  const authorsByName = new Map((await all('authors')).map((a) => [a.id, a]))
  const taxes = new Map((await all('tax_classes')).map((t) => [t.id, t]))
  const need = new Map<string, { required: number; classes: string[] }>()
  for (const { list, sets } of scope.selections) for (const it of list.items as Row[]) {
    const n = need.get(it.book_id) ?? { required: 0, classes: [] }
    n.required += sets * it.qty_per_set
    n.classes.push(list.class_name)
    need.set(it.book_id, n)
  }
  const st = await availableAt([scope.location.id]), oo = await onOrderAt([scope.location.id])
  const out = []
  for (const [bookId, n] of need) {
    const b = books.get(bookId)
    if (!b) continue
    const author = b.author_ids?.[0] ? authorsByName.get(b.author_ids[0]) ?? null : null
    const available = st.get(`${scope.location.id}|${bookId}`) ?? 0, ordered = oo.get(`${scope.location.id}|${bookId}`) ?? 0
    const problems: string[] = []
    if (b.status !== 'ACTIVE') problems.push(`Book is ${String(b.status).toLowerCase()}`)
    if (!author) problems.push('Book has no author')
    else if (!author.email) problems.push(`${author.name} has no email address`)
    out.push({ book_id: b.id, title: b.title, isbn13: b.isbn13 ?? null, sku: b.sku, classes: n.classes, author_id: author?.id ?? null, author_name: author?.name ?? null, author_email: author?.email ?? null,
      required: n.required, available, on_order: ordered, suggested: Math.max(n.required - available - ordered, 0), unit_cost: b.purchase_price ?? null, tax_rate: s2(taxes.get(b.tax_class_id)?.rate ?? 0), problems })
  }
  return out.sort((a, b) => lc(a.author_name).localeCompare(lc(b.author_name)) || lc(a.title).localeCompare(lc(b.title)))
}
route('POST', '/school-orders/preview', async ({ body }, ctx) => {
  ctx.require('schools.manage', 'purchasing.create')
  const scope = await resolveScope(ctx, body)
  return { school: schoolOut(scope.school), location: { id: scope.location.id, name: scope.location.name }, academic_year: scope.academic_year, lines: await requirements(scope) }
})
async function supplierForAuthor(u: Uow, ctx: Ctx, author: Row): Promise<Row> {
  if (author.supplier_id) {
    const sup = await byId('suppliers', author.supplier_id)
    if (sup) {
      if (sup.is_active === false) throw ValidationFailed(`The supplier account linked to ${author.name} (${sup.code}) is inactive`)
      return sup
    }
  }
  const sup = await createSupplier(u, ctx, { name: author.name, contact_person: null, phone: author.phone ?? null, email: author.email ?? null, gstin: null, pan: null, address_line1: null, address_line2: null, city: null, state: null, state_code: null, pincode: null, payment_terms_days: 30, notes: 'Created automatically for school-book orders addressed to this author.', is_active: true })
  await u.update(`authors/${author.id}`, { supplier_id: sup.id })
  ctx.audit(u, 'schools.author_supplier_created', { entity_type: 'supplier', entity_id: sup.id, details: { author: author.name, code: sup.code } })
  return sup
}
async function poBrief(p: Row) {
  const author = p.author_id ? await byId('authors', p.author_id) : null
  return { id: p.id, number: p.number, status: p.status, total: p.total, supplier_name: p.supplier_name, author_id: p.author_id, author_name: author?.name ?? null, author_email: author?.email ?? null,
    email_opened_at: p.email_opened_at ?? null, books: (p.lines as Row[]).length, copies: (p.lines as Row[]).reduce((a, l) => a + l.qty_ordered, 0), received: (p.lines as Row[]).reduce((a, l) => a + l.qty_received, 0) }
}
async function orderSummary(o: Row) {
  const loc = await byId('locations', o.location_id)
  return { id: o.id, number: o.number, school_id: o.school_id, school_name: o.school_name, school_code: o.school_code, academic_year: o.academic_year, location_id: o.location_id, location_name: loc?.name ?? '', notes: o.notes,
    created_at: o.created_at, created_by_name: o.created_by_name, classes: o.classes }
}
async function orderOut(o: Row) {
  const pos = (await find('purchase_orders', where('school_order_id', '==', o.id))).sort((a, b) => String(a.number).localeCompare(String(b.number)))
  return { ...(await orderSummary(o)), purchase_orders: await Promise.all(pos.map(poBrief)) }
}
route('POST', '/school-orders', async ({ body, headers }, ctx) => {
  ctx.require('schools.manage', 'purchasing.create')
  const key = String(headers['Idempotency-Key'] ?? '')
  if (key.length < 8) throw fieldError('idempotency-key', 'Idempotency-Key header is required')
  const prior = await getOne(`idempotency/so~${key}`)
  if (prior) { const o = await getOne(`school_orders/${prior.id}`); if (o) return orderOut(o) }
  const scope = await resolveScope(ctx, body)
  const reqs = new Map((await requirements(scope)).map((r) => [r.book_id, r]))
  const chosen = new Map<string, { book_id: string; qty: number; unit_cost: string }>()
  for (const ln of (body.lines ?? []) as Record<string, unknown>[]) {
    const req = reqs.get(String(ln.book_id))
    if (!req) throw ValidationFailed('A book in the order is not on the selected class lists')
    if (chosen.has(req.book_id)) throw ValidationFailed(`'${req.title}' appears more than once`)
    const qty = Number(ln.qty)
    if (!(Number.isInteger(qty) && qty >= 0 && qty <= 100000)) throw ValidationFailed('Quantities must be whole numbers')
    if (!(Number(ln.unit_cost) >= 0)) throw ValidationFailed('Unit cost cannot be negative')
    if (qty > 0) chosen.set(req.book_id, { book_id: req.book_id, qty, unit_cost: String(ln.unit_cost) })
  }
  if (!chosen.size) throw ValidationFailed('Enter a quantity for at least one book')
  const problems = [...chosen.keys()].flatMap((b) => reqs.get(b)!.problems.map((p) => `${reqs.get(b)!.title}: ${p}`))
  if (problems.length) throw ValidationFailed("Some books can't be ordered yet", { details: problems })
  const byAuthor = new Map<string, { book_id: string; qty: number; unit_cost: string }[]>()
  for (const [b, ln] of chosen) byAuthor.set(reqs.get(b)!.author_id!, [...(byAuthor.get(reqs.get(b)!.author_id!) ?? []), ln])
  const authors = new Map((await all('authors')).map((a) => [a.id, a]))
  const order = await tx(async (u) => {
    const id = newId()
    const number = await u.nextNumber('SCHOOL_ORDER', { prefix: 'SO' })
    const doc = { number, school_id: scope.school.id, school_name: scope.school.name, school_code: scope.school.code, academic_year: scope.academic_year, location_id: scope.location.id, notes: clean(body.notes),
      idempotency_key: key, created_by: ctx.uid, created_by_name: ctx.name, created_at: u.at, classes: scope.selections.map((s) => ({ list_id: s.list.id, class_name: s.list.class_name, sets: s.sets })), list_ids: scope.selections.map((s) => s.list.id) }
    u.set(`school_orders/${id}`, doc)
    const classesText = scope.selections.map((s) => `${classLabel(s.list.class_name)} x${s.sets}`).join(', ')
    for (const [authorId, ls] of [...byAuthor].sort(([a], [b]) => lc(authors.get(a)?.name).localeCompare(lc(authors.get(b)?.name)))) {
      const author = (await u.get(`authors/${authorId}`)) ?? authors.get(authorId)!
      const supplier = await supplierForAuthor(u, ctx, author)
      const poId = newId()
      const lines = await poLines(ls.map((l) => ({ book_id: l.book_id, qty: l.qty, unit_cost: l.unit_cost, tax_rate: reqs.get(l.book_id)!.tax_rate })), poId)
      const po = { ...newPoDoc({ number: await u.nextNumber('PO'), supplier, location_id: scope.location.id, lines, ctx, at: u.at, expected_date: clean(body.expected_date),
        notes: `School order ${number}: ${scope.school.name} (${scope.academic_year}) ${classesText}`, extra: { school_order_id: id, school_order_number: number, author_id: authorId } }), id: poId } as Row
      u.set(`purchase_orders/${poId}`, po)
      const submitted = await submitPo(u, ctx, po)
      ctx.audit(u, 'purchasing.po_created', { entity_type: 'purchase_order', entity_id: poId, location_id: scope.location.id, details: { number: po.number, total: po.total, school_order: number, status: submitted.status } })
    }
    u.set(`idempotency/so~${key}`, { id, created_at: u.at })
    ctx.audit(u, 'schools.order_created', { entity_type: 'school_order', entity_id: id, location_id: scope.location.id, details: { number, school: scope.school.code, purchase_orders: byAuthor.size } })
    return { ...doc, id }
  })
  return orderOut(order)
})
route('GET', '/school-orders/:id', async ({ params }, ctx) => {
  ctx.require('schools.view', 'purchasing.view')
  const o = await getOne(`school_orders/${params.id}`)
  if (!o) throw NotFound('School order not found')
  ctx.ensureResource(o.location_id)
  return orderOut(o)
})

// ---------------------------------------------------------------- author order email
const PLACEHOLDERS: Record<string, string> = {
  author_name: 'Author the order is addressed to', school_name: 'School name', school_code: 'School code', classes: "Classes this author's books are for, with number of sets",
  academic_year: 'Academic year, e.g. 2026-27', po_number: 'Purchase order number', order_date: 'Order date', book_lines: "Numbered list of this author's books with ISBN and quantity",
  total_quantity: 'Total copies ordered from this author', delivery_location: 'Shop or warehouse the books must be delivered to', delivery_address: 'Delivery address of that location',
  sender_name: 'Name of the person opening the email', org_name: 'Your business name', org_phone: 'Your business phone', org_email: 'Your business email',
}
const MULTILINE = ['book_lines', 'delivery_address']
const DEFAULT_SUBJECT = 'Book order {po_number}: {school_name}, {classes}'
const DEFAULT_BODY = `Dear {author_name},

We would like to order the following books for {school_name}, {classes}, academic year {academic_year}.

{book_lines}

Total copies: {total_quantity}
Purchase order: {po_number} dated {order_date}

Please deliver to:
{delivery_location}
{delivery_address}

Kindly confirm availability and the expected delivery date.

Regards,
{sender_name}
{org_name}
{org_phone}
{org_email}`

function placeholdersIn(text: string): string[] {
  const names: string[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '{') {
      if (text[i + 1] === '{') { i++; continue }
      const end = text.indexOf('}', i)
      if (end < 0) throw new Error("Unmatched '{' or '}'. Write {{ or }} for a literal brace.")
      const name = text.slice(i + 1, end)
      if (!(name in PLACEHOLDERS)) throw new Error(`Unknown placeholder {${name}}. Allowed: ${Object.keys(PLACEHOLDERS).map((p) => `{${p}}`).join(', ')}`)
      names.push(name)
      i = end
    } else if (c === '}') {
      if (text[i + 1] === '}') { i++; continue }
      throw new Error("Unmatched '{' or '}'. Write {{ or }} for a literal brace.")
    }
  }
  return names
}
function render(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{|\}\}|\{([a-z_]+)\}/g, (m, name: string | undefined) => (m === '{{' ? '{' : m === '}}' ? '}' : values[name!] ?? ''))
}
function templateIn(b: Record<string, unknown>) {
  const subject = String(b.subject ?? '').trim(), body = String(b.body ?? '').replace(/\r\n/g, '\n').trim()
  if (subject.length < 3 || subject.length > 200) throw fieldError('subject', 'Subject must be 3–200 characters')
  if (body.length < 10 || body.length > 5000) throw fieldError('body', 'Body must be 10–5000 characters')
  if (/[\r\n]/.test(subject)) throw fieldError('subject', 'Subject must be a single line')
  const sp = wrap(() => placeholdersIn(subject), 'subject')
  const ml = MULTILINE.find((p) => sp.includes(p))
  if (ml) throw fieldError('subject', `{${ml}} spans several lines and can only be used in the body`)
  wrap(() => placeholdersIn(body), 'body')
  return { subject, body }
}
async function getTemplate() {
  const row = (await all('settings')).find((s) => s.id === 'school_order_email_template')
  return row ? { subject: row.value.subject as string, body: row.value.body as string, customised: true } : { subject: DEFAULT_SUBJECT, body: DEFAULT_BODY, customised: false }
}
const templateOut = async () => ({ ...(await getTemplate()), placeholders: Object.entries(PLACEHOLDERS).map(([name, description]) => ({ name, description })), default: { subject: DEFAULT_SUBJECT, body: DEFAULT_BODY } })
route('GET', '/school-order-email-template', async (_r, ctx) => {
  ctx.require('schools.manage')
  return templateOut()
})
route('PUT', '/school-order-email-template', async ({ body }, ctx) => {
  ctx.require('schools.manage')
  const v = templateIn(body)
  await tx(async (u) => {
    u.set('settings/school_order_email_template', { value: v, updated_by: ctx.uid, updated_at: u.at })
    ctx.audit(u, 'schools.email_template_saved', { entity_type: 'setting', entity_id: 'school_order_email_template' })
  })
  return templateOut()
})
route('POST', '/school-order-email-template/preview', async ({ body }, ctx) => {
  ctx.require('schools.manage')
  const v = templateIn(body)
  const sample = { author_name: 'R. K. Sharma', school_name: 'Sample Public School', school_code: 'SPS', classes: 'Class 11 (40 sets), Class 12 (35 sets)', academic_year: '2026-27', po_number: 'PO/2627/00042', order_date: '10 Nov 2026',
    book_lines: '1. Physics Part I (ISBN 9780306406157) - 75 copies\n2. Physics Part II - 75 copies', total_quantity: '150', delivery_location: 'Fort, Mumbai', delivery_address: '12 Example Road\nMumbai 400001, Maharashtra',
    sender_name: 'Your Name', org_name: 'Your Bookstore', org_phone: '+91 22 0000 0000', org_email: 'orders@example.com' }
  return { subject: render(v.subject, sample), body: render(v.body, sample) }
})
const fmtDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
async function poEmail(po: Row, sender: string) {
  if (!po.author_id || !po.school_order_id) throw Conflict('This purchase order was not raised from a school order', { code: 'not_school_order' })
  const author = await byId('authors', po.author_id)
  if (!author?.email) throw Conflict(`Add an email address for ${author?.name ?? 'the author'} before emailing the order`, { code: 'author_email_missing' })
  const order = (await getOne(`school_orders/${po.school_order_id}`))!
  const loc = (await byId('locations', po.location_id))!
  const org = await getOrg()
  const books = await entries('books')
  const poBooks = new Set((po.lines as Row[]).map((l) => l.book_id))
  const classes = []
  for (const c of order.classes as Row[]) {
    const l = await byId('book_lists', c.list_id)
    if (l && (l.items as Row[]).some((i) => poBooks.has(i.book_id))) classes.push(`${classLabel(c.class_name)} (${c.sets} sets)`)
  }
  const cityLine = [loc.city, loc.pincode].filter(Boolean).join(' ')
  const address = [loc.address_line1, loc.address_line2, [cityLine, loc.state].filter(Boolean).join(', '), loc.phone ? `Phone: ${loc.phone}` : null].filter(Boolean).join('\n')
  const values = {
    author_name: author.name, school_name: order.school_name, school_code: order.school_code, classes: classes.join(', '), academic_year: order.academic_year, po_number: po.number, order_date: fmtDate(po.order_date),
    book_lines: (po.lines as Row[]).map((l, i) => { const b = books.get(l.book_id); return `${i + 1}. ${b?.title}${b?.isbn13 ? ` (ISBN ${b.isbn13})` : ''} - ${l.qty_ordered} ${l.qty_ordered === 1 ? 'copy' : 'copies'}` }).join('\n'),
    total_quantity: String((po.lines as Row[]).reduce((a, l) => a + l.qty_ordered, 0)), delivery_location: loc.name, delivery_address: address, sender_name: sender,
    org_name: org ? org.trade_name || org.legal_name : '', org_phone: org?.phone ?? '', org_email: org?.email ?? '',
  }
  const tpl = await getTemplate()
  return { to: author.email, author_name: author.name, subject: render(tpl.subject, values), body: render(tpl.body, values), status: po.status, email_opened_at: po.email_opened_at ?? null }
}
route('GET', '/purchase-orders/:id/author-email', async ({ params }, ctx) => {
  ctx.require('purchasing.create')
  const po = await getOne(`purchase_orders/${params.id}`)
  if (!po) throw NotFound('Purchase order not found')
  ctx.ensureResource(po.location_id)
  return { ...(await poEmail(po, ctx.name)), can_open: ON_ORDER.includes(po.status) }
})
route('POST', '/purchase-orders/:id/author-email/opened', async ({ params }, ctx) => {
  ctx.require('purchasing.create')
  const po = await getOne(`purchase_orders/${params.id}`)
  if (!po) throw NotFound('Purchase order not found')
  ctx.ensureResource(po.location_id)
  if (!ON_ORDER.includes(po.status)) throw Conflict(`Order emails can't be opened for a purchase order that is ${String(po.status).toLowerCase().replace('_', ' ')}`)
  const draft = await poEmail(po, ctx.name)
  return tx(async (u) => {
    await u.update(`purchase_orders/${po.id}`, { email_opened_at: u.at })
    ctx.audit(u, 'purchasing.po_email_opened', { entity_type: 'purchase_order', entity_id: po.id, location_id: po.location_id, details: { number: po.number, to_domain: draft.to.split('@').pop() } })
    return { email_opened_at: u.at }
  })
})

void localDate
