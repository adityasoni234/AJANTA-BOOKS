import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { AlertTriangle, Boxes, IndianRupee, PackageX, Receipt, RotateCcw, Store, Warehouse } from 'lucide-react'
import * as React from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartFrame, ChartTooltip, SERIES, axisProps, compactINR } from '@/components/common/charts'
import { DataTable } from '@/components/common/DataTable'
import { SearchInput } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { StatCard } from '@/components/common/StatCard'
import { EmptyState, ErrorState, PageLoader } from '@/components/common/States'
import { Badge, StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { NativeSelect } from '@/components/ui/input'
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, type Page } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useDebounced } from '@/lib/hooks'
import { LIVE_REFRESH_MS } from '@/lib/queries'
import { formatDate, formatINR, formatNumber } from '@/lib/utils'
import { PERIOD_LABELS, type OutletOverview, type PeriodKey, type SalesByRow } from './types'

const TABS = ['overview', 'stock', 'sales', 'staff'] as const
type Tab = (typeof TABS)[number]

export default function OutletPage() {
  const { id } = useParams()
  const [params, setParams] = useSearchParams()
  const tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'overview'
  const q = useQuery({ queryKey: ['outlet', id], queryFn: () => api.get<OutletOverview>(`/outlets/${id}/overview`), refetchInterval: LIVE_REFRESH_MS })
  if (q.isLoading) return <PageLoader />
  if (!q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const o = q.data
  const loc = o.location
  const Icon = loc.type === 'WAREHOUSE' ? Warehouse : Store
  const address = [loc.address_line1, loc.address_line2, [loc.city, loc.pincode].filter(Boolean).join(' '), loc.state].filter(Boolean).join(', ')
  return (
    <div>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-3"><Icon className="size-6 text-muted" />{loc.name} <Badge>{loc.code}</Badge>{!loc.is_active && <Badge tone="warning">Inactive</Badge>}</span>}
        description={[loc.type === 'WAREHOUSE' ? 'Warehouse' : 'Outlet', address, loc.phone].filter(Boolean).join(' · ')}
        crumbs={[{ label: 'Outlets', to: '/outlets' }, { label: loc.name }]}
      />
      <Tabs value={tab} onValueChange={(v) => setParams(v === 'overview' ? {} : { tab: v }, { replace: true })}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="stock">Stock</TabsTrigger>
          <TabsTrigger value="sales">Sales</TabsTrigger>
          {o.staff && <TabsTrigger value="staff">Staff ({o.staff.length})</TabsTrigger>}
        </TabsList>
        <TabsContent value="overview"><Overview o={o} /></TabsContent>
        <TabsContent value="stock"><StockTab o={o} /></TabsContent>
        <TabsContent value="sales"><SalesTab o={o} /></TabsContent>
        {o.staff && <TabsContent value="staff"><StaffTab o={o} /></TabsContent>}
      </Tabs>
    </div>
  )
}

function Overview({ o }: { o: OutletOverview }) {
  const { can } = useAuth()
  const trend = o.trend.map((t) => ({ label: t.date, value: Number(t.net_sales) }))
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        {(Object.keys(PERIOD_LABELS) as PeriodKey[]).map((k) => {
          const s = o.sales[k]
          const p = o.periods[k]
          return (
            <Card key={k} className="p-4">
              <p className="text-xs font-medium text-muted">{PERIOD_LABELS[k]} · {formatDate(p.from)}{p.from !== p.to ? ` – ${formatDate(p.to)}` : ''}</p>
              <p className="num mt-1.5 text-2xl font-semibold">{formatINR(s.invoice_value)}</p>
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted">Bills</dt><dd className="num text-right">{s.transactions}</dd>
                <dt className="text-muted">Average bill</dt><dd className="num text-right">{formatINR(s.avg_basket)}</dd>
                <dt className="text-muted">Net sales (ex-GST)</dt><dd className="num text-right">{formatINR(s.net_sales)}</dd>
                <dt className="text-muted">Discounts</dt><dd className="num text-right">{formatINR(s.discounts)}</dd>
                <dt className="text-muted">Returns ({s.returns_count})</dt><dd className="num text-right">{formatINR(s.returns_value)}</dd>
                {s.gross_profit !== null && <><dt className="text-muted">Gross profit</dt><dd className="num text-right">{formatINR(s.gross_profit)} <span className="text-muted">({Number(s.gross_margin_pct)}%)</span></dd></>}
                {s.voided > 0 && <><dt className="text-muted">Cancelled bills</dt><dd className="num text-right text-danger">{s.voided}</dd></>}
              </dl>
            </Card>
          )
        })}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Stock ready to sell" value={`${formatNumber(o.stock.available)} units`} hint={`${o.stock.titles_available} titles`} icon={Boxes} />
        <StatCard label="Stock value at selling price" value={formatINR(o.stock.retail_value)} hint={o.stock.cost_value !== null ? `Cost ${formatINR(o.stock.cost_value)}` : undefined} icon={IndianRupee} tone="success" />
        <StatCard label="Low stock" value={o.alerts.low} hint="At or below reorder level" icon={AlertTriangle} tone="warning" />
        <StatCard label="Out of stock" value={o.alerts.out} hint={`${o.alerts.dead} not sold for a long time`} icon={PackageX} tone="danger" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Last 30 days" description="Daily net sales excluding GST" />
          <CardBody>
            {trend.every((t) => t.value === 0) ? <EmptyState title="No sales in the last 30 days" /> : (
              <ChartFrame label="Daily net sales for this location" height={240}>
                <ResponsiveContainer>
                  <AreaChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="fillOutlet" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={SERIES[0]} stopOpacity={0.18} />
                        <stop offset="100%" stopColor={SERIES[0]} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} stroke="#eef2f6" />
                    <XAxis dataKey="label" {...axisProps} tickFormatter={(v: string) => formatDate(v).slice(0, 6)} minTickGap={24} />
                    <YAxis {...axisProps} width={64} tickFormatter={compactINR} />
                    <Tooltip content={<ChartTooltip labelFormatter={(l) => formatDate(String(l))} />} cursor={{ stroke: '#94a3b8', strokeDasharray: '3 3' }} />
                    <Area isAnimationActive={false} type="monotone" dataKey="value" name="Net sales" stroke={SERIES[0]} strokeWidth={2} fill="url(#fillOutlet)" activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartFrame>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Right now" />
          <CardBody className="space-y-3 text-sm [&>p]:gap-3 [&>p>span:last-child]:text-right [&>p>span:last-child]:whitespace-nowrap">
            <div>
              <p className="mb-1 text-xs font-medium text-muted">Open counters</p>
              {o.open_registers.length === 0 ? <p className="text-muted">None open</p> : o.open_registers.map((r) => (
                <p key={r.session_id} className="flex justify-between gap-2"><span>{r.register} · {r.cashier}</span><span className="text-xs text-muted">since {formatDate(r.opened_at, true)}</span></p>
              ))}
            </div>
            <p className="flex justify-between"><span className="text-muted">Transfers in progress</span><Link to="/transfers" className="font-medium hover:text-primary">{o.pending.transfers}</Link></p>
            <p className="flex justify-between"><span className="text-muted">Awaiting approval</span>{can('approvals.view') ? <Link to="/approvals" className="font-medium hover:text-primary">{o.pending.approvals}</Link> : <span>{o.pending.approvals}</span>}</p>
            {o.purchase_commitments && <p className="flex justify-between"><span className="text-muted">Books on order</span><span>{o.purchase_commitments.units_outstanding} units · {o.purchase_commitments.open_orders} POs</span></p>}
            {o.expenses_month !== undefined && <p className="flex justify-between"><span className="text-muted">Expenses this month</span><span className="num">{formatINR(o.expenses_month)}</span></p>}
            <p className="flex justify-between"><span className="text-muted">Damaged / quarantined</span><span>{o.stock.damaged} / {o.stock.quarantined} units</span></p>
            <p className="flex justify-between"><span className="text-muted">Arriving (in transit)</span><span>{o.stock.in_transit} units</span></p>
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <RankCard title="Best sellers this month" rows={o.top_books_month} unit="copies" link={(r) => r.key ? `/catalog/${r.key}` : undefined} />
        <RankCard title="Categories this month" rows={o.categories_month} unit="copies" />
        <RankCard title="Sales by staff this month" rows={o.cashiers_month} unit="items" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Collections this month" description="By payment method, net of refunds" />
          {o.payments_month.length === 0 ? <EmptyState title="No payments this month" /> : (
            <Table>
              <THead><TR><TH>Method</TH><TH className="text-right">Payments</TH><TH className="text-right">Net</TH></TR></THead>
              <TBody>{o.payments_month.map((m) => <TR key={m.code}><TD>{m.method}</TD><TD className="num text-right">{m.count}</TD><TD className="num text-right">{formatINR(m.net)}</TD></TR>)}</TBody>
            </Table>
          )}
        </Card>
        <Card>
          <CardHeader title="Needs restocking" description={`${o.alerts.out} out of stock · ${o.alerts.low} low`}
            actions={<Button size="sm" variant="secondary" asChild><Link to={`/outlets/${o.location.id}?tab=stock`}>See all stock</Link></Button>} />
          {o.out_of_stock.length + o.low_stock.length === 0 ? <EmptyState title="Nothing to restock" /> : (
            <Table>
              <THead><TR><TH>Book</TH><TH className="text-right">Available</TH><TH className="text-right">Reorder at</TH></TR></THead>
              <TBody>
                {[...o.out_of_stock, ...o.low_stock].slice(0, 10).map((r) => (
                  <TR key={r.book_id}>
                    <TD><Link to={`/catalog/${r.book_id}`} className="font-medium hover:text-primary">{r.title}</Link><p className="text-xs text-muted">{r.sku}{r.in_transit ? ` · ${r.in_transit} arriving` : ''}</p></TD>
                    <TD className={`num text-right ${r.available <= 0 ? 'text-danger' : 'text-amber-700'}`}>{r.available}</TD>
                    <TD className="num text-right">{r.reorder_level}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  )
}

function RankCard({ title, rows, unit, link }: { title: string; rows: SalesByRow[]; unit: string; link?: (r: SalesByRow) => string | undefined }) {
  const max = Math.max(...rows.map((r) => Number(r.net_sales)), 1)
  return (
    <Card>
      <CardHeader title={title} description="By net sales" />
      {rows.length === 0 ? <EmptyState title="No sales this month" /> : (
        <CardBody className="space-y-2.5">
          {rows.slice(0, 8).map((r) => {
            const to = link?.(r)
            return (
              <div key={`${r.key}-${r.label}`} className="text-sm">
                <div className="flex justify-between gap-2">
                  {to ? <Link to={to} className="truncate font-medium hover:text-primary">{r.label}</Link> : <span className="truncate font-medium">{r.label}</span>}
                  <span className="num shrink-0">{formatINR(r.net_sales)}</span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-1.5 flex-1 rounded-full bg-surface-2"><div className="h-1.5 rounded-full bg-primary" style={{ width: `${(Number(r.net_sales) / max) * 100}%` }} /></div>
                  <span className="w-20 shrink-0 text-right text-[11px] text-muted">{r.units} {r.units === 1 ? unit.replace(/ies$/, 'y').replace(/s$/, '') : unit}</span>
                </div>
              </div>
            )
          })}
        </CardBody>
      )}
    </Card>
  )
}

interface Balance {
  book_id: string; sku: string; isbn13: string | null; title: string; authors: string[]; on_hand: number; reserved: number; available: number
  damaged: number; quarantined: number; in_transit: number; reorder_level: number; stock_status: 'OK' | 'LOW' | 'OUT'; selling_price: string; stock_value: string | null
}

function StockTab({ o }: { o: OutletOverview }) {
  const navigate = useNavigate()
  const [q, setQ] = React.useState('')
  const [status, setStatus] = React.useState('')
  const [page, setPage] = React.useState(1)
  const dq = useDebounced(q)
  React.useEffect(() => setPage(1), [dq, status])
  const list = useQuery({
    queryKey: ['inventory', o.location.id, dq, status, page],
    queryFn: ({ signal }) => api.get<Page<Balance>>('/inventory', { location_id: o.location.id, q: dq, status, page, page_size: 25 }, signal),
    placeholderData: keepPreviousData,
    refetchInterval: LIVE_REFRESH_MS,
  })
  const s = o.stock
  const states: [string, number, string][] = [
    ['Ready to sell', s.available, 'On hand minus reserved'], ['Reserved', s.reserved, 'Held for outgoing transfers'],
    ['Damaged', s.damaged, 'Not sellable'], ['Quarantined', s.quarantined, 'Awaiting inspection'], ['Arriving', s.in_transit, 'In transit to here'],
  ]
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {states.map(([label, n, hint]) => (
          <Card key={label} className="px-4 py-3"><p className="text-xs text-muted">{label}</p><p className="num mt-1 text-xl font-semibold">{formatNumber(n)}</p><p className="text-[11px] text-muted">{hint}</p></Card>
        ))}
      </div>
      <Card>
        <CardHeader title="What kind of stock" description="Sellable stock on hand by category" />
        {o.stock_by_category.length === 0 ? <EmptyState title="No stock on hand" /> : (
          <Table>
            <THead><TR><TH>Category</TH><TH className="text-right">Titles</TH><TH className="text-right">Units</TH><TH className="text-right">Selling value</TH>{o.stock.cost_value !== null && <TH className="hidden text-right md:table-cell">Cost value</TH>}</TR></THead>
            <TBody>
              {o.stock_by_category.map((c) => (
                <TR key={c.category}>
                  <TD className="font-medium">{c.category}</TD><TD className="num text-right">{c.titles}</TD><TD className="num text-right">{formatNumber(c.units)}</TD>
                  <TD className="num text-right">{formatINR(c.retail_value)}</TD>{c.cost_value !== null && <TD className="num hidden text-right md:table-cell">{formatINR(c.cost_value)}</TD>}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
          <SearchInput value={q} onChange={setQ} placeholder="Title, author, ISBN, SKU…" />
          <NativeSelect aria-label="Stock status" className="w-full sm:w-48" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All stock lines</option><option value="IN_STOCK">In stock</option><option value="LOW">Low stock</option>
            <option value="OUT">Out of stock</option><option value="DAMAGED">Damaged / quarantined</option><option value="IN_TRANSIT">In transit</option>
          </NativeSelect>
        </div>
        <DataTable
          rows={list.data?.items} loading={list.isFetching} error={list.error} onRetry={() => list.refetch()}
          rowKey={(r) => r.book_id} onRowClick={(r) => navigate(`/catalog/${r.book_id}`)}
          page={page} pageSize={25} total={list.data?.total} onPageChange={setPage}
          empty={{ title: 'No matching stock' }}
          columns={[
            { key: 't', header: 'Book', cell: (r) => <><p className="font-medium">{r.title}</p><p className="text-xs text-muted">{[r.authors[0], r.isbn13 ?? r.sku].filter(Boolean).join(' · ')}</p></> },
            { key: 'a', header: 'Ready to sell', align: 'right', cell: (r) => <span className="num">{r.available}</span> },
            { key: 'h', header: 'On hand', align: 'right', hideBelow: 'md', cell: (r) => <span className="num">{r.on_hand}</span> },
            { key: 'x', header: 'Damaged', align: 'right', hideBelow: 'lg', cell: (r) => <span className="num">{r.damaged + r.quarantined}</span> },
            { key: 'i', header: 'Arriving', align: 'right', hideBelow: 'lg', cell: (r) => <span className="num">{r.in_transit}</span> },
            { key: 'p', header: 'Price', align: 'right', hideBelow: 'md', cell: (r) => formatINR(r.selling_price) },
            { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.stock_status} label={r.stock_status === 'OK' ? 'In stock' : r.stock_status === 'LOW' ? 'Low' : 'Out'} /> },
          ]}
        />
      </Card>
    </div>
  )
}

interface SaleRow { id: string; invoice_number: string | null; customer_name: string | null; status: string; grand_total: string; balance_due: string; items: number; cashier: string | null; created_at: string }

function SalesTab({ o }: { o: OutletOverview }) {
  const navigate = useNavigate()
  const { can } = useAuth()
  const [period, setPeriod] = React.useState<PeriodKey>('today')
  const [page, setPage] = React.useState(1)
  React.useEffect(() => setPage(1), [period])
  const p = o.periods[period]
  const list = useQuery({
    queryKey: ['sales', 'outlet', o.location.id, period, page],
    queryFn: () => api.get<Page<SaleRow>>('/sales', { location_id: o.location.id, date_from: p.from, date_to: p.to, page, page_size: 25 }),
    placeholderData: keepPreviousData,
    refetchInterval: LIVE_REFRESH_MS,
    enabled: can('sales.view'),
  })
  const s = o.sales[period]
  if (!can('sales.view')) return <EmptyState title="You don't have access to individual sales" />
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-md border border-border bg-white p-0.5" role="group" aria-label="Sales period">
          {(Object.keys(PERIOD_LABELS) as PeriodKey[]).map((k) => (
            <Button key={k} size="sm" variant={k === period ? 'primary' : 'ghost'} aria-pressed={k === period} onClick={() => setPeriod(k)}>{PERIOD_LABELS[k]}</Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          <Badge tone="primary"><Receipt className="size-3" /> {s.transactions} bill{s.transactions === 1 ? '' : 's'} · {formatINR(s.invoice_value)}</Badge>
          {s.returns_count > 0 && <Badge tone="warning"><RotateCcw className="size-3" /> {s.returns_count} return{s.returns_count === 1 ? '' : 's'} · {formatINR(s.returns_value)}</Badge>}
        </div>
      </div>
      <Card>
        <DataTable
          rows={list.data?.items} loading={list.isFetching} error={list.error} onRetry={() => list.refetch()}
          rowKey={(r) => r.id} onRowClick={(r) => navigate(`/sales/${r.id}`)}
          page={page} pageSize={25} total={list.data?.total} onPageChange={setPage}
          empty={{ title: `No sales ${PERIOD_LABELS[period].toLowerCase()}` }}
          columns={[
            { key: 'n', header: 'Invoice', cell: (r) => <span className="num font-medium">{r.invoice_number}</span> },
            { key: 'd', header: 'Time', cell: (r) => formatDate(r.created_at, true) },
            { key: 'c', header: 'Customer', hideBelow: 'md', cell: (r) => r.customer_name ?? <span className="text-muted">Walk-in</span> },
            { key: 'i', header: 'Items', align: 'right', hideBelow: 'md', cell: (r) => r.items },
            { key: 'u', header: 'Cashier', hideBelow: 'lg', cell: (r) => r.cashier },
            { key: 't', header: 'Total', align: 'right', cell: (r) => <>{formatINR(r.grand_total)}{Number(r.balance_due) > 0 && <Badge tone="warning" className="ml-1">due {formatINR(r.balance_due)}</Badge>}</> },
            { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          ]}
        />
      </Card>
    </div>
  )
}

function StaffTab({ o }: { o: OutletOverview }) {
  return (
    <Card>
      <CardHeader title="People assigned to this location" description="Users with organisation-wide access (such as the owner) are not listed." />
      {!o.staff?.length ? <EmptyState title="No staff assigned" /> : (
        <Table>
          <THead><TR><TH>Name</TH><TH>Role</TH><TH className="hidden md:table-cell">Email</TH><TH className="text-right">Last sign-in</TH></TR></THead>
          <TBody>
            {o.staff.map((u) => (
              <TR key={u.id}>
                <TD><p className="font-medium">{u.full_name}</p>{u.designation && <p className="text-xs text-muted">{u.designation}</p>}</TD>
                <TD>{u.role}</TD><TD className="hidden break-all md:table-cell">{u.email}</TD>
                <TD className="text-right text-xs">{u.last_login_at ? formatDate(u.last_login_at, true) : <span className="text-muted">Never</span>}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  )
}
