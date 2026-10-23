import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { DataTable } from '@/components/common/DataTable'
import { SearchInput } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { Badge, StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/input'
import { api, ApiError, errorMessage, type Page } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useDebounced } from '@/lib/hooks'
import { formatINR } from '@/lib/utils'

export interface Supplier {
  id: string; code: string; name: string; contact_person: string | null; phone: string | null; email: string | null; gstin: string | null; pan: string | null
  address_line1: string | null; address_line2: string | null; city: string | null; state: string | null; state_code: string | null; pincode: string | null
  payment_terms_days: number; notes: string | null; is_active: boolean; outstanding: string | null; overdue: string | null
}

export default function SuppliersPage() {
  const { can } = useAuth()
  const navigate = useNavigate()
  const [q, setQ] = React.useState('')
  const [page, setPage] = React.useState(1)
  const [open, setOpen] = React.useState(false)
  const dq = useDebounced(q)
  React.useEffect(() => setPage(1), [dq])
  const list = useQuery({ queryKey: ['suppliers', dq, page], queryFn: () => api.get<Page<Supplier>>('/suppliers', { q: dq, page, page_size: 25 }), placeholderData: keepPreviousData })
  return (
    <div>
      <PageHeader title="Suppliers" description="Distributors and publishers, with outstanding balances."
        actions={can('suppliers.manage') && <Button onClick={() => setOpen(true)}><Plus /> Add supplier</Button>} />
      <Card>
        <div className="border-b border-border p-3"><SearchInput value={q} onChange={setQ} placeholder="Name, code, GSTIN, phone…" /></div>
        <DataTable
          rows={list.data?.items}
          loading={list.isFetching}
          error={list.error}
          rowKey={(s) => s.id}
          onRowClick={(s) => navigate(`/suppliers/${s.id}`)}
          page={page}
          pageSize={25}
          total={list.data?.total}
          onPageChange={setPage}
          empty={{ title: 'No suppliers yet' }}
          columns={[
            { key: 'n', header: 'Supplier', cell: (s) => <><p className="font-medium">{s.name}</p><p className="text-xs text-muted">{s.code}{s.city ? ` · ${s.city}` : ''}</p></> },
            { key: 'c', header: 'Contact', hideBelow: 'md', cell: (s) => <><p>{s.contact_person ?? '—'}</p><p className="text-xs text-muted">{s.phone ?? s.email ?? ''}</p></> },
            { key: 'g', header: 'GSTIN', hideBelow: 'lg', cell: (s) => <span className="num text-xs">{s.gstin ?? '—'}</span> },
            { key: 't', header: 'Terms', hideBelow: 'md', cell: (s) => `${s.payment_terms_days} days` },
            { key: 'o', header: 'Outstanding', align: 'right', cell: (s) => s.outstanding === null ? '—' : <>{formatINR(s.outstanding)}{Number(s.overdue) > 0 && <Badge tone="danger" className="ml-2">{formatINR(s.overdue)} overdue</Badge>}</> },
            { key: 's', header: 'Status', cell: (s) => <StatusBadge status={s.is_active ? 'ACTIVE' : 'ARCHIVED'} label={s.is_active ? 'Active' : 'Inactive'} /> },
          ]}
        />
      </Card>
      <SupplierDialog open={open} onOpenChange={setOpen} onSaved={(s) => navigate(`/suppliers/${s.id}`)} />
    </div>
  )
}

const EMPTY = { name: '', contact_person: '', phone: '', email: '', gstin: '', pan: '', address_line1: '', address_line2: '', city: '', state: '', state_code: '', pincode: '', payment_terms_days: '30', notes: '', is_active: true }

export function SupplierDialog({ open, onOpenChange, supplier, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; supplier?: Supplier; onSaved?: (s: Supplier) => void }) {
  const qc = useQueryClient()
  const [f, setF] = React.useState(EMPTY)
  const [errs, setErrs] = React.useState<Record<string, string>>({})
  React.useEffect(() => {
    if (open) {
      setErrs({})
      setF(supplier ? Object.fromEntries(Object.entries({ ...EMPTY, ...supplier }).map(([k, v]) => [k, v === null ? '' : k === 'payment_terms_days' ? String(v) : v])) as typeof EMPTY : EMPTY)
    }
  }, [open, supplier])
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value })
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v === "" ? null : v]))
      body.payment_terms_days = Number(f.payment_terms_days || 0)
      body.name = f.name
      if (body.gstin) body.gstin = String(body.gstin).toUpperCase()
      if (body.pan) body.pan = String(body.pan).toUpperCase()
      return supplier ? api.put<Supplier>(`/suppliers/${supplier.id}`, body) : api.post<Supplier>('/suppliers', body)
    },
    onSuccess: (s) => { toast.success('Supplier saved'); onOpenChange(false); void qc.invalidateQueries({ queryKey: ['suppliers'] }); void qc.invalidateQueries({ queryKey: ['supplier', s.id] }); onSaved?.(s) },
    onError: (e) => { if (e instanceof ApiError) setErrs(e.fieldErrors()); toast.error(errorMessage(e)) },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" title={supplier ? 'Edit supplier' : 'Add supplier'}
        footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={f.name.length < 2} loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Business name" required error={errs.name} className="sm:col-span-2"><Input value={f.name} onChange={set('name')} /></Field>
          <Field label="Contact person"><Input value={f.contact_person} onChange={set('contact_person')} /></Field>
          <Field label="Phone"><Input value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Email" error={errs.email}><Input type="email" value={f.email} onChange={set('email')} /></Field>
          <Field label="GSTIN" error={errs.gstin}><Input value={f.gstin} maxLength={15} onChange={set('gstin')} /></Field>
          <Field label="PAN" error={errs.pan}><Input value={f.pan} maxLength={10} onChange={set('pan')} /></Field>
          <Field label="Payment terms (days)" error={errs.payment_terms_days}><Input inputMode="numeric" value={f.payment_terms_days} onChange={set('payment_terms_days')} /></Field>
          <Field label="Address" className="sm:col-span-2"><Input value={f.address_line1} onChange={set('address_line1')} /></Field>
          <Field label="City"><Input value={f.city} onChange={set('city')} /></Field>
          <Field label="State code" error={errs.state_code} hint="2-digit GST state code"><Input value={f.state_code} maxLength={2} onChange={set('state_code')} /></Field>
          <Field label="Notes" className="sm:col-span-2"><Textarea rows={2} value={f.notes} onChange={set('notes')} /></Field>
          {supplier && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Active</label>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
