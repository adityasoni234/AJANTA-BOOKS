import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Gift, Pencil, Wallet } from 'lucide-react'
import * as React from 'react'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { DataTable } from '@/components/common/DataTable'
import { PageHeader } from '@/components/common/PageHeader'
import { StatCard } from '@/components/common/StatCard'
import { ErrorState, PageLoader } from '@/components/common/States'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input, NativeSelect } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useIdempotencyKey } from '@/lib/hooks'
import { usePaymentMethods } from '@/lib/queries'
import { formatDate, formatINR, titleCase } from '@/lib/utils'
import { CustomerDialog, type Customer } from './CustomersPage'

interface History {
  sales: { id: string; invoice_number: string; location: string; status: string; grand_total: string; balance_due: string; items: number; created_at: string }[]
  returns: { id: string; number: string; status: string; refund_total: string; created_at: string }[]
  ledger: { kind: string; delta: string; note: string | null; ref_type: string | null; by: string | null; created_at: string }[]
}

export default function CustomerDetailPage() {
  const { id } = useParams()
  const { can } = useAuth()
  const c = useQuery({ queryKey: ['customer', id], queryFn: () => api.get<Customer>(`/customers/${id}`) })
  const h = useQuery({ queryKey: ['customer-history', id], queryFn: () => api.get<History>(`/customers/${id}/history`) })
  const [edit, setEdit] = React.useState(false)
  const [dlg, setDlg] = React.useState<null | 'receipt' | 'redeem' | 'adjust'>(null)
  if (c.isLoading) return <PageLoader />
  if (!c.data) return <ErrorState error={c.error} />
  const cu = c.data
  return (
    <div>
      <PageHeader title={cu.name} description={[cu.code, cu.phone, cu.email, cu.gstin && `GSTIN ${cu.gstin}`].filter(Boolean).join(' · ')} crumbs={[{ label: 'Customers', to: '/customers' }, { label: cu.code }]}
        actions={<>
          {Number(cu.outstanding) > 0 && can('pos.sell') && <Button variant="secondary" onClick={() => setDlg('receipt')}><Wallet /> Receive payment</Button>}
          {Number(cu.loyalty_points) > 0 && can('pos.sell') && <Button variant="secondary" onClick={() => setDlg('redeem')}><Gift /> Redeem points</Button>}
          {can('customers.manage') && <Button variant="secondary" onClick={() => setDlg('adjust')}>Adjust balance</Button>}
          {can('customers.manage') && <Button onClick={() => setEdit(true)}><Pencil /> Edit</Button>}
        </>} />
      <div className="mb-6 grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Lifetime spend (net)" value={formatINR(cu.lifetime_spend)} hint={`${cu.visits} visits`} />
        <StatCard label="Last purchase" value={formatDate(cu.last_purchase_at)} tone="info" />
        <StatCard label="Store credit" value={formatINR(cu.store_credit)} tone="success" />
        <StatCard label="Loyalty points" value={Number(cu.loyalty_points ?? 0).toLocaleString('en-IN')} tone="primary" />
        <StatCard label="Outstanding" value={formatINR(cu.outstanding)} hint={`Limit ${formatINR(cu.credit_limit)}`} tone={Number(cu.outstanding) > 0 ? 'warning' : 'success'} />
      </div>
      <Card>
        <Tabs defaultValue="sales" className="px-5 pt-2">
          <TabsList><TabsTrigger value="sales">Purchases</TabsTrigger><TabsTrigger value="returns">Returns</TabsTrigger><TabsTrigger value="ledger">Credit & points ledger</TabsTrigger></TabsList>
          <TabsContent value="sales" className="-mx-5">
            <DataTable rows={h.data?.sales} loading={h.isLoading} rowKey={(s) => s.id} empty={{ title: 'No purchases yet' }} columns={[
              { key: 'i', header: 'Invoice', cell: (s) => <Link className="font-medium hover:text-primary" to={`/sales/${s.id}`}>{s.invoice_number}</Link> },
              { key: 'd', header: 'Date', cell: (s) => formatDate(s.created_at, true) },
              { key: 'l', header: 'Outlet', cell: (s) => s.location },
              { key: 'n', header: 'Items', align: 'right', cell: (s) => s.items },
              { key: 't', header: 'Total', align: 'right', cell: (s) => formatINR(s.grand_total) },
              { key: 'b', header: 'Due', align: 'right', cell: (s) => Number(s.balance_due) ? formatINR(s.balance_due) : '—' },
              { key: 's', header: 'Status', cell: (s) => <StatusBadge status={s.status} /> },
            ]} />
          </TabsContent>
          <TabsContent value="returns" className="-mx-5">
            <DataTable rows={h.data?.returns} loading={h.isLoading} rowKey={(r) => r.id} empty={{ title: 'No returns' }} columns={[
              { key: 'n', header: 'Return', cell: (r) => <Link className="font-medium hover:text-primary" to={`/returns/${r.id}`}>{r.number}</Link> },
              { key: 'd', header: 'Date', cell: (r) => formatDate(r.created_at) },
              { key: 'a', header: 'Refund', align: 'right', cell: (r) => formatINR(r.refund_total) },
              { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
            ]} />
          </TabsContent>
          <TabsContent value="ledger" className="-mx-5">
            <DataTable rows={h.data?.ledger} loading={h.isLoading} rowKey={(l) => l.created_at + l.kind + l.delta} empty={{ title: 'No entries' }} columns={[
              { key: 'd', header: 'Date', cell: (l) => formatDate(l.created_at, true) },
              { key: 'k', header: 'Type', cell: (l) => l.kind === 'LOYALTY' ? 'Loyalty points' : 'Store credit' },
              { key: 'v', header: 'Change', align: 'right', cell: (l) => <span className={Number(l.delta) < 0 ? 'text-danger' : 'text-success'}>{Number(l.delta) > 0 ? '+' : ''}{l.kind === 'LOYALTY' ? Number(l.delta) : formatINR(l.delta)}</span> },
              { key: 'n', header: 'Note', cell: (l) => l.note ?? titleCase(l.ref_type) },
              { key: 'b', header: 'By', cell: (l) => l.by ?? '—' },
            ]} />
          </TabsContent>
        </Tabs>
      </Card>
      <CustomerDialog open={edit} onOpenChange={setEdit} customer={cu} />
      {dlg === 'receipt' && <ReceiptDialog customer={cu} sales={(h.data?.sales ?? []).filter((s) => Number(s.balance_due) > 0)} onClose={() => setDlg(null)} />}
      {dlg === 'redeem' && <RedeemDialog customer={cu} onClose={() => setDlg(null)} />}
      {dlg === 'adjust' && <AdjustDialog customer={cu} onClose={() => setDlg(null)} />}
    </div>
  )
}

function useRefresh(id: string) {
  const qc = useQueryClient()
  return () => { void qc.invalidateQueries({ queryKey: ['customer', id] }); void qc.invalidateQueries({ queryKey: ['customer-history', id] }) }
}

function ReceiptDialog({ customer, sales, onClose }: { customer: Customer; sales: History['sales']; onClose: () => void }) {
  const { locationId, outlets } = useAuth()
  const methods = usePaymentMethods()
  const idem = useIdempotencyKey()
  const refresh = useRefresh(customer.id)
  const [method, setMethod] = React.useState('')
  const [ref, setRef] = React.useState('')
  const [alloc, setAlloc] = React.useState<Record<string, string>>(() => Object.fromEntries(sales.map((s) => [s.id, s.balance_due])))
  const loc = locationId ?? outlets[0]?.id
  const regs = useQuery({ queryKey: ['registers', loc], queryFn: () => api.get<{ open_session: { id: string } | null }[]>('/registers', { location_id: loc! }), enabled: !!loc })
  const m = methods.data?.find((x) => x.id === method)
  const total = Object.values(alloc).reduce((a, v) => a + Number(v || 0), 0)
  const save = useMutation({
    mutationFn: () => api.post(`/customers/${customer.id}/receipts`, {
      location_id: loc, payment_method_id: method, amount: total.toFixed(2), reference: ref || null,
      register_session_id: m?.kind === 'CASH' ? regs.data?.find((r) => r.open_session)?.open_session?.id : null,
      allocations: Object.entries(alloc).filter(([, v]) => Number(v) > 0).map(([sale_id, amount]) => ({ sale_id, amount: Number(amount).toFixed(2) })),
    }, { idempotencyKey: idem.key }),
    onSuccess: () => { toast.success('Payment recorded'); refresh(); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Receive customer payment" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!method || total <= 0 || (!!m?.requires_reference && !ref)} loading={save.isPending} onClick={() => save.mutate()}>Record {formatINR(total)}</Button></>}>
        <div className="space-y-3">
          <Field label="Method"><NativeSelect value={method} onChange={(e) => setMethod(e.target.value)}><option value="">Choose…</option>{(methods.data ?? []).filter((x) => ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER'].includes(x.kind)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</NativeSelect></Field>
          {m?.requires_reference && <Field label="Reference" required><Input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>}
          {sales.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-3 text-sm">
              <span>{s.invoice_number} <span className="text-muted">due {formatINR(s.balance_due)}</span></span>
              <Input aria-label={`Allocate to ${s.invoice_number}`} className="w-28 text-right" inputMode="decimal" value={alloc[s.id]} onChange={(e) => setAlloc({ ...alloc, [s.id]: e.target.value })} />
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function RedeemDialog({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const refresh = useRefresh(customer.id)
  const [pts, setPts] = React.useState(String(Math.floor(Number(customer.loyalty_points ?? 0))))
  const save = useMutation({
    mutationFn: () => api.post<{ store_credit_added: string }>(`/customers/${customer.id}/redeem-points?points=${Number(pts)}`),
    onSuccess: (r) => { toast.success(`${formatINR(r.store_credit_added)} added as store credit`); refresh(); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm" title="Redeem loyalty points" description="Points convert to store credit at the configured value."
        footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!(Number(pts) > 0)} loading={save.isPending} onClick={() => save.mutate()}>Redeem</Button></>}>
        <Field label={`Points (available ${Number(customer.loyalty_points)})`}><Input inputMode="numeric" value={pts} onChange={(e) => setPts(e.target.value)} /></Field>
      </DialogContent>
    </Dialog>
  )
}

function AdjustDialog({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const { can } = useAuth()
  const refresh = useRefresh(customer.id)
  const [kind, setKind] = React.useState(can('finance.manage') ? 'STORE_CREDIT' : 'LOYALTY')
  const [delta, setDelta] = React.useState('')
  const [note, setNote] = React.useState('')
  const save = useMutation({
    mutationFn: () => api.post(`/customers/${customer.id}/ledger`, { kind, delta, note }),
    onSuccess: () => { toast.success('Balance adjusted'); refresh(); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm" title="Adjust balance" description="Every adjustment is recorded with your name. Store credit adjustments post to the goodwill account."
        footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!delta || note.length < 3} loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
        <div className="space-y-3">
          <Field label="Balance"><NativeSelect value={kind} onChange={(e) => setKind(e.target.value)}>{can('finance.manage') && <option value="STORE_CREDIT">Store credit (₹)</option>}<option value="LOYALTY">Loyalty points</option></NativeSelect></Field>
          <Field label="Change (use − to deduct)"><Input inputMode="decimal" value={delta} onChange={(e) => setDelta(e.target.value)} /></Field>
          <Field label="Reason" required><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
