import { useMutation, useQuery } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import * as React from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { BookSearch } from '@/components/common/BookSearch'
import { LocationSelect } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState, PageLoader } from '@/components/common/States'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input'
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useSuppliers } from '@/lib/queries'
import type { Book } from '@/lib/types'
import { formatINR } from '@/lib/utils'
import type { PO } from './types'

interface Line { book_id: string; title: string; sku: string; qty: string; unit_cost: string; discount_pct: string; tax_rate: string }

/** Display-only estimate; the server recalculates authoritative totals on save. */
function lineTotal(l: Line) {
  const net = Number(l.qty) * Number(l.unit_cost) * (1 - Number(l.discount_pct || 0) / 100)
  return { net, tax: net * Number(l.tax_rate || 0) / 100 }
}

export default function PurchaseOrderFormPage() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { locationId, me } = useAuth()
  const sups = useSuppliers()
  const existing = useQuery({ queryKey: ['po', id], queryFn: () => api.get<PO>(`/purchase-orders/${id}`), enabled: !!id })
  const warehouse = me?.locations.find((l) => l.type === 'WAREHOUSE')
  const [supplier, setSupplier] = React.useState(params.get('supplier') ?? '')
  const [loc, setLoc] = React.useState<string | null>(warehouse?.id ?? locationId)
  const [expected, setExpected] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [lines, setLines] = React.useState<Line[]>([])
  React.useEffect(() => {
    const p = existing.data
    if (!p) return
    setSupplier(p.supplier_id); setLoc(p.location_id); setExpected(p.expected_date ?? ''); setNotes(p.notes ?? '')
    setLines(p.lines.map((l) => ({ book_id: l.book_id, title: l.title, sku: l.sku, qty: String(l.qty_ordered), unit_cost: l.unit_cost, discount_pct: l.discount_pct, tax_rate: l.tax_rate })))
  }, [existing.data])
  const add = (b: Book) => setLines((ls) => ls.some((x) => x.book_id === b.id) ? ls : [...ls, {
    book_id: b.id, title: b.title, sku: b.sku, qty: String(b.reorder_qty || 10), unit_cost: b.purchase_price ?? (Number(b.mrp) * 0.6).toFixed(2), discount_pct: '0', tax_rate: b.tax_rate,
  }])
  const save = useMutation({
    mutationFn: (submit: boolean) => {
      const body = { supplier_id: supplier, location_id: loc, expected_date: expected || null, notes: notes || null,
        lines: lines.map((l) => ({ book_id: l.book_id, qty: Number(l.qty), unit_cost: l.unit_cost, discount_pct: l.discount_pct || '0', tax_rate: l.tax_rate || '0' })) }
      return (id ? api.put<PO>(`/purchase-orders/${id}`, body) : api.post<PO>('/purchase-orders', body)).then(async (po) => submit ? api.post<PO>(`/purchase-orders/${po.id}/submit`) : po)
    },
    onSuccess: (po) => { toast.success(`${po.number} ${po.status === 'DRAFT' ? 'saved' : po.status === 'APPROVED' ? 'approved' : 'sent for approval'}`); navigate(`/purchasing/orders/${po.id}`) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (id && existing.isLoading) return <PageLoader />
  const totals = lines.reduce((a, l) => { const t = lineTotal(l); return { net: a.net + t.net, tax: a.tax + t.tax } }, { net: 0, tax: 0 })
  const valid = supplier && loc && lines.length && lines.every((l) => Number(l.qty) > 0 && Number(l.unit_cost) >= 0)
  const upd = (i: number, k: keyof Line) => (e: React.ChangeEvent<HTMLInputElement>) => setLines(lines.map((x, j) => j === i ? { ...x, [k]: e.target.value } : x))
  return (
    <div className="max-w-6xl">
      <PageHeader title={id ? `Edit ${existing.data?.number}` : 'New purchase order'} crumbs={[{ label: 'Purchase orders', to: '/purchasing/orders' }, { label: id ? 'Edit' : 'New' }]} />
      <Card className="mb-4">
        <CardBody className="grid gap-4 sm:grid-cols-3">
          <Field label="Supplier" required>
            <NativeSelect value={supplier} onChange={(e) => setSupplier(e.target.value)}>
              <option value="">Choose supplier…</option>
              {(sups.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </NativeSelect>
          </Field>
          <Field label="Deliver to" required><LocationSelect value={loc} onChange={setLoc} allowAll={false} className="w-full" /></Field>
          <Field label="Expected delivery"><Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
          <Field label="Notes" className="sm:col-span-3"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Order lines" description="Unit cost before discount; GST rate as charged by the supplier." />
        <CardBody><BookSearch onSelect={add} placeholder="Add books by title, ISBN or barcode…" /></CardBody>
        {lines.length === 0 ? <EmptyState title="No lines yet" /> : (
          <Table>
            <THead><TR><TH>Book</TH><TH className="text-right">Qty</TH><TH className="text-right">Unit cost</TH><TH className="text-right">Disc %</TH><TH className="text-right">GST %</TH><TH className="text-right">Amount</TH><TH /></TR></THead>
            <TBody>
              {lines.map((l, i) => (
                <TR key={l.book_id}>
                  <TD><p className="font-medium">{l.title}</p><p className="text-xs text-muted">{l.sku}</p></TD>
                  <TD className="text-right"><Input aria-label="Quantity" className="ml-auto w-20 text-right" inputMode="numeric" value={l.qty} onChange={upd(i, 'qty')} /></TD>
                  <TD className="text-right"><Input aria-label="Unit cost" className="ml-auto w-24 text-right" inputMode="decimal" value={l.unit_cost} onChange={upd(i, 'unit_cost')} /></TD>
                  <TD className="text-right"><Input aria-label="Discount percent" className="ml-auto w-16 text-right" inputMode="decimal" value={l.discount_pct} onChange={upd(i, 'discount_pct')} /></TD>
                  <TD className="text-right"><Input aria-label="GST rate" className="ml-auto w-16 text-right" inputMode="decimal" value={l.tax_rate} onChange={upd(i, 'tax_rate')} /></TD>
                  <TD className="num text-right">{formatINR(lineTotal(l).net)}</TD>
                  <TD className="w-10"><Button variant="ghost" size="icon" aria-label="Remove line" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 /></Button></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        <div className="flex justify-end border-t border-border px-5 py-3 text-sm">
          <div className="w-64 space-y-1">
            <div className="flex justify-between"><span className="text-muted">Subtotal (est.)</span><span className="num">{formatINR(totals.net)}</span></div>
            <div className="flex justify-between"><span className="text-muted">GST (est.)</span><span className="num">{formatINR(totals.tax)}</span></div>
            <div className="flex justify-between font-semibold"><span>Total (est.)</span><span className="num">{formatINR(totals.net + totals.tax)}</span></div>
          </div>
        </div>
      </Card>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" disabled={!valid} loading={save.isPending && save.variables === false} onClick={() => save.mutate(false)}>Save draft</Button>
        <Button disabled={!valid} loading={save.isPending && save.variables === true} onClick={() => save.mutate(true)}>Save & submit</Button>
      </div>
    </div>
  )
}
