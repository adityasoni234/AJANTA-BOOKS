export interface School {
  id: string; code: string; name: string; city: string | null; contact_person: string | null; phone: string | null
  email: string | null; notes: string | null; is_active: boolean; lists: number | null
}
export interface Loc { id: string; code: string; name: string; type: 'WAREHOUSE' | 'OUTLET' }
export interface SetsAt { location_id: string; available: number | null; with_on_order: number | null }
export interface ListSummary { id: string; academic_year: string; class_name: string; is_active: boolean; books: number; sets: SetsAt[] }
export interface OrderClass { list_id: string; class_name: string; sets: number }
export interface OrderSummary {
  id: string; number: string; school_id: string; school_name: string; school_code: string; academic_year: string
  location_id: string; location_name: string; notes: string | null; created_at: string; created_by_name: string | null; classes: OrderClass[]
}
export interface SchoolDetail { school: School; locations: Loc[]; lists: ListSummary[]; orders: OrderSummary[] }

export interface ListItem {
  id: string; book_id: string; title: string; isbn13: string | null; sku: string; author: string | null; publisher: string | null
  mrp: string; qty_per_set: number; book_status: string; stock: { location_id: string; available: number; on_order: number }[]
}
export interface BookListDetail {
  id: string; school: School; academic_year: string; class_name: string; is_active: boolean
  locations: Loc[]; items: ListItem[]; sets: SetsAt[]
}

export interface OrderLine {
  book_id: string; title: string; isbn13: string | null; sku: string; classes: string[]; author_id: string | null
  author_name: string | null; author_email: string | null; required: number; available: number; on_order: number
  suggested: number; unit_cost: string | null; tax_rate: string; problems: string[]
}
export interface OrderPreview { school: School; location: { id: string; name: string }; academic_year: string; lines: OrderLine[] }
export interface OrderPO {
  id: string; number: string; status: string; total: string; supplier_name: string; author_id: string | null; author_name: string | null
  author_email: string | null; email_opened_at: string | null; books: number; copies: number; received: number
}
export interface SchoolOrder extends OrderSummary { purchase_orders: OrderPO[] }

export interface EmailDraft { to: string; author_name: string; subject: string; body: string; status: string; email_opened_at: string | null; can_open: boolean }

/** "11" → "Class 11"; names that already start with Class/Grade/Std are kept as they are. */
export function classLabel(name: string) {
  return /^(class|grade|std)/i.test(name) ? name : `Class ${name}`
}

/** Indian academic year (April–March) containing the date, e.g. 2026-27. */
export function currentAcademicYear(d = new Date()) {
  const start = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}
