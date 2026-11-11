/**
 * Shared primitives for the in-browser backend: exact decimal money, API errors with the same
 * `{code, message, details}` shape the FastAPI backend returned, ids, dates and document numbering.
 */
import Decimal from 'decimal.js-light'
import { ApiError } from '@/lib/api'

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP })

export { Decimal }
export type Num = Decimal | string | number | null | undefined

export const ZERO = new Decimal(0)
export function D(v: Num): Decimal {
  if (v === null || v === undefined || v === '') return ZERO
  return v instanceof Decimal ? v : new Decimal(v)
}
/** Money to paise, as the API string ("1118.00"). */
export const r2 = (v: Num): Decimal => D(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
export const r4 = (v: Num): Decimal => D(v).toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
export const roundRupee = (v: Num): Decimal => D(v).toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
export const s2 = (v: Num): string => r2(v).toFixed(2)
export const s4 = (v: Num): string => r4(v).toFixed(4)
export const s2n = (v: Num): string | null => (v === null || v === undefined || v === '' ? null : s2(v))
export const sum = (xs: Num[]): Decimal => xs.reduce<Decimal>((a, x) => a.plus(D(x)), ZERO)
export const dmax = (a: Decimal, b: Decimal) => (a.gt(b) ? a : b)
export const dmin = (a: Decimal, b: Decimal) => (a.lt(b) ? a : b)

// ---- errors (status codes and codes match the old backend) ----
const err = (status: number, code: string) => (message: string, opts: { code?: string; details?: unknown } = {}) =>
  new ApiError(status, { code: opts.code ?? code, message, details: opts.details })
export const BadRequest = err(400, 'bad_request')
export const Unauthorized = err(401, 'unauthorized')
export const Forbidden = err(403, 'forbidden')
export const NotFound = err(404, 'not_found')
export const Conflict = err(409, 'conflict')
export const ValidationFailed = err(422, 'validation_failed')

/** 422 with field details in the `{loc, msg}` form the forms already understand. */
export function fieldError(field: string, msg: string): ApiError {
  return new ApiError(422, { code: 'validation_failed', message: 'Request validation failed', details: [{ loc: ['body', ...field.split('.')], msg, type: 'value_error' }] })
}

// ---- ids & time ----
export function newId(): string {
  const a = new Uint8Array(12)
  crypto.getRandomValues(a)
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}
export const nowIso = () => new Date().toISOString()
const TZ = 'Asia/Kolkata'
/** Local (IST) calendar date `YYYY-MM-DD`. */
export function localDate(d: Date | string = new Date()): string {
  const x = typeof d === 'string' ? new Date(d) : d
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(x)
}
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}
/** ISO bounds of an IST calendar-date range, for querying `created_at` strings. */
export function isoRange(from: string, to: string): [string, string] {
  return [new Date(`${from}T00:00:00+05:30`).toISOString(), new Date(`${addDays(to, 1)}T00:00:00+05:30`).toISOString()]
}
export function financialYear(date: string, startMonth = 4): string {
  const [y, m] = date.split('-').map(Number)
  const start = m >= startMonth ? y : y - 1
  return startMonth === 1 ? `${start}` : `${start}-${String(start + 1).slice(-2)}`
}
export const fyShort = (fy: string) => (fy.includes('-') ? fy.slice(2, 4) + fy.slice(-2) : fy.slice(-2))

// ---- small helpers ----
export const clean = (s: unknown): string | null => {
  if (s === null || s === undefined) return null
  const t = String(s).trim()
  return t === '' ? null : t
}
export function pick<T extends object, K extends keyof T>(o: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>
  for (const k of keys) out[k] = o[k]
  return out
}
export function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const x of xs) {
    const k = key(x)
    const arr = m.get(k)
    if (arr) arr.push(x)
    else m.set(k, [x])
  }
  return m
}
export function paginate<T>(items: T[], page = 1, pageSize = 50) {
  const ps = Math.min(Math.max(Number(pageSize) || 50, 1), 200)
  const p = Math.max(Number(page) || 1, 1)
  return { items: items.slice((p - 1) * ps, p * ps), total: items.length, page: p, page_size: ps }
}
export const lc = (s: string | null | undefined) => (s ?? '').toLowerCase()
export function matches(q: string | null | undefined, ...fields: (string | null | undefined)[]): boolean {
  const t = lc(q).trim()
  if (!t) return true
  return fields.some((f) => lc(f).includes(t))
}
export const bool = (v: unknown) => v === true || v === 'true' || v === '1'
export const int = (v: unknown, dflt = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : dflt
}

// ---- passwords (same policy as before) ----
const COMMON = new Set(['password', 'password1', '12345678', '123456789', 'qwerty123', 'admin123', 'letmein1', 'welcome1', 'iloveyou', '11111111', 'abc12345', 'password123', 'admin@123'])
export function passwordProblems(pw: string, email?: string | null): string[] {
  const p: string[] = []
  if (pw.length < 10) p.push('Password must be at least 10 characters long')
  if (pw.length > 128) p.push('Password must be at most 128 characters long')
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((r) => r.test(pw)).length
  if (classes < 3) p.push('Use at least three of: lowercase, uppercase, digits, symbols')
  if (COMMON.has(pw.toLowerCase())) p.push('Password is too common')
  if (email && pw.toLowerCase().includes(email.split('@')[0].toLowerCase())) p.push('Password must not contain your email name')
  return p
}

// ---- ISBN / EAN ----
export const cleanIsbn = (v: string | null | undefined) => (v ?? '').replace(/[\s-]/g, '').toUpperCase()
export function validIsbn10(isbn: string): boolean {
  const s = cleanIsbn(isbn)
  if (!/^\d{9}[\dX]$/.test(s)) return false
  let t = 0
  for (let i = 0; i < 10; i++) t += (10 - i) * (s[i] === 'X' ? 10 : Number(s[i]))
  return t % 11 === 0
}
export function ean13Check(first12: string): string {
  let t = 0
  for (let i = 0; i < 12; i++) t += Number(first12[i]) * (i % 2 ? 3 : 1)
  return String((10 - (t % 10)) % 10)
}
export const validEan13 = (c: string) => /^\d{13}$/.test(c) && ean13Check(c.slice(0, 12)) === c[12]
export const validIsbn13 = (isbn: string) => {
  const s = cleanIsbn(isbn)
  return ['978', '979'].includes(s.slice(0, 3)) && validEan13(s)
}
export function isbn10to13(isbn10: string): string {
  const core = '978' + cleanIsbn(isbn10).slice(0, 9)
  return core + ean13Check(core)
}
export function isbn13to10(isbn13: string): string | null {
  const s = cleanIsbn(isbn13)
  if (!s.startsWith('978')) return null
  const core = s.slice(3, 12)
  let t = 0
  for (let i = 0; i < 9; i++) t += (10 - i) * Number(core[i])
  const c = (11 - (t % 11)) % 11
  return core + (c === 10 ? 'X' : String(c))
}
export function internalEan13(prefix: string, n: number): string {
  const body = `${prefix}${String(n).padStart(9, '0')}`
  if (body.length !== 12) throw BadRequest('Barcode sequence exhausted')
  return body + ean13Check(body)
}

// ---- amount in words (Indian system) ----
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
const two = (n: number) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`.trim())
const three = (n: number) => [Math.floor(n / 100) ? ONES[Math.floor(n / 100)] + ' Hundred' : '', n % 100 ? two(n % 100) : ''].filter(Boolean).join(' ')
function intWords(n: number): string {
  if (n === 0) return 'Zero'
  const parts: string[] = []
  const crore = Math.floor(n / 1e7); n %= 1e7
  const lakh = Math.floor(n / 1e5); n %= 1e5
  const th = Math.floor(n / 1000); n %= 1000
  if (crore) parts.push(intWords(crore) + ' Crore')
  if (lakh) parts.push(two(lakh) + ' Lakh')
  if (th) parts.push(two(th) + ' Thousand')
  if (n) parts.push(three(n))
  return parts.join(' ')
}
export function amountInWords(v: Num): string {
  let a = r2(v)
  const neg = a.lt(0)
  a = a.abs()
  const rupees = Math.floor(a.toNumber())
  const paise = a.minus(rupees).times(100).toNumber()
  let t = `Rupees ${intWords(rupees)}`
  if (paise) t += ` and ${two(Math.round(paise))} Paise`
  return (neg ? 'Minus ' : '') + t + ' Only'
}
