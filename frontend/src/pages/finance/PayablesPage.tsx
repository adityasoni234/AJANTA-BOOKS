import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, Wallet } from 'lucide-react'
import * as React from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { DataTable } from '@/components/common/DataTable'
import { PageHeader } from '@/components/common/PageHeader'
import { Badge, StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input, NativeSelect } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/misc'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, errorMessage, type Page } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useIdempotencyKey } from '@/lib/hooks'
import { useCashAccounts, usePaymentMethods, useSuppliers } from '@/lib/queries'
import { formatDate, formatINR, todayISO } from '@/lib/utils'
import type { GRN } from '../purchasing/types'

interface SI { id: string; supplier_id: string; supplier_name: string; invoice_number: string; invoice_date: string; due_date: string; total: string; amount_paid: string; balance_due: string; status: string; overdue: boolean; taxable_amount: string; cgst: string; sgst: string; igst: string; grns: { number: string }[] }
interface Aging { supplier_id: string; supplier: string; current: string; d1_30: string; d31_60: string; d61_90: string; d90_plus: string; total: string }
interface SPay { id: string; number: string; supplier_name: string; amount: string; method: string; reference: string | null; payment_date: string; allocations: { invoice_number: string; amount: string }[] }

export default function PayablesPage() {
  const { can } = useAuth()
  const [params] = useSearchParams()
  const presetSupplier = params.get('supplier') ?? ''
  const [supplier, setSupplier] = React.useState(presetSupplier)
  const [status, setStatus] = React.useState('OPEN,PARTIALLY_PAID')
  const [page, setPage] = React.useState(1)
  const [dlg, setDlg] = React.useState<null | 'invoice' | 'pay'>(presetSupplier && can('finance.manage') ? 'invoice' : null)
  const sups = useSuppliers()
  React.useEffect(() => setPage(1), [supplier, status])
  const invoices = useQuery({
    queryKey: ['supplier-invoices', supplier, status, page],
    queryFn: () => api.get<Page<SI>>('/supplier-invoices', { supplier_id: supplier, status, page, page_size: 25 }),
    placeholderData: keepPreviousData,
  })
  const aging = useQuery({ queryKey: ['supplier-aging'], queryFn: () => api.get<{ rows: Aging[] }>('/reports/supplier-aging') })
  const payments = useQuery({ queryKey: ['supplier-payments', supplier], queryFn: () => api.get<{ items: SPay[] }>('/supplier-payments', { supplier_id: supplier, page_size: 50 }) })
  return (
    <div>
      <PageHeader title="Payables" description="Supplier invoices are matched to goods receipts; payments are allocated to invoices."
        actions={can('finance.manage') && <><Button variant="secondary" onClick={() => setDlg('invoice')}><FileText /> Record supplier invoice</Button><Button onClick={() => setDlg('pay')}><Wallet /> Pay supplier</Button></>} />
      <Tabs defaultValue="invoices">
        <TabsList><TabsTrigger value="invoices">Invoices</TabsTrigger><TabsTrigger value="aging">Aging</TabsTrigger><TabsTrigger value="payments">Payments</TabsTrigger></TabsList>
        <TabsContent value="invoices">
          <Card>
            <div className="flex flex-wrap gap-2 border-b border-border p-3">
              <NativeSelect aria-label="Supplier" className="w-full sm:w-64" value={supplier} onChange={(e) => setSupplier(e.target.value)}><option value="">All suppliers</option>{(sups.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</NativeSelect>
              <NativeSelect aria-label="Status" className="w-full sm:w-48" value={status} onChange={(e) => setStatus(e.target.value)}><option value="OPEN,PARTIALLY_PAID">Unpaid</option><option value="PAID">Paid</option><option value="">All</option></NativeSelect>
            </div>
            <DataTable rows={invoices.data?.items} loading={invoices.isFetching} error={invoices.error} rowKey={(s) => s.id} page={page} pageSize={25} total={invoices.data?.total} onPageChange={setPage}
              empty={{ title: 'No supplier invoices' }}
              columns={[
                { key: 'n', header: 'Invoice', cell: (s) => <><p className="font-medium">{s.invoice_number}</p><p className="text-xs text-muted">{s.supplier_name} · GRN {s.grns.map((g) => g.number).join(', ')}</p></> },
                { key: 'd', header: 'Date', hideBelow: 'md', cell: (s) => formatDate(s.invoice_date) },
                { key: 'du', header: 'Due', cell: (s) => <span className={s.overdue ? 'font-medium text-danger' : ''}>{formatDate(s.due_date)}</span> },
                { key: 't', header: 'Total', align: 'right', cell: (s) => formatINR(s.total) },
                { key: 'b', header: 'Balance', align: 'right', cell: (s) => formatINR(s.balance_due) },
                { key: 's', header: 'Status', cell: (s) => <>{s.overdue ? <Badge tone="danger">Overdue</Badge> : <StatusBadge status={s.status} />}</> },
              ]} />
          </Card>
        </TabsContent>
        <TabsContent value="aging">
          <Card>
            <DataTable rows={aging.data?.rows} loading={aging.isLoading} rowKey={(r) => r.supplier_id} empty={{ title: 'Nothing outstanding' }}
              columns={[
                { key: 's', header: 'Supplier', cell: (r) => r.supplier },
                { key: 'c', header: 'Not due', align: 'right', cell: (r) => formatINR(r.current) },
                { key: 'a', header: '1–30', align: 'right', cell: (r) => formatINR(r.d1_30) },
                { key: 'b', header: '31–60', align: 'right', cell: (r) => formatINR(r.d31_60) },
                { key: 'e', header: '61–90', align: 'right', cell: (r) => formatINR(r.d61_90) },
                { key: 'f', header: '90+', align: 'right', cell: (r) => <span className={Number(r.d90_plus) ? 'text-danger' : ''}>{formatINR(r.d90_plus)}</span> },
                { key: 't', header: 'Total', align: 'right', cell: (r) => <strong>{formatINR(r.total)}</strong> },
              ]} />
          </Card>
        </TabsContent>
        <TabsContent value="payments">
          <Card>
            <DataTable rows={payments.data?.items} loading={payments.isLoading} rowKey={(p) => p.id} empty={{ title: 'No payments yet' }}
              columns={[
                { key: 'n', header: 'Payment', cell: (p) => <><p className="font-medium">{p.number}</p><p className="text-xs text-muted">{p.supplier_name}</p></> },
                { key: 'd', header: 'Date', cell: (p) => formatDate(p.payment_date) },
                { key: 'm', header: 'Method', cell: (p) => `${p.method}${p.reference ? ` · ${p.reference}` : ''}` },
                { key: 'a', header: 'Allocated to', hideBelow: 'md', cell: (p) => p.allocations.map((a) => `${a.invoice_number} (${formatINR(a.amount)})`).join(', ') },
                { key: 'v', header: 'Amount', align: 'right', cell: (p) => formatINR(p.amount) },
              ]} />
          </Card>
        </TabsContent>
      </Tabs>
      {dlg === 'invoice' && <InvoiceDialog initialSupplier={supplier} onClose={() => setDlg(null)} />}
      {dlg === 'pay' && <PayDialog initialSupplier={supplier} onClose={() => setDlg(null)} />}
    </div>
  )
}

function InvoiceDialog({ initialSupplier, onClose }: { initialSupplier: string; onClose: () => void }) {
  const qc = useQueryClient()
  const sups = useSuppliers()
  const [supplier, setSupplier] = React.useState(initialSupplier)
  const grns = useQuery({ queryKey: ['grns-uninvoiced', supplier], queryFn: () => api.get<Page<GRN>>('/goods-receipts', { supplier_id: supplier, uninvoiced: true, page_size: 100 }), enabled: !!supplier })
  const [sel, setSel] = React.useState<Set<string>>(new Set())
  const [f, setF] = React.useState({ invoice_number: '', invoice_date: todayISO(), due_date: '', taxable_amount: '', cgst: '0', sgst: '0', igst: '0', other_charges: '0' })
  const selected = (grns.data?.items ?? []).filter((g) => sel.has(g.id))
  const landed = selected.reduce((a, g) => a + Number(g.total_landed), 0)
  React.useEffect(() => { setF((x) => ({ ...x, taxable_amount: landed ? landed.toFixed(2) : '' })) }, [landed])
  const total = ['taxable_amount', 'cgst', 'sgst', 'igst', 'other_charges'].reduce((a, k) => a + Number(f[k as keyof typeof f] || 0), 0)
  const save = useMutation({
    mutationFn: () => api.post('/supplier-invoices', { supplier_id: supplier, ...f, due_date: f.due_date || null, grn_ids: [...sel] }),
    onSuccess: () => { toast.success('Supplier invoice recorded'); void qc.invalidateQueries({ queryKey: ['supplier-invoices'] }); void qc.invalidateQueries({ queryKey: ['supplier-aging'] }); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value })
  const variance = Number(f.taxable_amount || 0) + Number(f.other_charges || 0) - landed
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg" title="Record supplier invoice" description="Match the invoice to the goods receipts it bills. Any difference from received value posts to purchase price variance."
        footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!supplier || !sel.size || !f.invoice_number} loading={save.isPending} onClick={() => save.mutate()}>Record invoice {formatINR(total)}</Button></>}>
        <div className="space-y-4">
          <Field label="Supplier" required><NativeSelect value={supplier} onChange={(e) => { setSupplier(e.target.value); setSel(new Set()) }}><option value="">Choose…</option>{(sups.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</NativeSelect></Field>
          {supplier && (
            <div className="rounded-md border border-border">
              {(grns.data?.items ?? []).length === 0 ? <p className="p-3 text-sm text-muted">No un-invoiced goods receipts for this supplier.</p> : grns.data!.items.map((g) => (
                <label key={g.id} className="flex items-center gap-3 border-b border-border px-3 py-2 text-sm last:border-0">
                  <Checkbox checked={sel.has(g.id)} onCheckedChange={(v) => setSel((s) => { const n = new Set(s); if (v) n.add(g.id); else n.delete(g.id); return n })} />
                  <span className="flex-1">{g.number} · {formatDate(g.received_at)}{g.po_number && ` · ${g.po_number}`}</span>
                  <span className="num">{formatINR(g.total_landed)}</span>
                </label>
              ))}
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Invoice number" required><Input value={f.invoice_number} onChange={set('invoice_number')} /></Field>
            <Field label="Invoice date" required><Input type="date" value={f.invoice_date} onChange={set('invoice_date')} /></Field>
            <Field label="Due date" hint="Defaults to supplier terms"><Input type="date" value={f.due_date} onChange={set('due_date')} /></Field>
            <Field label="Taxable amount (₹)" required><Input inputMode="decimal" value={f.taxable_amount} onChange={set('taxable_amount')} /></Field>
            <Field label="CGST"><Input inputMode="decimal" value={f.cgst} onChange={set('cgst')} /></Field>
            <Field label="SGST"><Input inputMode="decimal" value={f.sgst} onChange={set('sgst')} /></Field>
            <Field label="IGST"><Input inputMode="decimal" value={f.igst} onChange={set('igst')} /></Field>
            <Field label="Other charges"><Input inputMode="decimal" value={f.other_charges} onChange={set('other_charges')} /></Field>
          </div>
          {sel.size > 0 && Math.abs(variance) >= 0.01 && <p className="text-sm text-warning">Differs from received value by {formatINR(variance)} — will post to purchase price variance.</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function PayDialog({ initialSupplier, onClose }: { initialSupplier: string; onClose: () => void }) {
  const qc = useQueryClient()
  const { me } = useAuth()
  const idem = useIdempotencyKey()
  const sups = useSuppliers()
  const methods = usePaymentMethods()
  const accounts = useCashAccounts()
  const [supplier, setSupplier] = React.useState(initialSupplier)
  const [method, setMethod] = React.useState('')
  const [account, setAccount] = React.useState('')
  const [ref, setRef] = React.useState('')
  const [date, setDate] = React.useState(todayISO())
  const [loc, setLoc] = React.useState(me?.locations.find((l) => l.type === 'WAREHOUSE')?.id ?? me?.locations[0]?.id ?? '')
  const open = useQuery({ queryKey: ['si-open', supplier], queryFn: () => api.get<Page<SI>>('/supplier-invoices', { supplier_id: supplier, status: 'OPEN,PARTIALLY_PAID', page_size: 100 }), enabled: !!supplier })
  const [alloc, setAlloc] = React.useState<Record<string, string>>({})
  const total = Object.values(alloc).reduce((a, v) => a + Number(v || 0), 0)
  const m = methods.data?.find((x) => x.id === method)
  const save = useMutation({
    mutationFn: () => api.post('/supplier-payments', {
      supplier_id: supplier, location_id: loc, payment_method_id: method, account_id: account || null, amount: total.toFixed(2), reference: ref || null, payment_date: date,
      allocations: Object.entries(alloc).filter(([, v]) => Number(v) > 0).map(([supplier_invoice_id, amount]) => ({ supplier_invoice_id, amount: Number(amount).toFixed(2) })),
    }, { idempotencyKey: idem.key }),
    onSuccess: () => { idem.reset(); toast.success('Payment recorded'); void qc.invalidateQueries({ queryKey: ['supplier-invoices'] }); void qc.invalidateQueries({ queryKey: ['supplier-payments'] }); void qc.invalidateQueries({ queryKey: ['supplier-aging'] }); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg" title="Pay supplier" description="Allocate the payment across open invoices. Retrying is safe; the payment is recorded once."
        footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!supplier || !method || total <= 0 || (!!m?.requires_reference && !ref)} loading={save.isPending} onClick={() => save.mutate()}>Pay {formatINR(total)}</Button></>}>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Supplier" required><NativeSelect value={supplier} onChange={(e) => { setSupplier(e.target.value); setAlloc({}) }}><option value="">Choose…</option>{(sups.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</NativeSelect></Field>
            <Field label="Paid from location" required><NativeSelect value={loc} onChange={(e) => setLoc(e.target.value)}>{me?.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</NativeSelect></Field>
            <Field label="Method" required><NativeSelect value={method} onChange={(e) => setMethod(e.target.value)}><option value="">Choose…</option>{(methods.data ?? []).filter((x) => ['CASH', 'BANK_TRANSFER', 'UPI', 'CARD'].includes(x.kind)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</NativeSelect></Field>
            <Field label="From account" hint="Defaults to the method’s account"><NativeSelect value={account} onChange={(e) => setAccount(e.target.value)}><option value="">Default</option>{(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</NativeSelect></Field>
            <Field label="Reference" required={!!m?.requires_reference}><Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="UTR / cheque no." /></Field>
            <Field label="Payment date" required><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          </div>
          {supplier && (
            <div className="divide-y divide-border rounded-md border border-border">
              {(open.data?.items ?? []).length === 0 && <p className="p-3 text-sm text-muted">No open invoices.</p>}
              {(open.data?.items ?? []).map((s) => (
                <div key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="flex-1">{s.invoice_number} <span className="text-muted">· due {formatDate(s.due_date)} · balance {formatINR(s.balance_due)}</span></span>
                  <Button size="sm" variant="ghost" onClick={() => setAlloc({ ...alloc, [s.id]: s.balance_due })}>Full</Button>
                  <Input aria-label={`Pay ${s.invoice_number}`} className="w-28 text-right" inputMode="decimal" value={alloc[s.id] ?? ''} onChange={(e) => setAlloc({ ...alloc, [s.id]: e.target.value })} />
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
