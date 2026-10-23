import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as React from 'react'
import { useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { BookSearch } from '@/components/common/BookSearch'
import { DataTable } from '@/components/common/DataTable'
import { PageHeader } from '@/components/common/PageHeader'
import { ErrorState, PageLoader } from '@/components/common/States'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/ui/misc'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDate } from '@/lib/utils'

interface Line { book_id: string; title: string; sku: string; counted_qty: number; system_qty: number; variance: number }
interface ST { id: string; number: string; location_name: string; status: string; created_at: string; posted_at: string | null; lines: Line[] }

export default function StocktakePage() {
  const { id } = useParams()
  const { can } = useAuth()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['stocktake', id], queryFn: () => api.get<ST>(`/inventory/stocktakes/${id}`) })
  const [confirm, setConfirm] = React.useState<'post' | 'cancel' | null>(null)
  const count = useMutation({
    mutationFn: (body: { book_id: string; counted_qty: number; mode: 'SET' | 'ADD' }[]) => api.post<ST>(`/inventory/stocktakes/${id}/counts`, body),
    onSuccess: (d) => qc.setQueryData(['stocktake', id], d),
    onError: (e) => toast.error(errorMessage(e)),
  })
  const act = useMutation({
    mutationFn: (what: 'post' | 'cancel') => api.post<{ adjustment_number?: string | null; adjustment_status?: string | null }>(`/inventory/stocktakes/${id}/${what}`),
    onSuccess: (r, what) => {
      toast.success(what === 'post' ? (r.adjustment_number ? `Posted. Variance adjustment ${r.adjustment_number} (${r.adjustment_status?.toLowerCase().replace('_', ' ')})` : 'Posted — no variances') : 'Stocktake cancelled')
      setConfirm(null)
      void q.refetch()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (q.isLoading) return <PageLoader />
  if (!q.data) return <ErrorState error={q.error} />
  const st = q.data
  const editable = st.status === 'OPEN' && can('inventory.stocktake')
  const variances = st.lines.filter((l) => l.variance !== 0).length
  return (
    <div>
      <PageHeader title={`Stocktake ${st.number}`} description={`${st.location_name} · started ${formatDate(st.created_at, true)}`} crumbs={[{ label: 'Stocktakes', to: '/inventory/adjustments?tab=stocktakes' }, { label: st.number }]}
        actions={<>
          <StatusBadge status={st.status} />
          {editable && <Button variant="secondary" onClick={() => setConfirm('cancel')}>Cancel count</Button>}
          {editable && <Button disabled={!st.lines.length} onClick={() => setConfirm('post')}>Post stocktake</Button>}
        </>} />
      {editable && (
        <Card className="mb-4">
          <CardBody>
            <p className="mb-2 text-xs text-muted">Scan each item: every scan adds 1 to its count. Edit counts directly in the table below.</p>
            <BookSearch autoFocus onSelect={(b) => count.mutate([{ book_id: b.id, counted_qty: 1, mode: 'ADD' }])} placeholder="Scan barcode or search to count…" />
          </CardBody>
        </Card>
      )}
      <Card>
        <DataTable
          rows={st.lines}
          rowKey={(l) => l.book_id}
          empty={{ title: 'Nothing counted yet', description: 'Scan items to begin counting.' }}
          columns={[
            { key: 't', header: 'Book', cell: (l) => <><p className="font-medium">{l.title}</p><p className="text-xs text-muted">{l.sku}</p></> },
            { key: 's', header: 'System qty', align: 'right', cell: (l) => l.system_qty },
            { key: 'c', header: 'Counted', align: 'right', cell: (l) => editable ? (
              <Input key={`${l.book_id}-${l.counted_qty}`} type="number" min={0} aria-label={`Counted quantity for ${l.title}`} defaultValue={l.counted_qty} className="ml-auto w-24 text-right"
                onBlur={(e) => { const v = Number(e.target.value); if (v !== l.counted_qty && v >= 0) count.mutate([{ book_id: l.book_id, counted_qty: v, mode: 'SET' }]) }} />
            ) : l.counted_qty },
            { key: 'v', header: 'Variance', align: 'right', cell: (l) => <span className={l.variance < 0 ? 'text-danger' : l.variance > 0 ? 'text-success' : 'text-muted'}>{l.variance > 0 ? '+' : ''}{l.variance}</span> },
          ]}
        />
      </Card>
      <ConfirmDialog open={confirm === 'post'} onOpenChange={(o) => !o && setConfirm(null)} title="Post stocktake?" loading={act.isPending} onConfirm={() => act.mutate('post')}
        description={`${variances} line(s) have variances. A stock adjustment will be created for them (it may require approval). Items not counted are not changed.`} confirmLabel="Post" />
      <ConfirmDialog open={confirm === 'cancel'} onOpenChange={(o) => !o && setConfirm(null)} title="Cancel this stocktake?" tone="danger" loading={act.isPending} onConfirm={() => act.mutate('cancel')}
        description="Counts will be discarded. Stock levels are not affected." confirmLabel="Cancel stocktake" />
    </div>
  )
}
