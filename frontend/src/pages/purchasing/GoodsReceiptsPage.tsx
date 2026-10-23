import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PackagePlus, Trash2, Undo2 } from 'lucide-react'
import * as React from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { BookSearch } from '@/components/common/BookSearch'
import { DataTable } from '@/components/common/DataTable'
import { LocationSelect } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, SheetContent } from '@/components/ui/dialog'
import { Field, Input, NativeSelect } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, errorMessage, type Page } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useIdempotencyKey } from '@/lib/hooks'
import { useSuppliers } from '@/lib/queries'
import type { Book } from '@/lib/types'
import { formatDate, formatINR } from '@/lib/utils'
import type { GRN } from './types'

interface SR { id: string; number: string; supplier_name: string; reason: string; value: string; created_at: string; lines: { title: string; qty: number; from_bucket: string }[] }

export default function GoodsReceiptsPage() {
  const { can, locationId } = useAuth()
  const [page, setPage] = React.useState(1)
  const [detail, setDetail] = React.useState<GRN | null>(null)
  const [mode, setMode] = React.useState<null | 'receive' | 'return'>(null)
  const list = useQuery({ queryKey: ['grns', page, locationId], queryFn: () => api.get<Page<GRN>>('/goods-receipts', { page, page_size: 25, location_id: locationId ?? undefined }), placeholderData: keepPreviousData })
  const rets = useQuery({ queryKey: ['supplier-returns'], queryFn: () => api.get<Page<SR>>('/supplier-returns', { page_size: 50 }) })
  return (
    <div>
      <PageHeader title="Goods receipts & supplier returns" description="Each receipt posts stock exactly once and records landed cost."
        actions={<>
          {can('purchasing.return') && <Button variant="secondary" onClick={() => setMode('return')}><Undo2 /> Return to supplier</Button>}
          {can('purchasing.receive') && <Button onClick={() => setMode('receive')}><PackagePlus /> Receive without PO</Button>}
        </>} />
      <Tabs defaultValue="grn">
        <TabsList><TabsTrigger value="grn">Goods receipts</TabsTrigger><TabsTrigger value="returns">Supplier returns</TabsTrigger></TabsList>
        <TabsContent value="grn">
          <Card>
            <DataTable
              rows={list.data?.items}
              loading={list.isFetching}
              error={list.error}
              rowKey={(g) => g.id}
              onRowClick={setDetail}
              page={page}
              pageSize={25}
              total={list.data?.total}
              onPageChange={setPage}
              empty={{ title: 'No goods received yet' }}
              columns={[
                { key: 'n', header: 'GRN', cell: (g) => <span className="font-medium">{g.number}</span> },
                { key: 'd', header: 'Received', cell: (g) => formatDate(g.received_at, true) },
                { key: 's', header: 'Supplier', cell: (g) => g.supplier_name },
                { key: 'p', header: 'PO', hideBelow: 'md', cell: (g) => g.po_id ? <Link onClick={(e) => e.stopPropagation()} className="hover:text-primary" to={`/purchasing/orders/${g.po_id}`}>{g.po_number}</Link> : '—' },
                { key: 'l', header: 'Location', hideBelow: 'lg', cell: (g) => g.location_name },
                { key: 'v', header: 'Landed value', align: 'right', cell: (g) => formatINR(g.total_landed) },
                { key: 'i', header: 'Invoice', cell: (g) => g.supplier_invoice_id ? <Badge tone="success">Invoiced</Badge> : <Badge tone="warning">Pending</Badge> },
              ]}
            />
          </Card>
        </TabsContent>
        <TabsContent value="returns">
          <Card>
            <DataTable
              rows={rets.data?.items}
              loading={rets.isLoading}
              rowKey={(r) => r.id}
              empty={{ title: 'No supplier returns' }}
              columns={[
                { key: 'n', header: 'Debit note', cell: (r) => <span className="font-medium">{r.number}</span> },
                { key: 'd', header: 'Date', cell: (r) => formatDate(r.created_at) },
                { key: 's', header: 'Supplier', cell: (r) => r.supplier_name },
                { key: 'i', header: 'Items', hideBelow: 'md', cell: (r) => r.lines.map((l) => `${l.title} ×${l.qty}`).join(', ') },
                { key: 'r', header: 'Reason', hideBelow: 'lg', cell: (r) => r.reason },
                { key: 'v', header: 'Value', align: 'right', cell: (r) => formatINR(r.value) },
              ]}
            />
          </Card>
        </TabsContent>
      </Tabs>
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <SheetContent title={detail?.number ?? ''} description={detail ? `${detail.supplier_name} · ${detail.location_name}` : ''}>
          {detail && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <p><span className="text-muted">Supplier ref:</span> {detail.supplier_ref ?? '—'}</p>
                <p><span className="text-muted">Received:</span> {formatDate(detail.received_at, true)}</p>
                <p><span className="text-muted">Goods:</span> {formatINR(detail.goods_value)}</p>
                <p><span className="text-muted">Freight + other:</span> {formatINR(Number(detail.freight) + Number(detail.other_charges))}</p>
              </div>
              <table className="w-full text-sm">
                <thead className="text-xs text-muted"><tr><th className="py-1 text-left">Book</th><th className="text-right">Good</th><th className="text-right">Dmg</th><th className="text-right">Landed cost</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {detail.lines.map((l) => <tr key={l.book_id}><td className="py-1.5">{l.title}</td><td className="num text-right">{l.qty_received}</td><td className="num text-right">{l.qty_damaged || '—'}</td><td className="num text-right">{formatINR(l.landed_unit_cost)}</td></tr>)}
                </tbody>
              </table>
            </div>
          )}
        </SheetContent>
      </Dialog>
      {mode && <AdHocDialog mode={mode} onClose={() => setMode(null)} />}
    </div>
  )
}

function AdHocDialog({ mode, onClose }: { mode: 'receive' | 'return'; onClose: () => void }) {
  const { me } = useAuth()
  const qc = useQueryClient()
  const idem = useIdempotencyKey()
  const sups = useSuppliers()
  const [supplier, setSupplier] = React.useState('')
  const [loc, setLoc] = React.useState<string | null>(me?.locations.find((l) => l.type === 'WAREHOUSE')?.id ?? null)
  const [reason, setReason] = React.useState('')
  const [lines, setLines] = React.useState<{ book: Book; qty: string; cost: string; bucket: string }[]>([])
  const save = useMutation({
    mutationFn: () => mode === 'receive'
      ? api.post('/goods-receipts', { location_id: loc, supplier_id: supplier, lines: lines.map((l) => ({ book_id: l.book.id, qty_received: Number(l.qty), unit_cost: l.cost })) }, { idempotencyKey: idem.key })
      : api.post('/supplier-returns', { location_id: loc, supplier_id: supplier, reason, lines: lines.map((l) => ({ book_id: l.book.id, qty: Number(l.qty), from_bucket: l.bucket })) }, { idempotencyKey: idem.key }),
    onSuccess: () => { toast.success(mode === 'receive' ? 'Goods receipt posted' : 'Debit note created'); void qc.invalidateQueries({ queryKey: ['grns'] }); void qc.invalidateQueries({ queryKey: ['supplier-returns'] }); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const valid = supplier && loc && lines.length && (mode === 'receive' ? lines.every((l) => Number(l.qty) > 0 && l.cost !== '') : reason.length >= 3)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg" title={mode === 'receive' ? 'Receive goods without a PO' : 'Return goods to supplier'}
        description={mode === 'receive' ? 'Use for walk-in purchases or consignment. Unit cost is required for valuation.' : 'Stock leaves at weighted-average cost and a debit note reduces the payable.'}
        footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>{mode === 'receive' ? 'Post receipt' : 'Create debit note'}</Button></>}>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Supplier" required><NativeSelect value={supplier} onChange={(e) => setSupplier(e.target.value)}><option value="">Choose…</option>{(sups.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</NativeSelect></Field>
            <Field label="Location" required><LocationSelect value={loc} onChange={setLoc} allowAll={false} className="w-full" /></Field>
          </div>
          {mode === 'return' && <Field label="Reason" required><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
          <BookSearch locationId={loc} onSelect={(b) => setLines((ls) => ls.some((x) => x.book.id === b.id) ? ls : [...ls, { book: b, qty: '1', cost: b.purchase_price ?? '', bucket: 'DAMAGED' }])} />
          {lines.map((l, i) => (
            <div key={l.book.id} className="flex items-end gap-3">
              <p className="flex-1 truncate text-sm">{l.book.title}</p>
              <Field label="Qty" className="w-20"><Input inputMode="numeric" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} /></Field>
              {mode === 'receive' ? (
                <Field label="Unit cost" className="w-28"><Input inputMode="decimal" value={l.cost} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, cost: e.target.value } : x))} /></Field>
              ) : (
                <Field label="From" className="w-36"><NativeSelect value={l.bucket} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, bucket: e.target.value } : x))}><option value="DAMAGED">Damaged</option><option value="ON_HAND">Sellable</option><option value="QUARANTINED">Quarantine</option></NativeSelect></Field>
              )}
              <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 /></Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
