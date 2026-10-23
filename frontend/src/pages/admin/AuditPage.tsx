import { keepPreviousData, useQuery } from '@tanstack/react-query'
import * as React from 'react'
import { DataTable } from '@/components/common/DataTable'
import { DateRange, SearchInput } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { Card } from '@/components/ui/card'
import { Dialog, SheetContent } from '@/components/ui/dialog'
import { api, type Page } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useDateRange, useDebounced } from '@/lib/hooks'
import { formatDate } from '@/lib/utils'

interface Log { id: number; ts: string; actor_name: string | null; action: string; entity_type: string | null; entity_id: string | null; location_id: string | null; ip: string | null; request_id: string | null; details: Record<string, unknown> }

export default function AuditPage() {
  const { locationId } = useAuth()
  const range = useDateRange(6)
  const [action, setAction] = React.useState('')
  const [page, setPage] = React.useState(1)
  const [detail, setDetail] = React.useState<Log | null>(null)
  const da = useDebounced(action)
  React.useEffect(() => setPage(1), [da, range.from, range.to, locationId])
  const q = useQuery({
    queryKey: ['audit', da, range.from, range.to, page, locationId],
    queryFn: () => api.get<Page<Log>>('/audit-logs', { action: da, date_from: range.from, date_to: range.to, page, page_size: 50, location_id: locationId ?? undefined }),
    placeholderData: keepPreviousData,
  })
  return (
    <div>
      <PageHeader title="Audit log" description="Append-only record of security-sensitive and business actions." actions={<DateRange from={range.from} to={range.to} onChange={range.set} />} />
      <Card>
        <div className="border-b border-border p-3"><SearchInput value={action} onChange={setAction} placeholder="Action prefix, e.g. auth. or pos.sale" /></div>
        <DataTable rows={q.data?.items} loading={q.isFetching} error={q.error} rowKey={(l) => String(l.id)} onRowClick={setDetail} page={page} pageSize={50} total={q.data?.total} onPageChange={setPage} dense
          empty={{ title: 'No audit events' }}
          columns={[
            { key: 't', header: 'Time', cell: (l) => formatDate(l.ts, true) },
            { key: 'u', header: 'User', cell: (l) => l.actor_name ?? 'System / anonymous' },
            { key: 'a', header: 'Action', cell: (l) => <span className="num text-xs">{l.action}</span> },
            { key: 'e', header: 'Entity', hideBelow: 'md', cell: (l) => l.entity_type ?? '—' },
            { key: 'i', header: 'IP', hideBelow: 'lg', cell: (l) => l.ip ?? '—' },
          ]} />
      </Card>
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <SheetContent title={detail?.action ?? ''} description={detail ? `${formatDate(detail.ts, true)} · ${detail.actor_name ?? 'system'} · request ${detail.request_id ?? '—'}` : ''}>
          <pre className="overflow-x-auto rounded-md bg-surface p-3 text-xs">{JSON.stringify(detail?.details ?? {}, null, 2)}</pre>
        </SheetContent>
      </Dialog>
    </div>
  )
}
