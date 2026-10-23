import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, X } from 'lucide-react'
import * as React from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState, ErrorState, LoadingRows } from '@/components/common/States'
import { Badge, StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, NativeSelect } from '@/components/ui/input'
import { api, errorMessage, type Page } from '@/lib/api'
import { formatDate, formatINR, titleCase } from '@/lib/utils'

interface Approval {
  id: string; type: string; status: string; title: string; location_name: string | null; entity_type: string | null; entity_id: string | null; amount: string | null
  reason: string | null; payload: Record<string, unknown>; requested_by: string | null; requested_at: string; decided_by: string | null; decided_at: string | null; decision_note: string | null; can_decide: boolean
}
const LINK: Record<string, (id: string) => string> = {
  purchase_order: (id) => `/purchasing/orders/${id}`, stock_transfer: (id) => `/transfers/${id}`, return: (id) => `/returns/${id}`, sale: (id) => `/sales/${id}`,
  stock_adjustment: () => '/inventory/adjustments', expense: () => '/finance/expenses',
}

export default function ApprovalsPage() {
  const qc = useQueryClient()
  const [status, setStatus] = React.useState('PENDING')
  const [type, setType] = React.useState('')
  const [notes, setNotes] = React.useState<Record<string, string>>({})
  const q = useQuery({ queryKey: ['approvals', status, type], queryFn: () => api.get<Page<Approval>>('/approvals', { status, type, page_size: 100 }), placeholderData: keepPreviousData, refetchInterval: 30_000 })
  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) => api.post(`/approvals/${id}/decision`, { approve, note: notes[id] || null }),
    onSuccess: (_, v) => { toast.success(v.approve ? 'Approved' : 'Rejected'); void qc.invalidateQueries({ queryKey: ['approvals'] }); void qc.invalidateQueries({ queryKey: ['notifications'] }); void qc.invalidateQueries({ queryKey: ['dashboard'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <div className="max-w-5xl">
      <PageHeader title="Approval center" description="Purchase orders, stock adjustments, transfers, discounts, refunds, voids and expenses that exceed policy limits. You cannot approve your own requests."
        actions={<>
          <NativeSelect aria-label="Type" className="w-44" value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{['PURCHASE_ORDER', 'STOCK_ADJUSTMENT', 'TRANSFER', 'DISCOUNT', 'REFUND', 'VOID', 'EXPENSE'].map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}</NativeSelect>
          <NativeSelect aria-label="Status" className="w-36" value={status} onChange={(e) => setStatus(e.target.value)}><option value="PENDING">Pending</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option><option value="">All</option></NativeSelect>
        </>} />
      {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data ? <LoadingRows /> : q.data.items.length === 0 ? (
        <Card><EmptyState title={status === 'PENDING' ? 'Nothing waiting for approval' : 'No requests'} /></Card>
      ) : (
        <div className="space-y-3">
          {q.data.items.map((a) => (
            <Card key={a.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="primary">{titleCase(a.type)}</Badge><StatusBadge status={a.status} />
                    {a.location_name && <span className="text-xs text-muted">{a.location_name}</span>}
                  </div>
                  <p className="mt-1.5 font-medium">{a.title}</p>
                  <p className="text-xs text-muted">Requested by {a.requested_by} · {formatDate(a.requested_at, true)}{a.amount && ` · ${formatINR(a.amount)}`}</p>
                  {a.reason && <p className="mt-1 text-sm text-slate-600">“{a.reason}”</p>}
                  {Array.isArray(a.payload.items) && <p className="mt-1 text-xs text-muted">{(a.payload.items as { title: string; qty: number }[]).map((i) => `${i.title} ×${i.qty}`).join(', ')}</p>}
                  {a.decided_by && <p className="mt-1 text-xs text-muted">{titleCase(a.status)} by {a.decided_by} · {formatDate(a.decided_at, true)}{a.decision_note ? ` — ${a.decision_note}` : ''}</p>}
                  {a.entity_type && a.entity_id && LINK[a.entity_type] && <Link to={LINK[a.entity_type](a.entity_id)} className="mt-1 inline-block text-xs text-primary hover:underline">Open record →</Link>}
                </div>
                {a.can_decide && (
                  <div className="flex w-full flex-col gap-2 sm:w-64">
                    <Input placeholder="Note (optional)" aria-label="Decision note" value={notes[a.id] ?? ''} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} />
                    <div className="flex gap-2">
                      <Button variant="secondary" className="flex-1" loading={decide.isPending && decide.variables?.id === a.id && !decide.variables.approve} onClick={() => decide.mutate({ id: a.id, approve: false })}><X /> Reject</Button>
                      <Button className="flex-1" loading={decide.isPending && decide.variables?.id === a.id && decide.variables.approve} onClick={() => decide.mutate({ id: a.id, approve: true })}><Check /> Approve</Button>
                    </div>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
