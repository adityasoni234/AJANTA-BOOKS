import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'
import { DataTable } from '@/components/common/DataTable'
import { PageHeader } from '@/components/common/PageHeader'
import { Badge, StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input, NativeSelect } from '@/components/ui/input'
import { api, ApiError, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'

interface Loc { id: string; code: string; name: string; type: string; is_active: boolean; address_line1: string | null; address_line2: string | null; city: string | null; state: string | null; state_code: string; pincode: string | null; phone: string | null; email: string | null; gstin: string | null; invoice_prefix: string }

export default function LocationsPage() {
  const { refresh, me } = useAuth()
  const [edit, setEdit] = React.useState<Loc | 'new' | null>(null)
  const list = useQuery({ queryKey: ['locations-admin'], queryFn: () => api.get<Loc[]>('/locations', { include_inactive: true }) })
  return (
    <div>
      <PageHeader title="Outlets & warehouses" description="Each location has its own stock, registers, invoice series and (optionally) GSTIN."
        actions={me?.all_locations && <Button onClick={() => setEdit('new')}><Plus /> Add location</Button>} />
      <Card>
        <DataTable rows={list.data} loading={list.isLoading} error={list.error} rowKey={(l) => l.id} onRowClick={setEdit} empty={{ title: 'No locations yet' }}
          columns={[
            { key: 'n', header: 'Location', cell: (l) => <><p className="font-medium">{l.name}</p><p className="text-xs text-muted">{l.code}</p></> },
            { key: 't', header: 'Type', cell: (l) => <Badge tone={l.type === 'WAREHOUSE' ? 'info' : 'primary'}>{l.type === 'WAREHOUSE' ? 'Warehouse' : 'Outlet'}</Badge> },
            { key: 'c', header: 'City / state', hideBelow: 'md', cell: (l) => `${l.city ?? '—'} · ${l.state_code}` },
            { key: 'g', header: 'GSTIN', hideBelow: 'lg', cell: (l) => <span className="num text-xs">{l.gstin ?? 'Uses organisation GSTIN'}</span> },
            { key: 'p', header: 'Invoice prefix', cell: (l) => <span className="num">{l.invoice_prefix}</span> },
            { key: 's', header: 'Status', cell: (l) => <StatusBadge status={l.is_active ? 'ACTIVE' : 'ARCHIVED'} label={l.is_active ? 'Active' : 'Inactive'} /> },
          ]} />
      </Card>
      {edit && <LocationDialog loc={edit === 'new' ? null : edit} onClose={() => { setEdit(null); void refresh() }} />}
    </div>
  )
}

function LocationDialog({ loc, onClose }: { loc: Loc | null; onClose: () => void }) {
  const qc = useQueryClient()
  const states = useQuery({ queryKey: ['states'], queryFn: () => api.get<{ code: string; name: string }[]>('/reference/states') })
  const [f, setF] = React.useState({
    code: loc?.code ?? '', name: loc?.name ?? '', type: loc?.type ?? 'OUTLET', address_line1: loc?.address_line1 ?? '', address_line2: loc?.address_line2 ?? '', city: loc?.city ?? '',
    state: loc?.state ?? '', state_code: loc?.state_code ?? '27', pincode: loc?.pincode ?? '', phone: loc?.phone ?? '', email: loc?.email ?? '', gstin: loc?.gstin ?? '',
    invoice_prefix: loc?.invoice_prefix ?? '', is_active: loc?.is_active ?? true,
  })
  const [errs, setErrs] = React.useState<Record<string, string>>({})
  const save = useMutation({
    mutationFn: () => {
      const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v === '' ? null : v]))
      body.state = states.data?.find((s) => s.code === f.state_code)?.name ?? null
      return loc ? api.put(`/locations/${loc.id}`, body) : api.post('/locations', body)
    },
    onSuccess: () => { toast.success('Location saved'); void qc.invalidateQueries({ queryKey: ['locations-admin'] }); void qc.invalidateQueries({ queryKey: ['location-directory'] }); onClose() },
    onError: (e) => { if (e instanceof ApiError) setErrs(e.fieldErrors()); toast.error(errorMessage(e)) },
  })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg" title={loc ? `Edit ${loc.name}` : 'Add location'} description={loc ? undefined : 'New outlets get a default register automatically.'}
        footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!f.code || !f.name || !f.invoice_prefix} loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required error={errs.name}><Input value={f.name} onChange={set('name')} /></Field>
          <Field label="Code" required error={errs.code} hint="Uppercase letters, digits and dashes"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="Type"><NativeSelect value={f.type} disabled={!!loc} onChange={set('type')}><option value="OUTLET">Retail outlet</option><option value="WAREHOUSE">Warehouse</option></NativeSelect></Field>
          <Field label="Invoice prefix" required error={errs.invoice_prefix} hint="Up to 4 characters; keeps invoice numbers within GST’s 16-character limit"><Input value={f.invoice_prefix} maxLength={4} onChange={(e) => setF({ ...f, invoice_prefix: e.target.value.toUpperCase() })} /></Field>
          <Field label="Address" className="sm:col-span-2"><Input value={f.address_line1} onChange={set('address_line1')} /></Field>
          <Field label="City"><Input value={f.city} onChange={set('city')} /></Field>
          <Field label="PIN code"><Input value={f.pincode} onChange={set('pincode')} /></Field>
          <Field label="State" required><NativeSelect value={f.state_code} onChange={set('state_code')}>{(states.data ?? []).map((s) => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}</NativeSelect></Field>
          <Field label="GSTIN" error={errs.gstin} hint="Leave blank to use the organisation GSTIN"><Input value={f.gstin} maxLength={15} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} /></Field>
          <Field label="Phone"><Input value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Email" error={errs.email}><Input type="email" value={f.email} onChange={set('email')} /></Field>
          {loc && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Active</label>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
