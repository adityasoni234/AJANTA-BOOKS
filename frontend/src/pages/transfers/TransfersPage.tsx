import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ArrowRight, Plus } from 'lucide-react'
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
import { formatDate } from '@/lib/utils'
import type { Transfer } from './types'

const STATUS_GROUPS: Record<string, string> = {
  '': 'All transfers', 'REQUESTED,APPROVED': 'Awaiting approval / dispatch', 'IN_TRANSIT,PARTIALLY_RECEIVED': 'In transit',
  DISCREPANCY: 'Discrepancies', COMPLETED: 'Completed', DRAFT: 'Drafts', 'CANCELLED,REJECTED': 'Cancelled / rejected',
}

export default function TransfersPage() {
  const { can, locationId } = useAuth()
  const navigate = useNavigate()
  const [status, setStatus] = React.useState('')
  const [direction, setDirection] = React.useState('')
  const [q, setQ] = React.useState('')
  const [page, setPage] = React.useState(1)
  const dq = useDebounced(q)
  React.useEffect(() => setPage(1), [status, direction, dq, locationId])
  const list = useQuery({
    queryKey: ['transfers', status, direction, dq, page, locationId],
    queryFn: () => api.get<Page<Transfer>>('/transfers', { status, q: dq, page, page_size: 25, location_id: locationId ?? undefined, direction: locationId ? direction || undefined : undefined }),
    placeholderData: keepPreviousData,
  })
  return (
    <div>
      <PageHeader title="Stock transfers" description="Warehouse-to-outlet and outlet-to-outlet movements with full in-transit tracking."
        actions={can('transfers.create') && <Button asChild><Link to="/transfers/new"><Plus /> New transfer</Link></Button>} />
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-border p-3">
          <SearchInput value={q} onChange={setQ} placeholder="Transfer number…" className="w-full sm:w-56" />
          <NativeSelect aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-full sm:w-60">
            {Object.entries(STATUS_GROUPS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </NativeSelect>
          {locationId && (
            <NativeSelect aria-label="Direction" value={direction} onChange={(e) => setDirection(e.target.value)} className="w-full sm:w-40">
              <option value="">In & out</option><option value="IN">Inbound</option><option value="OUT">Outbound</option>
            </NativeSelect>
          )}
        </div>
        <DataTable
          rows={list.data?.items}
          loading={list.isFetching}
          error={list.error}
          rowKey={(t) => t.id}
          onRowClick={(t) => navigate(`/transfers/${t.id}`)}
          page={page}
          pageSize={25}
          total={list.data?.total}
          onPageChange={setPage}
          empty={{ title: 'No transfers', description: 'Request stock from the warehouse or another outlet.' }}
          columns={[
            { key: 'n', header: 'Number', cell: (t) => <span className="font-medium">{t.number}</span> },
            { key: 'r', header: 'Route', cell: (t) => <span className="flex items-center gap-1.5">{t.source_location_name}<ArrowRight className="size-3.5 text-subtle" />{t.dest_location_name}</span> },
            { key: 'u', header: 'Units', align: 'right', cell: (t) => t.total_units },
            { key: 'b', header: 'Requested by', hideBelow: 'md', cell: (t) => t.created_by_name },
            { key: 'd', header: 'Created', hideBelow: 'md', cell: (t) => formatDate(t.created_at) },
            { key: 's', header: 'Status', cell: (t) => <StatusBadge status={t.status} /> },
          ]}
        />
      </Card>
    </div>
  )
}
