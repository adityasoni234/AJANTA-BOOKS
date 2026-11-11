/** Maps the old REST paths to in-browser handlers, so every page keeps calling `api.get('/books')` etc. */
import { ApiError } from '@/lib/api'
import { FirebaseError } from 'firebase/app'
import { loadCtx, type Ctx } from './ctx'

export type Query = Record<string, string | undefined>
export interface Req {
  params: Record<string, string>
  query: Query
  body: any // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Record<string, string>
}
type Handler = (req: Req, ctx: Ctx) => Promise<unknown>
type PublicHandler = (req: Req) => Promise<unknown>

interface Route {
  method: string
  re: RegExp
  keys: string[]
  run: (req: Req) => Promise<unknown>
}
const routes: Route[] = []

function compile(path: string): { re: RegExp; keys: string[] } {
  const keys: string[] = []
  const re = path.replace(/:([a-z_]+)(\*)?/g, (_, k: string, star?: string) => {
    keys.push(k)
    return star ? '(.+)' : '([^/]+)'
  })
  return { re: new RegExp(`^${re}$`), keys }
}

function add(method: string, path: string, run: (req: Req) => Promise<unknown>) {
  const { re, keys } = compile(path)
  routes.push({ method, re, keys, run })
}

/** Authenticated route; `opts.pending` allows users who still must change their password. */
export function route(method: string, path: string, h: Handler, opts: { pending?: boolean } = {}) {
  add(method, path, async (req) => h(req, await loadCtx({ allowPendingPassword: opts.pending })))
}
export function publicRoute(method: string, path: string, h: PublicHandler) {
  add(method, path, h)
}

const FS_MESSAGES: Record<string, [number, string, string]> = {
  'permission-denied': [403, 'permission_denied', 'You do not have permission to do this'],
  unavailable: [503, 'backend_unavailable', 'Cannot reach the server. Check your connection and try again.'],
  'failed-precondition': [409, 'conflict', 'The data changed while saving. Please try again.'],
  aborted: [409, 'conflict', 'The data changed while saving. Please try again.'],
  'resource-exhausted': [429, 'quota_exceeded', 'Daily free usage limit reached. Try again tomorrow.'],
  'auth/invalid-credential': [401, 'invalid_credentials', 'Invalid email or password'],
  'auth/wrong-password': [401, 'invalid_credentials', 'Invalid email or password'],
  'auth/user-not-found': [401, 'invalid_credentials', 'Invalid email or password'],
  'auth/user-disabled': [401, 'invalid_credentials', 'Invalid email or password'],
  'auth/too-many-requests': [429, 'rate_limited', 'Too many attempts. Try again later.'],
  'auth/email-already-in-use': [409, 'conflict', 'A user with this email already exists'],
  'auth/network-request-failed': [503, 'backend_unavailable', 'Cannot reach the server. Check your connection and try again.'],
  'auth/requires-recent-login': [403, 'reauth_required', 'Please sign in again and retry'],
}

export async function dispatch(method: string, fullPath: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
  const [path, qs = ''] = fullPath.split('?')
  const query: Query = Object.fromEntries(new URLSearchParams(qs))
  for (const r of routes) {
    if (r.method !== method) continue
    const m = r.re.exec(path)
    if (!m) continue
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]))
    try {
      return await r.run({ params, query, body: body ?? {}, headers })
    } catch (e) {
      if (e instanceof ApiError) throw e
      if (e instanceof FirebaseError) {
        const hit = FS_MESSAGES[e.code]
        if (hit) throw new ApiError(hit[0], { code: hit[1], message: hit[2] })
        console.error(e)
        throw new ApiError(500, { code: 'internal_error', message: e.message })
      }
      console.error(e)
      throw new ApiError(500, { code: 'internal_error', message: e instanceof Error ? e.message : 'An unexpected error occurred' })
    }
  }
  throw new ApiError(501, { code: 'not_available', message: 'This section is not available yet: it is still being moved to Firebase.' })
}
