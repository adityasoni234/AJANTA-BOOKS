import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import * as React from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { DataTable } from '@/components/common/DataTable'
import { SearchInput } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { NativeSelect } from '@/components/ui/input'
import { api, type Page } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useDebounced } from '@/lib/hooks'
import { formatDate, formatINR } from '@/lib/utils'
import type { PO } from './types'

const FILTERS: Record<string, string> = {
  '': 'All orders', 'DRAFT,PENDING_APPROVAL': 'Draft / awaiting approval', 'APPROVED,ISSUED,PARTIALLY_RECEIVED': 'Open (to receive)',
  'RECEIVED,CLOSED': 'Received / closed', CANCELLED: 'Cancelled',
}

export default function PurchaseOrdersPage() {
  const { can, locationId } = useAuth()
  const navigate = useNavigate()
  const [status, setStatus] = React.useState('')
  const [q, setQ] = React.useState('')
  const [page, setPage] = React.useState(1)
  const dq = useDebounced(q)
  React.useEffect(() => setPage(1), [status, dq, locationId])
  const list = useQuery({
    queryKey: ['pos', status, dq, page, locationId],
    queryFn: () => api.get<Page<PO>>('/purchase-orders', { status, q: dq, page, page_size: 25, location_id: locationId ?? undefined }),
    placeholderData: keepPreviousData,
  })
  return (
    <div>
      <PageHeader title="Purchase orders" description="Draft → approval → issue → receive → supplier invoice → payment."
        actions={can('purchasing.create') && <Button asChild><Link to="/purchasing/orders/new"><Plus /> New purchase order</Link></Button>} />
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-border p-3">
          <SearchInput value={q} onChange={setQ} placeholder="PO number…" className="w-full sm:w-56" />
          <NativeSelect aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-full sm:w-60">
            {Object.entries(FILTERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </NativeSelect>
        </div>
        <DataTable
          rows={list.data?.items}
          loading={list.isFetching}
          error={list.error}
          rowKey={(p) => p.id}
          onRowClick={(p) => navigate(`/purchasing/orders/${p.id}`)}
          page={page}
          pageSize={25}
          total={list.data?.total}
          onPageChange={setPage}
          empty={{ title: 'No purchase orders' }}
          columns={[
            { key: 'n', header: 'PO', cell: (p) => <span className="font-medium">{p.number}</span> },
            { key: 's', header: 'Supplier', cell: (p) => p.supplier_name },
            { key: 'l', header: 'Deliver to', hideBelow: 'md', cell: (p) => p.location_name },
            { key: 'd', header: 'Order date', hideBelow: 'md', cell: (p) => formatDate(p.order_date) },
            { key: 'e', header: 'Expected', hideBelow: 'lg', cell: (p) => formatDate(p.expected_date) },
            { key: 't', header: 'Total', align: 'right', cell: (p) => formatINR(p.total) },
            { key: 'st', header: 'Status', cell: (p) => <StatusBadge status={p.status} /> },
          ]}
        />
      </Card>
    </div>
  )
}
