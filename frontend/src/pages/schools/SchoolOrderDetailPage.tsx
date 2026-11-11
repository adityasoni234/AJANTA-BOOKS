import { useMutation, useQuery } from '@tanstack/react-query'
import { Mail, Send } from 'lucide-react'
import * as React from 'react'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { PageHeader } from '@/components/common/PageHeader'
import { ErrorState, PageLoader } from '@/components/common/States'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { LIVE_REFRESH_MS } from '@/lib/queries'
import { formatDate, formatINR } from '@/lib/utils'
import { AuthorEmailDialog } from './AuthorEmailDialog'
import { classLabel, type SchoolOrder } from './types'

const EMAILABLE = ['APPROVED', 'ISSUED', 'PARTIALLY_RECEIVED']

export default function SchoolOrderDetailPage() {
  const { id } = useParams()
  const { can } = useAuth()
  const q = useQuery({ queryKey: ['school-order', id], queryFn: () => api.get<SchoolOrder>(`/school-orders/${id}`), refetchInterval: LIVE_REFRESH_MS })
  const [emailPo, setEmailPo] = React.useState<string | null>(null)
  const issue = useMutation({
    mutationFn: (poId: string) => api.post<{ number: string }>(`/purchase-orders/${poId}/issue`),
    onSuccess: (p) => { toast.success(`${p.number} marked as issued`); void q.refetch() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (q.isLoading) return <PageLoader />
  if (!q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const o = q.data
  const canOrder = can('purchasing.create')
  return (
    <div>
      <PageHeader title={o.number} description={`${o.school_name} · ${o.academic_year} · deliver to ${o.location_name}`}
        crumbs={[{ label: 'Schools', to: '/schools' }, { label: o.school_code, to: `/schools/${o.school_id}` }, { label: o.number }]} />
      <div className="space-y-6">
        <Card>
          <CardHeader title="Purchase orders by author"
            description="1. Open the email and send it from your mail app. 2. Mark the order as issued. 3. Receive the books when they arrive." />
          <Table>
            <THead><TR><TH>Author</TH><TH>Purchase order</TH><TH className="text-right">Copies</TH><TH className="hidden text-right sm:table-cell">Total</TH><TH>Email</TH><TH /></TR></THead>
            <TBody>
              {o.purchase_orders.map((p) => (
                <TR key={p.id}>
                  <TD><p className="whitespace-nowrap font-medium">{p.author_name ?? p.supplier_name}</p><p className="max-w-56 truncate text-xs text-muted" title={p.author_email ?? undefined}>{p.author_email ?? 'no email'}</p></TD>
                  <TD><Link to={`/purchasing/orders/${p.id}`} className="whitespace-nowrap font-medium hover:text-primary">{p.number}</Link><div className="mt-0.5"><StatusBadge status={p.status} /></div></TD>
                  <TD className="num text-right">{p.copies}{p.received > 0 && <span className="block text-[11px] text-muted">{p.received} received</span>}</TD>
                  <TD className="num hidden text-right sm:table-cell">{formatINR(p.total)}</TD>
                  <TD className="text-xs">{p.email_opened_at ? <span title="Opened in a mail app; sending can't be confirmed">Opened {formatDate(p.email_opened_at, true)}</span> : <span className="text-muted">Not opened</span>}</TD>
                  <TD>
                    <div className="flex flex-wrap justify-end gap-2">
                      {canOrder && EMAILABLE.includes(p.status) && <Button size="sm" variant={p.email_opened_at ? 'secondary' : 'primary'} onClick={() => setEmailPo(p.id)}><Mail /> Email author</Button>}
                      {canOrder && p.status === 'APPROVED' && p.email_opened_at && <Button size="sm" variant="secondary" loading={issue.isPending && issue.variables === p.id} onClick={() => issue.mutate(p.id)}><Send /> Mark issued</Button>}
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          {o.purchase_orders.some((p) => p.status === 'PENDING_APPROVAL') &&
            <CardBody className="border-t border-border text-sm text-amber-700">Orders awaiting approval can be emailed once approved in Approvals.</CardBody>}
        </Card>
        <Card>
          <CardHeader title="Details" />
          <CardBody className="space-y-1.5 text-sm">
            <p><span className="text-muted">Classes:</span> {o.classes.map((c) => `${classLabel(c.class_name)} × ${c.sets} sets`).join(', ')}</p>
            <p><span className="text-muted">Created:</span> {formatDate(o.created_at, true)} by {o.created_by_name}</p>
            {o.notes && <p className="pt-2 text-slate-600">{o.notes}</p>}
          </CardBody>
        </Card>
      </div>
      <AuthorEmailDialog poId={emailPo} open={emailPo !== null} onOpenChange={(v) => !v && setEmailPo(null)} onOpened={() => void q.refetch()} />
    </div>
  )
}
