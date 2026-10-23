import { keepPreviousData, useQuery } from '@tanstack/react-query'
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { DataTable } from '@/components/common/DataTable'
import { DateRange, SearchInput } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { Badge, StatusBadge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { NativeSelect } from '@/components/ui/input'
import { api, type Page } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useDateRange, useDebounced } from '@/lib/hooks'
import { usePaymentMethods } from '@/lib/queries'
import { formatDate, formatINR } from '@/lib/utils'

interface SaleRow { id: string; invoice_number: string | null; doc_type: string | null; location_name: string; customer_name: string | null; status: string; grand_total: string; discount_total: string; tax_total: string; balance_due: string; items: number; cashier: string | null; created_at: string }

export default function SalesPage() {
  const { locationId, location } = useAuth()
  const navigate = useNavigate()
  const range = useDateRange(6)
  const [q, setQ] = React.useState('')
  const [status, setStatus] = React.useState('')
  const [method, setMethod] = React.useState('')
  const [credit, setCredit] = React.useState(false)
  const [page, setPage] = React.useState(1)
  const dq = useDebounced(q)
  const methods = usePaymentMethods()
  React.useEffect(() => setPage(1), [dq, status, method, credit, range.from, range.to, locationId])
  const list = useQuery({
    queryKey: ['sales', dq, status, method, credit, range.from, range.to, page, locationId],
    queryFn: () => api.get<Page<SaleRow>>('/sales', { q: dq, status, payment_method_id: method, has_balance: credit || undefined, date_from: range.from, date_to: range.to, page, page_size: 25, location_id: locationId ?? undefined }),
    placeholderData: keepPreviousData,
  })
  return (
    <div>
      <PageHeader title="Sales & invoices" description={location ? location.name : 'All your outlets'} actions={<DateRange from={range.from} to={range.to} onChange={range.set} />} />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <SearchInput value={q} onChange={setQ} placeholder="Invoice no., customer name or phone…" />
          <NativeSelect aria-label="Status" className="w-full sm:w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option><option value="COMPLETED">Completed</option><option value="CANCELLED">Cancelled</option>
          </NativeSelect>
          <NativeSelect aria-label="Payment method" className="w-full sm:w-44" value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="">Any payment method</option>
            {(methods.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </NativeSelect>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={credit} onChange={(e) => setCredit(e.target.checked)} /> With balance due</label>
        </div>
        <DataTable
          rows={list.data?.items}
          loading={list.isFetching}
          error={list.error}
          rowKey={(s) => s.id}
          onRowClick={(s) => navigate(`/sales/${s.id}`)}
          page={page}
          pageSize={25}
          total={list.data?.total}
          onPageChange={setPage}
          empty={{ title: 'No sales in this period' }}
          columns={[
            { key: 'n', header: 'Invoice', cell: (s) => <><p className="num font-medium">{s.invoice_number}</p><p className="text-xs text-muted">{s.doc_type === 'TAX_INVOICE' ? 'Tax invoice' : 'Bill of supply'}</p></> },
            { key: 'd', header: 'Date', cell: (s) => formatDate(s.created_at, true) },
            { key: 'c', header: 'Customer', cell: (s) => s.customer_name ?? <span className="text-muted">Walk-in</span> },
            { key: 'l', header: 'Outlet', hideBelow: 'lg', cell: (s) => s.location_name },
            { key: 'i', header: 'Items', align: 'right', hideBelow: 'md', cell: (s) => s.items },
            { key: 'u', header: 'Cashier', hideBelow: 'lg', cell: (s) => s.cashier },
            { key: 't', header: 'Total', align: 'right', cell: (s) => <>{formatINR(s.grand_total)}{Number(s.balance_due) > 0 && <Badge tone="warning" className="ml-1">due {formatINR(s.balance_due)}</Badge>}</> },
            { key: 's', header: 'Status', cell: (s) => <StatusBadge status={s.status} /> },
          ]}
        />
      </Card>
    </div>
  )
}
