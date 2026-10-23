import { useQuery } from '@tanstack/react-query'
import { Printer } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { PageHeader } from '@/components/common/PageHeader'
import { ErrorState, PageLoader } from '@/components/common/States'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table'
import { api } from '@/lib/api'
import { formatDate, formatINR, titleCase } from '@/lib/utils'
import type { ReturnDetail } from './types'

export default function ReturnDetailPage() {
  const { id } = useParams()
  const q = useQuery({ queryKey: ['return', id], queryFn: () => api.get<ReturnDetail>(`/returns/${id}`) })
  if (q.isLoading) return <PageLoader />
  if (!q.data) return <ErrorState error={q.error} />
  const r = q.data
  return (
    <div className="max-w-5xl">
      <PageHeader title={<span className="flex items-center gap-3">Return {r.number} <StatusBadge status={r.status} /></span>}
        description={`${r.location_name} · ${formatDate(r.created_at, true)} · by ${r.created_by}`}
        crumbs={[{ label: 'Returns', to: '/returns' }, { label: r.number }]}
        actions={r.credit_note && <Button variant="secondary" asChild><a href={`/returns/${r.id}/print?format=a4`} target="_blank" rel="noreferrer"><Printer /> Credit note</a></Button>} />
      {r.status === 'PENDING_APPROVAL' && <div className="mb-4 rounded-md border border-amber-200 bg-warning-soft px-4 py-3 text-sm text-amber-800">Awaiting manager approval. Stock and refund are applied once approved (<Link className="underline" to="/approvals">Approvals</Link>).</div>}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Returned items" description={`Against invoice ${r.original_invoice_number}`} />
          <Table>
            <THead><TR><TH>Item</TH><TH className="text-right">Qty</TH><TH>Disposition</TH><TH className="text-right">Taxable</TH><TH className="text-right">GST</TH><TH className="text-right">Refund</TH></TR></THead>
            <TBody>
              {r.lines.map((l) => (
                <TR key={l.sale_line_id}>
                  <TD>{l.title}</TD><TD className="num text-right">{l.qty}</TD><TD>{titleCase(l.disposition)} · {titleCase(l.condition)}</TD>
                  <TD className="num text-right">{formatINR(l.taxable_value)}</TD><TD className="num text-right">{formatINR(Number(l.cgst) + Number(l.sgst) + Number(l.igst))}</TD>
                  <TD className="num text-right">{formatINR(l.line_total)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
        <Card>
          <CardHeader title="Refund" />
          <CardBody className="space-y-1.5 text-sm">
            <p className="flex justify-between"><span className="text-muted">Taxable</span><span className="num">{formatINR(r.taxable_total)}</span></p>
            <p className="flex justify-between"><span className="text-muted">GST reversed</span><span className="num">{formatINR(Number(r.cgst_total) + Number(r.sgst_total) + Number(r.igst_total))}</span></p>
            {Number(r.round_off) !== 0 && <p className="flex justify-between"><span className="text-muted">Round off</span><span className="num">{formatINR(r.round_off)}</span></p>}
            <p className="flex justify-between border-t border-border pt-1.5 font-semibold"><span>Total refund</span><span className="num">{formatINR(r.refund_total)}</span></p>
            <p className="text-muted">Via {r.refund_method}{r.refund_reference ? ` · ${r.refund_reference}` : ''}</p>
            <p className="text-muted">Reason: {r.reason}</p>
            {r.credit_note && <p className="text-muted">Credit note {r.credit_note.number}</p>}
            <Button variant="link" asChild><Link to={`/sales/${r.sale_id}`}>View original sale →</Link></Button>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}
