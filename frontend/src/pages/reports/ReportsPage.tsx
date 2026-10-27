import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Download } from 'lucide-react'
import * as React from 'react'
import { useSearchParams } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { toast } from 'sonner'
import { ChartFrame, ChartTooltip, SERIES, axisProps, compactINR } from '@/components/common/charts'
import { DataTable, type Column } from '@/components/common/DataTable'
import { DateRange } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { StatCard } from '@/components/common/StatCard'
import { ErrorState, LoadingRows } from '@/components/common/States'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Input, NativeSelect } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useDateRange } from '@/lib/hooks'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDate, formatINR, formatNumber, todayISO } from '@/lib/utils'

type Row = Record<string, unknown>
const money = (k: string) => (r: Row) => formatINR(r[k] as string)
const text = (k: string) => (r: Row) => (r[k] as string) ?? '—'

function useReport<T>(path: string, query: Record<string, string | undefined>, enabled = true) {
  return useQuery({ queryKey: ['report', path, query], queryFn: () => api.get<T>(path, query), enabled })
}

function ExportButton({ path, query, name }: { path: string; query: Record<string, string | undefined>; name: string }) {
  const { can } = useAuth()
  if (!can('reports.export')) return null
  return (
    <Button size="sm" variant="secondary" onClick={() => api.download(path, { ...query, format: 'csv' }, `${name}.csv`).catch((e) => toast.error(errorMessage(e)))}>
      <Download /> CSV
    </Button>
  )
}

function Section<T extends Row>({ title, description, path, query, name, columns, rowsKey = 'rows', footer }: {
  title: string; description?: string; path: string; query: Record<string, string | undefined>; name: string; columns: Column<T>[]; rowsKey?: string; footer?: (d: Row) => React.ReactNode
}) {
  const q = useReport<Row>(path, query)
  const rows = (q.data?.[rowsKey] as T[] | undefined) ?? undefined
  return (
    <Card>
      <CardHeader title={title} description={description} actions={<ExportButton path={path} query={query} name={name} />} />
      <DataTable rows={rows} loading={q.isFetching} error={q.error} onRetry={() => q.refetch()} rowKey={(r) => JSON.stringify(r).slice(0, 120)} columns={columns} dense empty={{ title: 'No data for this selection' }} />
      {q.data && footer?.(q.data)}
    </Card>
  )
}

export default function ReportsPage() {
  const { can, locationId, location } = useAuth()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? (can('reports.view') ? 'sales' : 'pl')
  const range = useDateRange(29)
  const base = { date_from: range.from, date_to: range.to, location_id: locationId ?? undefined }
  return (
    <div>
      <PageHeader title="Reports" description={`${location?.name ?? 'All permitted locations'} · ${formatDate(range.from)} – ${formatDate(range.to)}`}
        actions={<DateRange from={range.from} to={range.to} onChange={range.set} />} />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList>
          {can('reports.view') && <TabsTrigger value="sales">Sales</TabsTrigger>}
          {(can('reports.financial') || can('finance.view')) && <TabsTrigger value="gst">GST</TabsTrigger>}
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
          {can('reports.financial') && <TabsTrigger value="pl">Profit & loss</TabsTrigger>}
          {can('reports.financial') && <TabsTrigger value="cashflow">Cash flow</TabsTrigger>}
          {can('reports.financial') && can('accounting.view') && <TabsTrigger value="bs">Balance sheet</TabsTrigger>}
          {can('accounting.view') && <TabsTrigger value="tb">Trial balance</TabsTrigger>}
          {can('finance.view') && <TabsTrigger value="receivables">Receivables</TabsTrigger>}
          {can('expenses.view') && <TabsTrigger value="expenses">Expenses</TabsTrigger>}
          {can('registers.manage') && <TabsTrigger value="registers">Registers</TabsTrigger>}
        </TabsList>
        <TabsContent value="sales"><SalesReports q={base} /></TabsContent>
        <TabsContent value="gst"><GstReports q={base} /></TabsContent>
        <TabsContent value="inventory"><InventoryReports locationId={locationId} /></TabsContent>
        <TabsContent value="pl"><ProfitLoss q={base} /></TabsContent>
        <TabsContent value="cashflow"><CashFlow q={base} /></TabsContent>
        <TabsContent value="bs"><BalanceSheet /></TabsContent>
        <TabsContent value="tb"><TrialBalance /></TabsContent>
        <TabsContent value="receivables">
          <Section title="Receivables aging" description="Outstanding balances on credit sales" path="/reports/receivables-aging" query={{ location_id: locationId ?? undefined }} name="receivables_aging"
            columns={[{ key: 'c', header: 'Customer', cell: text('customer') }, { key: 'p', header: 'Phone', cell: text('phone') }, { key: 'a', header: '0–30 days', align: 'right', cell: money('d0_30') },
              { key: 'b', header: '31–60', align: 'right', cell: money('d31_60') }, { key: 'x', header: '60+', align: 'right', cell: money('d60_plus') }, { key: 't', header: 'Total', align: 'right', cell: money('total') }]} />
        </TabsContent>
        <TabsContent value="expenses">
          <Section title="Expenses by location & category" path="/reports/expenses" query={base} name="expenses"
            columns={[{ key: 'l', header: 'Location', cell: text('location') }, { key: 'c', header: 'Category', cell: text('category') }, { key: 'n', header: 'Entries', align: 'right', cell: (r) => String(r.count) }, { key: 'a', header: 'Amount', align: 'right', cell: money('amount') }]}
            footer={(d) => <p className="border-t border-border px-5 py-3 text-right text-sm font-semibold">Total {formatINR(d.total as string)}</p>} />
        </TabsContent>
        <TabsContent value="registers">
          <Section title="Register sessions" path="/reports/registers" query={base} name="register_sessions"
            columns={[{ key: 'l', header: 'Location', cell: text('location') }, { key: 'r', header: 'Register', cell: text('register') }, { key: 'u', header: 'Cashier', cell: text('cashier') },
              { key: 'o', header: 'Opened', cell: (r) => formatDate(r.opened_at as string, true) }, { key: 'e', header: 'Expected', align: 'right', cell: money('expected_cash') },
              { key: 'c', header: 'Counted', align: 'right', cell: money('counted_cash') }, { key: 'v', header: 'Variance', align: 'right', cell: (r) => <span className={Number(r.variance) ? 'text-danger' : ''}>{formatINR(r.variance as string)}</span> }]} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

interface SalesSummary { transactions: number; gross_sales: string; discounts: string; invoice_value: string; returns_value: string; returns_count: number; net_sales: string; gst_collected: string; cogs: string | null; gross_profit: string | null; gross_margin_pct: string | null; profit_complete: boolean; cost_incomplete_sales: number; avg_basket: string; voided: number }

function SalesReports({ q }: { q: Record<string, string | undefined> }) {
  const [dim, setDim] = React.useState('book')
  const s = useReport<SalesSummary>('/reports/sales-summary', q)
  const by = useReport<{ rows: Row[] }>('/reports/sales-by', { ...q, dim })
  const pays = useReport<{ rows: Row[] }>('/reports/payments', q)
  const chart = (by.data?.rows ?? []).slice(0, 10).map((r) => ({ name: String(r.label).slice(0, 22), value: Number(r.net_sales) }))
  return (
    <div className="space-y-6">
      {s.error ? <ErrorState error={s.error} /> : !s.data ? <LoadingRows rows={2} cols={4} /> : (
        <div className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Gross sales" value={formatINR(s.data.gross_sales)} hint={`${formatNumber(s.data.transactions)} bills · ${s.data.voided} voided`} />
          <StatCard label="Discounts" value={formatINR(s.data.discounts)} tone="warning" />
          <StatCard label="Returns" value={formatINR(s.data.returns_value)} hint={`${s.data.returns_count} returns`} tone="warning" />
          <StatCard label="Net sales (ex-GST)" value={formatINR(s.data.net_sales)} tone="success" />
          <StatCard label="GST collected (net)" value={formatINR(s.data.gst_collected)} tone="info" />
          <StatCard label="Invoice value (incl. GST)" value={formatINR(s.data.invoice_value)} hint={`Avg bill ${formatINR(s.data.avg_basket)}`} />
          <StatCard label="Cost of goods sold" value={s.data.cogs === null ? 'Restricted' : formatINR(s.data.cogs)} />
          <StatCard label="Gross profit" value={s.data.gross_profit === null ? 'Restricted' : formatINR(s.data.gross_profit)} hint={s.data.gross_margin_pct ? `${s.data.gross_margin_pct}% margin` : undefined}
            warning={!s.data.profit_complete ? `${s.data.cost_incomplete_sales} sale(s) lacked cost data` : undefined} tone="success" />
        </div>
      )}
      <Card>
        <CardHeader title="Sales breakdown" description="Net sales excluding GST, before returns"
          actions={<><NativeSelect aria-label="Group by" className="h-8 w-40" value={dim} onChange={(e) => setDim(e.target.value)}><option value="book">By book</option><option value="category">By category</option><option value="location">By location</option><option value="cashier">By cashier</option></NativeSelect><ExportButton path="/reports/sales-by" query={{ ...q, dim }} name={`sales_by_${dim}`} /></>} />
        {chart.length > 0 && (
          <CardBody>
            <ChartFrame label={`Top ten ${dim}s by net sales`} height={Math.max(160, chart.length * 30)}>
              <ResponsiveContainer>
                <BarChart data={chart} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid horizontal={false} stroke="#eef2f6" />
                  <XAxis type="number" {...axisProps} tickFormatter={compactINR} />
                  <YAxis type="category" dataKey="name" {...axisProps} width={170} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: '#f1f5f9' }} />
                  <Bar isAnimationActive={false} dataKey="value" name="Net sales" fill={SERIES[0]} radius={[0, 4, 4, 0]} barSize={16} />
                </BarChart>
              </ResponsiveContainer>
            </ChartFrame>
          </CardBody>
        )}
        <DataTable rows={by.data?.rows} loading={by.isFetching} error={by.error} rowKey={(r) => String(r.key ?? r.label)} dense empty={{ title: 'No sales' }}
          columns={[
            { key: 'l', header: dim === 'book' ? 'Book' : dim.charAt(0).toUpperCase() + dim.slice(1), cell: (r) => <>{String(r.label)}{r.sku ? <span className="ml-1 text-xs text-muted">{String(r.sku)}</span> : null}</> },
            { key: 't', header: 'Bills', align: 'right', cell: (r) => String(r.transactions) },
            { key: 'u', header: 'Units', align: 'right', cell: (r) => String(r.units) },
            { key: 'n', header: 'Net sales', align: 'right', cell: money('net_sales') },
            { key: 'i', header: 'Incl. GST', align: 'right', cell: money('invoice_value') },
            { key: 'g', header: 'Gross profit', align: 'right', cell: (r) => r.gross_profit === null ? '—' : formatINR(r.gross_profit as string) },
          ]} />
      </Card>
      <Card>
        <CardHeader title="Collections by payment method" actions={<ExportButton path="/reports/payments" query={q} name="payments" />} />
        <DataTable rows={pays.data?.rows} loading={pays.isFetching} rowKey={(r) => String(r.code)} dense empty={{ title: 'No payments' }}
          columns={[{ key: 'm', header: 'Method', cell: text('method') }, { key: 'n', header: 'Transactions', align: 'right', cell: (r) => String(r.count) },
            { key: 'c', header: 'Collected', align: 'right', cell: money('collected') }, { key: 'r', header: 'Refunded', align: 'right', cell: money('refunded') }, { key: 't', header: 'Net', align: 'right', cell: money('net') }]} />
      </Card>
    </div>
  )
}

function GstReports({ q }: { q: Record<string, string | undefined> }) {
  return (
    <div className="space-y-6">
      <div className="flex gap-2 rounded-md border border-amber-200 bg-warning-soft px-4 py-3 text-sm text-amber-800">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        These registers support GST return preparation. Verify classification, rates and place of supply with your accountant; this system does not file returns.
      </div>
      <Section title="Rate & HSN-wise summary" description="Outward supplies net of credit notes" path="/reports/gst-summary" query={q} name="gst_hsn_summary"
        columns={[{ key: 'h', header: 'HSN', cell: (r) => (r.hsn_code as string) || '—' }, { key: 'r', header: 'Rate', align: 'right', cell: (r) => `${Number(r.tax_rate)}%` }, { key: 'q', header: 'Qty', align: 'right', cell: (r) => String(r.qty) },
          { key: 't', header: 'Taxable value', align: 'right', cell: money('taxable_value') }, { key: 'c', header: 'CGST', align: 'right', cell: money('cgst') }, { key: 's', header: 'SGST', align: 'right', cell: money('sgst') },
          { key: 'i', header: 'IGST', align: 'right', cell: money('igst') }, { key: 'x', header: 'Total tax', align: 'right', cell: money('total_tax') }]} />
      <Section title="Sales register" description="Every invoice and credit note (cancelled invoices shown with zero value)" path="/reports/gst-register" query={q} name="gst_sales_register"
        columns={[{ key: 'n', header: 'Document', cell: (r) => <><span className="num">{String(r.invoice_number)}</span> {r.doc_type === 'CREDIT_NOTE' && <Badge tone="warning">Credit note</Badge>}{r.status === 'CANCELLED' && <Badge tone="danger">Cancelled</Badge>}</> },
          { key: 'd', header: 'Date', cell: (r) => formatDate(r.date as string) }, { key: 'c', header: 'Customer', cell: text('customer') }, { key: 'g', header: 'GSTIN', cell: (r) => (r.customer_gstin as string) ?? <Badge>B2C</Badge> },
          { key: 'p', header: 'POS', cell: text('place_of_supply') }, { key: 't', header: 'Taxable', align: 'right', cell: money('taxable_value') }, { key: 'x', header: 'Tax', align: 'right', cell: (r) => formatINR(Number(r.cgst) + Number(r.sgst) + Number(r.igst)) },
          { key: 'v', header: 'Total', align: 'right', cell: money('total') }]}
        footer={(d) => { const t = d.totals as Record<string, string>; return <p className="border-t border-border px-5 py-3 text-right text-sm">Taxable {formatINR(t.taxable_value)} · CGST {formatINR(t.cgst)} · SGST {formatINR(t.sgst)} · IGST {formatINR(t.igst)} · <strong>Total {formatINR(t.total)}</strong></p> }} />
    </div>
  )
}

function InventoryReports({ locationId }: { locationId: string | null }) {
  const { can } = useAuth()
  const [kind, setKind] = React.useState('slow')
  const lq = { location_id: locationId ?? undefined }
  const val = useReport<Row>('/reports/inventory-valuation', lq, can('reports.financial'))
  const labels: Record<string, string> = { fast: 'Fast-moving (last 30 days)', slow: 'Slow-moving', dead: 'Dead stock (no sales)', excess: 'Excess stock', low: 'Low stock', out: 'Out of stock' }
  return (
    <div className="space-y-6">
      {can('reports.financial') && val.data && (
        <Card>
          <CardHeader title="Inventory valuation" description={`${val.data.method as string}. On-hand, damaged and quarantined stock at cost; in-transit at transfer cost.`} actions={<ExportButton path="/reports/inventory-valuation" query={lq} name="inventory_valuation" />} />
          <DataTable rows={val.data.locations as Row[]} rowKey={(r) => String(r.location_id)} dense
            columns={[{ key: 'l', header: 'Location', cell: text('location') }, { key: 'u', header: 'Units', align: 'right', cell: (r) => formatNumber(r.units as number) },
              { key: 'c', header: 'Cost value', align: 'right', cell: money('cost_value') }, { key: 't', header: 'In transit', align: 'right', cell: money('in_transit_value') },
              { key: 'r', header: 'Retail value', align: 'right', cell: money('retail_value') }, { key: 'm', header: 'Missing cost', align: 'right', cell: (r) => Number(r.items_missing_cost) ? <Badge tone="warning">{String(r.items_missing_cost)}</Badge> : '—' }]} />
          <div className="flex flex-wrap justify-end gap-6 border-t border-border px-5 py-3 text-sm">
            <span>Total at cost <strong className="num">{formatINR(val.data.total_cost_value as string)}</strong></span>
            {val.data.gl_inventory_balance !== null && <span>GL inventory <strong className="num">{formatINR(val.data.gl_inventory_balance as string)}</strong> {Number(val.data.gl_difference) === 0 ? <Badge tone="success">Reconciled</Badge> : <Badge tone="warning">Diff {formatINR(val.data.gl_difference as string)}</Badge>}</span>}
          </div>
        </Card>
      )}
      <Card>
        <CardHeader title={labels[kind]} actions={<><NativeSelect aria-label="Analysis" className="h-8 w-52" value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(labels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect><ExportButton path="/reports/stock-analysis" query={{ ...lq, kind }} name={`stock_${kind}`} /></>} />
        <StockAnalysis kind={kind} locationId={locationId} />
      </Card>
    </div>
  )
}

function StockAnalysis({ kind, locationId }: { kind: string; locationId: string | null }) {
  const q = useReport<{ rows: Row[] }>('/reports/stock-analysis', { kind, location_id: locationId ?? undefined })
  const cols: Column<Row>[] = [{ key: 't', header: 'Book', cell: (r) => <>{String(r.title)} <span className="text-xs text-muted">{String(r.sku)}</span></> }, { key: 'l', header: 'Location', cell: text('location') }]
  if (kind === 'low' || kind === 'out') cols.push({ key: 'a', header: 'Available', align: 'right', cell: (r) => String(r.available) }, { key: 'r', header: 'Reorder level', align: 'right', cell: (r) => String(r.reorder_level) }, { key: 'q', header: 'Suggested order', align: 'right', cell: (r) => String(r.reorder_qty) }, { key: 'i', header: 'In transit', align: 'right', cell: (r) => String(r.in_transit) })
  else cols.push({ key: 'o', header: 'On hand', align: 'right', cell: (r) => String(r.on_hand) }, { key: 's', header: 'Units sold (window)', align: 'right', cell: (r) => `${r.units_sold} / ${r.window_days}d` }, { key: 'd', header: 'Last sale', cell: (r) => formatDate(r.last_sale as string) }, { key: 'v', header: 'Stock value', align: 'right', cell: (r) => r.stock_value === undefined ? '—' : formatINR(r.stock_value as string) })
  return <DataTable rows={q.data?.rows} loading={q.isFetching} error={q.error} rowKey={(r) => `${r.book_id}-${r.location_id}`} columns={cols} dense empty={{ title: 'Nothing to report' }} />
}

interface PL { revenue: string; cogs: string; gross_profit: string; net_profit: string; total_operating_expenses: string; income: { code: string; name: string; amount: string }[]; operating_expenses: { code: string; name: string; amount: string }[]; complete: boolean; warnings: string[] }

function ProfitLoss({ q }: { q: Record<string, string | undefined> }) {
  const r = useReport<PL>('/reports/profit-loss', q)
  if (r.error) return <ErrorState error={r.error} />
  if (!r.data) return <LoadingRows />
  const d = r.data
  return (
    <Card className="max-w-3xl">
      <CardHeader title="Profit & loss statement" description="From posted journal entries (accrual basis)" />
      <CardBody className="space-y-4 text-sm">
        {d.warnings.map((w) => <p key={w} className="rounded-md bg-warning-soft px-3 py-2 text-amber-800">{w}</p>)}
        <Group title="Income" rows={d.income} />
        <Total label="Revenue" value={d.revenue} />
        <Total label="Cost of goods sold" value={d.cogs} />
        <Total label="Gross profit" value={d.gross_profit} strong />
        <Group title="Operating expenses" rows={d.operating_expenses} />
        <Total label="Total operating expenses" value={d.total_operating_expenses} />
        <Total label="Net profit" value={d.net_profit} strong tone={Number(d.net_profit) < 0 ? 'danger' : 'success'} />
      </CardBody>
    </Card>
  )
}

function CashFlow({ q }: { q: Record<string, string | undefined> }) {
  const r = useReport<{ opening_cash: string; closing_cash: string; net_change: string; method: string; lines: { activity: string; inflow: string; outflow: string; net: string }[] }>('/reports/cash-flow', q)
  if (!r.data) return r.error ? <ErrorState error={r.error} /> : <LoadingRows />
  return (
    <Card className="max-w-3xl">
      <CardHeader title="Cash flow" description={r.data.method} />
      <DataTable rows={r.data.lines} rowKey={(l) => l.activity} dense columns={[{ key: 'a', header: 'Activity', cell: (l) => l.activity }, { key: 'i', header: 'Inflow', align: 'right', cell: (l) => formatINR(l.inflow) }, { key: 'o', header: 'Outflow', align: 'right', cell: (l) => formatINR(l.outflow) }, { key: 'n', header: 'Net', align: 'right', cell: (l) => formatINR(l.net) }]} />
      <CardBody className="space-y-1 text-sm">
        <Total label="Opening cash & bank" value={r.data.opening_cash} />
        <Total label="Net change" value={r.data.net_change} />
        <Total label="Closing cash & bank" value={r.data.closing_cash} strong />
      </CardBody>
    </Card>
  )
}

function BalanceSheet() {
  const [asOf, setAsOf] = React.useState(todayISO())
  const r = useReport<{ assets: Row[]; liabilities: Row[]; equity: Row[]; current_earnings: string; total_assets: string; total_liabilities: string; total_equity: string; balanced: boolean; complete: boolean; warnings: string[] }>('/reports/balance-sheet', { as_of: asOf })
  return (
    <Card className="max-w-3xl">
      <CardHeader title="Balance sheet" actions={<Input type="date" aria-label="As of date" className="h-8 w-40" value={asOf} onChange={(e) => setAsOf(e.target.value)} />} />
      {!r.data ? (r.error ? <ErrorState error={r.error} /> : <LoadingRows />) : (
        <CardBody className="space-y-4 text-sm">
          {r.data.warnings.map((w) => <p key={w} className="rounded-md bg-warning-soft px-3 py-2 text-amber-800">{w}</p>)}
          <Group title="Assets" rows={r.data.assets as never} /><Total label="Total assets" value={r.data.total_assets} strong />
          <Group title="Liabilities" rows={r.data.liabilities as never} /><Total label="Total liabilities" value={r.data.total_liabilities} />
          <Group title="Equity" rows={r.data.equity as never} /><Total label="Current period earnings" value={r.data.current_earnings} /><Total label="Total equity" value={r.data.total_equity} strong />
          <p className={r.data.balanced ? 'text-success' : 'text-danger'}>{r.data.balanced ? 'Assets = Liabilities + Equity' : 'Out of balance — investigate'}</p>
        </CardBody>
      )}
    </Card>
  )
}

function TrialBalance() {
  const [asOf, setAsOf] = React.useState(todayISO())
  const r = useReport<{ rows: Row[]; total_debit: string; total_credit: string; balanced: boolean }>('/reports/trial-balance', { as_of: asOf })
  return (
    <Card className="max-w-4xl">
      <CardHeader title="Trial balance" actions={<><Input type="date" aria-label="As of date" className="h-8 w-40" value={asOf} onChange={(e) => setAsOf(e.target.value)} /><ExportButton path="/reports/trial-balance" query={{ as_of: asOf }} name="trial_balance" /></>} />
      <DataTable rows={r.data?.rows} loading={r.isFetching} error={r.error} rowKey={(x) => String(x.account_id)} dense
        columns={[{ key: 'c', header: 'Code', cell: text('code') }, { key: 'n', header: 'Account', cell: text('name') }, { key: 'd', header: 'Debit', align: 'right', cell: (x) => Number(x.balance_debit) ? formatINR(x.balance_debit as string) : '' }, { key: 'k', header: 'Credit', align: 'right', cell: (x) => Number(x.balance_credit) ? formatINR(x.balance_credit as string) : '' }]} />
      {r.data && <p className="border-t border-border px-5 py-3 text-right text-sm font-semibold">Dr {formatINR(r.data.total_debit)} · Cr {formatINR(r.data.total_credit)} {r.data.balanced ? <Badge tone="success">Balanced</Badge> : <Badge tone="danger">Unbalanced</Badge>}</p>}
    </Card>
  )
}

function Group({ title, rows }: { title: string; rows: { code: string; name: string; amount: string }[] }) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{title}</p>
      {rows.length === 0 && <p className="text-muted">—</p>}
      {rows.map((r) => <div key={r.code} className="flex justify-between py-0.5"><span><span className="num mr-2 text-xs text-subtle">{r.code}</span>{r.name}</span><span className="num">{formatINR(r.amount)}</span></div>)}
    </div>
  )
}

function Total({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: 'danger' | 'success' }) {
  return <div className={`flex justify-between border-t border-border pt-1 ${strong ? 'font-semibold' : ''} ${tone === 'danger' ? 'text-danger' : ''}`}><span>{label}</span><span className="num">{formatINR(value)}</span></div>
}
