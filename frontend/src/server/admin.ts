/** Sign-in, first-run setup, organisation, locations, policy, roles, users and the audit log. */
import {
  EmailAuthProvider, confirmPasswordReset, createUserWithEmailAndPassword, reauthenticateWithCredential, sendPasswordResetEmail,
  signInWithEmailAndPassword, signOut, updatePassword,
} from 'firebase/auth'
import { limit, orderBy, where } from 'firebase/firestore'
import { auth, withSecondaryAuth } from './firebase'
import { clearProfile, loadCtx, resetAuthWait, watchProfile, type Ctx } from './ctx'
import { Conflict, Forbidden, NotFound, Unauthorized, ValidationFailed, clean, fieldError, isoRange, lc, matches, newId, paginate, passwordProblems } from './core'
import { DEFAULT_EXPENSE_ACCOUNTS, STATE_CODES, SYSTEM_ACCOUNTS, validGstin } from './ledger'
import { DEFAULT_POLICY, PERMISSIONS, ROLE_TEMPLATES } from './permissions'
import { getOrg, getPolicy } from './settings'
import { publicRoute, route } from './router'
import { all, byId, findScoped, getOne, resetLive, tx, type Row } from './store'

const TAX_CLASSES: [string, string, string, boolean][] = [['GST0', 'Nil-rated / Exempt (0%)', '0', true], ['GST5', 'GST 5%', '5', false], ['GST12', 'GST 12%', '12', false], ['GST18', 'GST 18%', '18', false], ['GST28', 'GST 28%', '28', false]]
const PAYMENT_METHODS: [string, string, string, string, boolean][] = [
  ['CASH', 'Cash', 'CASH', 'CASH', false], ['UPI', 'UPI', 'UPI', 'UPI_CLEARING', true], ['CARD', 'Card', 'CARD', 'CARD_CLEARING', true], ['BANK', 'Bank Transfer', 'BANK_TRANSFER', 'BANK', true],
  ['STORE_CREDIT', 'Store Credit', 'STORE_CREDIT', 'STORE_CREDIT', false], ['CREDIT', 'Credit (Pay Later)', 'CREDIT', 'AR', false], ['EXCHANGE', 'Exchange Credit', 'EXCHANGE', 'EXCHANGE_CLEARING', false],
]
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/


async function buildMe(ctx: Ctx) {
  const locs = (await all('locations')).filter((l) => l.is_active && (ctx.all_locations || ctx.location_ids.includes(l.id)))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'WAREHOUSE' ? -1 : 1))
  const org = await getOrg()
  return {
    id: ctx.uid, email: ctx.user.email, full_name: ctx.user.full_name, role_code: ctx.user.role_code, role_name: ctx.user.role_name,
    permissions: [...ctx.perms].sort(), all_locations: ctx.all_locations,
    locations: locs.map((l) => ({ id: l.id, code: l.code, name: l.name, type: l.type, state_code: l.state_code })),
    must_change_password: !!ctx.user.must_change_password, organization_name: org ? org.trade_name || org.legal_name : null, csrf_token: null,
  }
}

// ---------------------------------------------------------------- auth
publicRoute('POST', '/auth/login', async ({ body }) => {
  const email = lc(clean(body.email))
  if (!EMAIL_RE.test(email)) throw fieldError('email', 'value is not a valid email address')
  const a = auth()
  const cred = await signInWithEmailAndPassword(a, email, String(body.password ?? ''))
  const profile = await watchProfile(cred.user.uid)
  if (!profile || !profile.is_active || profile.can_login === false) {
    await signOut(a)
    clearProfile()
    throw Unauthorized('Invalid email or password', { code: 'invalid_credentials' })
  }
  const ctx = await loadCtx({ allowPendingPassword: true })
  await tx(async (u) => {
    await u.update(`users/${ctx.uid}`, { last_login_at: u.at })
    ctx.audit(u, 'auth.login', { entity_type: 'user', entity_id: ctx.uid })
  })
  return buildMe(ctx)
})

publicRoute('POST', '/auth/logout', async () => {
  try {
    const ctx = await loadCtx({ allowPendingPassword: true })
    await tx(async (u) => ctx.audit(u, 'auth.logout', { entity_type: 'user', entity_id: ctx.uid }))
  } catch { /* already signed out */ }
  await signOut(auth())
  clearProfile()
  resetLive()
  resetAuthWait()
  return { message: 'Signed out' }
})

route('GET', '/auth/me', async (_r, ctx) => buildMe(ctx), { pending: true })

route('POST', '/auth/change-password', async ({ body }, ctx) => {
  const cur = String(body.current_password ?? ''), next = String(body.new_password ?? '')
  if (cur === next) throw ValidationFailed('New password must differ from the current password')
  const problems = passwordProblems(next, ctx.user.email)
  if (problems.length) throw ValidationFailed('Password does not meet requirements', { details: problems })
  const fb = auth().currentUser!
  try {
    await reauthenticateWithCredential(fb, EmailAuthProvider.credential(fb.email!, cur))
  } catch {
    throw ValidationFailed('Current password is incorrect', { code: 'invalid_password' })
  }
  await updatePassword(fb, next)
  await tx(async (u) => {
    await u.update(`users/${ctx.uid}`, { must_change_password: false, password_changed_at: u.at })
    ctx.audit(u, 'auth.password_changed', { entity_type: 'user', entity_id: ctx.uid })
  })
  return { message: 'Password updated' }
}, { pending: true })

publicRoute('POST', '/auth/password-reset/request', async ({ body }) => {
  const email = lc(clean(body.email))
  if (!EMAIL_RE.test(email)) throw fieldError('email', 'value is not a valid email address')
  try {
    await sendPasswordResetEmail(auth(), email)
  } catch { /* same response whether or not the account exists */ }
  return { message: 'If the account exists, a reset link has been sent.', email_configured: true }
})

publicRoute('POST', '/auth/password-reset/confirm', async ({ body }) => {
  const problems = passwordProblems(String(body.new_password ?? ''))
  if (problems.length) throw ValidationFailed('Password does not meet requirements', { details: problems })
  try {
    await confirmPasswordReset(auth(), String(body.token ?? ''), String(body.new_password))
  } catch {
    throw ValidationFailed('Reset link is invalid or has expired', { code: 'invalid_token' })
  }
  return { message: 'Password has been reset. You can now sign in.' }
})

// Firebase Auth manages sessions; only the current device is shown.
route('GET', '/auth/sessions', async () => [{ id: 'current', created_at: auth().currentUser?.metadata.lastSignInTime ? new Date(auth().currentUser!.metadata.lastSignInTime!).toISOString() : null, last_seen_at: new Date().toISOString(), expires_at: null, ip: null, user_agent: navigator.userAgent, current: true }])
route('POST', '/auth/sessions/:id/revoke', async () => { throw NotFound('Session not found') })

// ---------------------------------------------------------------- first-run setup
const statesList = () => Object.entries(STATE_CODES).sort().map(([code, name]) => ({ code, name }))

publicRoute('GET', '/setup/status', async () => {
  const done = await getOne('meta/setup')
  return { needs_setup: !done, setup_token_required: false, states: statesList() }
})

publicRoute('POST', '/setup', async ({ body }) => {
  const email = lc(clean(body.admin_email))
  const name = clean(body.admin_name) ?? ''
  const org = clean(body.organization_name) ?? ''
  const state = String(body.state_code ?? '')
  const gstin = clean(body.gstin)?.toUpperCase() ?? null
  if (org.length < 2) throw fieldError('organization_name', 'String should have at least 2 characters')
  if (name.length < 2) throw fieldError('admin_name', 'String should have at least 2 characters')
  if (!EMAIL_RE.test(email)) throw fieldError('admin_email', 'value is not a valid email address')
  if (!(state in STATE_CODES)) throw ValidationFailed('Unknown state code')
  if (gstin && !validGstin(gstin)) throw fieldError('gstin', 'Invalid GSTIN (format or checksum)')
  const problems = passwordProblems(String(body.admin_password ?? ''), email)
  if (problems.length) throw ValidationFailed('Password does not meet requirements', { details: problems })
  if (await getOne('meta/setup')) throw Conflict('Setup has already been completed')

  const a = auth()
  let uid: string
  try {
    uid = (await createUserWithEmailAndPassword(a, email, String(body.admin_password))).user.uid
  } catch (e) {
    if ((e as { code?: string }).code === 'auth/email-already-in-use') uid = (await signInWithEmailAndPassword(a, email, String(body.admin_password))).user.uid
    else throw e
  }
  try {
    await tx(async (u) => {
      if (await u.get('meta/setup')) throw Conflict('Setup has already been completed')
      u.set('meta/setup', { owner_uid: uid, completed_at: u.at })
      u.set('organization/main', { legal_name: org, trade_name: org, gstin, gst_registration_type: gstin ? 'REGULAR' : 'UNREGISTERED', pan: null, address_line1: null, address_line2: null,
        city: null, state: STATE_CODES[state], state_code: state, pincode: null, phone: null, email: null, financial_year_start_month: 4, timezone: 'Asia/Kolkata', currency: 'INR', created_at: u.at })
      for (const [code, tpl] of Object.entries(ROLE_TEMPLATES)) u.set(`roles/${code}`, { code, name: tpl.name, description: tpl.description, is_system: true, permissions: [...tpl.permissions].sort(), created_at: u.at })
      u.set(`users/${uid}`, { email, full_name: name, phone: null, employee_code: null, designation: 'Owner', joined_on: null, role_id: 'OWNER', role_code: 'OWNER', role_name: ROLE_TEMPLATES.OWNER.name,
        perms: [...ROLE_TEMPLATES.OWNER.permissions].sort(), all_locations: true, location_ids: [], is_active: true, can_login: true, must_change_password: false, last_login_at: null, created_at: u.at })
      const accId: Record<string, string> = {}
      for (const [key, code, nm, type, cash] of SYSTEM_ACCOUNTS) {
        accId[key] = `A${code}`
        u.set(`accounts/A${code}`, { code, name: nm, type, system_key: key, is_cash_or_bank: cash, is_active: true, parent_id: null, created_at: u.at })
      }
      DEFAULT_EXPENSE_ACCOUNTS.forEach(([code, nm, label]) => {
        u.set(`accounts/A${code}`, { code, name: nm, type: 'EXPENSE', system_key: null, is_cash_or_bank: false, is_active: true, parent_id: null, created_at: u.at })
        u.set(`expense_categories/E${code}`, { name: label, account_id: `A${code}`, is_active: true })
      })
      PAYMENT_METHODS.forEach(([code, nm, kind, acc, ref], i) => u.set(`payment_methods/${code}`, { code, name: nm, kind, account_id: accId[acc], requires_reference: ref, sort_order: i, is_active: kind !== 'CREDIT' }))
      for (const [code, nm, rate, exempt] of TAX_CLASSES) u.set(`tax_classes/${code}`, { code, name: nm, rate, is_exempt: exempt, is_active: true, created_at: u.at })
      u.set('settings/policy', { value: DEFAULT_POLICY, updated_by: uid, updated_at: u.at })
      u.add('audit_logs', { ts: u.at, actor_id: uid, actor_name: name, action: 'setup.completed', entity_type: 'user', entity_id: uid, location_id: null, details: {} })
    })
  } finally {
    await signOut(a)
    clearProfile()
    resetLive()
    resetAuthWait()
  }
  return { message: 'Setup complete. Sign in with the administrator account.' }
})

// ---------------------------------------------------------------- locations
const LOC_FIELDS = ['code', 'name', 'type', 'address_line1', 'address_line2', 'city', 'state', 'state_code', 'pincode', 'phone', 'email', 'gstin', 'invoice_prefix', 'is_active'] as const
function locationIn(b: Record<string, unknown>) {
  const v: Record<string, unknown> = {}
  for (const k of LOC_FIELDS) v[k] = typeof b[k] === 'string' ? clean(b[k]) : b[k]
  v.is_active = b.is_active === undefined ? true : !!b.is_active
  if (!/^[A-Z0-9-]{2,20}$/.test(String(v.code ?? ''))) throw fieldError('code', 'String should match pattern ^[A-Z0-9-]+$')
  if (String(v.name ?? '').length < 2) throw fieldError('name', 'String should have at least 2 characters')
  if (!['WAREHOUSE', 'OUTLET'].includes(String(v.type))) throw fieldError('type', 'Invalid location type')
  if (!/^\d{2}$/.test(String(v.state_code ?? ''))) throw fieldError('state_code', 'String should match pattern ^\\d{2}$')
  if (!/^[A-Z0-9]{1,4}$/.test(String(v.invoice_prefix ?? ''))) throw fieldError('invoice_prefix', 'String should match pattern ^[A-Z0-9]+$')
  if (v.email && !EMAIL_RE.test(String(v.email))) throw fieldError('email', 'value is not a valid email address')
  if (v.gstin) {
    v.gstin = String(v.gstin).toUpperCase()
    if (!validGstin(String(v.gstin))) throw fieldError('gstin', 'Invalid GSTIN (format or checksum)')
  }
  if (!(String(v.state_code) in STATE_CODES)) throw ValidationFailed('Unknown state code')
  if (v.gstin && String(v.gstin).slice(0, 2) !== v.state_code) throw ValidationFailed('GSTIN state code does not match the location state')
  return v
}
const sortLocs = (xs: Row[]) => xs.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'WAREHOUSE' ? -1 : 1))

route('GET', '/locations', async ({ query }, ctx) => {
  ctx.requireAny('dashboard.view', 'pos.sell', 'inventory.view', 'locations.manage')
  return sortLocs((await all('locations')).filter((l) => ctx.canAccess(l.id) && (query.include_inactive === 'true' || l.is_active)))
})
route('GET', '/locations/directory', async (_r, ctx) => {
  ctx.requireAny('transfers.create', 'transfers.view', 'locations.manage')
  return sortLocs((await all('locations')).filter((l) => l.is_active))
})
route('POST', '/locations', async ({ body }, ctx) => {
  ctx.require('locations.manage')
  const v = locationIn(body)
  if (!ctx.all_locations) throw Forbidden('Only organisation-wide administrators can create locations')
  if ((await all('locations')).some((l) => l.code === v.code)) throw Conflict('A location with this code already exists')
  return tx(async (u) => {
    const id = u.add('locations', v)
    if (v.type === 'OUTLET') u.add('registers', { location_id: id, name: 'Counter 1', is_active: true })
    ctx.audit(u, 'location.created', { entity_type: 'location', entity_id: id, location_id: id, details: v })
    return { ...v, id, created_at: u.at }
  })
})
route('PUT', '/locations/:id', async ({ params, body }, ctx) => {
  ctx.require('locations.manage')
  const loc = await byId('locations', params.id)
  if (!loc) throw NotFound('Location not found')
  ctx.ensureLocation(params.id)
  const v = locationIn(body)
  if (v.type !== loc.type) throw ValidationFailed('Location type cannot be changed after creation')
  if ((await all('locations')).some((l) => l.code === v.code && l.id !== loc.id)) throw Conflict('A location with this code already exists')
  return tx(async (u) => {
    await u.update(`locations/${loc.id}`, v)
    ctx.audit(u, 'location.updated', { entity_type: 'location', entity_id: loc.id, location_id: loc.id, details: { before: loc, after: v } })
    return { ...loc, ...v }
  })
})

// ---------------------------------------------------------------- organisation & policy
route('GET', '/organization', async (_r, ctx) => {
  ctx.requireAny('settings.manage', 'dashboard.view', 'pos.sell')
  const org = await getOrg()
  if (!org) throw NotFound('Organisation not configured')
  return org
})
route('PUT', '/organization', async ({ body }, ctx) => {
  ctx.require('settings.manage')
  const org = await getOrg()
  const v: Record<string, unknown> = {}
  for (const k of ['legal_name', 'trade_name', 'gstin', 'gst_registration_type', 'pan', 'address_line1', 'address_line2', 'city', 'state', 'state_code', 'pincode', 'phone', 'email', 'timezone']) v[k] = clean(body[k])
  v.financial_year_start_month = Number(body.financial_year_start_month)
  v.timezone = v.timezone ?? 'Asia/Kolkata'
  if (String(v.legal_name ?? '').length < 2) throw fieldError('legal_name', 'String should have at least 2 characters')
  if (!['REGULAR', 'COMPOSITION', 'UNREGISTERED'].includes(String(v.gst_registration_type))) throw fieldError('gst_registration_type', 'Invalid registration type')
  if (v.pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(String(v.pan))) throw fieldError('pan', 'String should match pattern ^[A-Z]{5}\\d{4}[A-Z]$')
  if (!/^\d{2}$/.test(String(v.state_code ?? ''))) throw fieldError('state_code', 'String should match pattern ^\\d{2}$')
  if (!(Number(v.financial_year_start_month) >= 1 && Number(v.financial_year_start_month) <= 12)) throw fieldError('financial_year_start_month', 'Input should be between 1 and 12')
  if (v.gstin) {
    v.gstin = String(v.gstin).toUpperCase()
    if (!validGstin(String(v.gstin))) throw fieldError('gstin', 'Invalid GSTIN (format or checksum)')
  }
  if (v.gst_registration_type === 'REGULAR' && !v.gstin) throw ValidationFailed('A GSTIN is required for regular GST registration')
  if (v.gstin && String(v.gstin).slice(0, 2) !== v.state_code) throw ValidationFailed('GSTIN state code does not match the organisation state')
  try { new Intl.DateTimeFormat('en', { timeZone: String(v.timezone) }) } catch { throw ValidationFailed('Unknown timezone') }
  return tx(async (u) => {
    await u.update('organization/main', v)
    ctx.audit(u, 'organization.updated', { entity_type: 'organization', entity_id: 'main', details: v })
    return { ...org, ...v, id: 'main', currency: 'INR' }
  })
})
route('GET', '/settings/policy', async (_r, ctx) => {
  ctx.requireAny('settings.manage', 'pos.sell', 'dashboard.view')
  return getPolicy()
})
route('PUT', '/settings/policy', async ({ body }, ctx) => {
  ctx.require('settings.manage')
  const before = await getPolicy()
  const next: Record<string, unknown> = { ...DEFAULT_POLICY }
  for (const [k, dflt] of Object.entries(DEFAULT_POLICY)) {
    const v = body[k] ?? (before as Record<string, unknown>)[k]
    next[k] = typeof dflt === 'boolean' ? !!v : typeof dflt === 'number' ? Number(v) : String(v)
  }
  for (const k of ['max_discount_pct', 'po_approval_threshold', 'refund_approval_threshold', 'expense_approval_threshold', 'adjustment_approval_threshold', 'loyalty_points_per_100', 'loyalty_point_value', 'register_variance_alert']) {
    if (!(Number(next[k]) >= 0)) throw fieldError(k, 'Input should be greater than or equal to 0')
  }
  if (Number(next.max_discount_pct) > 100) throw fieldError('max_discount_pct', 'Input should be less than or equal to 100')
  if (!/^2\d{2}$/.test(String(next.barcode_prefix))) throw fieldError('barcode_prefix', 'String should match pattern ^2\\d{2}$')
  if (!/^[A-Z]{1,5}$/.test(String(next.sku_prefix))) throw fieldError('sku_prefix', 'String should match pattern ^[A-Z]{1,5}$')
  if (!/^[A-Z]{1,4}$/.test(String(next.copy_code_prefix))) throw fieldError('copy_code_prefix', 'String should match pattern ^[A-Z]{1,4}$')
  if (!(Number(next.return_window_days) >= 0 && Number(next.return_window_days) <= 365)) throw fieldError('return_window_days', 'Input should be between 0 and 365')
  if (Number(next.dead_stock_days) < 30) throw fieldError('dead_stock_days', 'Input should be greater than or equal to 30')
  if (Number(next.slow_moving_days) < 7) throw fieldError('slow_moving_days', 'Input should be greater than or equal to 7')
  if (Number(next.excess_stock_multiplier) < 2) throw fieldError('excess_stock_multiplier', 'Input should be greater than or equal to 2')
  return tx(async (u) => {
    u.set('settings/policy', { value: next, updated_by: ctx.uid, updated_at: u.at })
    ctx.audit(u, 'settings.policy_updated', { entity_type: 'settings', entity_id: 'policy', details: { before, after: next } })
    return next
  })
})
route('GET', '/settings/integrations', async (_r, ctx) => {
  ctx.require('settings.manage')
  return { email: { configured: false, provider: null }, whatsapp: { configured: false, provider: null }, payment_gateway: { configured: false, provider: null } }
})
route('GET', '/reference/states', async (_r, ctx) => {
  ctx.requireAny('dashboard.view', 'pos.sell', 'catalog.view')
  return statesList()
})

// ---------------------------------------------------------------- roles & permissions
route('GET', '/permissions', async (_r, ctx) => {
  ctx.requireAny('roles.manage', 'users.view')
  return Object.entries(PERMISSIONS).map(([code, [module, description]]) => ({ code, module, description })).sort((a, b) => (a.module === b.module ? a.code.localeCompare(b.code) : a.module.localeCompare(b.module)))
})
async function roleOut(r: Row, users?: Row[]) {
  const us = users ?? (await all('users').catch(() => [] as Row[]))
  return { id: r.id, code: r.code, name: r.name, description: r.description ?? null, is_system: !!r.is_system, permissions: [...(r.permissions ?? [])].sort(), user_count: us.filter((x) => x.role_id === r.id).length }
}
route('GET', '/roles', async (_r, ctx) => {
  ctx.requireAny('roles.manage', 'users.view')
  const users = await all('users').catch(() => [] as Row[])
  const roles = (await all('roles')).sort((a, b) => (a.is_system === b.is_system ? a.name.localeCompare(b.name) : a.is_system ? -1 : 1))
  return Promise.all(roles.map((r) => roleOut(r, users)))
})
function validatePerms(ctx: Ctx, perms: unknown): string[] {
  const list = Array.isArray(perms) ? (perms as string[]) : []
  const unknown = list.filter((p) => !(p in PERMISSIONS))
  if (unknown.length) throw ValidationFailed(`Unknown permissions: ${unknown.sort().join(', ')}`)
  const esc = list.filter((p) => !ctx.perms.has(p))
  if (esc.length) throw Forbidden('You cannot grant permissions you do not hold', { details: esc.sort() })
  return [...new Set(list)].sort()
}
function roleIn(b: Record<string, unknown>) {
  const code = String(b.code ?? ''), name = String(b.name ?? '')
  if (!/^[A-Z0-9_]{2,40}$/.test(code)) throw fieldError('code', 'String should match pattern ^[A-Z0-9_]+$')
  if (name.length < 2) throw fieldError('name', 'String should have at least 2 characters')
  return { code, name, description: clean(b.description) }
}
route('POST', '/roles', async ({ body }, ctx) => {
  ctx.require('roles.manage')
  const v = roleIn(body)
  const perms = validatePerms(ctx, body.permissions)
  if ((await all('roles')).some((r) => r.code === v.code)) throw Conflict('Role code already exists')
  return tx(async (u) => {
    const id = u.add('roles', { ...v, is_system: false, permissions: perms })
    ctx.audit(u, 'role.created', { entity_type: 'role', entity_id: id, details: { code: v.code, permissions: perms } })
    return { id, ...v, is_system: false, permissions: perms, user_count: 0 }
  })
})
route('PUT', '/roles/:id', async ({ params, body }, ctx) => {
  ctx.require('roles.manage')
  const role = await byId('roles', params.id)
  if (!role) throw NotFound('Role not found')
  if (role.code === 'OWNER') throw Forbidden('The owner role always has every permission and cannot be edited')
  if (ctx.user.role_id === role.id) throw Forbidden('You cannot edit your own role')
  const v = roleIn(body)
  const perms = validatePerms(ctx, body.permissions)
  const users = (await all('users')).filter((x) => x.role_id === role.id)
  return tx(async (u) => {
    await u.update(`roles/${role.id}`, { name: v.name, description: v.description, code: role.is_system ? role.code : v.code, permissions: perms })
    for (const usr of users) await u.update(`users/${usr.id}`, { perms, role_name: v.name, role_code: role.is_system ? role.code : v.code })
    ctx.audit(u, 'role.updated', { entity_type: 'role', entity_id: role.id, details: { before: role.permissions, after: perms } })
    return { id: role.id, code: role.is_system ? role.code : v.code, name: v.name, description: v.description, is_system: !!role.is_system, permissions: perms, user_count: users.length }
  })
})
route('DELETE', '/roles/:id', async ({ params }, ctx) => {
  ctx.require('roles.manage')
  const role = await byId('roles', params.id)
  if (!role) throw NotFound('Role not found')
  if (role.is_system) throw Forbidden('System roles cannot be deleted')
  if ((await all('users')).some((x) => x.role_id === role.id)) throw Conflict('Role is assigned to users; reassign them first')
  await tx(async (u) => {
    u.delete(`roles/${role.id}`)
    ctx.audit(u, 'role.deleted', { entity_type: 'role', entity_id: role.id, details: { code: role.code } })
  })
  return undefined
})

// ---------------------------------------------------------------- users
function userOut(x: Row) {
  return {
    id: x.id, email: x.email, full_name: x.full_name, phone: x.phone ?? null, employee_code: x.employee_code ?? null, designation: x.designation ?? null, joined_on: x.joined_on ?? null,
    role_id: x.role_id, role_name: x.role_name, role_code: x.role_code, all_locations: !!x.all_locations, location_ids: [...(x.location_ids ?? [])].sort(), is_active: !!x.is_active,
    can_login: x.can_login !== false, must_change_password: !!x.must_change_password, last_login_at: x.last_login_at ?? null, locked: false, created_at: x.created_at,
  }
}
const visible = (ctx: Ctx, x: Row) => ctx.all_locations || (!x.all_locations && (x.location_ids ?? []).some((l: string) => ctx.location_ids.includes(l)))

async function guardAssignment(ctx: Ctx, b: Record<string, unknown>) {
  const role = await byId('roles', String(b.role_id ?? ''))
  if (!role) throw ValidationFailed('Role not found')
  if (!(role.permissions as string[]).every((p) => ctx.perms.has(p))) throw Forbidden('You cannot assign a role with more permissions than your own')
  const allLoc = !!b.all_locations
  const locIds = (Array.isArray(b.location_ids) ? b.location_ids : []) as string[]
  if (allLoc && !ctx.all_locations) throw Forbidden('You cannot grant organisation-wide location access')
  const known = new Set((await all('locations')).map((l) => l.id))
  for (const lid of locIds) {
    ctx.ensureLocation(lid)
    if (!known.has(lid)) throw ValidationFailed('Unknown location')
  }
  if (!allLoc && !locIds.length) throw ValidationFailed('Assign at least one location or organisation-wide access')
  return role
}
function userIn(b: Record<string, unknown>) {
  const email = lc(clean(b.email))
  if (!EMAIL_RE.test(email)) throw fieldError('email', 'value is not a valid email address')
  const full_name = clean(b.full_name) ?? ''
  if (full_name.length < 2) throw fieldError('full_name', 'String should have at least 2 characters')
  return {
    email, full_name, phone: clean(b.phone), employee_code: clean(b.employee_code), designation: clean(b.designation), joined_on: clean(b.joined_on),
    all_locations: !!b.all_locations, location_ids: b.all_locations ? [] : [...new Set((b.location_ids ?? []) as string[])], is_active: b.is_active === undefined ? true : !!b.is_active,
  }
}

route('GET', '/users', async ({ query }, ctx) => {
  ctx.require('users.view')
  if (query.location_id) ctx.ensureLocation(query.location_id)
  const rows = (await all('users')).filter((x) => visible(ctx, x) && matches(query.q, x.full_name, x.email, x.employee_code)
    && (!query.role_id || x.role_id === query.role_id)
    && (!query.location_id || x.all_locations || (x.location_ids ?? []).includes(query.location_id))
    && (query.active === undefined || String(!!x.is_active) === query.active))
    .sort((a, b) => a.full_name.localeCompare(b.full_name))
  return paginate(rows.map(userOut), Number(query.page), Number(query.page_size))
})
route('GET', '/users/:id', async ({ params }, ctx) => {
  ctx.require('users.view')
  const x = await byId('users', params.id)
  if (!x || !visible(ctx, x)) throw NotFound('User not found')
  return userOut(x)
})
route('POST', '/users', async ({ body }, ctx) => {
  ctx.require('users.manage')
  const role = await guardAssignment(ctx, body)
  const v = userIn(body)
  if ((await all('users')).some((x) => lc(x.email) === v.email)) throw Conflict('A user with this email already exists')
  const canLogin = body.can_login !== false
  let id = newId()
  if (canLogin) {
    const pw = String(body.initial_password ?? '')
    if (!pw) throw ValidationFailed('An initial password is required for users who can sign in')
    const problems = passwordProblems(pw, v.email)
    if (problems.length) throw ValidationFailed('Password does not meet requirements', { details: problems })
    id = await withSecondaryAuth(async (a) => (await createUserWithEmailAndPassword(a, v.email, pw)).user.uid)
  }
  return tx(async (u) => {
    const doc = { ...v, role_id: role.id, role_code: role.code, role_name: role.name, perms: [...role.permissions].sort(), can_login: canLogin, must_change_password: canLogin, last_login_at: null, created_at: u.at }
    u.set(`users/${id}`, doc)
    ctx.audit(u, 'user.created', { entity_type: 'user', entity_id: id, details: { email: v.email, role: role.code, locations: v.location_ids, all_locations: v.all_locations } })
    return userOut({ ...doc, id })
  })
})
route('PUT', '/users/:id', async ({ params, body }, ctx) => {
  ctx.require('users.manage')
  const x = await byId('users', params.id)
  if (!x || !visible(ctx, x)) throw NotFound('User not found')
  const v = userIn(body)
  if (x.id === ctx.uid && (body.role_id !== x.role_id || !v.is_active || v.all_locations !== !!x.all_locations)) throw Forbidden('You cannot change your own role, scope or active status')
  if (!(x.perms as string[]).every((p) => ctx.perms.has(p))) throw Forbidden('You cannot modify a user with more permissions than your own')
  const role = await guardAssignment(ctx, body)
  const loginAccount = x.can_login !== false
  if (v.email !== lc(x.email)) {
    if (loginAccount) throw ValidationFailed('The email of a sign-in account cannot be changed. Create a new user for the new email.')
    if ((await all('users')).some((o) => lc(o.email) === v.email)) throw Conflict('A user with this email already exists')
  }
  if (body.can_login !== false && !loginAccount) throw ValidationFailed('Sign-in can only be set up when the user is created. Create a new user with sign-in enabled.')
  return tx(async (u) => {
    const patch = { ...v, role_id: role.id, role_code: role.code, role_name: role.name, perms: [...role.permissions].sort(), can_login: loginAccount && body.can_login !== false }
    await u.update(`users/${x.id}`, patch)
    ctx.audit(u, 'user.updated', { entity_type: 'user', entity_id: x.id, details: { before: userOut(x), after: patch } })
    return userOut({ ...x, ...patch })
  })
})
route('POST', '/users/:id/reset-password', async ({ params }, ctx) => {
  ctx.require('users.manage')
  const x = await byId('users', params.id)
  if (!x || !visible(ctx, x)) throw NotFound('User not found')
  if (!(x.perms as string[]).every((p) => ctx.perms.has(p))) throw Forbidden('You cannot reset the password of a user with more permissions than your own')
  await sendPasswordResetEmail(auth(), x.email)
  await tx(async (u) => ctx.audit(u, 'user.password_reset_issued', { entity_type: 'user', entity_id: x.id }))
  return { reset_url: null, message: `A password reset email was sent to ${x.email}.`, expires_in_hours: 1 }
})
route('POST', '/users/:id/revoke-sessions', async () => { throw ValidationFailed('Deactivate the user instead: deactivated users are signed out on their next action.') })
route('POST', '/users/:id/unlock', async () => ({ message: 'Account unlocked' }))

// ---------------------------------------------------------------- audit log
route('GET', '/audit-logs', async ({ query }, ctx) => {
  ctx.require('audit.view')
  if (query.location_id) ctx.ensureLocation(query.location_id)
  const cs = []
  if (query.date_from || query.date_to) {
    const [a, b] = isoRange(query.date_from ?? '2000-01-01', query.date_to ?? '2999-12-31')
    cs.push(where('ts', '>=', a), where('ts', '<', b))
  }
  const rows = (await findScoped('audit_logs', query.location_id ? [query.location_id] : ctx.scope(), 'location_id', ...cs, orderBy('ts', 'desc'), limit(2000)))
    .filter((r) => (!query.action || String(r.action).startsWith(query.action)) && (!query.actor_id || r.actor_id === query.actor_id)
      && (!query.entity_type || r.entity_type === query.entity_type) && (!query.entity_id || r.entity_id === query.entity_id))
  return paginate(rows.map((r) => ({ ...r, ip: null, request_id: null })), Number(query.page), Number(query.page_size))
})

