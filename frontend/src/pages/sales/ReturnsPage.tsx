import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import * as React from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { DataTable } from '@/components/common/DataTable'
import { DateRange } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { NativeSelect } from '@/components/ui/input'
import { useDateRange } from '@/lib/hooks'
import { api, type Page } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDate, formatINR } from '@/lib/utils'
import type { ReturnDetail } from './types'

export default function ReturnsPage() {
  const { can, locationId } = useAuth()
  const navigate = useNavigate()
  const range = useDateRange(29)
  const [status, setStatus] = React.useState('')
  const [page, setPage] = React.useState(1)
  React.useEffect(() => setPage(1), [status, range.from, range.to, locationId])
  const list = useQuery({
    queryKey: ['returns', status, range.from, range.to, page, locationId],
    queryFn: () => api.get<Page<ReturnDetail>>('/returns', { status, date_from: range.from, date_to: range.to, page, page_size: 25, location_id: locationId ?? undefined }),
    placeholderData: keepPreviousData,
  })
  return (
    <div>
      <PageHeader title="Returns & credit notes" description="Refunds are calculated from the original invoice, never from current prices."
        actions={<><DateRange from={range.from} to={range.to} onChange={range.set} />{can('returns.create') && <Button asChild><Link to="/returns/new"><Plus /> New return</Link></Button>}</>} />
      <Card>
        <div className="border-b border-border p-3">
          <NativeSelect aria-label="Status" className="w-full sm:w-48" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option><option value="COMPLETED">Completed</option><option value="PENDING_APPROVAL">Pending approval</option><option value="REJECTED">Rejected</option>
          </NativeSelect>
        </div>
        <DataTable
          rows={list.data?.items}
          loading={list.isFetching}
          error={list.error}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/returns/${r.id}`)}
          page={page}
          pageSize={25}
          total={list.data?.total}
          onPageChange={setPage}
          empty={{ title: 'No returns in this period' }}
          columns={[
            { key: 'n', header: 'Return', cell: (r) => <><p className="font-medium">{r.number}</p><p className="text-xs text-muted">{r.credit_note?.number ?? 'No credit note yet'}</p></> },
            { key: 'd', header: 'Date', cell: (r) => formatDate(r.created_at, true) },
            { key: 'i', header: 'Original invoice', cell: (r) => r.original_invoice_number },
            { key: 'c', header: 'Customer', hideBelow: 'md', cell: (r) => r.customer_name ?? 'Walk-in' },
            { key: 'm', header: 'Refund via', hideBelow: 'md', cell: (r) => r.refund_method },
            { key: 'a', header: 'Refund', align: 'right', cell: (r) => formatINR(r.refund_total) },
            { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          ]}
        />
      </Card>
    </div>
  )
}
