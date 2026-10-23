import { useMutation, useQuery } from '@tanstack/react-query'
import { Ban, Printer, RotateCcw } from 'lucide-react'
import * as React from 'react'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { PageHeader } from '@/components/common/PageHeader'
import { ErrorState, PageLoader } from '@/components/common/States'
import { Badge, StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field, Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/ui/misc'
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDate, formatINR, titleCase } from '@/lib/utils'
import type { SaleDetail } from './types'

export default function SaleDetailPage() {
  const { id } = useParams()
  const { can } = useAuth()
  const q = useQuery({ queryKey: ['sale', id], queryFn: () => api.get<SaleDetail>(`/sales/${id}`) })
  const [voidOpen, setVoidOpen] = React.useState(false)
  const [reason, setReason] = React.useState('')
  const voidSale = useMutation({
    mutationFn: () => api.post<{ status: string }>(`/sales/${id}/void`, { reason }),
    onSuccess: (r) => { toast.success(r.status === 'CANCELLED' ? 'Sale voided — stock restored and payments refunded' : 'Void request sent for manager approval'); setVoidOpen(false); void q.refetch() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (q.isLoading) return <PageLoader />
  if (!q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const s = q.data
  const returnable = s.status === 'COMPLETED' && s.lines.some((l) => l.qty_returned < l.qty)
  return (
    <div>
      <PageHeader
        title={<span className="flex items-center gap-3">{s.invoice?.number ?? 'Sale'} <StatusBadge status={s.status} /></span>}
        description={`${s.location_name} · ${formatDate(s.created_at, true)} · ${s.cashier ?? ''}`}
        crumbs={[{ label: 'Sales', to: '/sales' }, { label: s.invoice?.number ?? '' }]}
        actions={<>
          <Button variant="secondary" asChild><a href={`/sales/${s.id}/print?format=thermal`} target="_blank" rel="noreferrer"><Printer /> Receipt</a></Button>
          <Button variant="secondary" asChild><a href={`/sales/${s.id}/print?format=a4`} target="_blank" rel="noreferrer"><Printer /> A4 invoice</a></Button>
          {returnable && can('returns.create') && <Button variant="secondary" asChild><Link to={`/returns/new?sale=${s.id}`}><RotateCcw /> Return / exchange</Link></Button>}
          {s.status === 'COMPLETED' && can('pos.sell') && !s.returns.length && <Button variant="danger-outline" onClick={() => setVoidOpen(true)}><Ban /> Void</Button>}
        </>}
      />
      {s.status === 'CANCELLED' && <div className="mb-4 rounded-md border border-red-200 bg-danger-soft px-4 py-3 text-sm text-red-700">Voided {formatDate(s.cancelled_at, true)} — {s.cancel_reason}. The invoice number remains reserved.</div>}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Items" description={`${s.prices_include_tax ? 'Prices include GST' : 'Prices exclude GST'} · ${s.is_interstate ? 'Interstate (IGST)' : 'Intrastate (CGST + SGST)'}`} />
          <Table>
            <THead><TR><TH>Item</TH><TH className="text-right">Qty</TH><TH className="text-right">Price</TH><TH className="text-right">Discount</TH><TH className="text-right">Taxable</TH><TH className="text-right">GST</TH><TH className="text-right">Total</TH></TR></THead>
            <TBody>
              {s.lines.map((l) => (
                <TR key={l.id}>
                  <TD><Link to={`/catalog/${l.book_id}`} className="font-medium hover:text-primary">{l.title}</Link><p className="text-xs text-muted">HSN {l.hsn_code ?? '—'}{l.copy_code && ` · copy ${l.copy_code}`}{l.qty_returned > 0 && <Badge tone="warning" className="ml-1">{l.qty_returned} returned</Badge>}</p></TD>
                  <TD className="num text-right">{l.qty}</TD>
                  <TD className="num text-right">{formatINR(l.unit_price)}</TD>
                  <TD className="num text-right">{Number(l.line_discount) + Number(l.bill_discount_alloc) ? formatINR(Number(l.line_discount) + Number(l.bill_discount_alloc)) : '—'}</TD>
                  <TD className="num text-right">{formatINR(l.taxable_value)}</TD>
                  <TD className="num text-right">{Number(l.tax_rate)}%<span className="block text-xs text-muted">{formatINR(Number(l.cgst) + Number(l.sgst) + Number(l.igst))}</span></TD>
                  <TD className="num text-right font-medium">{formatINR(l.line_total)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <div className="flex justify-end border-t border-border px-5 py-3 text-sm">
            <dl className="w-64 space-y-1">
              <Line l="Gross" v={s.gross_amount} />
              {Number(s.discount_total) > 0 && <Line l={`Discount${s.discount_reason ? ` (${s.discount_reason})` : ''}`} v={`-${s.discount_total}`} />}
              <Line l="Taxable value" v={s.taxable_total} />
              {s.is_interstate ? <Line l="IGST" v={s.igst_total} /> : <><Line l="CGST" v={s.cgst_total} /><Line l="SGST" v={s.sgst_total} /></>}
              {Number(s.round_off) !== 0 && <Line l="Round off" v={s.round_off} />}
              <div className="flex justify-between border-t border-border pt-1 font-semibold"><dt>Total</dt><dd className="num">{formatINR(s.grand_total)}</dd></div>
              <p className="pt-1 text-xs text-muted">{s.amount_in_words}</p>
            </dl>
          </div>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Customer" />
            <CardBody className="text-sm">
              {s.customer_id ? <Link to={`/customers/${s.customer_id}`} className="font-medium hover:text-primary">{s.customer_name}</Link> : <p className="text-muted">Walk-in customer</p>}
              {s.invoice?.buyer.gstin && <p className="text-xs text-muted">GSTIN {s.invoice.buyer.gstin}</p>}
              <p className="mt-1 text-xs text-muted">Place of supply: {s.invoice?.place_of_supply}</p>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Payments" description={Number(s.balance_due) > 0 ? `Balance due ${formatINR(s.balance_due)}` : 'Fully paid'} />
            <ul className="divide-y divide-border text-sm">
              {s.payments.map((p) => (
                <li key={p.id} className="flex justify-between gap-3 px-5 py-2.5">
                  <div><p>{p.method} {p.direction === 'OUT' && <Badge tone="danger">{titleCase(p.purpose)}</Badge>}</p><p className="text-xs text-muted">{p.reference ?? p.number}{p.change_given && Number(p.change_given) > 0 ? ` · change ${formatINR(p.change_given)}` : ''}</p></div>
                  <span className={`num ${p.direction === 'OUT' ? 'text-danger' : ''}`}>{p.direction === 'OUT' ? '−' : ''}{formatINR(p.amount)}</span>
                </li>
              ))}
            </ul>
          </Card>
          {s.returns.length > 0 && (
            <Card>
              <CardHeader title="Returns" />
              <ul className="divide-y divide-border text-sm">
                {s.returns.map((r) => (
                  <li key={r.id} className="flex justify-between px-5 py-2.5"><Link to={`/returns/${r.id}`} className="hover:text-primary">{r.number}</Link><span><StatusBadge status={r.status} /> <span className="num">{formatINR(r.refund_total)}</span></span></li>
                ))}
              </ul>
            </Card>
          )}
          {s.cogs_total !== null && (
            <Card><CardBody className="text-sm"><p className="flex justify-between"><span className="text-muted">Cost of goods</span><span className="num">{formatINR(s.cogs_total)}</span></p>
              <p className="flex justify-between"><span className="text-muted">Gross margin</span><span className="num">{formatINR(Number(s.taxable_total) - Number(s.cogs_total))}</span></p>
              {!s.cost_complete && <p className="mt-1 text-xs text-warning">Some items had no cost data.</p>}</CardBody></Card>
          )}
        </div>
      </div>
      <ConfirmDialog open={voidOpen} onOpenChange={setVoidOpen} tone="danger" title="Void this sale?" confirmLabel={can('pos.void') ? 'Void sale' : 'Request void'} loading={voidSale.isPending}
        description="Allowed only while the register session is open. Stock is restocked, payments are refunded by the original method and the invoice is marked cancelled (its number is never reused)."
        onConfirm={() => reason.length >= 3 ? voidSale.mutate() : toast.error('Enter a reason')}>
        <Field label="Reason" required><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </ConfirmDialog>
    </div>
  )
}

function Line({ l, v }: { l: string; v: string }) {
  return <div className="flex justify-between"><dt className="text-muted">{l}</dt><dd className="num">{formatINR(v)}</dd></div>
}
