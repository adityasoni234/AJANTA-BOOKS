import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, GitMerge, ImagePlus, Pencil, Printer, Settings2 } from 'lucide-react'
import * as React from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Barcode } from '@/components/common/Barcode'
import { DataTable } from '@/components/common/DataTable'
import { LocationSelect } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { ErrorState, PageLoader } from '@/components/common/States'
import { Badge, StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { BookSearch } from '@/components/common/BookSearch'
import { api, errorMessage, type Page } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import type { Book } from '@/lib/types'
import { formatDate, formatINR, titleCase } from '@/lib/utils'

interface StockRow { location_id: string; location_name: string; location_type: string; on_hand: number; reserved: number; available: number; damaged: number; quarantined: number; in_transit: number; reorder_level: number | null; price_override: string | null; avg_cost: string | null }
interface Detail extends Book { stock: StockRow[]; suppliers: { supplier_id: string; name: string; supplier_sku: string | null; last_cost: string | null; last_purchased_at: string | null }[]; default_supplier_name: string | null }
interface PriceRow { id: string; field: string; old_value: string | null; new_value: string | null; reason: string | null; changed_by_name: string | null; changed_at: string; location_id: string | null }
interface LedgerRow { id: number; location_name: string; bucket: string; qty_delta: number; movement_type: string; ref_number: string | null; unit_cost: string | null; actor_name: string | null; created_at: string; note: string | null }

export default function BookDetailPage() {
  const { id } = useParams()
  const { can } = useAuth()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['book', id], queryFn: () => api.get<Detail>(`/books/${id}`) })
  const [ledgerPage, setLedgerPage] = React.useState(1)
  const prices = useQuery({ queryKey: ['book-prices', id], queryFn: () => api.get<PriceRow[]>(`/books/${id}/price-history`) })
  const ledger = useQuery({
    queryKey: ['book-ledger', id, ledgerPage],
    queryFn: () => api.get<Page<LedgerRow>>(`/books/${id}/inventory-history`, { page: ledgerPage, page_size: 15 }),
    enabled: can('inventory.view'),
  })
  const [locDialog, setLocDialog] = React.useState(false)
  const [mergeDialog, setMergeDialog] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement>(null)

  const upload = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData()
      fd.append('file', file)
      return api.post<Book>(`/books/${id}/cover`, fd)
    },
    onSuccess: () => { toast.success('Cover updated'); void qc.invalidateQueries({ queryKey: ['book', id] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })

  if (q.isLoading) return <PageLoader />
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const b = q.data
  const totals = b.stock.reduce((a, s) => ({ on_hand: a.on_hand + s.on_hand, available: a.available + s.available, transit: a.transit + s.in_transit }), { on_hand: 0, available: 0, transit: 0 })

  return (
    <div>
      <PageHeader
        title={b.title}
        description={[b.subtitle, b.authors.join(', ')].filter(Boolean).join(' · ')}
        crumbs={[{ label: 'Catalog', to: '/catalog' }, { label: b.sku }]}
        actions={
          <>
            <Button variant="secondary" asChild><Link to={`/inventory/labels?book=${b.id}`}><Printer /> Labels</Link></Button>
            {can('catalog.merge') && b.status !== 'ARCHIVED' && <Button variant="secondary" onClick={() => setMergeDialog(true)}><GitMerge /> Merge</Button>}
            {can('catalog.edit') && <Button asChild><Link to={`/catalog/${b.id}/edit`}><Pencil /> Edit</Link></Button>}
          </>
        }
      />
      {b.merged_into_id && (
        <div className="mb-4 rounded-md border border-amber-200 bg-warning-soft px-4 py-3 text-sm text-amber-800">
          This record was merged into <Link className="underline" to={`/catalog/${b.merged_into_id}`}>another book</Link>. History is preserved here.
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardBody className="flex flex-col gap-6 sm:flex-row">
              <div className="flex w-32 shrink-0 flex-col items-center gap-2">
                {b.cover_url ? (
                  <img src={b.cover_url} alt={`Cover of ${b.title}`} className="h-44 w-32 rounded-md border border-border object-cover" />
                ) : (
                  <div className="flex h-44 w-32 items-center justify-center rounded-md border border-dashed border-border bg-surface text-xs text-subtle">No cover</div>
                )}
                {can('catalog.edit') && (
                  <>
                    <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
                    <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()} loading={upload.isPending}><ImagePlus /> Cover</Button>
                  </>
                )}
              </div>
              <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
                <Info label="Status"><div className="flex gap-1"><StatusBadge status={b.status} />{b.tracking_mode === 'COPY' && <Badge tone="primary">Copy-tracked</Badge>}</div></Info>
                <Info label="ISBN-13">{b.isbn13 ?? '—'}</Info>
                <Info label="ISBN-10">{b.isbn10 ?? '—'}</Info>
                <Info label="SKU">{b.sku}</Info>
                <Info label="Publisher">{b.publisher ?? '—'}</Info>
                <Info label="Category">{b.category ?? '—'}</Info>
                <Info label="Edition">{b.edition ?? '—'}</Info>
                <Info label="Language">{b.language ?? '—'}</Info>
                <Info label="Binding">{b.binding ?? '—'}</Info>
                <Info label="MRP">{formatINR(b.mrp)}</Info>
                <Info label="Selling price">{formatINR(b.selling_price)}</Info>
                <Info label="Minimum price">{formatINR(b.min_selling_price)}</Info>
                <Info label="GST">{b.tax_class} · HSN {b.hsn_code ?? '—'}</Info>
                {b.purchase_price !== null && <Info label="Last purchase price">{formatINR(b.purchase_price)}</Info>}
                <Info label="Reorder">{b.reorder_level} / {b.reorder_qty}</Info>
                {b.default_supplier_name && <Info label="Default supplier">{b.default_supplier_name}</Info>}
              </dl>
            </CardBody>
            {b.description && <p className="border-t border-border px-5 py-4 text-sm text-slate-600">{b.description}</p>}
          </Card>
          <Card>
            <Tabs defaultValue="stock" className="px-5 pt-2">
              <TabsList>
                <TabsTrigger value="stock">Stock by location</TabsTrigger>
                {can('inventory.view') && <TabsTrigger value="ledger">Inventory history</TabsTrigger>}
                <TabsTrigger value="prices">Price history</TabsTrigger>
                {b.suppliers.length > 0 && <TabsTrigger value="suppliers">Suppliers</TabsTrigger>}
              </TabsList>
              <TabsContent value="stock" className="-mx-5">
                <DataTable
                  rows={b.stock}
                  rowKey={(r) => r.location_id}
                  empty={{ title: 'No stock recorded yet' }}
                  columns={[
                    { key: 'l', header: 'Location', cell: (r) => r.location_name },
                    { key: 'a', header: 'Available', align: 'right', cell: (r) => <span className={r.available <= 0 ? 'text-danger' : ''}>{r.available}</span> },
                    { key: 'o', header: 'On hand', align: 'right', cell: (r) => r.on_hand },
                    { key: 'r', header: 'Reserved', align: 'right', hideBelow: 'md', cell: (r) => r.reserved },
                    { key: 'd', header: 'Damaged / Q', align: 'right', hideBelow: 'md', cell: (r) => `${r.damaged} / ${r.quarantined}` },
                    { key: 't', header: 'In transit', align: 'right', cell: (r) => r.in_transit },
                    { key: 'p', header: 'Price', align: 'right', hideBelow: 'lg', cell: (r) => r.price_override ? <Badge tone="info">{formatINR(r.price_override)}</Badge> : '—' },
                    ...(b.stock.some((s) => s.avg_cost !== null) ? [{ key: 'c', header: 'Avg cost', align: 'right' as const, hideBelow: 'lg' as const, cell: (r: StockRow) => formatINR(r.avg_cost) }] : []),
                  ]}
                />
              </TabsContent>
              <TabsContent value="ledger" className="-mx-5">
                <DataTable
                  rows={ledger.data?.items}
                  loading={ledger.isFetching}
                  error={ledger.error}
                  rowKey={(r) => String(r.id)}
                  page={ledgerPage}
                  pageSize={15}
                  total={ledger.data?.total}
                  onPageChange={setLedgerPage}
                  empty={{ title: 'No movements yet' }}
                  dense
                  columns={[
                    { key: 'd', header: 'Date', cell: (r) => formatDate(r.created_at, true) },
                    { key: 'l', header: 'Location', cell: (r) => r.location_name },
                    { key: 'm', header: 'Movement', cell: (r) => titleCase(r.movement_type) },
                    { key: 'b', header: 'Bucket', hideBelow: 'md', cell: (r) => titleCase(r.bucket) },
                    { key: 'q', header: 'Qty', align: 'right', cell: (r) => <span className={r.qty_delta < 0 ? 'text-danger' : 'text-success'}>{r.qty_delta > 0 ? '+' : ''}{r.qty_delta}</span> },
                    { key: 'r', header: 'Reference', hideBelow: 'md', cell: (r) => r.ref_number ?? '—' },
                    { key: 'u', header: 'By', hideBelow: 'lg', cell: (r) => r.actor_name ?? '—' },
                  ]}
                />
              </TabsContent>
              <TabsContent value="prices" className="-mx-5">
                <DataTable
                  rows={prices.data}
                  loading={prices.isLoading}
                  rowKey={(r) => r.id}
                  dense
                  empty={{ title: 'No price changes' }}
                  columns={[
                    { key: 'd', header: 'Date', cell: (r) => formatDate(r.changed_at, true) },
                    { key: 'f', header: 'Field', cell: (r) => titleCase(r.field) },
                    { key: 'o', header: 'From', align: 'right', cell: (r) => formatINR(r.old_value) },
                    { key: 'n', header: 'To', align: 'right', cell: (r) => formatINR(r.new_value) },
                    { key: 'r', header: 'Reason', hideBelow: 'md', cell: (r) => r.reason ?? '—' },
                    { key: 'u', header: 'By', hideBelow: 'md', cell: (r) => r.changed_by_name ?? '—' },
                  ]}
                />
              </TabsContent>
              <TabsContent value="suppliers" className="-mx-5">
                <DataTable
                  rows={b.suppliers}
                  rowKey={(r) => r.supplier_id}
                  columns={[
                    { key: 'n', header: 'Supplier', cell: (r) => <Link className="hover:text-primary" to={`/suppliers/${r.supplier_id}`}>{r.name}</Link> },
                    { key: 'c', header: 'Last cost', align: 'right', cell: (r) => formatINR(r.last_cost) },
                    { key: 'd', header: 'Last purchased', cell: (r) => formatDate(r.last_purchased_at) },
                  ]}
                />
              </TabsContent>
            </Tabs>
          </Card>
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Barcode" />
            <CardBody className="flex flex-col items-center gap-2">
              <Barcode value={b.barcode} format={/^\d{13}$/.test(b.barcode) ? 'EAN13' : 'CODE128'} />
              <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard?.writeText(b.barcode); toast.success('Copied') }}><Copy /> Copy code</Button>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Stock summary" actions={(can('catalog.price_edit') || can('inventory.settings')) && <Button size="sm" variant="secondary" onClick={() => setLocDialog(true)}><Settings2 /> Location settings</Button>} />
            <CardBody className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted">On hand (all your locations)</span><span className="num font-medium">{totals.on_hand}</span></div>
              <div className="flex justify-between"><span className="text-muted">Available</span><span className="num font-medium">{totals.available}</span></div>
              <div className="flex justify-between"><span className="text-muted">In transit</span><span className="num font-medium">{totals.transit}</span></div>
              {b.tracking_mode === 'COPY' && <Button variant="link" asChild><Link to={`/inventory/copies?book=${b.id}`}>View individual copies →</Link></Button>}
            </CardBody>
          </Card>
        </div>
      </div>
      <LocationSettingsDialog open={locDialog} onOpenChange={setLocDialog} book={b} />
      <MergeDialog open={mergeDialog} onOpenChange={setMergeDialog} book={b} onMerged={(target) => navigate(`/catalog/${target}`)} />
    </div>
  )
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 font-medium text-foreground">{children}</dd>
    </div>
  )
}

function LocationSettingsDialog({ open, onOpenChange, book }: { open: boolean; onOpenChange: (o: boolean) => void; book: Detail }) {
  const { locationId, can } = useAuth()
  const qc = useQueryClient()
  const [loc, setLoc] = React.useState<string | null>(locationId)
  const current = book.stock.find((s) => s.location_id === loc)
  const [price, setPrice] = React.useState('')
  const [reorder, setReorder] = React.useState('')
  const [reason, setReason] = React.useState('')
  React.useEffect(() => {
    setPrice(current?.price_override ?? '')
    setReorder(current?.reorder_level !== null && current?.reorder_level !== undefined ? String(current.reorder_level) : '')
  }, [current?.price_override, current?.reorder_level, loc])
  const save = useMutation({
    mutationFn: () => api.put(`/books/${book.id}/location-settings`, {
      location_id: loc, price_override: price === '' ? null : price, reorder_level: reorder === '' ? null : Number(reorder),
      reorder_qty: null, reason: reason || null,
    }),
    onSuccess: () => { toast.success('Location settings saved'); onOpenChange(false); void qc.invalidateQueries({ queryKey: ['book', book.id] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Location price & reorder level" description="Overrides apply only to the chosen location."
        footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={!loc} loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
        <div className="space-y-4">
          <Field label="Location"><LocationSelect value={loc} onChange={setLoc} allowAll={false} className="w-full" /></Field>
          <Field label="Price override (₹)" hint={`Organisation price ${formatINR(book.selling_price)} · MRP ${formatINR(book.mrp)}. Leave blank to use the organisation price.`}>
            <Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} disabled={!can('catalog.price_edit')} />
          </Field>
          <Field label="Reorder level" hint={`Blank uses the book default (${book.reorder_level})`}>
            <Input inputMode="numeric" value={reorder} onChange={(e) => setReorder(e.target.value)} disabled={!can('inventory.settings')} />
          </Field>
          <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function MergeDialog({ open, onOpenChange, book, onMerged }: { open: boolean; onOpenChange: (o: boolean) => void; book: Detail; onMerged: (id: string) => void }) {
  const [target, setTarget] = React.useState<Book | null>(null)
  const [reason, setReason] = React.useState('')
  const merge = useMutation({
    mutationFn: () => api.post<Book>(`/books/${book.id}/merge`, { into_book_id: target!.id, reason }),
    onSuccess: (r) => { toast.success('Records merged'); onOpenChange(false); onMerged(r.id) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Merge duplicate record" description="Moves this record’s stock and copies into the surviving book and archives this one. Sales history is preserved."
        footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="danger" disabled={!target || reason.length < 3} loading={merge.isPending} onClick={() => merge.mutate()}>Merge into selected</Button></>}>
        <div className="space-y-4">
          <Field label="Surviving book"><BookSearch onSelect={(b) => b.id !== book.id && setTarget(b)} /></Field>
          {target && <p className="rounded-md bg-surface px-3 py-2 text-sm">Merge into <strong>{target.title}</strong> ({target.isbn13 ?? target.sku})</p>}
          <Field label="Reason" required><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
