import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { DataTable } from '@/components/common/DataTable'
import { SearchInput } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input'
import { api, ApiError, errorMessage, type Page } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useDebounced } from '@/lib/hooks'
import { formatDate, formatINR } from '@/lib/utils'

export interface Customer {
  id: string; code: string; name: string; phone: string | null; email: string | null; gstin: string | null; billing_address: string | null; state_code: string | null
  notes: string | null; marketing_consent: boolean; credit_limit: string; is_active: boolean; created_at: string
  lifetime_spend: string | null; visits: number | null; last_purchase_at: string | null; store_credit: string | null; loyalty_points: string | null; outstanding: string | null; segment: string | null
}

const SEGMENT_TONE: Record<string, 'primary' | 'success' | 'warning' | 'neutral' | 'info'> = { VIP: 'primary', REGULAR: 'success', OCCASIONAL: 'info', LAPSED: 'warning', NEW: 'neutral' }

export default function CustomersPage() {
  const { can } = useAuth()
  const navigate = useNavigate()
  const [q, setQ] = React.useState('')
  const [segment, setSegment] = React.useState('')
  const [balance, setBalance] = React.useState(false)
  const [page, setPage] = React.useState(1)
  const [open, setOpen] = React.useState(false)
  const dq = useDebounced(q)
  React.useEffect(() => setPage(1), [dq, segment, balance])
  const list = useQuery({
    queryKey: ['customers', dq, segment, balance, page],
    queryFn: () => api.get<Page<Customer>>('/customers', { q: dq, segment, with_balance: balance || undefined, page, page_size: 25 }),
    placeholderData: keepPreviousData,
  })
  return (
    <div>
      <PageHeader title="Customers" description="Optional profiles for loyalty, store credit, B2B invoices and purchase history."
        actions={can('customers.manage') && <Button onClick={() => setOpen(true)}><Plus /> Add customer</Button>} />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <SearchInput value={q} onChange={setQ} placeholder="Name, phone, email, GSTIN…" />
          <NativeSelect aria-label="Segment" className="w-full sm:w-44" value={segment} onChange={(e) => setSegment(e.target.value)}>
            <option value="">All segments</option>{Object.keys(SEGMENT_TONE).map((s) => <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>)}
          </NativeSelect>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={balance} onChange={(e) => setBalance(e.target.checked)} /> Owes money</label>
        </div>
        <DataTable
          rows={list.data?.items}
          loading={list.isFetching}
          error={list.error}
          rowKey={(c) => c.id}
          onRowClick={(c) => navigate(`/customers/${c.id}`)}
          page={page}
          pageSize={25}
          total={list.data?.total}
          onPageChange={setPage}
          empty={{ title: 'No customers found' }}
          columns={[
            { key: 'n', header: 'Customer', cell: (c) => <><p className="font-medium">{c.name}</p><p className="text-xs text-muted">{c.code}{c.gstin ? ` · ${c.gstin}` : ''}</p></> },
            { key: 'p', header: 'Contact', hideBelow: 'md', cell: (c) => <><p>{c.phone ?? '—'}</p><p className="text-xs text-muted">{c.email}</p></> },
            { key: 'seg', header: 'Segment', cell: (c) => c.segment && <Badge tone={SEGMENT_TONE[c.segment]}>{c.segment.charAt(0) + c.segment.slice(1).toLowerCase()}</Badge> },
            { key: 'v', header: 'Visits', align: 'right', hideBelow: 'md', cell: (c) => c.visits },
            { key: 's', header: 'Lifetime spend', align: 'right', cell: (c) => formatINR(c.lifetime_spend) },
            { key: 'l', header: 'Last purchase', hideBelow: 'lg', cell: (c) => formatDate(c.last_purchase_at) },
            { key: 'b', header: 'Balances', hideBelow: 'lg', cell: (c) => <div className="flex flex-wrap gap-1">
              {Number(c.store_credit) > 0 && <Badge tone="success">{formatINR(c.store_credit)} credit</Badge>}
              {Number(c.loyalty_points) > 0 && <Badge tone="primary">{Number(c.loyalty_points)} pts</Badge>}
              {Number(c.outstanding) > 0 && <Badge tone="warning">owes {formatINR(c.outstanding)}</Badge>}
            </div> },
          ]}
        />
      </Card>
      <CustomerDialog open={open} onOpenChange={setOpen} onSaved={(c) => navigate(`/customers/${c.id}`)} />
    </div>
  )
}

export function CustomerDialog({ open, onOpenChange, customer, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; customer?: Customer; onSaved?: (c: Customer) => void }) {
  const qc = useQueryClient()
  const { canAny, locationId } = useAuth()
  const blank = { name: '', phone: '', email: '', gstin: '', billing_address: '', state_code: '', notes: '', marketing_consent: false, credit_limit: '0', is_active: true }
  const [f, setF] = React.useState(blank)
  const [errs, setErrs] = React.useState<Record<string, string>>({})
  const [dups, setDups] = React.useState<Customer[]>([])
  React.useEffect(() => {
    if (!open) return
    setErrs({}); setDups([])
    setF(customer ? { name: customer.name, phone: customer.phone ?? '', email: customer.email ?? '', gstin: customer.gstin ?? '', billing_address: customer.billing_address ?? '',
      state_code: customer.state_code ?? '', notes: customer.notes ?? '', marketing_consent: customer.marketing_consent, credit_limit: customer.credit_limit, is_active: customer.is_active } : blank)
  }, [open, customer]) // eslint-disable-line react-hooks/exhaustive-deps
  const body = () => ({ ...f, phone: f.phone || null, email: f.email || null, gstin: f.gstin ? f.gstin.toUpperCase() : null, billing_address: f.billing_address || null, state_code: f.state_code || null, notes: f.notes || null })
  const check = async () => {
    if (customer || f.name.length < 3) return
    try { setDups(await api.post<Customer[]>('/customers/check-duplicates', body())) } catch { /* ignore */ }
  }
  const save = useMutation({
    mutationFn: () => customer ? api.put<Customer>(`/customers/${customer.id}`, body()) : api.post<Customer>(`/customers${locationId ? `?location_id=${locationId}` : ''}`, body()),
    onSuccess: (c) => { toast.success('Customer saved'); onOpenChange(false); void qc.invalidateQueries({ queryKey: ['customers'] }); void qc.invalidateQueries({ queryKey: ['customer', c.id] }); onSaved?.(c) },
    onError: (e) => { if (e instanceof ApiError) setErrs(e.fieldErrors()); toast.error(errorMessage(e)) },
  })
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" title={customer ? 'Edit customer' : 'Add customer'}
        footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={!f.name} loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
        {dups.length > 0 && <div className="mb-3 rounded-md border border-amber-200 bg-warning-soft px-3 py-2 text-sm text-amber-800">Possible duplicates: {dups.map((d) => `${d.name} (${d.phone ?? d.code})`).join(', ')}</div>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required error={errs.name}><Input value={f.name} onChange={set('name')} onBlur={check} /></Field>
          <Field label="Mobile" error={errs.phone}><Input inputMode="tel" value={f.phone} onChange={set('phone')} onBlur={check} /></Field>
          <Field label="Email" error={errs.email}><Input type="email" value={f.email} onChange={set('email')} /></Field>
          <Field label="GSTIN" error={errs.gstin} hint="For B2B tax invoices"><Input value={f.gstin} maxLength={15} onChange={set('gstin')} /></Field>
          <Field label="Billing address" className="sm:col-span-2"><Textarea rows={2} value={f.billing_address} onChange={set('billing_address')} /></Field>
          <Field label="State code" error={errs.state_code}><Input value={f.state_code} maxLength={2} onChange={set('state_code')} /></Field>
          <Field label="Credit limit (₹)" error={errs.credit_limit} hint="Only managers can change"><Input inputMode="decimal" value={f.credit_limit} disabled={!canAny('finance.manage', 'registers.manage')} onChange={set('credit_limit')} /></Field>
          <Field label="Notes" className="sm:col-span-2"><Textarea rows={2} value={f.notes} onChange={set('notes')} /></Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.marketing_consent} onChange={(e) => setF({ ...f, marketing_consent: e.target.checked })} /> Consents to marketing messages</label>
        </div>
      </DialogContent>
    </Dialog>
  )
}
