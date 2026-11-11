/**
 * Optional sample data for trying the system: a warehouse and three outlets, categories, books, opening stock
 * and a few customers. Owner-only and only while the catalog is empty. It creates no logins; staff accounts are
 * added by the owner (Administration → Users) with their own passwords.
 */
import { createBook, parseBookIn } from './catalog'
import { Conflict, ean13Check, newId } from './core'
import { createAdjustment } from './inventory'
import { route } from './router'
import { all, entries, shardPath, tx } from './store'

const LOCATIONS = [
  { code: 'WH', name: 'Central Warehouse — Bhiwandi', type: 'WAREHOUSE', city: 'Bhiwandi', state: 'Maharashtra', state_code: '27', invoice_prefix: 'WH' },
  { code: 'FORT', name: 'Fort, Mumbai', type: 'OUTLET', city: 'Mumbai', state: 'Maharashtra', state_code: '27', invoice_prefix: 'FT' },
  { code: 'PUNE', name: 'FC Road, Pune', type: 'OUTLET', city: 'Pune', state: 'Maharashtra', state_code: '27', invoice_prefix: 'PN' },
  { code: 'BLR', name: 'Church Street, Bengaluru', type: 'OUTLET', city: 'Bengaluru', state: 'Karnataka', state_code: '29', invoice_prefix: 'BL' },
]
const CATEGORIES = ['Fiction', 'Children', 'Academic', 'Stationery']
// title, authors, publisher, category, mrp, cost, tax class
const BOOKS: [string, string[], string, string, number, number, string][] = [
  ['Monsoon Letters', ['Ravi Kulkarni'], 'Ajanta Press', 'Fiction', 499, 300, 'GST0'],
  ['The Salt Road', ['Meera Iyer'], 'Coastline Books', 'Fiction', 399, 240, 'GST0'],
  ['City of Lanterns', ['Arjun Menon'], 'Ajanta Press', 'Fiction', 450, 270, 'GST0'],
  ['Tiny Tiger Learns to Roar', ['Priya Shah'], 'Little Owl', 'Children', 199, 110, 'GST0'],
  ['Stars Over Sahyadri', ['Priya Shah'], 'Little Owl', 'Children', 249, 140, 'GST0'],
  ['NCERT Mathematics Class 11', ['NCERT'], 'NCERT', 'Academic', 220, 170, 'GST0'],
  ['NCERT Physics Class 12 Part 1', ['NCERT'], 'NCERT', 'Academic', 180, 140, 'GST0'],
  ['Concise Chemistry Class 10', ['S. P. Singh'], 'Selina', 'Academic', 520, 380, 'GST0'],
  ['English Grammar in Practice', ['R. K. Sinha'], 'Bharati Bhawan', 'Academic', 350, 230, 'GST0'],
  ['A4 Notebook (200 pages)', [], 'Classmate', 'Stationery', 90, 55, 'GST12'],
  ['Gel Pen (pack of 5)', [], 'Cello', 'Stationery', 118, 70, 'GST18'],
  ['Geometry Box', [], 'Camlin', 'Stationery', 160, 95, 'GST18'],
]
const CUSTOMERS = [['Asha Rao', '9876500001'], ['Vikram Desai', '9876500002'], ['Neha Kapoor', '9876500003'], ['St. Mary’s School', '9876500004']]

const isbn = (i: number) => {
  const core = `97893${String(5100000 + i).slice(-7)}`
  return core + ean13Check(core)
}

route('POST', '/sample-data', async (_r, ctx) => {
  ctx.require('settings.manage', 'catalog.create', 'locations.manage', 'inventory.adjust')
  if (!ctx.all_locations) throw Conflict('Only the owner can load sample data')
  if ((await entries('books')).size) throw Conflict('Sample data can only be loaded while the catalog is empty')
  const existing = await all('locations')
  const locIds: Record<string, string> = {}
  await tx(async (u) => {
    for (const l of LOCATIONS) {
      const found = existing.find((x) => x.code === l.code)
      if (found) { locIds[l.code] = found.id; continue }
      const id = u.add('locations', { ...l, is_active: true, address_line1: null, address_line2: null, pincode: null, phone: null, email: null, gstin: null })
      locIds[l.code] = id
      if (l.type === 'OUTLET') u.add('registers', { location_id: id, name: 'Counter 1', is_active: true })
    }
    const cats = await all('categories')
    for (const c of CATEGORIES) if (!cats.some((x) => x.name === c)) u.add('categories', { name: c, parent_id: null })
    ctx.audit(u, 'sample_data.locations', { details: { locations: Object.keys(locIds) } })
  })
  const cats = new Map((await all('categories')).map((c) => [c.name, c.id]))
  const bookIds: { id: string; cost: number }[] = []
  await tx(async (u) => {
    for (let i = 0; i < BOOKS.length; i++) {
      const [title, authors, publisher, cat, mrp, cost, tc] = BOOKS[i]
      const d = parseBookIn({ title, authors, publisher, category_id: cats.get(cat), isbn13: cat === 'Stationery' ? null : isbn(i), hsn_code: cat === 'Stationery' ? '4820' : '4901', tax_class_id: tc, mrp, selling_price: mrp, purchase_price: cost, reorder_level: 5, reorder_qty: 20 })
      const b = await createBook(u, ctx, d, { skipChecks: true })
      bookIds.push({ id: b.id, cost })
    }
    for (const [name, phone] of CUSTOMERS) {
      const id = newId()
      await u.setEntry(shardPath('customers', id), id, { name, phone, email: null, gstin: null, billing_address: null, state_code: '27', notes: null, marketing_consent: false, credit_limit: '0.00', is_active: true,
        code: await u.nextCode('CUSTOMER', 'C', 6), consent_updated_at: null, home_location_id: null, created_by: ctx.uid, created_at: u.at, spend: '0.00', visits: 0, outstanding: '0.00', store_credit: '0.00', loyalty_points: 0, last_purchase_at: null })
    }
  })
  const qty: Record<string, number> = { WH: 200, FORT: 25, PUNE: 15, BLR: 10 }
  for (const code of Object.keys(qty)) {
    await tx((u) => createAdjustment(u, ctx, { location_id: locIds[code], reason_code: 'OPENING', notes: 'Sample opening stock', lines: bookIds.map((b, i) => ({ book_id: b.id, qty: Math.max(2, qty[code] - (i % 4) * 3), from_bucket: null, to_bucket: 'ON_HAND', unit_cost: String(b.cost) })) }))
  }
  return { message: 'Sample data loaded', locations: Object.keys(locIds).length, books: bookIds.length, customers: CUSTOMERS.length }
})
