import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, KeyRound, Plus, Unlock, UserPlus, X } from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'
import { DataTable } from '@/components/common/DataTable'
import { SearchInput } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { Badge, StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input, NativeSelect } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/misc'
import { api, ApiError, errorMessage, type Page } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useDebounced } from '@/lib/hooks'
import { formatDate } from '@/lib/utils'

interface User { id: string; email: string; full_name: string; phone: string | null; employee_code: string | null; designation: string | null; joined_on: string | null; role_id: string; role_name: string; role_code: string; all_locations: boolean; location_ids: string[]; is_active: boolean; can_login: boolean; must_change_password: boolean; last_login_at: string | null; locked: boolean }
interface Role { id: string; code: string; name: string }

export default function UsersPage() {
  const { can, me } = useAuth()
  const [q, setQ] = React.useState('')
  const [page, setPage] = React.useState(1)
  const [edit, setEdit] = React.useState<User | 'new' | null>(null)
  const [resetUrl, setResetUrl] = React.useState<string | null>(null)
  const qc = useQueryClient()
  const dq = useDebounced(q)
  const list = useQuery({ queryKey: ['users', dq, page], queryFn: () => api.get<Page<User>>('/users', { q: dq, page, page_size: 25 }), placeholderData: keepPreviousData })
  const locs = new Map((me?.locations ?? []).map((l) => [l.id, l.name]))
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'reset-password' | 'revoke-sessions' | 'unlock' }) => api.post<{ reset_url?: string | null; revoked?: number; message?: string }>(`/users/${id}/${action}`),
    onSuccess: (r, v) => {
      if (v.action === 'reset-password') { if (r.reset_url) setResetUrl(r.reset_url); else toast.success(r.message ?? 'Password reset email sent') }
      else toast.success(v.action === 'unlock' ? 'Account unlocked' : `${r.revoked} session(s) revoked`)
      void qc.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <div>
      <PageHeader title="Employees & users" description="Each user has one role and access to specific outlets (or the whole organisation)."
        actions={can('users.manage') && <Button onClick={() => setEdit('new')}><Plus /> Add employee</Button>} />
      {can('users.manage') && <PendingSignups />}
      <Card>
        <div className="border-b border-border p-3"><SearchInput value={q} onChange={setQ} placeholder="Name, email, employee code…" /></div>
        <DataTable rows={list.data?.items} loading={list.isFetching} error={list.error} rowKey={(u) => u.id} page={page} pageSize={25} total={list.data?.total} onPageChange={setPage}
          onRowClick={can('users.manage') ? (u) => setEdit(u) : undefined} empty={{ title: 'No users' }}
          columns={[
            { key: 'n', header: 'Employee', cell: (u) => <><p className="font-medium">{u.full_name}</p><p className="text-xs text-muted">{u.email}{u.employee_code ? ` · ${u.employee_code}` : ''}</p></> },
            { key: 'r', header: 'Role', cell: (u) => u.role_name },
            { key: 'l', header: 'Locations', hideBelow: 'md', cell: (u) => u.all_locations ? <Badge tone="primary">All locations</Badge> : u.location_ids.map((id) => locs.get(id) ?? 'Other').join(', ') },
            { key: 'll', header: 'Last sign-in', hideBelow: 'lg', cell: (u) => u.can_login ? formatDate(u.last_login_at, true) : <span className="text-muted">No login</span> },
            { key: 's', header: 'Status', cell: (u) => <div className="flex flex-wrap gap-1"><StatusBadge status={u.is_active ? 'ACTIVE' : 'ARCHIVED'} label={u.is_active ? 'Active' : 'Inactive'} />{u.locked && <Badge tone="danger">Locked</Badge>}{u.must_change_password && <Badge tone="warning">Must change password</Badge>}</div> },
            ...(can('users.manage') ? [{ key: 'a', header: '', cell: (u: User) => (
              <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                {u.locked && <Button size="icon-sm" variant="ghost" aria-label="Unlock" onClick={() => act.mutate({ id: u.id, action: 'unlock' })}><Unlock /></Button>}
                {u.can_login && <Button size="icon-sm" variant="ghost" aria-label="Email a password reset link" title="Email a password reset link" onClick={() => act.mutate({ id: u.id, action: 'reset-password' })}><KeyRound /></Button>}
              </div>
            ) }] : []),
          ]} />
      </Card>
      {edit && <UserDialog user={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      <Dialog open={!!resetUrl} onOpenChange={(o) => !o && setResetUrl(null)}>
        <DialogContent size="md" title="One-time reset link" description="Share this link privately with the employee. It works once and expires in 24 hours. Their existing sessions were signed out."
          footer={<Button onClick={() => { void navigator.clipboard?.writeText(resetUrl ?? ''); toast.success('Copied') }}>Copy link</Button>}>
          <p className="break-all rounded-md bg-surface p-3 font-mono text-xs">{resetUrl}</p>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function UserDialog({ user, onClose }: { user: User | null; onClose: () => void }) {
  const { me } = useAuth()
  const qc = useQueryClient()
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/roles') })
  const allLocs = useQuery({ queryKey: ['locations-all'], queryFn: () => api.get<{ id: string; name: string }[]>('/locations') })
  const [f, setF] = React.useState({
    email: user?.email ?? '', full_name: user?.full_name ?? '', phone: user?.phone ?? '', employee_code: user?.employee_code ?? '', designation: user?.designation ?? '',
    joined_on: user?.joined_on ?? '', role_id: user?.role_id ?? '', all_locations: user?.all_locations ?? false, location_ids: user?.location_ids ?? [],
    is_active: user?.is_active ?? true, can_login: user?.can_login ?? true, initial_password: '',
  })
  const [errs, setErrs] = React.useState<Record<string, string>>({})
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, phone: f.phone || null, employee_code: f.employee_code || null, designation: f.designation || null, joined_on: f.joined_on || null, initial_password: f.initial_password || null }
      return user ? api.put(`/users/${user.id}`, body) : api.post('/users', body)
    },
    onSuccess: () => { toast.success('Saved. Changes take effect on the user’s next request.'); void qc.invalidateQueries({ queryKey: ['users'] }); onClose() },
    onError: (e) => { if (e instanceof ApiError) setErrs(e.fieldErrors()); toast.error(errorMessage(e)) },
  })
  const self = user?.id === me?.id
  const needsPw = f.can_login && (!user || !user.can_login)
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg" title={user ? `Edit ${user.full_name}` : 'Add employee'}
        footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!f.email || !f.full_name || !f.role_id || (needsPw && !f.initial_password)} loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" required error={errs.full_name}><Input value={f.full_name} onChange={set('full_name')} /></Field>
          <Field label="Email (sign-in)" required error={errs.email}><Input type="email" value={f.email} onChange={set('email')} /></Field>
          <Field label="Phone"><Input value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Employee code"><Input value={f.employee_code} onChange={set('employee_code')} /></Field>
          <Field label="Designation"><Input value={f.designation} onChange={set('designation')} /></Field>
          <Field label="Joined on"><Input type="date" value={f.joined_on} onChange={set('joined_on')} /></Field>
          <Field label="Role" required className="sm:col-span-2" hint={self ? 'You cannot change your own role.' : 'You can only assign roles whose permissions you hold.'}>
            <NativeSelect value={f.role_id} disabled={self} onChange={set('role_id')}><option value="">Choose…</option>{(roles.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</NativeSelect>
          </Field>
          <div className="space-y-2 sm:col-span-2">
            <p className="text-xs font-medium">Location access</p>
            {me?.all_locations && <label className="flex items-center gap-2 text-sm"><Checkbox checked={f.all_locations} disabled={self} onCheckedChange={(v) => setF({ ...f, all_locations: v === true })} /> All locations (organisation-wide)</label>}
            {!f.all_locations && (
              <div className="grid grid-cols-2 gap-2 rounded-md border border-border p-3">
                {(allLocs.data ?? []).map((l) => (
                  <label key={l.id} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={f.location_ids.includes(l.id)} onCheckedChange={(v) => setF({ ...f, location_ids: v ? [...f.location_ids, l.id] : f.location_ids.filter((x) => x !== l.id) })} /> {l.name}
                  </label>
                ))}
              </div>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={f.can_login} onCheckedChange={(v) => setF({ ...f, can_login: v === true })} /> Can sign in</label>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={f.is_active} disabled={self} onCheckedChange={(v) => setF({ ...f, is_active: v === true })} /> Active (deactivating signs them out)</label>
          {needsPw && <Field label="Initial password" required className="sm:col-span-2" error={errs.initial_password} hint="They must change it at first sign-in."><Input type="password" autoComplete="new-password" value={f.initial_password} onChange={set('initial_password')} /></Field>}
        </div>
      </DialogContent>
    </Dialog>
  )
}

interface SignupRequest { id: string; email: string; full_name: string; phone: string | null; note: string | null; created_at: string }

/** Accounts people created on the sign-up page, waiting for the owner to approve (with a role and store) or reject. */
function PendingSignups() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['signup-requests'], queryFn: () => api.get<SignupRequest[]>('/signup-requests') })
  const [approving, setApproving] = React.useState<SignupRequest | null>(null)
  const reject = useMutation({
    mutationFn: (id: string) => api.post(`/signup-requests/${id}/reject`, {}),
    onSuccess: () => { toast.success('Request rejected'); void qc.invalidateQueries({ queryKey: ['signup-requests'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const rows = list.data ?? []
  if (!rows.length) return null
  return (
    <Card className="mb-6 border-amber-200">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <UserPlus className="size-4 text-warning" aria-hidden />
        <p className="font-medium">Sign-ups waiting for approval</p>
        <Badge tone="warning">{rows.length}</Badge>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <div className="min-w-0">
              <p className="font-medium">{r.full_name}</p>
              <p className="text-xs text-muted">{r.email}{r.phone ? ` · ${r.phone}` : ''} · signed up {formatDate(r.created_at, true)}</p>
              {r.note && <p className="mt-1 text-sm">“{r.note}”</p>}
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" loading={reject.isPending && reject.variables === r.id} onClick={() => reject.mutate(r.id)}><X /> Reject</Button>
              <Button size="sm" onClick={() => setApproving(r)}><Check /> Approve</Button>
            </div>
          </li>
        ))}
      </ul>
      {approving && <ApproveDialog req={approving} onClose={() => setApproving(null)} />}
    </Card>
  )
}

function ApproveDialog({ req, onClose }: { req: SignupRequest; onClose: () => void }) {
  const { me } = useAuth()
  const qc = useQueryClient()
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/roles') })
  const allLocs = useQuery({ queryKey: ['locations-all'], queryFn: () => api.get<{ id: string; name: string }[]>('/locations') })
  const [roleId, setRoleId] = React.useState('')
  const [allLocations, setAllLocations] = React.useState(false)
  const [locationIds, setLocationIds] = React.useState<string[]>([])
  const [designation, setDesignation] = React.useState('')
  const approve = useMutation({
    mutationFn: () => api.post(`/signup-requests/${req.id}/approve`, { role_id: roleId, all_locations: allLocations, location_ids: locationIds, designation: designation || null }),
    onSuccess: () => {
      toast.success(`${req.full_name} can now sign in`)
      void qc.invalidateQueries({ queryKey: ['signup-requests'] })
      void qc.invalidateQueries({ queryKey: ['users'] })
      onClose()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const toggle = (id: string) => setLocationIds((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]))
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md" title={`Approve ${req.full_name}`} description={req.email}
        footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={approve.isPending} disabled={!roleId || (!allLocations && !locationIds.length)} onClick={() => approve.mutate()}>Approve</Button></>}>
        <div className="grid gap-4">
          <Field label="Role" required>
            <NativeSelect value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              <option value="">Choose…</option>
              {(roles.data ?? []).filter((r) => r.code !== 'OWNER').map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </NativeSelect>
          </Field>
          <Field label="Designation"><Input value={designation} onChange={(e) => setDesignation(e.target.value)} placeholder="e.g. Cashier" /></Field>
          <div>
            <p className="mb-2 text-sm font-medium">Store access</p>
            {me?.all_locations && <label className="mb-2 flex items-center gap-2 text-sm"><Checkbox checked={allLocations} onCheckedChange={(v) => setAllLocations(!!v)} /> All locations</label>}
            {!allLocations && (
              <div className="grid gap-1.5 sm:grid-cols-2">
                {(allLocs.data ?? []).map((l) => <label key={l.id} className="flex items-center gap-2 text-sm"><Checkbox checked={locationIds.includes(l.id)} onCheckedChange={() => toggle(l.id)} /> {l.name}</label>)}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
