import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import * as React from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { BookSearch } from '@/components/common/BookSearch'
import { DataTable } from '@/components/common/DataTable'
import { LocationSelect } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, errorMessage, type Page } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import type { Book } from '@/lib/types'
import { formatDate, formatINR, titleCase } from '@/lib/utils'

interface Adjustment { id: string; number: string; location_name: string; reason_code: string; status: string; notes: string | null; value: string | null; created_by_name: string | null; created_at: string; lines: { title: string; qty: number; from_bucket: string | null; to_bucket: string | null; copy_code: string | null }[] }
interface Stocktake { id: string; number: string; location_name: string; status: string; created_at: string; posted_at: string | null; lines: unknown[] }

const REASONS: Record<string, string> = {
  DAMAGE: 'Damaged (move to damaged stock)', LOSS: 'Lost / missing', WRITE_OFF: 'Write off damaged stock', FOUND: 'Found stock',
  QUARANTINE: 'Quarantine for inspection', RELEASE: 'Release from quarantine', OPENING: 'Opening stock (with cost)',
}

export default function AdjustmentsPage() {
  const { can, locationId } = useAuth()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'adjustments'
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [page, setPage] = React.useState(1)
  const [open, setOpen] = React.useState(false)
  const adjs = useQuery({
    queryKey: ['adjustments', locationId, page],
    queryFn: () => api.get<Page<Adjustment>>('/inventory/adjustments', { location_id: locationId ?? undefined, page, page_size: 20 }),
    placeholderData: keepPreviousData,
  })
  const sts = useQuery({ queryKey: ['stocktakes', locationId], queryFn: () => api.get<Page<Stocktake>>('/inventory/stocktakes', { location_id: locationId ?? undefined, page_size: 50 }) })
  const startCount = useMutation({
    mutationFn: () => api.post<Stocktake>('/inventory/stocktakes', { location_id: locationId }),
    onSuccess: (st) => { void qc.invalidateQueries({ queryKey: ['stocktakes'] }); navigate(`/inventory/stocktakes/${st.id}`) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <div>
      <PageHeader
        title="Adjustments & stocktakes"
        description="Every stock correction is an authorised, audited ledger entry. Large adjustments need approval."
        actions={
          <>
            {can('inventory.stocktake') && <Button variant="secondary" disabled={!locationId} title={!locationId ? 'Select a location first' : undefined} loading={startCount.isPending} onClick={() => startCount.mutate()}>Start stocktake</Button>}
            {can('inventory.adjust') && <Button onClick={() => setOpen(true)}><Plus /> New adjustment</Button>}
          </>
        }
      />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList><TabsTrigger value="adjustments">Adjustments</TabsTrigger><TabsTrigger value="stocktakes">Stocktakes</TabsTrigger></TabsList>
        <TabsContent value="adjustments">
          <Card>
            <DataTable
              rows={adjs.data?.items}
              loading={adjs.isFetching}
              error={adjs.error}
              rowKey={(r) => r.id}
              page={page}
              pageSize={20}
              total={adjs.data?.total}
              onPageChange={setPage}
              empty={{ title: 'No adjustments yet' }}
              columns={[
                { key: 'n', header: 'Number', cell: (r) => <span className="font-medium">{r.number}</span> },
                { key: 'd', header: 'Date', cell: (r) => formatDate(r.created_at, true) },
                { key: 'l', header: 'Location', cell: (r) => r.location_name },
                { key: 'r', header: 'Reason', cell: (r) => titleCase(r.reason_code) },
                { key: 'i', header: 'Items', hideBelow: 'md', cell: (r) => r.lines.map((l) => `${l.title} ×${l.qty}${l.copy_code ? ` (${l.copy_code})` : ''}`).join(', ') },
                { key: 'v', header: 'Value', align: 'right', hideBelow: 'md', cell: (r) => formatINR(r.value) },
                { key: 'b', header: 'By', hideBelow: 'lg', cell: (r) => r.created_by_name },
                { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
              ]}
            />
          </Card>
        </TabsContent>
        <TabsContent value="stocktakes">
          <Card>
            <DataTable
              rows={sts.data?.items}
              loading={sts.isFetching}
              error={sts.error}
              rowKey={(r) => r.id}
              onRowClick={(r) => navigate(`/inventory/stocktakes/${r.id}`)}
              empty={{ title: 'No stocktakes', description: locationId ? 'Start a count for the selected location.' : 'Select a location in the top bar, then start a count.' }}
              columns={[
                { key: 'n', header: 'Number', cell: (r) => <span className="font-medium">{r.number}</span> },
                { key: 'l', header: 'Location', cell: (r) => r.location_name },
                { key: 'c', header: 'Lines counted', align: 'right', cell: (r) => r.lines.length },
                { key: 'd', header: 'Started', cell: (r) => formatDate(r.created_at, true) },
                { key: 'p', header: 'Posted', cell: (r) => formatDate(r.posted_at, true) },
                { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
              ]}
            />
          </Card>
        </TabsContent>
      </Tabs>
      <AdjustmentDialog open={open} onOpenChange={setOpen} />
    </div>
  )
}

interface Line { book: Book; qty: string; unit_cost: string; copy_codes: string }

function AdjustmentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { locationId } = useAuth()
  const qc = useQueryClient()
  const [loc, setLoc] = React.useState<string | null>(locationId)
  const [reason, setReason] = React.useState('DAMAGE')
  const [notes, setNotes] = React.useState('')
  const [lines, setLines] = React.useState<Line[]>([])
  React.useEffect(() => { if (open) { setLoc(locationId); setLines([]); setNotes('') } }, [open, locationId])
  const save = useMutation({
    mutationFn: async () => {
      const out = []
      for (const l of lines) {
        let copy_ids: string[] | undefined
        const codes = l.copy_codes.split(/[\s,]+/).filter(Boolean)
        if (l.book.tracking_mode === 'COPY' && reason !== 'OPENING' && reason !== 'FOUND') {
          copy_ids = []
          for (const code of codes) {
            const r = await api.get<{ copy_id: string | null }>('/books/lookup', { code })
            if (!r.copy_id) throw new Error(`Copy ${code} not found`)
            copy_ids.push(r.copy_id)
          }
        }
        out.push({ book_id: l.book.id, qty: copy_ids ? copy_ids.length : Number(l.qty), unit_cost: l.unit_cost || null, copy_ids })
      }
      return api.post<{ number: string; status: string }>('/inventory/adjustments', { location_id: loc, reason_code: reason, notes: notes || null, lines: out })
    },
    onSuccess: (r) => {
      toast.success(r.status === 'PENDING_APPROVAL' ? `${r.number} sent for approval` : `${r.number} posted`)
      onOpenChange(false)
      void qc.invalidateQueries({ queryKey: ['adjustments'] })
      void qc.invalidateQueries({ queryKey: ['inventory'] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" title="New stock adjustment" description="Removals are valued at weighted-average cost and posted to the inventory and shrinkage accounts."
        footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={!loc || !lines.length || notes.length < 3} loading={save.isPending} onClick={() => save.mutate()}>Submit adjustment</Button></>}>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Location" required><LocationSelect value={loc} onChange={setLoc} allowAll={false} className="w-full" /></Field>
            <Field label="Reason" required>
              <NativeSelect value={reason} onChange={(e) => setReason(e.target.value)}>
                {Object.entries(REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </NativeSelect>
            </Field>
          </div>
          <Field label="Add item"><BookSearch locationId={loc} onSelect={(b) => setLines((ls) => ls.some((x) => x.book.id === b.id) ? ls : [...ls, { book: b, qty: '1', unit_cost: '', copy_codes: '' }])} /></Field>
          {lines.length > 0 && (
            <div className="divide-y divide-border rounded-md border border-border">
              {lines.map((l, i) => (
                <div key={l.book.id} className="flex flex-wrap items-end gap-3 p-3">
                  <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{l.book.title}</p><p className="text-xs text-muted">{l.book.sku}</p></div>
                  {l.book.tracking_mode === 'COPY' && reason !== 'OPENING' && reason !== 'FOUND' ? (
                    <Field label="Copy codes" className="w-56"><Input value={l.copy_codes} placeholder="CP00000001, CP00000002" onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, copy_codes: e.target.value } : x))} /></Field>
                  ) : (
                    <Field label="Qty" className="w-20"><Input inputMode="numeric" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} /></Field>
                  )}
                  {(reason === 'OPENING' || reason === 'FOUND') && <Field label="Unit cost (₹)" className="w-28"><Input inputMode="decimal" value={l.unit_cost} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, unit_cost: e.target.value } : x))} /></Field>}
                  <Button variant="ghost" size="icon" aria-label="Remove line" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 /></Button>
                </div>
              ))}
            </div>
          )}
          <Field label="Notes / justification" required><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} /></Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
