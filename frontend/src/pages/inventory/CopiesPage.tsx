import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Printer } from 'lucide-react'
import * as React from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { DataTable } from '@/components/common/DataTable'
import { SearchInput } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, SheetContent } from '@/components/ui/dialog'
import { Field, Input, NativeSelect } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/misc'
import { api, errorMessage, type Page } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useDebounced } from '@/lib/hooks'
import { formatDate, formatINR, titleCase } from '@/lib/utils'

interface CopyRow { id: string; copy_code: string; book_id: string; title: string; sku: string; location_name: string; status: string; condition: string; acquisition_cost: string | null; selling_price: string; created_at: string }
interface CopyEvent { event_type: string; from_location: string | null; to_location: string | null; from_status: string | null; to_status: string | null; condition: string | null; actor: string | null; created_at: string; note: string | null }

export default function CopiesPage() {
  const { locationId, can } = useAuth()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [q, setQ] = React.useState('')
  const [status, setStatus] = React.useState('AVAILABLE')
  const [page, setPage] = React.useState(1)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [detail, setDetail] = React.useState<string | null>(null)
  const dq = useDebounced(q)
  const book = params.get('book') ?? undefined
  React.useEffect(() => setPage(1), [dq, status, locationId])
  const list = useQuery({
    queryKey: ['copies', locationId, dq, status, page, book],
    queryFn: () => api.get<Page<CopyRow>>('/copies', { location_id: locationId ?? undefined, q: dq, status, page, page_size: 30, book_id: book }),
    placeholderData: keepPreviousData,
  })
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  return (
    <div>
      <PageHeader title="Individual copies" description="Each copy-tracked book has a unique barcode and full lifecycle history."
        actions={<>
          <Button variant="secondary" onClick={() => navigate('/inventory/labels')}><Printer /> Book labels</Button>
          <Button disabled={!selected.size} onClick={() => navigate(`/inventory/labels?copies=${[...selected].join(',')}`)}><Printer /> Print {selected.size || ''} copy labels</Button>
        </>} />
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-border p-3">
          <SearchInput value={q} onChange={setQ} placeholder="Copy code or title…" />
          <NativeSelect aria-label="Copy status" className="w-full sm:w-48" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {['AVAILABLE', 'IN_TRANSIT', 'SOLD', 'DAMAGED', 'QUARANTINED', 'WRITTEN_OFF', 'LOST', 'RETURNED_TO_SUPPLIER'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </NativeSelect>
        </div>
        <DataTable
          rows={list.data?.items}
          loading={list.isFetching}
          error={list.error}
          rowKey={(r) => r.id}
          page={page}
          pageSize={30}
          total={list.data?.total}
          onPageChange={setPage}
          onRowClick={(r) => setDetail(r.id)}
          empty={{ title: 'No copies found', description: 'Copies are created automatically when copy-tracked books are received.' }}
          columns={[
            { key: 'sel', header: <span className="sr-only">Select</span>, cell: (r) => <span onClick={(e) => e.stopPropagation()}><Checkbox aria-label={`Select ${r.copy_code}`} checked={selected.has(r.id)} onCheckedChange={() => toggle(r.id)} /></span> },
            { key: 'c', header: 'Copy code', cell: (r) => <span className="num font-medium">{r.copy_code}</span> },
            { key: 't', header: 'Book', cell: (r) => r.title },
            { key: 'l', header: 'Location', hideBelow: 'md', cell: (r) => r.location_name },
            { key: 'cd', header: 'Condition', hideBelow: 'md', cell: (r) => titleCase(r.condition) },
            ...(can('reports.financial') || can('purchasing.view') ? [{ key: 'a', header: 'Acq. cost', align: 'right' as const, hideBelow: 'lg' as const, cell: (r: CopyRow) => formatINR(r.acquisition_cost) }] : []),
            { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          ]}
        />
      </Card>
      <CopyDetail id={detail} onClose={() => setDetail(null)} />
    </div>
  )
}

function CopyDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can } = useAuth()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['copy', id], queryFn: () => api.get<{ copy: CopyRow; events: CopyEvent[] }>(`/copies/${id}`), enabled: !!id })
  const [cond, setCond] = React.useState('GOOD')
  const [note, setNote] = React.useState('')
  const save = useMutation({
    mutationFn: () => api.post(`/copies/${id}/condition`, { condition: cond, note: note || null }),
    onSuccess: () => { toast.success('Condition updated'); void qc.invalidateQueries({ queryKey: ['copy', id] }); void qc.invalidateQueries({ queryKey: ['copies'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const c = q.data?.copy
  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={c ? c.copy_code : 'Copy'} description={c?.title}>
        {c && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><p className="text-xs text-muted">Status</p><StatusBadge status={c.status} /></div>
              <div><p className="text-xs text-muted">Location</p><p>{c.location_name}</p></div>
              <div><p className="text-xs text-muted">Condition</p><p>{titleCase(c.condition)}</p></div>
              <div><p className="text-xs text-muted">Price</p><p>{formatINR(c.selling_price)}</p></div>
            </div>
            {can('inventory.copies') && ['AVAILABLE', 'QUARANTINED'].includes(c.status) && (
              <div className="flex items-end gap-2 rounded-md border border-border p-3">
                <Field label="Condition" className="w-32"><NativeSelect value={cond} onChange={(e) => setCond(e.target.value)}>{['NEW', 'GOOD', 'FAIR', 'POOR'].map((x) => <option key={x}>{x}</option>)}</NativeSelect></Field>
                <Field label="Note" className="flex-1"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
                <Button size="md" loading={save.isPending} onClick={() => save.mutate()}>Update</Button>
              </div>
            )}
            <div>
              <p className="mb-2 text-sm font-semibold">History</p>
              <ol className="relative space-y-3 border-l border-border pl-4">
                {q.data!.events.map((e, i) => (
                  <li key={i} className="text-sm">
                    <span className="absolute -left-1.5 mt-1.5 size-3 rounded-full border-2 border-white bg-primary" aria-hidden />
                    <p className="font-medium">{titleCase(e.event_type)}</p>
                    <p className="text-xs text-muted">
                      {[e.from_status && e.to_status && e.from_status !== e.to_status ? `${titleCase(e.from_status)} → ${titleCase(e.to_status)}` : titleCase(e.to_status),
                        e.from_location !== e.to_location ? `${e.from_location ?? '—'} → ${e.to_location}` : e.to_location, e.actor].filter(Boolean).join(' · ')}
                    </p>
                    {e.note && <p className="text-xs text-slate-600">{e.note}</p>}
                    <p className="text-[11px] text-subtle">{formatDate(e.created_at, true)}</p>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </SheetContent>
    </Dialog>
  )
}
