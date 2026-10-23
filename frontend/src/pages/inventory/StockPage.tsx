import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ClipboardCheck, Download } from 'lucide-react'
import * as React from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { DataTable, type Column } from '@/components/common/DataTable'
import { SearchInput } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { StatCard } from '@/components/common/StatCard'
import { Badge, StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { NativeSelect } from '@/components/ui/input'
import { api, type Page } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useDebounced } from '@/lib/hooks'
import { formatINR, formatNumber } from '@/lib/utils'

interface Balance {
  location_id: string; location_name: string; book_id: string; sku: string; isbn13: string | null; title: string; authors: string[]
  tracking_mode: string; on_hand: number; reserved: number; available: number; damaged: number; quarantined: number; in_transit: number
  reorder_level: number; reorder_qty: number; stock_status: 'OK' | 'LOW' | 'OUT'; selling_price: string; avg_cost: string | null; stock_value: string | null
}
interface Summary { location_id: string; location_name: string; location_type: string; on_hand: number; reserved: number; unsellable: number; in_transit: number; titles_in_stock: number; value: string | null; items_missing_cost: number | null }

export default function StockPage() {
  const { locationId, location, can } = useAuth()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const status = params.get('status') ?? ''
  const [q, setQ] = React.useState('')
  const [page, setPage] = React.useState(1)
  const dq = useDebounced(q)
  React.useEffect(() => setPage(1), [dq, status, locationId])
  const list = useQuery({
    queryKey: ['inventory', locationId, dq, status, page],
    queryFn: ({ signal }) => api.get<Page<Balance>>('/inventory', { location_id: locationId ?? undefined, q: dq, status, page, page_size: 30 }, signal),
    placeholderData: keepPreviousData,
  })
  const summary = useQuery({ queryKey: ['inventory-summary'], queryFn: () => api.get<Summary[]>('/inventory/summary') })
  const scoped = (summary.data ?? []).filter((s) => !locationId || s.location_id === locationId)
  const totals = scoped.reduce((a, s) => ({
    on_hand: a.on_hand + s.on_hand, transit: a.transit + s.in_transit, unsellable: a.unsellable + s.unsellable,
    value: s.value === null ? null : (a.value ?? 0) + Number(s.value), titles: a.titles + s.titles_in_stock,
  }), { on_hand: 0, transit: 0, unsellable: 0, value: 0 as number | null, titles: 0 })

  const cols: Column<Balance>[] = [
    { key: 't', header: 'Book', cell: (r) => <div className="min-w-0"><p className="truncate font-medium">{r.title}</p><p className="truncate text-xs text-muted">{r.isbn13 ?? r.sku}{r.tracking_mode === 'COPY' && ' · copy-tracked'}</p></div> },
    ...(!locationId ? [{ key: 'l', header: 'Location', cell: (r: Balance) => r.location_name }] : []),
    { key: 'a', header: 'Available', align: 'right', cell: (r) => <span className="font-medium">{r.available}</span> },
    { key: 'o', header: 'On hand', align: 'right', hideBelow: 'md', cell: (r) => r.on_hand },
    { key: 'r', header: 'Reserved', align: 'right', hideBelow: 'lg', cell: (r) => r.reserved || '—' },
    { key: 'd', header: 'Damaged / Q', align: 'right', hideBelow: 'lg', cell: (r) => (r.damaged || r.quarantined) ? `${r.damaged} / ${r.quarantined}` : '—' },
    { key: 'it', header: 'In transit', align: 'right', hideBelow: 'md', cell: (r) => r.in_transit || '—' },
    { key: 'rl', header: 'Reorder at', align: 'right', hideBelow: 'lg', cell: (r) => r.reorder_level || '—' },
    ...(can('reports.financial') || can('purchasing.view') ? [{ key: 'v', header: 'Value @ cost', align: 'right' as const, hideBelow: 'lg' as const, cell: (r: Balance) => r.stock_value === null ? <Badge tone="warning">No cost</Badge> : formatINR(r.stock_value) }] : []),
    { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.stock_status} label={r.stock_status === 'OK' ? 'In stock' : r.stock_status === 'LOW' ? 'Low' : 'Out'} /> },
  ]

  return (
    <div>
      <PageHeader
        title="Stock"
        description={location ? `Inventory at ${location.name}` : 'Inventory across your locations'}
        actions={
          <>
            {can('reports.export') && <Button variant="secondary" onClick={() => api.download('/reports/stock-analysis', { kind: status === 'OUT' ? 'out' : 'low', location_id: locationId ?? undefined, format: 'csv' }, 'stock_alerts.csv')}><Download /> Export alerts</Button>}
            {can('inventory.stocktake') && <Button variant="secondary" asChild><Link to="/inventory/adjustments?tab=stocktakes"><ClipboardCheck /> Stocktake</Link></Button>}
          </>
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Units on hand" value={formatNumber(totals.on_hand)} hint={`${formatNumber(totals.titles)} titles in stock`} />
        <StatCard label="In transit (inbound)" value={formatNumber(totals.transit)} tone="info" />
        <StatCard label="Damaged / quarantined" value={formatNumber(totals.unsellable)} tone="warning" />
        <StatCard label="Valuation @ weighted avg cost" value={totals.value === null || !(can('reports.financial') || can('purchasing.view')) ? 'Restricted' : formatINR(totals.value)} tone="success" />
      </div>
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <SearchInput value={q} onChange={setQ} placeholder="Search title, ISBN, SKU…" />
          <NativeSelect aria-label="Stock status" className="w-full sm:w-48" value={status} onChange={(e) => { const p = new URLSearchParams(params); if (e.target.value) p.set('status', e.target.value); else p.delete('status'); setParams(p) }}>
            <option value="">All stock lines</option>
            <option value="IN_STOCK">In stock</option>
            <option value="LOW">Low stock</option>
            <option value="OUT">Out of stock</option>
            <option value="DAMAGED">Damaged / quarantined</option>
            <option value="IN_TRANSIT">In transit</option>
          </NativeSelect>
        </div>
        <DataTable
          columns={cols}
          rows={list.data?.items}
          rowKey={(r) => `${r.location_id}-${r.book_id}`}
          loading={list.isFetching}
          error={list.error}
          onRetry={() => list.refetch()}
          onRowClick={(r) => navigate(`/catalog/${r.book_id}`)}
          page={page}
          pageSize={30}
          total={list.data?.total}
          onPageChange={setPage}
          empty={{ title: 'No stock lines match', description: 'Receive goods or transfer stock to see it here.' }}
        />
      </Card>
    </div>
  )
}
