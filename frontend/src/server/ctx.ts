/** The signed-in staff member: Firebase Auth identity + `users/{uid}` profile (role permissions, location scope). */
import { onAuthStateChanged, type User as FbUser } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import { auth, db } from './firebase'
import { Forbidden, NotFound, Unauthorized } from './core'
import { all, currentTenant, fullPath, getOne, setTenant, type Row, type Uow } from './store'

export interface Ctx {
  uid: string
  user: Row
  name: string
  perms: Set<string>
  all_locations: boolean
  location_ids: string[]
  has(p: string): boolean
  require(...p: string[]): void
  requireAny(...p: string[]): void
  canAccess(locationId: string | null | undefined): boolean
  ensureLocation(locationId: string | null | undefined): void
  ensureResource(...locationIds: (string | null | undefined)[]): void
  /** Report/list filter: null = every location (unrestricted users only). */
  scope(requested?: string | null): string[] | null
  audit(u: Uow, action: string, opts?: { entity_type?: string; entity_id?: string | null; location_id?: string | null; details?: Record<string, unknown> }): void
}

let authReady: Promise<FbUser | null> | null = null
function currentFirebaseUser(): Promise<FbUser | null> {
  const a = auth()
  if (a.currentUser) return Promise.resolve(a.currentUser)
  if (!authReady) {
    authReady = new Promise((resolve) => {
      const off = onAuthStateChanged(a, (u) => {
        off()
        resolve(u)
      })
    })
  }
  return authReady
}
export function resetAuthWait() {
  authReady = null
}

// Live copy of the signed-in user's own profile (one read, then updates only).
let profile: { uid: string; data: Row | null; ready: Promise<void>; unsub: () => void } | null = null
export function watchProfile(uid: string): Promise<Row | null> {
  if (!profile || profile.uid !== uid) {
    profile?.unsub()
    let resolve!: () => void
    const p = { uid, data: null as Row | null, ready: new Promise<void>((r) => (resolve = r)), unsub: () => {} }
    p.unsub = onSnapshot(
      doc(db(), fullPath(`users/${uid}`)),
      (s) => {
        p.data = s.exists() ? ({ ...s.data(), id: s.id } as Row) : null
        resolve()
      },
      () => {
        p.data = null
        resolve()
      },
    )
    profile = p
  }
  return profile.ready.then(() => profile!.data)
}
export function clearProfile() {
  profile?.unsub()
  profile = null
}

/** Find the business this login belongs to (`/members/{uid}`) and make it the current one. Null if none. */
let tenantOf: { uid: string; org: Promise<string | null> } | null = null
export function resolveTenant(uid: string): Promise<string | null> {
  if (!tenantOf || tenantOf.uid !== uid) {
    const t = { uid, org: getOne(`/members/${uid}`).catch(() => null).then((m) => {
      const org = (m?.org_id as string | undefined) ?? null
      if (org !== currentTenant()) {
        clearProfile()
        setTenant(org)
      }
      if (!org && tenantOf === t) tenantOf = null
      return org
    }) }
    tenantOf = t
  }
  return tenantOf.org
}
/** Use this business for the given login (enrolment and sign-up, before the membership is readable). */
export function enterTenant(uid: string, org: string) {
  clearProfile()
  setTenant(org)
  tenantOf = { uid, org: Promise.resolve(org) }
}
export function forgetTenant() {
  tenantOf = null
  clearProfile()
  setTenant(null)
}

export async function loadCtx(opts: { allowPendingPassword?: boolean } = {}): Promise<Ctx> {
  const fb = await currentFirebaseUser()
  if (!fb) throw Unauthorized('Not authenticated', { code: 'not_authenticated' })
  if (!(await resolveTenant(fb.uid))) throw Unauthorized('Not authenticated', { code: 'not_authenticated' })
  const user = await watchProfile(fb.uid)
  if (!user || !user.is_active) throw Unauthorized('Account is deactivated', { code: 'account_inactive' })
  if (user.must_change_password && !opts.allowPendingPassword) throw Forbidden('Password change required', { code: 'password_change_required' })
  const active = new Set((await all('locations')).filter((l) => l.is_active).map((l) => l.id))
  const locs: string[] = ((user.location_ids ?? []) as string[]).filter((id) => active.has(id))
  const perms = new Set<string>((user.perms ?? []) as string[])
  const allLoc = !!user.all_locations
  const ctx: Ctx = {
    uid: fb.uid,
    user,
    name: user.full_name as string,
    perms,
    all_locations: allLoc,
    location_ids: locs,
    has: (p) => perms.has(p),
    require: (...p) => {
      const missing = p.filter((x) => !perms.has(x))
      if (missing.length) throw Forbidden(`Missing permission: ${missing.join(', ')}`, { code: 'permission_denied' })
    },
    requireAny: (...p) => {
      if (!p.some((x) => perms.has(x))) throw Forbidden(`Requires one of: ${p.join(', ')}`, { code: 'permission_denied' })
    },
    canAccess: (id) => (id ? allLoc || locs.includes(id) : allLoc),
    ensureLocation: (id) => {
      if (!ctx.canAccess(id)) throw Forbidden('You do not have access to this location', { code: 'location_denied' })
    },
    ensureResource: (...ids) => {
      if (allLoc) return
      if (!ids.some((id) => id && locs.includes(id))) throw NotFound('Not found')
    },
    scope: (requested) => {
      if (requested) {
        ctx.ensureLocation(requested)
        return [requested]
      }
      return allLoc ? null : [...locs].sort()
    },
    audit: (u, action, o = {}) => {
      u.add('audit_logs', {
        ts: u.at,
        actor_id: fb.uid,
        actor_name: user.full_name,
        action,
        entity_type: o.entity_type ?? null,
        entity_id: o.entity_id ?? null,
        location_id: o.location_id ?? null,
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 300) : null,
        details: JSON.parse(JSON.stringify(o.details ?? {})),
      })
    },
  }
  return ctx
}
