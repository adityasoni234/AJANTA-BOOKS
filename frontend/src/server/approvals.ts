/** Approval center. Domain modules register what happens when a request is approved or rejected. */
import { limit, orderBy, where } from 'firebase/firestore'
import type { Ctx } from './ctx'
import { Conflict, Forbidden, NotFound, paginate, s2n, type Num } from './core'
import { route } from './router'
import { all, find, findScoped, type Row, type Uow } from './store'

export const APPROVER_PERMISSION: Record<string, string> = {
  PURCHASE_ORDER: 'purchasing.approve', STOCK_ADJUSTMENT: 'inventory.approve', TRANSFER: 'transfers.approve', DISCOUNT: 'pos.discount_override',
  REFUND: 'returns.approve', EXPENSE: 'expenses.approve', VOID: 'pos.void',
}
const LINKS: Record<string, string> = {
  PURCHASE_ORDER: '/purchasing/orders/{id}', STOCK_ADJUSTMENT: '/inventory/adjustments', TRANSFER: '/transfers/{id}', DISCOUNT: '/approvals',
  REFUND: '/returns/{id}', EXPENSE: '/finance/expenses', VOID: '/sales/{id}',
}
type Handler = (u: Uow, ctx: Ctx, req: Row) => Promise<void>
const handlers = new Map<string, [Handler | null, Handler | null]>()
export function registerApproval(type: string, onApprove: Handler | null, onReject: Handler | null = null) {
  handlers.set(type, [onApprove, onReject])
}

export function createApproval(u: Uow, ctx: Ctx, o: { type: string; location_id: string | null; title: string; entity_type?: string | null; entity_id?: string | null; amount?: Num; payload?: Record<string, unknown>; reason?: string | null }): string {
  const id = u.add('approvals', {
    type: o.type, status: 'PENDING', location_id: o.location_id, entity_type: o.entity_type ?? null, entity_id: o.entity_id ?? null, title: o.title.slice(0, 200),
    amount: s2n(o.amount), payload: o.payload ?? {}, reason: o.reason ?? null, requested_by: ctx.uid, requested_by_name: ctx.name, requested_at: u.at,
    decided_by: null, decided_by_name: null, decided_at: null, decision_note: null,
  })
  ctx.audit(u, 'approval.requested', { entity_type: 'approval_request', entity_id: id, location_id: o.location_id, details: { type: o.type, title: o.title, amount: s2n(o.amount), link: (LINKS[o.type] ?? '/approvals').replace('{id}', o.entity_id ?? id) } })
  return id
}

export async function pendingFor(entityType: string, entityId: string): Promise<Row | null> {
  const rows = await find('approvals', where('entity_id', '==', entityId), where('status', '==', 'PENDING'))
  return rows.find((r) => r.entity_type === entityType) ?? null
}
export async function cancelPending(u: Uow, entityType: string, entityId: string) {
  const req = await pendingFor(entityType, entityId)
  if (req) await u.update(`approvals/${req.id}`, { status: 'CANCELLED', decided_at: u.at })
}

export async function decide(u: Uow, ctx: Ctx, id: string, approve: boolean, note: string | null): Promise<Row> {
  const req = await u.get(`approvals/${id}`)
  if (!req) throw NotFound('Approval request not found')
  ctx.ensureResource(req.location_id)
  const perm = APPROVER_PERMISSION[req.type]
  if (!ctx.has(perm)) throw Forbidden(`Missing permission: ${perm}`, { code: 'permission_denied' })
  if (req.status !== 'PENDING') throw Conflict(`Request is already ${String(req.status).toLowerCase()}`)
  if (req.requested_by === ctx.uid) throw Forbidden('You cannot approve or reject your own request', { code: 'self_approval' })
  const patch = { status: approve ? 'APPROVED' : 'REJECTED', decided_by: ctx.uid, decided_by_name: ctx.name, decided_at: u.at, decision_note: note }
  await u.update(`approvals/${id}`, patch)
  const [onA, onR] = handlers.get(req.type) ?? [null, null]
  const h = approve ? onA : onR
  if (h) await h(u, ctx, { ...req, ...patch })
  ctx.audit(u, `approval.${approve ? 'approved' : 'rejected'}`, { entity_type: 'approval_request', entity_id: id, location_id: req.location_id, details: { type: req.type, note } })
  return { ...req, ...patch }
}

async function visibleApprovals(ctx: Ctx): Promise<Row[]> {
  const rows = ctx.all_locations ? await find('approvals', orderBy('requested_at', 'desc'), limit(1000)) : [
    ...(await findScoped('approvals', ctx.location_ids, 'location_id', orderBy('requested_at', 'desc'), limit(1000))),
    ...(await find('approvals', where('requested_by', '==', ctx.uid), limit(500))),
  ]
  const seen = new Set<string>()
  return rows.filter((r) => !seen.has(r.id) && seen.add(r.id)).sort((a, b) => String(b.requested_at).localeCompare(String(a.requested_at)))
}
const canDecide = (ctx: Ctx, r: Row) => r.status === 'PENDING' && ctx.has(APPROVER_PERMISSION[r.type]) && r.requested_by !== ctx.uid && ctx.canAccess(r.location_id)

route('GET', '/approvals', async ({ query }, ctx) => {
  ctx.require('approvals.view')
  const status = query.status === undefined ? 'PENDING' : query.status
  const locs = new Map((await all('locations')).map((l) => [l.id, l.name]))
  const rows = (await visibleApprovals(ctx)).filter((r) => (!status || r.status === status) && (!query.type || r.type === query.type))
  return paginate(rows.map((r) => ({
    id: r.id, type: r.type, status: r.status, title: r.title, location_id: r.location_id, location_name: locs.get(r.location_id) ?? null, entity_type: r.entity_type, entity_id: r.entity_id,
    amount: r.amount, reason: r.reason, payload: r.payload ?? {}, requested_by: r.requested_by_name, requested_by_id: r.requested_by, requested_at: r.requested_at,
    decided_by: r.decided_by_name, decided_at: r.decided_at, decision_note: r.decision_note, can_decide: canDecide(ctx, r),
  })), Number(query.page), Number(query.page_size))
})

route('POST', '/approvals/:id/decision', async ({ params, body }, ctx) => {
  ctx.require('approvals.view')
  const { tx } = await import('./store')
  const req = await tx((u) => decide(u, ctx, params.id, !!body.approve, (body.note as string) || null))
  return { id: req.id, status: req.status }
})

// Notifications are derived from the approval center: requests waiting for you, and decisions on yours.
route('GET', '/notifications', async ({ query }, ctx) => {
  const readAt = (ctx.user.notif_read_at as string | undefined) ?? ''
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString()
  const rows = ctx.has('approvals.view') ? await visibleApprovals(ctx) : await find('approvals', where('requested_by', '==', ctx.uid), limit(200))
  const items: { id: string; kind: string; title: string; body: unknown; link: string; created_at: string }[] = rows.flatMap((r) => {
    if (canDecide(ctx, r)) return [{ id: `${r.id}:req`, kind: 'APPROVAL_REQUESTED', title: `Approval needed: ${r.title}`, body: r.reason, link: '/approvals', created_at: r.requested_at }]
    if (r.requested_by === ctx.uid && r.decided_at && r.decided_at >= since && ['APPROVED', 'REJECTED'].includes(r.status)) {
      return [{ id: `${r.id}:dec`, kind: 'APPROVAL_DECIDED', title: `${r.status === 'APPROVED' ? 'Approved' : 'Rejected'}: ${r.title}`, body: r.decision_note, link: (LINKS[r.type] ?? '/approvals').replace('{id}', r.entity_id ?? r.id), created_at: r.decided_at }]
    }
    return []
  })
  if (ctx.has('users.manage')) {
    for (const r of await find('signup_requests', where('status', '==', 'PENDING')).catch(() => [] as Row[])) {
      items.push({ id: `${r.id}:signup`, kind: 'SIGNUP_REQUESTED', title: `New sign-up waiting for approval: ${r.full_name}`, body: r.email, link: '/admin/users', created_at: r.created_at })
    }
  }
  const list0 = items.map((n) => ({ ...n, read_at: n.created_at <= readAt ? readAt : null })).sort((a, b) => b.created_at.localeCompare(a.created_at))
  const unread = list0.filter((n) => !n.read_at).length
  const list = query.unread_only === 'true' ? list0.filter((n) => !n.read_at) : list0
  const p = paginate(list, Number(query.page), Number(query.page_size))
  return { ...p, unread }
})
route('POST', '/notifications/read', async (_r, ctx) => {
  const { tx } = await import('./store')
  await tx(async (u) => u.update(`users/${ctx.uid}`, { notif_read_at: u.at }))
  return { message: 'ok' }
})
