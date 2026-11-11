import { useQuery } from '@tanstack/react-query'
import { Store, Warehouse } from 'lucide-react'
import * as React from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState, ErrorState, PageLoader } from '@/components/common/States'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { LIVE_REFRESH_MS } from '@/lib/queries'
import { formatDate, formatINR, formatNumber } from '@/lib/utils'
import { PERIOD_LABELS, type OutletsSummary, type PeriodKey } from './types'

export default function OutletsPage() {
  const { can } = useAuth()
  const [period, setPeriod] = React.useState<PeriodKey>('today')
  const q = useQuery({ queryKey: ['outlets-summary'], queryFn: () => api.get<OutletsSummary>('/outlets/summary'), refetchInterval: LIVE_REFRESH_MS })
  if (q.isLoading) return <PageLoader />
  if (!q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const rows = q.data.locations
  const p = q.data.periods[period]
  const fin = can('reports.financial')
  const total = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0)
  return (
    <div>
      <PageHeader title="Outlets" description={`Every shop and warehouse side by side. Updated live · ${formatDate(q.data.as_of)}`}
        actions={<div className="flex rounded-md border border-border bg-white p-0.5" role="group" aria-label="Sales period">
          {(Object.keys(PERIOD_LABELS) as PeriodKey[]).map((k) => (
            <Button key={k} size="sm" variant={k === period ? 'primary' : 'ghost'} aria-pressed={k === period} onClick={() => setPeriod(k)}>{PERIOD_LABELS[k]}</Button>
          ))}
        </div>} />
      {rows.length === 0 ? <EmptyState title="No locations" /> : (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {rows.map((r) => {
              const s = r.sales[period]
              const Icon = r.location.type === 'WAREHOUSE' ? Warehouse : Store
              return (
                <Link key={r.location.id} to={`/outlets/${r.location.id}`} className="block rounded-lg focus-visible:outline-2 focus-visible:outline-primary">
                  <Card className="h-full p-4 transition-shadow hover:shadow-md">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 font-semibold"><Icon className="size-4 shrink-0 text-muted" /><span className="truncate">{r.location.name}</span></p>
                        <p className="text-xs text-muted">{r.location.type === 'WAREHOUSE' ? 'Warehouse' : 'Outlet'}{r.location.city ? ` · ${r.location.city}` : ''}</p>
                      </div>
                      {r.open_registers > 0 && <Badge tone="success">{r.open_registers} counter open</Badge>}
                    </div>
                    <p className="num mt-3 text-2xl font-semibold">{formatINR(s.invoice_value)}</p>
                    <p className="text-xs text-muted">{PERIOD_LABELS[period]} · {s.transactions} bill{s.transactions === 1 ? '' : 's'}{Number(s.returns_value) > 0 ? ` · returns ${formatINR(s.returns_value)}` : ''}</p>
                    <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-xs">
                      <div><p className="text-muted">Stock to sell</p><p className="num font-medium">{formatNumber(r.stock.available)} units</p></div>
                      <div><p className="text-muted">{r.stock.titles_available} titles worth</p><p className="num font-medium">{formatINR(r.stock.retail_value)}</p></div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {r.alerts.out > 0 && <Badge tone="danger">{r.alerts.out} out of stock</Badge>}
                      {r.alerts.low > 0 && <Badge tone="warning">{r.alerts.low} low</Badge>}
                      {r.pending_transfers > 0 && <Badge tone="info">{r.pending_transfers} transfers</Badge>}
                    </div>
                  </Card>
                </Link>
              )
            })}
          </div>
          <Card>
            <Table>
              <THead><TR>
                <TH>Location</TH><TH className="text-right">Today</TH><TH className="text-right">This week</TH><TH className="text-right">This month</TH>
                <TH className="text-right">Units to sell</TH><TH className="hidden text-right md:table-cell">Retail value</TH>
                {fin && <TH className="hidden text-right lg:table-cell">Cost value</TH>}<TH className="hidden text-right md:table-cell">Low / out</TH>
              </TR></THead>
              <TBody>
                {rows.map((r) => (
                  <TR key={r.location.id}>
                    <TD><Link to={`/outlets/${r.location.id}`} className="font-medium hover:text-primary">{r.location.name}</Link></TD>
                    {(['today', 'week', 'month'] as PeriodKey[]).map((k) => (
                      <TD key={k} className="text-right"><span className="num">{formatINR(r.sales[k].invoice_value)}</span><span className="block text-[11px] text-muted">{r.sales[k].transactions} bill{r.sales[k].transactions === 1 ? '' : 's'}</span></TD>
                    ))}
                    <TD className="num text-right">{formatNumber(r.stock.available)}</TD>
                    <TD className="num hidden text-right md:table-cell">{formatINR(r.stock.retail_value)}</TD>
                    {fin && <TD className="num hidden text-right lg:table-cell">{formatINR(r.stock.cost_value)}</TD>}
                    <TD className="num hidden text-right md:table-cell">{r.alerts.low} / <span className={r.alerts.out ? 'text-danger' : ''}>{r.alerts.out}</span></TD>
                  </TR>
                ))}
                <TR className="bg-surface font-semibold">
                  <TD>All locations</TD>
                  {(['today', 'week', 'month'] as PeriodKey[]).map((k) => (
                    <TD key={k} className="num text-right">{formatINR(total((r) => Number(r.sales[k].invoice_value)))}</TD>
                  ))}
                  <TD className="num text-right">{formatNumber(total((r) => r.stock.available))}</TD>
                  <TD className="num hidden text-right md:table-cell">{formatINR(total((r) => Number(r.stock.retail_value)))}</TD>
                  {fin && <TD className="num hidden text-right lg:table-cell">{formatINR(total((r) => Number(r.stock.cost_value ?? 0)))}</TD>}
                  <TD className="num hidden text-right md:table-cell">{total((r) => r.alerts.low)} / {total((r) => r.alerts.out)}</TD>
                </TR>
              </TBody>
            </Table>
            <p className="border-t border-border px-5 py-2 text-xs text-muted">Sales are invoice values including GST. Cards show {PERIOD_LABELS[period].toLowerCase()} ({formatDate(p.from)}{p.from !== p.to ? ` – ${formatDate(p.to)}` : ''}). Weeks start on Monday.</p>
          </Card>
        </>
      )}
    </div>
  )
}
