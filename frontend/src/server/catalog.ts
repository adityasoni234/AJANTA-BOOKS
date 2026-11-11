/** Book catalog: books (sharded maps), master data, CSV import/export, merge, prices, covers, label data. */
import { limit, orderBy, where } from 'firebase/firestore'
import type { Ctx } from './ctx'
import {
  Conflict, D, NotFound, ValidationFailed, clean, cleanIsbn, fieldError, int, internalEan13, isbn10to13, isbn13to10, lc, matches, newId, paginate,
  s2, s2n, validEan13, validIsbn10, validIsbn13,
} from './core'
import { route } from './router'
import { getPolicy } from './settings'
import { StockTx, balancesAt, copyByCode, moveCopy, valuedQty, VALUED_BUCKETS, BUCKET_FIELD, movementLines, type Bal } from './stock'
import { all, byId, entries, entry, find, getOne, shardPath, tx, type Row, type Uow } from './store'

export const canSeeCost = (ctx: Ctx) => ctx.has('purchasing.view') || ctx.has('reports.financial')

// ---------------------------------------------------------------- output
export async function bookOut(b: Row, bal?: Bal | null, includeCost = true) {
  const [tcs, cats, pubs] = await Promise.all([indexOf('tax_classes'), indexOf('categories'), indexOf('publishers')])
  const tc = tcs.get(b.tax_class_id)
  return {
    id: b.id, sku: b.sku, barcode: b.barcode, isbn13: b.isbn13 ?? null, isbn10: b.isbn10 ?? null, title: b.title, subtitle: b.subtitle ?? null,
    authors: (b.authors ?? []) as string[], publisher: pubs.get(b.publisher_id)?.name ?? null, publisher_id: b.publisher_id ?? null,
    edition: b.edition ?? null, publication_date: b.publication_date ?? null, language: b.language ?? null, category_id: b.category_id ?? null,
    category: cats.get(b.category_id)?.name ?? null, genre: b.genre ?? null, binding: b.binding ?? null, format: b.format ?? null, page_count: b.page_count ?? null,
    description: b.description ?? null, tags: (b.tags ?? []) as string[], cover_url: null as string | null, has_cover: !!b.has_cover, hsn_code: b.hsn_code ?? null,
    tax_class_id: b.tax_class_id, tax_class: tc?.name ?? '', tax_rate: tc ? s2(tc.rate) : '0.00', mrp: b.mrp, selling_price: b.selling_price,
    min_selling_price: b.min_selling_price ?? null, purchase_price: includeCost ? (b.purchase_price ?? null) : null, default_supplier_id: b.default_supplier_id ?? null,
    reorder_level: b.reorder_level ?? 0, reorder_qty: b.reorder_qty ?? 0, tracking_mode: b.tracking_mode, status: b.status, merged_into_id: b.merged_into_id ?? null,
    created_at: b.created_at, updated_at: b.updated_at ?? b.created_at,
    stock_on_hand: bal ? bal.on_hand : null, stock_available: bal ? bal.on_hand - bal.reserved : null,
    location_price: bal && bal.price_override !== null ? bal.price_override : b.selling_price,
  }
}
async function indexOf(coll: string) {
  const { indexById } = await import('./store')
  return indexById(coll)
}

export async function getBook(id: string): Promise<Row> {
  const b = await entry('books', id)
  if (!b) throw NotFound('Book not found')
  return b
}
export async function liveBooks(): Promise<Row[]> {
  return [...(await entries('books')).values()].filter((b) => !b.merged_into_id)
}

export async function searchFilter(q: string | null | undefined): Promise<(b: Row) => boolean> {
  const term = (q ?? '').trim()
  if (!term) return () => true
  const digits = term.replace(/[-\s]/g, '')
  const [cats, pubs] = await Promise.all([indexOf('categories'), indexOf('publishers')])
  return (b) => matches(term, b.title, b.subtitle, b.sku, ...(b.authors ?? []), pubs.get(b.publisher_id)?.name, cats.get(b.category_id)?.name)
    || b.barcode === term || b.isbn13 === digits || b.isbn10 === digits.toUpperCase()
}

// ---------------------------------------------------------------- validation
const PRICE_FIELDS = ['mrp', 'selling_price', 'min_selling_price', 'purchase_price'] as const
type BookIn = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

function names(v: unknown, max: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of (Array.isArray(v) ? v : []) as string[]) {
    const t = String(n).split(/\s+/).filter(Boolean).join(' ')
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t.slice(0, 200)) }
  }
  if (out.length > max) throw fieldError('authors', `List should have at most ${max} items`)
  return out
}
function money(v: unknown, field: string, required = false): string | null {
  if (v === null || v === undefined || v === '') {
    if (required) throw fieldError(field, 'Field required')
    return null
  }
  const n = Number(v)
  if (!Number.isFinite(n)) throw fieldError(field, 'Input should be a valid decimal')
  if (n < 0) throw fieldError(field, 'Input should be greater than or equal to 0')
  return s2(v as string)
}
export function parseBookIn(b: Record<string, unknown>): BookIn {
  const title = clean(b.title) ?? ''
  if (!title) throw fieldError('title', 'String should have at least 1 character')
  if (title.length > 300) throw fieldError('title', 'String should have at most 300 characters')
  const d: BookIn = {
    title, subtitle: clean(b.subtitle), authors: names(b.authors, 20), publisher: clean(b.publisher)?.split(/\s+/).join(' ') ?? null,
    isbn13: clean(b.isbn13), isbn10: clean(b.isbn10), barcode: clean(b.barcode), edition: clean(b.edition), publication_date: clean(b.publication_date),
    language: clean(b.language), category_id: clean(b.category_id), genre: clean(b.genre), binding: clean(b.binding), format: clean(b.format),
    page_count: b.page_count === null || b.page_count === undefined || b.page_count === '' ? null : int(b.page_count), description: clean(b.description),
    tags: names(b.tags, 30), hsn_code: b.hsn_code === undefined ? '4901' : clean(b.hsn_code), tax_class_id: clean(b.tax_class_id),
    mrp: money(b.mrp, 'mrp', true), selling_price: money(b.selling_price, 'selling_price', true), min_selling_price: money(b.min_selling_price, 'min_selling_price'),
    purchase_price: money(b.purchase_price, 'purchase_price'), default_supplier_id: clean(b.default_supplier_id),
    reorder_level: int(b.reorder_level ?? 0), reorder_qty: int(b.reorder_qty ?? 0), tracking_mode: String(b.tracking_mode ?? 'QUANTITY'), status: String(b.status ?? 'ACTIVE'),
  }
  if (!d.tax_class_id) throw fieldError('tax_class_id', 'Field required')
  if (d.page_count !== null && !(d.page_count > 0 && d.page_count < 100000)) throw fieldError('page_count', 'Input should be greater than 0')
  if (d.description && d.description.length > 5000) throw fieldError('description', 'String should have at most 5000 characters')
  if (d.hsn_code && !/^\d{4,8}$/.test(d.hsn_code)) throw fieldError('hsn_code', 'String should match pattern ^\\d{4,8}$')
  if (d.reorder_level < 0) throw fieldError('reorder_level', 'Input should be greater than or equal to 0')
  if (d.reorder_qty < 0) throw fieldError('reorder_qty', 'Input should be greater than or equal to 0')
  if (!['QUANTITY', 'COPY'].includes(d.tracking_mode)) throw fieldError('tracking_mode', 'String should match pattern ^(QUANTITY|COPY)$')
  if (!['ACTIVE', 'DISCONTINUED', 'ARCHIVED'].includes(d.status)) throw fieldError('status', 'String should match pattern ^(ACTIVE|DISCONTINUED|ARCHIVED)$')
  if (d.isbn13) {
    d.isbn13 = cleanIsbn(d.isbn13)
    if (!validIsbn13(d.isbn13)) throw ValidationFailed('Invalid ISBN-13 (checksum or format)', { details: [{ loc: ['body'], msg: 'Value error, Invalid ISBN-13 (checksum or format)' }] })
  }
  if (d.isbn10) {
    d.isbn10 = cleanIsbn(d.isbn10)
    if (!validIsbn10(d.isbn10)) throw ValidationFailed('Invalid ISBN-10 (checksum or format)', { details: [{ loc: ['body'], msg: 'Value error, Invalid ISBN-10 (checksum or format)' }] })
  }
  if (d.isbn10 && !d.isbn13) d.isbn13 = isbn10to13(d.isbn10)
  else if (d.isbn13 && !d.isbn10) d.isbn10 = isbn13to10(d.isbn13)
  else if (d.isbn10 && d.isbn13 && isbn10to13(d.isbn10) !== d.isbn13) throw ValidationFailed('ISBN-10 and ISBN-13 refer to different books', { details: [{ loc: ['body'], msg: 'Value error, ISBN-10 and ISBN-13 refer to different books' }] })
  if (D(d.selling_price).gt(D(d.mrp))) throw ValidationFailed('Selling price cannot exceed MRP', { details: [{ loc: ['body'], msg: 'Value error, Selling price cannot exceed MRP' }] })
  if (d.min_selling_price !== null && D(d.min_selling_price).gt(D(d.selling_price))) throw ValidationFailed('Minimum selling price cannot exceed selling price', { details: [{ loc: ['body'], msg: 'Value error, Minimum selling price cannot exceed selling price' }] })
  return d
}

async function validateRefs(d: BookIn) {
  const tc = await byId('tax_classes', d.tax_class_id)
  if (!tc || !tc.is_active) throw ValidationFailed('Tax class not found or inactive')
  if (d.category_id && !(await byId('categories', d.category_id))) throw ValidationFailed('Category not found')
  if (d.default_supplier_id && !(await byId('suppliers', d.default_supplier_id).catch(() => null))) throw ValidationFailed('Supplier not found')
}
async function checkIsbnUnique(d: BookIn, exclude: string | null) {
  if (!d.isbn13) return
  const dup = [...(await entries('books')).values()].find((b) => b.id !== exclude && (b.isbn13 === d.isbn13 || b.barcode === d.isbn13))
  if (dup) throw Conflict(`ISBN ${d.isbn13} already exists ('${dup.title}', SKU ${dup.sku})`, { code: 'duplicate_isbn', details: { book_id: dup.id } })
}
async function checkBarcodeUnique(code: string, exclude: string | null) {
  if ([...(await entries('books')).values()].some((b) => b.id !== exclude && (b.barcode === code || b.isbn13 === code || b.sku === code))) {
    throw Conflict('This barcode is already assigned to another book', { code: 'duplicate_barcode' })
  }
  if (await copyByCode(code).catch(() => null)) throw Conflict('This barcode is already used by an individual copy', { code: 'duplicate_barcode' })
}

export async function publisherId(u: Uow, name: string | null): Promise<string | null> {
  if (!name) return null
  const n = name.split(/\s+/).join(' ')
  const key = `publisher:${lc(n)}`
  const memo = u.memo.get(key)
  if (memo) return memo
  const p = (await all('publishers')).find((x) => lc(x.name) === lc(n))
  const id = p ? p.id : u.add('publishers', { name: n })
  u.memo.set(key, id)
  return id
}
export async function authorIds(u: Uow, list: string[]): Promise<string[]> {
  const existing = await all('authors')
  return list.map((n) => {
    const key = `author:${lc(n)}`
    const memo = u.memo.get(key)
    if (memo) return memo
    const a = existing.find((x) => lc(x.name) === lc(n))
    const id = a ? a.id : u.add('authors', { name: n, email: null, phone: null, supplier_id: null })
    u.memo.set(key, id)
    return id
  })
}
function recordPrice(u: Uow, ctx: Ctx, bookId: string, field: string, oldV: string | null, newV: string | null, reason: string | null, locationId: string | null = null) {
  if ((oldV ?? null) !== (newV ?? null)) u.add('price_history', { book_id: bookId, location_id: locationId, field, old_value: oldV ?? null, new_value: newV ?? null, reason, changed_by: ctx.uid, changed_by_name: ctx.name, changed_at: u.at })
}

/** Create a book inside a unit of work (also used by school list import and CSV import). */
export async function createBook(u: Uow, ctx: Ctx, d: BookIn, opts: { skipChecks?: boolean } = {}): Promise<Row> {
  if (!opts.skipChecks) {
    await validateRefs(d)
    await checkIsbnUnique(d, null)
  }
  if (d.barcode && /^\d{13}$/.test(d.barcode) && !validEan13(d.barcode)) throw ValidationFailed('Barcode looks like an EAN-13 but has an invalid check digit')
  const policy = await getPolicy()
  const barcode = d.barcode || d.isbn13 || internalEan13(policy.barcode_prefix, await u.nextValue('BARCODE'))
  if (!opts.skipChecks) await checkBarcodeUnique(barcode, null)
  const id = newId()
  const sku = await u.nextCode('SKU', `${policy.sku_prefix}-`, 6)
  const book = {
    sku, barcode, isbn13: d.isbn13, isbn10: d.isbn10, title: d.title.trim(), subtitle: d.subtitle, publisher_id: await publisherId(u, d.publisher),
    edition: d.edition, publication_date: d.publication_date, language: d.language, category_id: d.category_id, genre: d.genre, binding: d.binding, format: d.format,
    page_count: d.page_count, description: d.description, tags: d.tags, hsn_code: d.hsn_code, tax_class_id: d.tax_class_id, mrp: d.mrp, selling_price: d.selling_price,
    min_selling_price: d.min_selling_price, purchase_price: d.purchase_price, default_supplier_id: d.default_supplier_id, reorder_level: d.reorder_level, reorder_qty: d.reorder_qty,
    tracking_mode: d.tracking_mode, status: d.status, merged_into_id: null, authors: d.authors, author_ids: await authorIds(u, d.authors), suppliers: {}, has_cover: false,
    created_by: ctx.uid, updated_by: ctx.uid, created_at: u.at, updated_at: u.at,
  }
  await u.setEntry(shardPath('books', id), id, book)
  for (const f of PRICE_FIELDS) recordPrice(u, ctx, id, f.toUpperCase(), null, book[f], 'Initial price')
  return { ...book, id }
}

async function hasStock(bookId: string): Promise<boolean> {
  for (const l of await all('locations')) {
    const b = (await balancesAt(l.id)).get(bookId)
    if (b && b.on_hand + b.damaged + b.quarantined + b.in_transit > 0) return true
  }
  return false
}

// ---------------------------------------------------------------- trigram similarity (pg_trgm compatible enough)
function trigrams(s: string): Set<string> {
  const out = new Set<string>()
  for (const w of s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    const p = `  ${w} `
    for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3))
  }
  return out
}
export function similarity(a: string, b: string): number {
  const x = trigrams(a), y = trigrams(b)
  if (!x.size || !y.size) return 0
  let common = 0
  for (const t of x) if (y.has(t)) common++
  return common / (x.size + y.size - common)
}
export async function findDuplicates(o: { title: string; authors: string[]; isbn13: string | null; exclude_id?: string | null }): Promise<Row[]> {
  let c = (await liveBooks()).filter((b) => b.id !== o.exclude_id && (similarity(b.title, o.title) > 0.6 || (o.isbn13 && b.isbn13 === o.isbn13))).slice(0, 10)
  if (o.authors.length) {
    const lower = new Set(o.authors.map(lc))
    c = c.sort((a, b) => (b.authors ?? []).filter((n: string) => lower.has(lc(n))).length - (a.authors ?? []).filter((n: string) => lower.has(lc(n))).length)
  }
  return c
}

export async function lookupCode(code: string): Promise<{ book: Row; copy: Row | null }> {
  const t = code.trim()
  if (!t) throw NotFound('Empty code')
  const copy = await copyByCode(t).catch(() => null)
  if (copy) return { book: await getBook(copy.book_id), copy }
  const norm = cleanIsbn(t)
  const books = await liveBooks()
  let book = books.find((b) => b.barcode === t || b.sku === t.toUpperCase() || b.isbn13 === norm || b.isbn10 === norm)
  if (!book && norm.length === 10 && validIsbn10(norm)) book = books.find((b) => b.isbn13 === isbn10to13(norm))
  if (!book) throw NotFound(`No book found for code '${t}'`)
  return { book, copy: null }
}

// ---------------------------------------------------------------- routes: books
const SORTS: Record<string, (a: Row, b: Row) => number> = {
  title: (a, b) => a.title.localeCompare(b.title), '-title': (a, b) => b.title.localeCompare(a.title),
  created: (a, b) => String(a.created_at).localeCompare(String(b.created_at)), '-created': (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
  price: (a, b) => D(a.selling_price).cmp(D(b.selling_price)), '-price': (a, b) => D(b.selling_price).cmp(D(a.selling_price)), sku: (a, b) => a.sku.localeCompare(b.sku),
}

route('GET', '/books', async ({ query }, ctx) => {
  ctx.require('catalog.view')
  const f = await searchFilter(query.q)
  const cats = await all('categories')
  const catIds = query.category_id ? new Set([query.category_id, ...cats.filter((c) => c.parent_id === query.category_id).map((c) => c.id)]) : null
  let bals: Map<string, Bal> | null = null
  if (query.location_id) {
    ctx.ensureLocation(query.location_id)
    bals = await balancesAt(query.location_id)
  }
  const rows = (await liveBooks()).filter((b) => f(b) && (!catIds || catIds.has(b.category_id)) && (!query.publisher_id || b.publisher_id === query.publisher_id)
    && (query.status ? b.status === query.status : b.status !== 'ARCHIVED') && (!query.tracking_mode || b.tracking_mode === query.tracking_mode)
    && (!(bals && query.in_stock === 'true') || ((bals.get(b.id)?.on_hand ?? 0) - (bals.get(b.id)?.reserved ?? 0) > 0)))
    .sort((a, b) => (SORTS[query.sort ?? 'title'] ?? SORTS.title)(a, b) || a.id.localeCompare(b.id))
  const page = paginate(rows, Number(query.page), Number(query.page_size))
  const cost = canSeeCost(ctx)
  return { ...page, items: await Promise.all(page.items.map((b) => bookOut(b, bals ? (bals.get(b.id) ?? null) : null, cost))) }
})

route('GET', '/books/lookup', async ({ query }, ctx) => {
  ctx.require('catalog.view')
  const { book, copy } = await lookupCode(String(query.code ?? ''))
  let bal: Bal | null = null
  if (query.location_id) {
    ctx.ensureLocation(query.location_id)
    bal = (await balancesAt(query.location_id)).get(book.id) ?? null
  }
  const out: Record<string, unknown> = { book: await bookOut(book, bal, canSeeCost(ctx)), copy_id: null, copy_code: null, copy_status: null, copy_location_id: null, copy_condition: null }
  if (copy && (ctx.canAccess(copy.location_id) || ctx.has('catalog.edit'))) Object.assign(out, { copy_id: copy.id, copy_code: copy.copy_code, copy_status: copy.status, copy_location_id: copy.location_id, copy_condition: copy.condition })
  return out
})

route('POST', '/books', async ({ body }, ctx) => {
  ctx.require('catalog.create')
  const d = parseBookIn(body)
  return tx(async (u) => {
    const b = await createBook(u, ctx, d)
    ctx.audit(u, 'catalog.book_created', { entity_type: 'book', entity_id: b.id, details: { title: b.title, sku: b.sku, isbn13: b.isbn13 } })
    return bookOut(b)
  })
})

route('PUT', '/books/:id', async ({ params, body }, ctx) => {
  ctx.require('catalog.edit')
  const book = await getBook(params.id)
  const d = parseBookIn(body)
  if (d.status === 'ARCHIVED' && book.status !== 'ARCHIVED') ctx.require('catalog.archive')
  await validateRefs(d)
  await checkIsbnUnique(d, book.id)
  if (book.merged_into_id) throw Conflict('This book was merged into another record and can no longer be edited')
  const priceChanged = PRICE_FIELDS.some((f) => (book[f] ?? null) !== (d[f] ?? null))
  if (priceChanged && !ctx.has('catalog.price_edit')) throw ValidationFailed('You do not have permission to change prices', { code: 'permission_denied' })
  if (d.tracking_mode !== book.tracking_mode && (await hasStock(book.id))) throw Conflict('Tracking mode can only change while the book has no stock anywhere')
  const barcode = d.barcode || book.barcode
  if (barcode !== book.barcode) await checkBarcodeUnique(barcode, book.id)
  const reason = clean(body.change_reason)
  return tx(async (u) => {
    for (const f of PRICE_FIELDS) recordPrice(u, ctx, book.id, f.toUpperCase(), book[f] ?? null, d[f] ?? null, reason)
    const patch: Record<string, unknown> = { barcode, title: d.title.trim(), publisher_id: await publisherId(u, d.publisher), updated_by: ctx.uid, updated_at: u.at, authors: d.authors, author_ids: await authorIds(u, d.authors) }
    for (const f of ['isbn13', 'isbn10', 'subtitle', 'edition', 'publication_date', 'language', 'category_id', 'genre', 'binding', 'format', 'page_count', 'description', 'tags', 'hsn_code', 'tax_class_id', 'default_supplier_id', 'reorder_level', 'reorder_qty', 'tracking_mode', 'status', ...PRICE_FIELDS]) patch[f] = d[f]
    const next = { ...book, ...patch }
    const { id: _i, _shard, ...store } = next
    void _i; void _shard
    await u.setEntry(shardPath('books', book.id), book.id, store)
    const before = await bookOut(book), after = await bookOut(next)
    const changed: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(after)) if (k !== 'updated_at' && JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify(v)) changed[k] = { from: (before as Record<string, unknown>)[k], to: v }
    ctx.audit(u, 'catalog.book_updated', { entity_type: 'book', entity_id: book.id, details: { changes: changed } })
    return after
  })
})

route('POST', '/books/check-duplicates', async ({ body }, ctx) => {
  ctx.require('catalog.view')
  const rows = await findDuplicates({ title: String(body.title ?? ''), authors: (body.authors ?? []) as string[], isbn13: clean(body.isbn13), exclude_id: clean(body.exclude_id) })
  return Promise.all(rows.map((b) => bookOut(b, null, false)))
})

route('POST', '/books/:id/merge', async ({ params, body }, ctx) => {
  ctx.require('catalog.merge')
  if (!ctx.all_locations) throw ValidationFailed('Merging requires organisation-wide access')
  const reason = String(body.reason ?? '')
  if (reason.length < 3) throw fieldError('reason', 'String should have at least 3 characters')
  const src = await entry('books', params.id), dst = await entry('books', String(body.into_book_id ?? ''))
  if (!src || !dst) throw NotFound('Book not found')
  if (src.id === dst.id || src.merged_into_id || dst.merged_into_id) throw Conflict('Invalid merge (same book or already merged)')
  if (src.tracking_mode !== dst.tracking_mode) throw Conflict('Both books must use the same tracking mode')
  const openPo = (await find('purchase_orders', where('book_ids', 'array-contains', src.id))).some((p) => ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ISSUED', 'PARTIALLY_RECEIVED'].includes(p.status))
  if (openPo) throw Conflict('The duplicate has open purchase orders; close or receive them first')
  const locs = await all('locations')
  const copies = await find('copies', where('book_id', '==', src.id))
  return tx(async (u) => {
    const st = new StockTx(u, { uid: ctx.uid, name: ctx.name })
    const ref = { type: 'MERGE', id: src.id, number: src.sku }
    for (const l of locs) {
      const s = await st.bal(l.id, src.id)
      if (!valuedQty(s) && !s.in_transit && !s.reserved) continue
      const d = await st.bal(l.id, dst.id)
      if (s.in_transit || s.reserved) throw Conflict('The duplicate has stock in transit or reserved; complete transfers first')
      const moved = valuedQty(s)
      if (moved) st.receiveCost(d, moved, s.avg_cost)
      for (const bucket of VALUED_BUCKETS) {
        const qty = s[BUCKET_FIELD[bucket]]
        if (qty) {
          await st.apply(s, { bucket, delta: -qty, movement_type: 'MERGE_OUT', ref, unit_cost: s.avg_cost })
          await st.apply(d, { bucket, delta: qty, movement_type: 'MERGE_IN', ref, unit_cost: s.avg_cost })
        }
      }
    }
    await st.commit()
    for (const c of copies) {
      const fresh = await u.need(`copies/${c.id}`)
      await moveCopy(u, fresh, { event: 'MERGED', to_status: fresh.status, ref, actor: ctx, note: `Merged into ${dst.sku}` })
      await u.update(`copies/${c.id}`, { book_id: dst.id })
    }
    const sup = { ...(src.suppliers ?? {}), ...(dst.suppliers ?? {}) }
    const { id: _s, _shard: _ss, ...srcStore } = src
    const { id: _d, _shard: _ds, ...dstStore } = dst
    void _s; void _ss; void _d; void _ds
    await u.setEntry(shardPath('books', src.id), src.id, { ...srcStore, status: 'ARCHIVED', merged_into_id: dst.id, updated_by: ctx.uid, updated_at: u.at })
    await u.setEntry(shardPath('books', dst.id), dst.id, { ...dstStore, suppliers: sup, updated_at: u.at })
    ctx.audit(u, 'catalog.book_merged', { entity_type: 'book', entity_id: src.id, details: { into: dst.id, reason, source_sku: src.sku, target_sku: dst.sku } })
    return bookOut({ ...dst, suppliers: sup })
  })
})

route('PUT', '/books/:id/location-settings', async ({ params, body }, ctx) => {
  ctx.requireAny('catalog.price_edit', 'inventory.settings')
  const loc = String(body.location_id ?? '')
  ctx.ensureLocation(loc)
  const book = await getBook(params.id)
  const price = s2n(body.price_override as string)
  const rl = body.reorder_level === null || body.reorder_level === undefined || body.reorder_level === '' ? null : int(body.reorder_level)
  const rq = body.reorder_qty === null || body.reorder_qty === undefined || body.reorder_qty === '' ? null : int(body.reorder_qty)
  return tx(async (u) => {
    const st = new StockTx(u, { uid: ctx.uid, name: ctx.name })
    const bal = await st.bal(loc, book.id)
    if (price !== bal.price_override) {
      ctx.require('catalog.price_edit')
      if (price !== null && D(price).gt(D(book.mrp))) throw ValidationFailed('Location price cannot exceed MRP')
      recordPrice(u, ctx, book.id, 'LOCATION_PRICE', bal.price_override, price, clean(body.reason), loc)
      bal.price_override = price
    }
    if (rl !== bal.reorder_level || rq !== bal.reorder_qty) {
      ctx.require('inventory.settings')
      bal.reorder_level = rl
      bal.reorder_qty = rq
    }
    st.touch(bal)
    await st.commit()
    ctx.audit(u, 'catalog.location_settings', { entity_type: 'book', entity_id: book.id, location_id: loc, details: body })
    return { message: 'Saved' }
  })
})

route('GET', '/books/:id/price-history', async ({ params }, ctx) => {
  ctx.require('catalog.view')
  await getBook(params.id)
  const cost = canSeeCost(ctx)
  const rows = (await find('price_history', where('book_id', '==', params.id), orderBy('changed_at', 'desc'), limit(200)))
    .filter((r) => (cost || r.field !== 'PURCHASE_PRICE') && (!r.location_id || ctx.canAccess(r.location_id)))
  return rows.map((r) => ({ id: r.id, field: r.field, old_value: r.old_value, new_value: r.new_value, reason: r.reason, location_id: r.location_id, changed_by_name: r.changed_by_name, changed_at: r.changed_at }))
})

route('GET', '/books/:id/inventory-history', async ({ params, query }, ctx) => {
  ctx.require('inventory.view')
  await getBook(params.id)
  if (query.location_id) ctx.ensureLocation(query.location_id)
  const locs = new Map((await all('locations')).map((l) => [l.id, l.name]))
  const cost = canSeeCost(ctx)
  const lines = await movementLines(ctx.scope(), { location_id: query.location_id, book_id: params.id })
  return paginate(lines.map((l) => ({ ...l, location_name: locs.get(l.location_id) ?? null, unit_cost: cost ? l.unit_cost : null })), Number(query.page), Number(query.page_size))
})

// covers: Firebase Storage needs the paid plan, so a downscaled JPEG is kept in Firestore.
async function toCoverDataUrl(file: Blob): Promise<string> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  const isJpg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
  const isWebp = String.fromCharCode(...head.slice(0, 4)) === 'RIFF' && String.fromCharCode(...head.slice(8, 12)) === 'WEBP'
  if (!isJpg && !isPng && !isWebp) throw ValidationFailed('Only JPEG, PNG or WebP images are allowed')
  if (file.size > 5 * 1024 * 1024) throw ValidationFailed('Image is too large')
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, 600 / Math.max(bmp.width, bmp.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bmp.width * scale)
  canvas.height = Math.round(bmp.height * scale)
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.8)
}
route('POST', '/books/:id/cover', async ({ params, body }, ctx) => {
  ctx.require('catalog.edit')
  const book = await getBook(params.id)
  const file = body instanceof FormData ? (body.get('file') as Blob | null) : null
  if (!file) throw ValidationFailed('No file uploaded')
  const data = await toCoverDataUrl(file)
  return tx(async (u) => {
    u.set(`book_images/${book.id}`, { data, updated_at: u.at })
    const { id: _i, _shard, ...store } = book
    void _i; void _shard
    await u.setEntry(shardPath('books', book.id), book.id, { ...store, has_cover: true, updated_at: u.at })
    ctx.audit(u, 'catalog.cover_uploaded', { entity_type: 'book', entity_id: book.id })
    return { ...(await bookOut({ ...book, has_cover: true })), cover_url: data }
  })
})

route('GET', '/books/import/template', async (_r, ctx) => {
  ctx.require('catalog.import')
  const rows = [CSV_COLUMNS, ['The Example Book', '', 'Jane Author;John Author', 'Example Press', '9780306406157', '', '', '1st', 'English', 'Fiction', 'Paperback', '', '320', '4901', 'GST0', '499.00', '449.00', '', '300.00', '5', '10', 'QUANTITY', 'bestseller;classic']]
  return new Response(new Blob([toCsv(rows)], { type: 'text/csv' }))
})

route('GET', '/books/export.csv', async ({ query }, ctx) => {
  ctx.require('catalog.import', 'reports.export')
  const f = await searchFilter(query.q)
  const [cats, pubs, tcs] = await Promise.all([indexOf('categories'), indexOf('publishers'), indexOf('tax_classes')])
  const cost = canSeeCost(ctx)
  const rows: unknown[][] = [['sku', 'barcode', ...CSV_COLUMNS, 'status']]
  for (const b of (await liveBooks()).filter((x) => f(x) && (!query.status || x.status === query.status)).sort((a, z) => a.title.localeCompare(z.title))) {
    rows.push([b.sku, b.barcode, b.title, b.subtitle ?? '', (b.authors ?? []).join(';'), pubs.get(b.publisher_id)?.name ?? '', b.isbn13 ?? '', b.isbn10 ?? '', b.barcode, b.edition ?? '', b.language ?? '',
      cats.get(b.category_id)?.name ?? '', b.binding ?? '', b.format ?? '', b.page_count ?? '', b.hsn_code ?? '', tcs.get(b.tax_class_id)?.code ?? '', b.mrp, b.selling_price, b.min_selling_price ?? '',
      cost ? (b.purchase_price ?? '') : '', b.reorder_level ?? 0, b.reorder_qty ?? 0, b.tracking_mode, (b.tags ?? []).join(';'), b.status])
  }
  await tx(async (u) => ctx.audit(u, 'catalog.exported', { entity_type: 'book' }))
  return new Response(new Blob([toCsv(rows)], { type: 'text/csv' }))
})

// ---------------------------------------------------------------- CSV import
const CSV_COLUMNS = ['title', 'subtitle', 'authors', 'publisher', 'isbn13', 'isbn10', 'barcode', 'edition', 'language', 'category', 'binding', 'format', 'page_count', 'hsn_code', 'tax_class', 'mrp', 'selling_price', 'min_selling_price', 'purchase_price', 'reorder_level', 'reorder_qty', 'tracking_mode', 'tags']

export function toCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map((v) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }).join(',')).join('\r\n') + '\r\n'
}
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ } else q = false
      } else cell += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((x) => x.trim() !== ''))
}

async function validateCsv(file: Blob) {
  const text = (await file.text()).replace(/^\uFEFF/, '')
  const grid = parseCsv(text)
  const header = (grid[0] ?? []).map((h) => h.trim())
  if (!header.includes('title') || !header.includes('mrp')) throw ValidationFailed("CSV must include at least 'title' and 'mrp' columns", { details: { expected: CSV_COLUMNS } })
  if (grid.length - 1 > 5000) throw ValidationFailed('Import is limited to 5000 rows per file')
  const tcs = new Map((await all('tax_classes')).filter((t) => t.is_active).map((t) => [t.code, t.id]))
  const cats = new Map((await all('categories')).map((c) => [lc(c.name), c.id]))
  const books = [...(await entries('books')).values()]
  const seenIsbn = new Map<string, number>(), seenBarcode = new Map<string, number>()
  const results = []
  for (let r = 1; r < grid.length; r++) {
    const rowNo = r + 1
    const row: Record<string, string> = Object.fromEntries(header.map((h, i) => [h, grid[r][i] ?? '']))
    const errors: string[] = [], warnings: string[] = []
    let parsed: BookIn | null = null
    try {
      const tc = (row.tax_class || 'GST0').trim().toUpperCase()
      if (!tcs.has(tc)) throw new Error(`tax_class: unknown code '${tc}'`)
      const cat = (row.category ?? '').trim()
      if (cat && !cats.has(lc(cat))) throw new Error(`category: unknown '${cat}'`)
      for (const k of ['mrp', 'selling_price', 'min_selling_price', 'purchase_price']) if ((row[k] ?? '').trim() && !Number.isFinite(Number(row[k]))) throw new Error(`${k}: not a number`)
      parsed = parseBookIn({
        title: row.title, subtitle: row.subtitle, authors: (row.authors ?? '').split(';').filter((a) => a.trim()), publisher: row.publisher, isbn13: row.isbn13, isbn10: row.isbn10, barcode: row.barcode,
        edition: row.edition, language: row.language, category_id: cat ? cats.get(lc(cat)) : null, binding: row.binding, format: row.format, page_count: (row.page_count ?? '').trim() || null,
        hsn_code: (row.hsn_code ?? '').trim() || '4901', tax_class_id: tcs.get(tc), mrp: row.mrp, selling_price: (row.selling_price ?? '').trim() || row.mrp, min_selling_price: row.min_selling_price,
        purchase_price: row.purchase_price, reorder_level: row.reorder_level || 0, reorder_qty: row.reorder_qty || 0, tracking_mode: ((row.tracking_mode ?? '').trim() || 'QUANTITY').toUpperCase(),
        tags: (row.tags ?? '').split(';').filter((t) => t.trim()),
      })
    } catch (e) {
      const d = (e as { details?: { loc?: string[]; msg: string }[] }).details
      errors.push(Array.isArray(d) && d[0] ? `${(d[0].loc ?? []).filter((x) => x !== 'body').join('.') || 'row'}: ${d[0].msg}` : (e as Error).message)
    }
    if (parsed) {
      if (parsed.isbn13) {
        if (seenIsbn.has(parsed.isbn13)) errors.push(`Duplicate ISBN within file (row ${seenIsbn.get(parsed.isbn13)})`)
        seenIsbn.set(parsed.isbn13, rowNo)
        const dup = books.find((b) => b.isbn13 === parsed!.isbn13 || b.barcode === parsed!.isbn13)
        if (dup) errors.push(`ISBN already in catalog: ${dup.title} (${dup.sku})`)
      }
      if (parsed.barcode) {
        if (seenBarcode.has(parsed.barcode)) errors.push(`Duplicate barcode within file (row ${seenBarcode.get(parsed.barcode)})`)
        seenBarcode.set(parsed.barcode, rowNo)
        if (books.some((b) => b.barcode === parsed!.barcode || b.isbn13 === parsed!.barcode)) errors.push('Barcode already in catalog')
      }
      if (!parsed.isbn13 && (await findDuplicates({ title: parsed.title, authors: parsed.authors, isbn13: null })).length) warnings.push('Possible duplicate title already in catalog')
    }
    results.push({ row: rowNo, title: row.title, isbn13: parsed ? parsed.isbn13 : row.isbn13, errors, warnings, data: parsed && !errors.length ? parsed : null })
  }
  return results
}
route('POST', '/books/import/preview', async ({ body }, ctx) => {
  ctx.require('catalog.import')
  const file = body instanceof FormData ? (body.get('file') as Blob | null) : null
  if (!file) throw ValidationFailed('No file uploaded')
  const rows = await validateCsv(file)
  return { rows, valid: rows.filter((r) => !r.errors.length).length, invalid: rows.filter((r) => r.errors.length).length }
})
route('POST', '/books/import/commit', async ({ body }, ctx) => {
  ctx.require('catalog.import', 'catalog.create')
  const file = body instanceof FormData ? (body.get('file') as Blob | null) : null
  if (!file) throw ValidationFailed('No file uploaded')
  const rows = await validateCsv(file)
  const bad = rows.filter((r) => r.errors.length)
  if (bad.length) throw ValidationFailed(`${bad.length} row(s) have errors; fix them and re-upload`, { details: bad.slice(0, 50) })
  // all-or-nothing; Firestore allows 500 writes per transaction, so large files go in a few transactions
  let created = 0
  for (let i = 0; i < rows.length; i += 150) {
    const chunk = rows.slice(i, i + 150)
    await tx(async (u) => {
      for (const r of chunk) await createBook(u, ctx, r.data!, { skipChecks: true })
      if (i + 150 >= rows.length) ctx.audit(u, 'catalog.imported', { entity_type: 'book', details: { count: rows.length } })
    })
    created += chunk.length
  }
  return { created }
})

// ---------------------------------------------------------------- master data
route('GET', '/tax-classes', async (_r, ctx) => {
  ctx.require('catalog.view')
  return (await all('tax_classes')).sort((a, b) => D(a.rate).cmp(D(b.rate))).map((t) => ({ id: t.id, code: t.code, name: t.name, rate: s2(t.rate), is_exempt: !!t.is_exempt, is_active: !!t.is_active }))
})
function taxClassIn(b: Record<string, unknown>) {
  const code = String(b.code ?? ''), name = String(b.name ?? ''), rate = Number(b.rate)
  if (!/^[A-Z0-9_]{2,30}$/.test(code)) throw fieldError('code', 'String should match pattern ^[A-Z0-9_]+$')
  if (name.length < 2) throw fieldError('name', 'String should have at least 2 characters')
  if (!(rate >= 0 && rate <= 50)) throw fieldError('rate', 'Input should be between 0 and 50')
  return { code, name, rate: s2(rate), is_exempt: !!b.is_exempt, is_active: b.is_active === undefined ? true : !!b.is_active }
}
route('POST', '/tax-classes', async ({ body }, ctx) => {
  ctx.require('settings.manage')
  const v = taxClassIn(body)
  if ((await all('tax_classes')).some((t) => t.code === v.code)) throw Conflict('Tax class code already exists')
  return tx(async (u) => {
    u.set(`tax_classes/${v.code}`, { ...v, created_at: u.at })
    ctx.audit(u, 'settings.tax_class_created', { entity_type: 'tax_class', details: v })
    return { id: v.code, ...v }
  })
})
route('PUT', '/tax-classes/:id', async ({ params, body }, ctx) => {
  ctx.require('settings.manage')
  const tc = await byId('tax_classes', params.id)
  if (!tc) throw NotFound('Tax class not found')
  const v = taxClassIn(body)
  return tx(async (u) => {
    await u.update(`tax_classes/${tc.id}`, v)
    ctx.audit(u, 'settings.tax_class_updated', { entity_type: 'tax_class', entity_id: tc.id, details: { before: tc, after: v } })
    return { id: tc.id, ...v }
  })
})
route('GET', '/categories', async (_r, ctx) => {
  ctx.require('catalog.view')
  return (await all('categories')).sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ id: c.id, name: c.name, parent_id: c.parent_id ?? null }))
})
route('POST', '/categories', async ({ body }, ctx) => {
  ctx.require('catalog.master_data')
  const name = String(body.name ?? '').split(/\s+/).filter(Boolean).join(' ')
  if (!name) throw fieldError('name', 'String should have at least 1 character')
  const parentId = clean(body.parent_id)
  if (parentId) {
    const parent = await byId('categories', parentId)
    if (!parent) throw ValidationFailed('Parent category not found')
    if (parent.parent_id) throw ValidationFailed('Only two category levels (category / subcategory) are supported')
  }
  if ((await all('categories')).some((c) => (c.parent_id ?? null) === parentId && lc(c.name) === lc(name))) throw Conflict('The request conflicts with existing data')
  return tx(async (u) => {
    const id = u.add('categories', { name, parent_id: parentId })
    ctx.audit(u, 'catalog.category_created', { entity_type: 'category', entity_id: id, details: { name, parent_id: parentId } })
    return { id, name, parent_id: parentId }
  })
})
route('PUT', '/categories/:id', async ({ params, body }, ctx) => {
  ctx.require('catalog.master_data')
  const c = await byId('categories', params.id)
  if (!c) throw NotFound('Category not found')
  const parentId = clean(body.parent_id)
  if (parentId === c.id) throw ValidationFailed('A category cannot be its own parent')
  const name = String(body.name ?? '').split(/\s+/).filter(Boolean).join(' ')
  return tx(async (u) => {
    await u.update(`categories/${c.id}`, { name, parent_id: parentId })
    ctx.audit(u, 'catalog.category_updated', { entity_type: 'category', entity_id: c.id, details: { name, parent_id: parentId } })
    return { id: c.id, name, parent_id: parentId }
  })
})
route('GET', '/publishers', async ({ query }, ctx) => {
  ctx.require('catalog.view')
  return (await all('publishers')).filter((p) => matches(query.q, p.name)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 50).map((p) => ({ id: p.id, name: p.name }))
})
export async function authorOut(a: Row, books: number | null = null) {
  const sup = a.supplier_id ? await byId('suppliers', a.supplier_id).catch(() => null) : null
  return { id: a.id, name: a.name, email: a.email ?? null, phone: a.phone ?? null, books, supplier_id: a.supplier_id ?? null, supplier_code: sup?.code ?? null }
}
route('GET', '/authors', async ({ query }, ctx) => {
  ctx.require('catalog.view')
  const counts = new Map<string, number>()
  for (const b of await liveBooks()) for (const id of (b.author_ids ?? []) as string[]) counts.set(id, (counts.get(id) ?? 0) + 1)
  const lim = Math.min(Math.max(int(query.limit, 50), 1), 200)
  const rows = (await all('authors')).filter((a) => (!query.q || matches(query.q, a.name, a.email)) && (query.missing_email !== 'true' || !a.email)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, lim)
  return Promise.all(rows.map((a) => authorOut(a, counts.get(a.id) ?? 0)))
})
route('PUT', '/authors/:id', async ({ params, body }, ctx) => {
  ctx.requireAny('catalog.master_data', 'schools.manage')
  const a = await byId('authors', params.id)
  if (!a) throw NotFound('Author not found')
  const email = clean(body.email)?.toLowerCase() ?? null
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fieldError('email', 'value is not a valid email address')
  const phone = clean(body.phone)
  return tx(async (u) => {
    await u.update(`authors/${a.id}`, { email, phone })
    ctx.audit(u, 'catalog.author_contact_updated', { entity_type: 'author', entity_id: a.id, details: { name: a.name } })
    return authorOut({ ...a, email, phone })
  })
})

route('DELETE', '/books/:id', async ({ params }, ctx) => {
  ctx.require('catalog.archive')
  const b = await getBook(params.id)
  const used = (await hasStock(b.id)) || (await find('stock_moves', where('book_ids', 'array-contains', b.id), limit(1))).length
    || (await find('purchase_orders', where('book_ids', 'array-contains', b.id), limit(1))).length
    || (await all('book_lists').catch(() => [] as Row[])).some((l) => (l.items as Row[]).some((i) => i.book_id === b.id))
  if (used) throw Conflict('This book has stock, sales, orders or is on a school list; archive it instead')
  await tx(async (u) => {
    await u.setEntry(shardPath('books', b.id), b.id, null)
    if (b.has_cover) u.delete(`book_images/${b.id}`)
    ctx.audit(u, 'catalog.book_deleted', { entity_type: 'book', entity_id: b.id, details: { title: b.title, sku: b.sku } })
  })
  return undefined
})

// detail last, so the static /books/... paths above win
route('GET', '/books/:id', async ({ params }, ctx) => {
  ctx.require('catalog.view')
  const b = await getBook(params.id)
  const cost = canSeeCost(ctx)
  const locs = (await all('locations')).filter((l) => ctx.canAccess(l.id)).sort((a, z) => (a.type === z.type ? a.name.localeCompare(z.name) : a.type === 'WAREHOUSE' ? -1 : 1))
  const stock = []
  for (const l of locs) {
    const bal = (await balancesAt(l.id)).get(b.id)
    if (!bal) continue
    stock.push({ location_id: l.id, location_name: l.name, location_type: l.type, on_hand: bal.on_hand, reserved: bal.reserved, available: bal.on_hand - bal.reserved, damaged: bal.damaged,
      quarantined: bal.quarantined, in_transit: bal.in_transit, reorder_level: bal.reorder_level, price_override: bal.price_override, avg_cost: cost ? bal.avg_cost : null })
  }
  const suppliers = []
  if (ctx.has('suppliers.view')) {
    for (const [sid, sp] of Object.entries((b.suppliers ?? {}) as Record<string, Row>)) {
      const sup = await byId('suppliers', sid)
      if (sup) suppliers.push({ supplier_id: sid, name: sup.name, supplier_sku: sp.supplier_sku ?? null, last_cost: cost ? (sp.last_cost ?? null) : null, last_purchased_at: sp.last_purchased_at ?? null })
    }
  }
  const sup = b.default_supplier_id && ctx.has('suppliers.view') ? await byId('suppliers', b.default_supplier_id).catch(() => null) : null
  const img = b.has_cover ? await getOne(`book_images/${b.id}`) : null
  return { ...(await bookOut(b, null, cost)), cover_url: (img?.data as string) ?? null, stock, suppliers, default_supplier_name: sup?.name ?? null }
})
