/** API surface used by every page: same paths as before, served by src/server on Firebase. Structured errors. */

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

let onUnauthorized: (() => void) | null = null

/** Kept for callers; sessions are managed by Firebase Auth. */
export function setCsrfToken(_token: string | null) {
  void _token
}

export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn
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
  const headers: Record<string, string> = { ...opts.headers }
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey
  // Data is handled in the browser by the Firebase-backed handlers in src/server (same paths as the old API).
  const { dispatch } = await import('@/server')
  try {
    const data = await dispatch(method, `${path}${qs(opts.query)}`, opts.body, headers)
    if (opts.raw) return (data instanceof Response ? data : new Response(data as BodyInit)) as unknown as T
    return data as T
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && onUnauthorized && !path.startsWith('/auth/login')) onUnauthorized()
    throw e
  }
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
