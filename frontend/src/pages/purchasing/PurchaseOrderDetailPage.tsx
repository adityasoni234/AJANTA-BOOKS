import { useMutation, useQuery } from '@tanstack/react-query'
import { Check, Mail, PackageCheck, Pencil, Send, X } from 'lucide-react'
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
import { formatDate, formatINR } from '@/lib/utils'
import { AuthorEmailDialog } from '../schools/AuthorEmailDialog'
import { ReceiveGoodsDialog } from './ReceiveGoodsDialog'
import type { PO } from './types'

export default function PurchaseOrderDetailPage() {
  const { id } = useParams()
  const { can, me } = useAuth()
  const q = useQuery({ queryKey: ['po', id], queryFn: () => api.get<PO>(`/purchase-orders/${id}`) })
  const [receive, setReceive] = React.useState(false)
  const [email, setEmail] = React.useState(false)
  const [confirm, setConfirm] = React.useState<null | 'cancel' | 'reject' | 'approve'>(null)
  const [reason, setReason] = React.useState('')
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => api.post<PO>(`/purchase-orders/${id}/${path}`, body),
    onSuccess: (p) => { toast.success(`${p.number} is now ${p.status.toLowerCase().replace(/_/g, ' ')}`); setConfirm(null); setReason(''); void q.refetch() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (q.isLoading) return <PageLoader />
  if (!q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const po = q.data
  const canApprove = po.status === 'PENDING_APPROVAL' && can('purchasing.approve') && po.created_by_name !== me?.full_name
  const received = po.lines.reduce((a, l) => a + l.qty_received, 0)
  return (
    <div>
      <PageHeader
        title={<span className="flex items-center gap-3">{po.number} <StatusBadge status={po.status} /></span>}
        description={`${po.supplier_name} → ${po.location_name}`}
        crumbs={[{ label: 'Purchase orders', to: '/purchasing/orders' }, { label: po.number }]}
        actions={<>
          {po.status === 'DRAFT' && can('purchasing.create') && <Button variant="secondary" asChild><Link to={`/purchasing/orders/${po.id}/edit`}><Pencil /> Edit</Link></Button>}
          {po.status === 'DRAFT' && can('purchasing.create') && <Button loading={act.isPending} onClick={() => act.mutate({ path: 'submit' })}><Send /> Submit</Button>}
          {canApprove && <><Button variant="secondary" onClick={() => setConfirm('reject')}><X /> Reject</Button><Button onClick={() => setConfirm('approve')}><Check /> Approve</Button></>}
          {po.author_id && ['APPROVED', 'ISSUED', 'PARTIALLY_RECEIVED'].includes(po.status) && can('purchasing.create') && <Button variant={po.status === 'APPROVED' ? 'primary' : 'secondary'} onClick={() => setEmail(true)}><Mail /> Email author</Button>}
          {po.status === 'APPROVED' && can('purchasing.create') && <Button variant={po.author_id ? 'secondary' : 'primary'} loading={act.isPending} onClick={() => act.mutate({ path: 'issue' })}><Send /> {po.author_id ? 'Mark issued' : 'Issue to supplier'}</Button>}
          {['ISSUED', 'PARTIALLY_RECEIVED'].includes(po.status) && can('purchasing.receive') && <Button onClick={() => setReceive(true)}><PackageCheck /> Receive goods</Button>}
          {!['RECEIVED', 'CLOSED', 'CANCELLED'].includes(po.status) && can('purchasing.create') && <Button variant="danger-outline" onClick={() => setConfirm('cancel')}>{received ? 'Close short' : 'Cancel'}</Button>}
        </>}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Lines" />
          <Table>
            <THead><TR><TH>Book</TH><TH className="text-right">Ordered</TH><TH className="text-right">Received</TH><TH className="text-right">Outstanding</TH><TH className="text-right">Unit cost</TH><TH className="text-right">GST</TH></TR></THead>
            <TBody>
              {po.lines.map((l) => (
                <TR key={l.id}>
                  <TD><Link to={`/catalog/${l.book_id}`} className="font-medium hover:text-primary">{l.title}</Link><p className="text-xs text-muted">{l.isbn13 ?? l.sku}</p></TD>
                  <TD className="num text-right">{l.qty_ordered}</TD>
                  <TD className="num text-right">{l.qty_received}</TD>
                  <TD className="num text-right">{l.qty_outstanding}{l.qty_cancelled > 0 && <Badge className="ml-1">{l.qty_cancelled} cancelled</Badge>}</TD>
                  <TD className="num text-right">{formatINR(l.unit_cost)}{Number(l.discount_pct) > 0 && <span className="block text-xs text-muted">−{Number(l.discount_pct)}%</span>}</TD>
                  <TD className="num text-right">{Number(l.tax_rate)}%</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <div className="flex justify-end border-t border-border px-5 py-3 text-sm">
            <div className="w-56 space-y-1">
              <div className="flex justify-between"><span className="text-muted">Subtotal</span><span className="num">{formatINR(po.subtotal)}</span></div>
              <div className="flex justify-between"><span className="text-muted">GST</span><span className="num">{formatINR(po.tax_total)}</span></div>
              <div className="flex justify-between font-semibold"><span>Total</span><span className="num">{formatINR(po.total)}</span></div>
            </div>
          </div>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Details" />
            <CardBody className="space-y-1.5 text-sm">
              <p><span className="text-muted">Ordered:</span> {formatDate(po.order_date)}</p>
              <p><span className="text-muted">Expected:</span> {formatDate(po.expected_date)}</p>
              <p><span className="text-muted">Created by:</span> {po.created_by_name}</p>
              <p><span className="text-muted">Approved:</span> {formatDate(po.approved_at, true)}</p>
              <p><span className="text-muted">Issued:</span> {formatDate(po.issued_at, true)}</p>
              {po.school_order_id && <p><span className="text-muted">School order:</span> <Link to={`/schools/orders/${po.school_order_id}`} className="font-medium hover:text-primary">{po.school_order_number}</Link></p>}
              {po.author_name && <p><span className="text-muted">Author:</span> {po.author_name}{po.author_email ? ` · ${po.author_email}` : ''}</p>}
              {po.author_id && <p><span className="text-muted">Order email:</span> {po.email_opened_at ? `opened ${formatDate(po.email_opened_at, true)}` : 'not opened yet'}</p>}
              {po.notes && <p className="pt-2 text-slate-600">{po.notes}</p>}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Goods receipts" />
            <CardBody className="space-y-2 text-sm">
              {po.receipts.length === 0 && <p className="text-muted">Nothing received yet.</p>}
              {po.receipts.map((r) => (
                <div key={r.id} className="flex items-center justify-between">
                  <div><p className="font-medium">{r.number}</p><p className="text-xs text-muted">{formatDate(r.received_at, true)}</p></div>
                  <div className="text-right"><p className="num">{formatINR(r.total_landed)}</p>{r.invoiced ? <Badge tone="success">Invoiced</Badge> : <Badge tone="warning">Awaiting invoice</Badge>}</div>
                </div>
              ))}
              {po.receipts.some((r) => !r.invoiced) && can('finance.manage') && <Button size="sm" variant="secondary" asChild><Link to={`/finance/payables?supplier=${po.supplier_id}`}>Record supplier invoice</Link></Button>}
            </CardBody>
          </Card>
        </div>
      </div>
      <AuthorEmailDialog poId={po.author_id ? po.id : null} open={email} onOpenChange={setEmail} onOpened={() => void q.refetch()} />
      <ReceiveGoodsDialog po={po} open={receive} onOpenChange={(o) => { setReceive(o); if (!o) void q.refetch() }} />
      <ConfirmDialog open={confirm === 'cancel'} onOpenChange={(o) => !o && setConfirm(null)} tone="danger" title={received ? 'Close purchase order short?' : 'Cancel purchase order?'}
        description={received ? 'Outstanding quantities will be cancelled. Received stock is unaffected.' : 'The order will be cancelled.'} confirmLabel="Confirm" loading={act.isPending}
        onConfirm={() => reason.length >= 3 ? act.mutate({ path: 'cancel', body: { reason } }) : toast.error('Enter a reason')}>
        <Field label="Reason" required><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </ConfirmDialog>
      <ConfirmDialog open={confirm === 'approve' || confirm === 'reject'} onOpenChange={(o) => !o && setConfirm(null)} tone={confirm === 'reject' ? 'danger' : 'primary'}
        title={confirm === 'approve' ? `Approve ${po.number} for ${formatINR(po.total)}?` : 'Reject purchase order?'} confirmLabel={confirm === 'approve' ? 'Approve' : 'Reject'} loading={act.isPending}
        onConfirm={() => act.mutate({ path: 'decision', body: { approve: confirm === 'approve', note: reason || null } })}>
        <Field label="Note (optional)"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </ConfirmDialog>
    </div>
  )
}
