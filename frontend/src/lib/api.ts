/** Thin fetch wrapper: same-origin cookies, CSRF header on unsafe methods, structured errors. */

export interface ApiErrorBody {
  code: string
  message: string
  details?: unknown
  request_id?: string
}

export class ApiError extends Error {
  status: number
  code: string
  details?: unknown
  requestId?: string

  constructor(status: number, body: ApiErrorBody) {
    super(body.message)
    this.status = status
    this.code = body.code
    this.details = body.details
    this.requestId = body.request_id
  }

  /** Field-level messages from a 422 validation response, keyed by field name. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {}
    if (Array.isArray(this.details)) {
      for (const d of this.details as { loc?: string[]; msg?: string }[]) {
        const field = d.loc?.filter((x) => x !== 'body').join('.')
        if (field && d.msg) out[field] = d.msg.replace(/^Value error, /, '')
      }
    }
    return out
  }

  /** Human-readable message including list details (e.g. password rules). */
  fullMessage(): string {
    if (Array.isArray(this.details) && this.details.every((d) => typeof d === 'string')) {
      return `${this.message}: ${(this.details as string[]).join('; ')}`
    }
    const fields = Object.entries(this.fieldErrors())
    if (fields.length) return fields.map(([k, v]) => `${k}: ${v}`).join('; ')
    return this.message
  }
}

const BASE = '/api/v1'
let csrfToken: string | null = null
let onUnauthorized: (() => void) | null = null

export function setCsrfToken(token: string | null) {
  csrfToken = token
}

export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn
}

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  return m ? decodeURIComponent(m[1]) : null
}

type Query = Record<string, string | number | boolean | null | undefined>

export function qs(params?: Query): string {
  if (!params) return ''
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

interface RequestOptions {
  body?: unknown
  query?: Query
  headers?: Record<string, string>
  idempotencyKey?: string
  raw?: boolean
  signal?: AbortSignal
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers }
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method)
  if (unsafe) {
    const token = csrfToken ?? readCookie('ab_csrf')
    if (token) headers['X-CSRF-Token'] = token
  }
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey
  let body: BodyInit | undefined
  if (opts.body instanceof FormData) {
    body = opts.body
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  let res: Response
  try {
    res = await fetch(`${BASE}${path}${qs(opts.query)}`, { method, headers, body, credentials: 'same-origin', signal: opts.signal })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new ApiError(0, { code: 'network_error', message: 'Cannot reach the server. Check your connection and try again.' })
  }
  if (res.status === 401 && onUnauthorized && !path.startsWith('/auth/login')) onUnauthorized()
  if (!res.ok) {
    let err: ApiErrorBody = { code: 'http_error', message: `Request failed (${res.status})` }
    try {
      const j = await res.json()
      if (j?.error) err = j.error
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, err)
  }
  if (opts.raw) return res as unknown as T
  if (res.status === 204) return undefined as T
  const ct = res.headers.get('content-type') ?? ''
  return (ct.includes('application/json') ? res.json() : res.text()) as Promise<T>
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>('GET', path, { query, signal }),
  post: <T>(path: string, body?: unknown, opts: Omit<RequestOptions, 'body'> = {}) => request<T>('POST', path, { ...opts, body }),
  put: <T>(path: string, body?: unknown, opts: Omit<RequestOptions, 'body'> = {}) => request<T>('PUT', path, { ...opts, body }),
  del: <T>(path: string) => request<T>('DELETE', path),
  /** Download a CSV/file through the same authenticated session. */
  async download(path: string, query: Query | undefined, filename: string) {
    const res = await request<Response>('GET', path, { query, raw: true })
    const blob = await res.blob()
    const { downloadBlob } = await import('./utils')
    downloadBlob(blob, filename)
  },
}

export interface Page<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.fullMessage()
  if (e instanceof Error) return e.message
  return 'Something went wrong'
}
