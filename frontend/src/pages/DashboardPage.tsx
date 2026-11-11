import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle, ArrowLeftRight, BadgeCheck, Banknote, Boxes, IndianRupee, PackageX, Receipt, RotateCcw, ShoppingBag, Store, TrendingUp,
} from 'lucide-react'
import * as React from 'react'
import { Link } from 'react-router-dom'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartFrame, ChartTooltip, SERIES, axisProps, compactINR } from '@/components/common/charts'
import { DateRange } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { StatCard } from '@/components/common/StatCard'
import { EmptyState, ErrorState, PageLoader } from '@/components/common/States'
import { Badge } from '@/components/ui/badge'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table'
import { useDateRange } from '@/lib/hooks'
import { LIVE_REFRESH_MS } from '@/lib/queries'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDate, formatINR, formatNumber } from '@/lib/utils'

type Money = string
interface Summary {
  transactions: number; gross_sales: Money; discounts: Money; invoice_value: Money; returns_value: Money; returns_count: number
  net_sales: Money; gst_collected: Money; cogs: Money | null; gross_profit: Money | null; gross_margin_pct: Money | null
  profit_complete: boolean; cost_incomplete_sales: number; avg_basket: Money; voided: number
}
interface Dashboard {
  period: { from: string; to: string }
  today: Summary
  summary: Summary
  trend: { date: string; net_sales: Money; transactions: number }[]
  payments: { code: string; method: string; collected: Money; refunded: Money; net: Money }[]
  top_books: { key: string; label: string; sku?: string; units: number; net_sales: Money }[]
  by_category: { key: string; label: string; units: number; net_sales: Money }[]
  outlets: { key: string; label: string; transactions: number; units: number; net_sales: Money; gross_profit: Money | null }[]
  alerts: { low: number; out: number }
  low_stock: { book_id: string; title: string; location: string; available: number; reorder_level: number }[]
  dead_stock_count: number
  slow_moving: { book_id: string; title: string; location: string; on_hand: number; units_sold: number }[]
  pending: { transfers: number; approvals: number; open_register_sessions: number }
  expenses: Money | null
  registers: { session_id: string; location: string; register: string; cashier: string; status: string; variance: Money | null; opened_at: string }[] | null
  inventory: { locations: { location: string; type: string; units: number; cost_value?: Money; retail_value: Money; items_missing_cost: number }[]; total_units: number; total_cost_value: Money | null; total_retail_value: Money; complete: boolean }
  supplier_dues?: { total: Money; overdue: Money; top: { supplier_id: string; supplier: string; total: Money }[] }
  purchase_commitments?: { open_orders: number; units_outstanding: number; value_outstanding: Money }
  cash_positions?: { account: string; location: string; balance: Money }[]
  profit?: { revenue: Money; cogs: Money; gross_profit: Money; operating_expenses: Money; net_profit: Money; complete: boolean; warnings: string[] }
}

export default function DashboardPage() {
  const { locationId, location, me } = useAuth()
  const range = useDateRange(29)
  const q = useQuery({
    queryKey: ['dashboard', range.from, range.to, locationId],
    queryFn: () => api.get<Dashboard>('/dashboard', { date_from: range.from, date_to: range.to, location_id: locationId ?? undefined }),
    refetchInterval: LIVE_REFRESH_MS,
  })
  const scopeLabel = location ? location.name : me?.all_locations ? 'All locations' : 'Your locations'

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description={`${scopeLabel} · ${formatDate(range.from)} – ${formatDate(range.to)}`}
        actions={<DateRange from={range.from} to={range.to} onChange={range.set} />}
      />
      {q.isLoading ? <PageLoader /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data && <DashboardBody d={q.data} />}
    </div>
  )
}

function DashboardBody({ d }: { d: Dashboard }) {
  const s = d.summary
  const trend = d.trend.map((t) => ({ ...t, value: Number(t.net_sales), label: t.date }))
  const payments = d.payments.map((p) => ({ name: p.method, value: Number(p.net) })).filter((p) => p.value !== 0)
  const outlets = d.outlets.map((o) => ({ name: o.label, value: Number(o.net_sales) }))
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Sales today (incl. GST)" value={formatINR(d.today.invoice_value)} hint={`${d.today.transactions} bills · net ${formatINR(d.today.net_sales)}`} icon={IndianRupee} />
        <StatCard label="Net sales (period, ex-GST)" value={formatINR(s.net_sales)} hint={`${formatNumber(s.transactions)} bills · avg ${formatINR(s.avg_basket)}`} icon={TrendingUp} tone="success" />
        <StatCard
          label="Gross profit"
          value={s.gross_profit === null ? 'Restricted' : formatINR(s.gross_profit)}
          hint={s.gross_margin_pct !== null ? `${s.gross_margin_pct}% margin` : 'Requires financial report access'}
          warning={!s.profit_complete && s.gross_profit !== null ? `${s.cost_incomplete_sales} sale(s) missing cost data` : undefined}
          icon={Receipt}
          tone="info"
        />
        <StatCard label="Discounts & returns" value={formatINR(Number(s.discounts) + Number(s.returns_value))} hint={`${formatINR(s.discounts)} discounts · ${s.returns_count} returns`} icon={RotateCcw} tone="warning" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Net sales trend" description="Daily sales excluding GST (returns shown separately)" />
          <CardBody>
            {trend.every((t) => t.value === 0) ? <EmptyState title="No sales in this period" /> : (
              <ChartFrame label="Daily net sales line chart" height={260}>
                <ResponsiveContainer>
                  <AreaChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="fillSales" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={SERIES[0]} stopOpacity={0.18} />
                        <stop offset="100%" stopColor={SERIES[0]} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} stroke="#eef2f6" />
                    <XAxis dataKey="label" {...axisProps} tickFormatter={(v: string) => formatDate(v).slice(0, 6)} minTickGap={24} />
                    <YAxis {...axisProps} width={64} tickFormatter={compactINR} />
                    <Tooltip content={<ChartTooltip labelFormatter={(l) => formatDate(String(l))} />} cursor={{ stroke: '#94a3b8', strokeDasharray: '3 3' }} />
                    <Area isAnimationActive={false} type="monotone" dataKey="value" name="Net sales" stroke={SERIES[0]} strokeWidth={2} fill="url(#fillSales)" activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartFrame>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Collections by payment method" description="Net of refunds" />
          <CardBody>
            {payments.length === 0 ? <EmptyState title="No collections" /> : (
              <ChartFrame label="Collections by payment method bar chart" height={260}>
                <ResponsiveContainer>
                  <BarChart data={payments} layout="vertical" margin={{ top: 0, right: 16, left: 8, bottom: 0 }}>
                    <CartesianGrid horizontal={false} stroke="#eef2f6" />
                    <XAxis type="number" {...axisProps} tickFormatter={compactINR} />
                    <YAxis type="category" dataKey="name" {...axisProps} width={84} />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: '#f1f5f9' }} />
                    <Bar isAnimationActive={false} dataKey="value" name="Collected" fill={SERIES[0]} radius={[0, 4, 4, 0]} barSize={18} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartFrame>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 lg:grid-cols-4">
        <PendingTile to="/approvals" label="Pending approvals" value={d.pending.approvals} icon={BadgeCheck} />
        <PendingTile to="/transfers" label="Open transfers" value={d.pending.transfers} icon={ArrowLeftRight} />
        <PendingTile to="/inventory?status=LOW" label="Low / out of stock" value={`${d.alerts.low} / ${d.alerts.out}`} icon={AlertTriangle} tone={d.alerts.out ? 'danger' : 'warning'} />
        <PendingTile to="/reports?tab=inventory" label="Dead stock lines" value={d.dead_stock_count} icon={PackageX} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {outlets.length > 1 && (
          <Card className="lg:col-span-2">
            <CardHeader title="Outlet comparison" description="Net sales (ex-GST) by location" />
            <CardBody>
              <ChartFrame label="Net sales by outlet bar chart" height={240}>
                <ResponsiveContainer>
                  <BarChart data={outlets} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="#eef2f6" />
                    <XAxis dataKey="name" {...axisProps} />
                    <YAxis {...axisProps} width={64} tickFormatter={compactINR} />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: '#f1f5f9' }} />
                    <Bar isAnimationActive={false} dataKey="value" name="Net sales" fill={SERIES[0]} radius={[4, 4, 0, 0]} maxBarSize={56} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartFrame>
              <Table className="mt-4">
                <THead><TR><TH>Location</TH><TH className="text-right">Bills</TH><TH className="text-right">Units</TH><TH className="text-right">Net sales</TH><TH className="text-right">Gross profit</TH></TR></THead>
                <TBody>
                  {d.outlets.map((o) => (
                    <TR key={o.key}>
                      <TD>{o.label}</TD><TD className="num text-right">{o.transactions}</TD><TD className="num text-right">{o.units}</TD>
                      <TD className="num text-right">{formatINR(o.net_sales)}</TD><TD className="num text-right">{o.gross_profit === null ? '—' : formatINR(o.gross_profit)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardBody>
          </Card>
        )}
        <Card className={outlets.length > 1 ? '' : 'lg:col-span-3'}>
          <CardHeader title="Best sellers" description="By net sales in period" actions={<Link className="text-xs text-primary hover:underline" to="/reports?tab=sales">All</Link>} />
          {d.top_books.length === 0 ? <EmptyState title="No sales yet" /> : (
            <ul className="divide-y divide-border">
              {d.top_books.map((b, i) => (
                <li key={b.key} className="flex items-center gap-3 px-5 py-2.5">
                  <span className="w-4 text-xs text-subtle">{i + 1}</span>
                  <Link to={`/catalog/${b.key}`} className="min-w-0 flex-1 truncate text-sm hover:text-primary">{b.label}</Link>
                  <span className="text-xs text-muted">{b.units} sold</span>
                  <span className="num w-24 text-right text-sm">{formatINR(b.net_sales)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Low stock" actions={<Link className="text-xs text-primary hover:underline" to="/inventory?status=LOW">View</Link>} />
          {d.low_stock.length === 0 ? <EmptyState title="Stock levels are healthy" /> : (
            <ul className="divide-y divide-border">
              {d.low_stock.map((r) => (
                <li key={`${r.book_id}-${r.location}`} className="flex items-center justify-between gap-3 px-5 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{r.title}</p>
                    <p className="text-xs text-muted">{r.location}</p>
                  </div>
                  <Badge tone="warning">{r.available} left · min {r.reorder_level}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Inventory by location" description={d.inventory.total_cost_value !== null ? `Valuation ${formatINR(d.inventory.total_cost_value)} at cost` : `${formatNumber(d.inventory.total_units)} units`} />
          <ul className="divide-y divide-border">
            {d.inventory.locations.map((l) => (
              <li key={l.location} className="flex items-center justify-between px-5 py-2.5">
                <div className="flex items-center gap-2">
                  {l.type === 'WAREHOUSE' ? <Boxes className="size-4 text-muted" /> : <Store className="size-4 text-muted" />}
                  <span className="text-sm">{l.location}</span>
                </div>
                <div className="text-right">
                  <p className="num text-sm">{formatNumber(l.units)} units</p>
                  {l.cost_value !== undefined && <p className="num text-xs text-muted">{formatINR(l.cost_value)}</p>}
                </div>
              </li>
            ))}
          </ul>
          {!d.inventory.complete && <p className="px-5 pb-3 text-xs text-warning">Some stock has no cost data; valuation is understated.</p>}
        </Card>
        <Card>
          <CardHeader title="Finance snapshot" />
          <CardBody className="space-y-3 text-sm">
            {d.profit && (
              <div>
                <Row label="Revenue (GL)" value={formatINR(d.profit.revenue)} />
                <Row label="Cost of goods sold" value={formatINR(d.profit.cogs)} />
                <Row label="Operating expenses" value={formatINR(d.profit.operating_expenses)} />
                <Row label="Net profit" value={formatINR(d.profit.net_profit)} strong />
                {d.profit.warnings.map((w) => <p key={w} className="mt-1 text-xs text-warning">{w}</p>)}
              </div>
            )}
            {d.expenses !== null && <Row label="Expenses (period)" value={formatINR(d.expenses)} />}
            {d.supplier_dues && (
              <>
                <Row label="Supplier dues" value={formatINR(d.supplier_dues.total)} />
                <Row label="  of which overdue" value={formatINR(d.supplier_dues.overdue)} tone={Number(d.supplier_dues.overdue) > 0 ? 'danger' : undefined} />
              </>
            )}
            {d.purchase_commitments && <Row label={`Open POs (${d.purchase_commitments.open_orders})`} value={formatINR(d.purchase_commitments.value_outstanding)} />}
            {d.cash_positions && d.cash_positions.length > 0 && (
              <div className="border-t border-border pt-3">
                <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted"><Banknote className="size-3.5" /> Cash & bank positions</p>
                {d.cash_positions.slice(0, 6).map((c) => <Row key={`${c.account}-${c.location}`} label={`${c.account} · ${c.location}`} value={formatINR(c.balance)} />)}
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {d.registers && d.registers.length > 0 && (
        <Card>
          <CardHeader title="Registers" description="Open sessions and cash discrepancies in the period" actions={<Link className="text-xs text-primary hover:underline" to="/finance/registers">Manage</Link>} />
          <Table>
            <THead><TR><TH>Location</TH><TH>Register</TH><TH>Cashier</TH><TH>Opened</TH><TH>Status</TH><TH className="text-right">Variance</TH></TR></THead>
            <TBody>
              {d.registers.map((r) => (
                <TR key={r.session_id}>
                  <TD>{r.location}</TD><TD>{r.register}</TD><TD>{r.cashier}</TD><TD>{formatDate(r.opened_at, true)}</TD>
                  <TD><Badge tone={r.status === 'OPEN' ? 'info' : 'neutral'}>{r.status === 'OPEN' ? 'Open' : 'Closed'}</Badge></TD>
                  <TD className={`num text-right ${r.variance && Number(r.variance) !== 0 ? 'text-danger' : ''}`}>{r.variance === null ? '—' : formatINR(r.variance)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
      <p className="flex items-center gap-1.5 text-xs text-subtle"><ShoppingBag className="size-3.5" /> All figures come from posted transactions in your permitted locations.</p>
    </div>
  )
}

function Row({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: 'danger' }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-muted">{label}</span>
      <span className={`num ${strong ? 'font-semibold' : ''} ${tone === 'danger' ? 'text-danger' : ''}`}>{value}</span>
    </div>
  )
}

function PendingTile({ to, label, value, icon: Icon, tone = 'primary' }: { to: string; label: string; value: React.ReactNode; icon: React.ComponentType<{ className?: string }>; tone?: 'primary' | 'warning' | 'danger' }) {
  const tones = { primary: 'text-primary bg-primary-soft', warning: 'text-warning bg-warning-soft', danger: 'text-danger bg-danger-soft' }
  return (
    <Link to={to} className="flex items-center gap-3 rounded-lg border border-border bg-white p-4 shadow-[var(--shadow-card)] transition-colors hover:border-primary/40">
      <div className={`rounded-md p-2 ${tones[tone]}`}><Icon className="size-4" /></div>
      <div>
        <p className="num text-lg font-semibold">{value}</p>
        <p className="text-xs text-muted">{label}</p>
      </div>
    </Link>
  )
}
