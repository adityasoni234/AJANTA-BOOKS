import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowRight, Check, Truck, X } from 'lucide-react'
import * as React from 'react'
import { useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { PageHeader } from '@/components/common/PageHeader'
import { ErrorState, PageLoader } from '@/components/common/States'
import { Badge, StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input'
import { Checkbox, ConfirmDialog } from '@/components/ui/misc'
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table'
import { api, errorMessage } from '@/lib/api'
import { useIdempotencyKey } from '@/lib/hooks'
import { formatDate, formatINR } from '@/lib/utils'
import type { Transfer } from './types'

export default function TransferDetailPage() {
  const { id } = useParams()
  const q = useQuery({ queryKey: ['transfer', id], queryFn: () => api.get<Transfer>(`/transfers/${id}`) })
  const [mode, setMode] = React.useState<null | 'dispatch' | 'receive' | 'resolve' | 'reject' | 'cancel' | 'approve'>(null)
  const act = useMutation({
    mutationFn: ({ path, body, key }: { path: string; body?: unknown; key?: string }) => api.post<Transfer>(`/transfers/${id}/${path}`, body ?? {}, { idempotencyKey: key }),
    onSuccess: (t) => { q.refetch(); setMode(null); toast.success(`Transfer ${t.status.toLowerCase().replace(/_/g, ' ')}`) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (q.isLoading) return <PageLoader />
  if (!q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const t = q.data
  const steps = [
    { label: 'Requested', at: t.requested_at }, { label: 'Approved', at: t.approved_at }, { label: 'Dispatched', at: t.dispatched_at }, { label: 'Completed', at: t.completed_at },
  ]
  return (
    <div>
      <PageHeader
        title={<span className="flex items-center gap-3">Transfer {t.number} <StatusBadge status={t.status} /></span>}
        description={<span className="flex items-center gap-1.5">{t.source_location_name}<ArrowRight className="size-3.5" />{t.dest_location_name}</span>}
        crumbs={[{ label: 'Transfers', to: '/transfers' }, { label: t.number }]}
        actions={<>
          {t.can.cancel && <Button variant="danger-outline" onClick={() => setMode('cancel')}>Cancel</Button>}
          {t.can.submit && <Button loading={act.isPending} onClick={() => act.mutate({ path: 'submit' })}>Submit request</Button>}
          {t.can.approve && t.approval_request_id && <><Button variant="secondary" onClick={() => setMode('reject')}><X /> Reject</Button><Button onClick={() => setMode('approve')}><Check /> Approve</Button></>}
          {t.can.dispatch && <Button onClick={() => setMode('dispatch')}><Truck /> Dispatch</Button>}
          {t.can.receive && <Button onClick={() => setMode('receive')}>Receive</Button>}
          {t.can.resolve && t.lines.some((l) => l.qty_outstanding > 0) && <Button variant="secondary" onClick={() => setMode('resolve')}>Resolve discrepancy</Button>}
        </>}
      />
      <ol className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {steps.map((s) => (
          <li key={s.label} className={`rounded-md border px-3 py-2 ${s.at ? 'border-primary/30 bg-primary-soft' : 'border-border bg-white'}`}>
            <p className={`text-xs font-medium ${s.at ? 'text-primary' : 'text-muted'}`}>{s.label}</p>
            <p className="text-xs text-muted">{s.at ? formatDate(s.at, true) : '—'}</p>
          </li>
        ))}
      </ol>
      {t.status === 'DISCREPANCY' && <div className="mb-4 rounded-md border border-amber-200 bg-warning-soft px-4 py-3 text-sm text-amber-800">Some dispatched units were not received. A manager must resolve them as lost or returned to source.</div>}
      {t.rejection_reason && <div className="mb-4 rounded-md border border-red-200 bg-danger-soft px-4 py-3 text-sm text-red-700">Reason: {t.rejection_reason}</div>}
      <Card className="mb-6">
        <CardHeader title="Lines" />
        <Table>
          <THead><TR><TH>Book</TH><TH className="text-right">Requested</TH><TH className="text-right">Dispatched</TH><TH className="text-right">Received</TH><TH className="text-right">Damaged</TH><TH className="text-right">Lost / returned</TH><TH className="text-right">Outstanding</TH></TR></THead>
          <TBody>
            {t.lines.map((l) => (
              <TR key={l.id}>
                <TD>
                  <p className="font-medium">{l.title}</p>
                  <p className="text-xs text-muted">{l.isbn13 ?? l.sku}{l.unit_cost && ` · cost ${formatINR(l.unit_cost)}`}</p>
                  {l.copies.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{l.copies.map((c) => <Badge key={c.copy_id} tone={c.state === 'RECEIVED' ? 'success' : c.state === 'DISPATCHED' ? 'info' : 'danger'}>{c.copy_code}</Badge>)}</div>}
                </TD>
                <TD className="num text-right">{l.qty_requested}</TD>
                <TD className="num text-right">{l.qty_dispatched}</TD>
                <TD className="num text-right">{l.qty_received}</TD>
                <TD className="num text-right">{l.qty_damaged || '—'}</TD>
                <TD className="num text-right">{l.qty_lost || l.qty_returned ? `${l.qty_lost} / ${l.qty_returned}` : '—'}</TD>
                <TD className={`num text-right ${l.qty_outstanding ? 'font-semibold text-warning' : ''}`}>{l.qty_outstanding}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader title="Details" />
          <CardBody className="space-y-2 text-sm">
            <p><span className="text-muted">Requested by:</span> {t.created_by_name}</p>
            <p><span className="text-muted">Created:</span> {formatDate(t.created_at, true)}</p>
            {t.notes && <p><span className="text-muted">Notes:</span> {t.notes}</p>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Receipts & resolutions" />
          <CardBody className="space-y-3 text-sm">
            {t.receipts.length === 0 && <p className="text-muted">Nothing received yet.</p>}
            {t.receipts.map((r) => (
              <div key={r.id}>
                <p className="font-medium">{r.kind === 'RECEIPT' ? 'Received' : 'Discrepancy resolved'} by {r.received_by}</p>
                <p className="text-xs text-muted">{formatDate(r.received_at, true)}{r.notes ? ` · ${r.notes}` : ''}</p>
              </div>
            ))}
          </CardBody>
        </Card>
      </div>
      {mode === 'dispatch' && <DispatchDialog t={t} onClose={() => setMode(null)} onSubmit={(lines) => act.mutate({ path: 'dispatch', body: { lines } })} loading={act.isPending} />}
      {mode === 'receive' && <ReceiveDialog t={t} onClose={() => setMode(null)} onSubmit={(body, key) => act.mutate({ path: 'receive', body, key })} loading={act.isPending} />}
      {mode === 'resolve' && <ResolveDialog t={t} onClose={() => setMode(null)} onSubmit={(body, key) => act.mutate({ path: 'resolve', body, key })} loading={act.isPending} />}
      <DecisionDialog open={mode === 'approve' || mode === 'reject'} approve={mode === 'approve'} onClose={() => setMode(null)} loading={act.isPending}
        onSubmit={(note) => act.mutate({ path: 'decision', body: { approve: mode === 'approve', note } })} />
      <CancelDialog open={mode === 'cancel'} onClose={() => setMode(null)} loading={act.isPending} onSubmit={(reason) => act.mutate({ path: 'cancel', body: { reason } })} />
    </div>
  )
}

function DispatchDialog({ t, onClose, onSubmit, loading }: { t: Transfer; onClose: () => void; onSubmit: (lines: unknown[]) => void; loading: boolean }) {
  const [qty, setQty] = React.useState<Record<string, string>>(() => Object.fromEntries(t.lines.map((l) => [l.id, String(l.qty_requested)])))
  const [codes, setCodes] = React.useState<Record<string, string>>({})
  const [err, setErr] = React.useState<string | null>(null)
  const submit = async () => {
    setErr(null)
    try {
      const lines = []
      for (const l of t.lines) {
        const entry: { line_id: string; qty: number; copy_ids?: string[] } = { line_id: l.id, qty: Number(qty[l.id] ?? 0) }
        const cs = (codes[l.id] ?? '').split(/[\s,]+/).filter(Boolean)
        if (l.tracking_mode === 'COPY' && cs.length) {
          entry.copy_ids = []
          for (const c of cs) {
            const r = await api.get<{ copy_id: string | null }>('/books/lookup', { code: c })
            if (!r.copy_id) throw new Error(`Copy ${c} not found`)
            entry.copy_ids.push(r.copy_id)
          }
          entry.qty = entry.copy_ids.length
        }
        lines.push(entry)
      }
      onSubmit(lines)
    } catch (e) {
      setErr(errorMessage(e))
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg" title="Dispatch transfer" description="Stock leaves the source now and is held in transit until the destination receives it. Reduce quantities for short shipments."
        footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} onClick={submit}><Truck /> Dispatch</Button></>}>
        {err && <p className="mb-3 text-sm text-danger" role="alert">{err}</p>}
        <div className="space-y-3">
          {t.lines.map((l) => (
            <div key={l.id} className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3">
              <p className="min-w-0 flex-1 text-sm font-medium">{l.title} <span className="text-xs text-muted">(requested {l.qty_requested})</span></p>
              {l.tracking_mode === 'COPY' ? (
                <Field label="Scan copy codes (optional)" className="w-64" hint="Blank picks the oldest available copies"><Input value={codes[l.id] ?? ''} onChange={(e) => setCodes({ ...codes, [l.id]: e.target.value })} /></Field>
              ) : null}
              <Field label="Dispatch qty" className="w-28"><Input type="number" min={0} max={l.qty_requested} value={qty[l.id]} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} /></Field>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ReceiveDialog({ t, onClose, onSubmit, loading }: { t: Transfer; onClose: () => void; onSubmit: (body: unknown, key: string) => void; loading: boolean }) {
  const idem = useIdempotencyKey()
  const open = t.lines.filter((l) => l.qty_outstanding > 0)
  const [rec, setRec] = React.useState<Record<string, string>>(() => Object.fromEntries(open.map((l) => [l.id, String(l.qty_outstanding)])))
  const [dmg, setDmg] = React.useState<Record<string, string>>({})
  const [final, setFinal] = React.useState(true)
  const [notes, setNotes] = React.useState('')
  const short = open.some((l) => Number(rec[l.id] ?? 0) + Number(dmg[l.id] ?? 0) < l.qty_outstanding)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg" title="Receive transfer" description="Count what arrived. Damaged units go to damaged stock; anything missing becomes a discrepancy."
        footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} onClick={() => onSubmit({
          lines: open.map((l) => ({ line_id: l.id, qty_received: Number(rec[l.id] ?? 0), qty_damaged: Number(dmg[l.id] ?? 0) })), final, notes: notes || null,
        }, idem.key)}>Confirm receipt</Button></>}>
        <Table>
          <THead><TR><TH>Book</TH><TH className="text-right">Outstanding</TH><TH className="text-right">Received good</TH><TH className="text-right">Damaged</TH></TR></THead>
          <TBody>
            {open.map((l) => (
              <TR key={l.id}>
                <TD className="text-sm">{l.title}</TD>
                <TD className="num text-right">{l.qty_outstanding}</TD>
                <TD className="text-right"><Input aria-label={`Received ${l.title}`} className="ml-auto w-20 text-right" type="number" min={0} value={rec[l.id]} onChange={(e) => setRec({ ...rec, [l.id]: e.target.value })} /></TD>
                <TD className="text-right"><Input aria-label={`Damaged ${l.title}`} className="ml-auto w-20 text-right" type="number" min={0} value={dmg[l.id] ?? ''} onChange={(e) => setDmg({ ...dmg, [l.id]: e.target.value })} /></TD>
              </TR>
            ))}
          </TBody>
        </Table>
        {short && (
          <label className="mt-4 flex items-start gap-2 text-sm">
            <Checkbox checked={final} onCheckedChange={(v) => setFinal(v === true)} className="mt-0.5" />
            <span>This is the final delivery — flag the shortfall as a discrepancy. <span className="text-muted">(Untick if more boxes are still coming.)</span></span>
          </label>
        )}
        <Field label="Notes" className="mt-4"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </DialogContent>
    </Dialog>
  )
}

function ResolveDialog({ t, onClose, onSubmit, loading }: { t: Transfer; onClose: () => void; onSubmit: (body: unknown, key: string) => void; loading: boolean }) {
  const idem = useIdempotencyKey()
  const open = t.lines.filter((l) => l.qty_outstanding > 0)
  const [action, setAction] = React.useState<Record<string, string>>(() => Object.fromEntries(open.map((l) => [l.id, 'LOST'])))
  const [notes, setNotes] = React.useState('')
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Resolve discrepancy" description="Lost units are written off to shrinkage. Returned units go back to the source location's stock."
        footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} onClick={() => onSubmit({ lines: open.map((l) => ({ line_id: l.id, action: action[l.id] })), notes: notes || null }, idem.key)}>Resolve</Button></>}>
        <div className="space-y-3">
          {open.map((l) => (
            <div key={l.id} className="flex items-center justify-between gap-3">
              <p className="text-sm">{l.title} <span className="text-muted">— {l.qty_outstanding} missing</span></p>
              <NativeSelect aria-label={`Resolution for ${l.title}`} className="w-48" value={action[l.id]} onChange={(e) => setAction({ ...action, [l.id]: e.target.value })}>
                <option value="LOST">Lost in transit</option><option value="RETURN">Returned to source</option>
              </NativeSelect>
            </div>
          ))}
          <Field label="Notes"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function DecisionDialog({ open, approve, onClose, onSubmit, loading }: { open: boolean; approve: boolean; onClose: () => void; onSubmit: (note: string | null) => void; loading: boolean }) {
  const [note, setNote] = React.useState('')
  return (
    <ConfirmDialog open={open} onOpenChange={(o) => !o && onClose()} title={approve ? 'Approve transfer?' : 'Reject transfer?'} tone={approve ? 'primary' : 'danger'}
      description={approve ? 'Requested quantities will be reserved at the source so they cannot be sold before dispatch.' : 'The requester will be notified.'}
      confirmLabel={approve ? 'Approve' : 'Reject'} loading={loading} onConfirm={() => onSubmit(note || null)}>
      <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </ConfirmDialog>
  )
}

function CancelDialog({ open, onClose, onSubmit, loading }: { open: boolean; onClose: () => void; onSubmit: (reason: string) => void; loading: boolean }) {
  const [reason, setReason] = React.useState('')
  return (
    <ConfirmDialog open={open} onOpenChange={(o) => !o && onClose()} title="Cancel transfer?" tone="danger" confirmLabel="Cancel transfer" loading={loading}
      description="Any reserved stock is released." onConfirm={() => reason.length >= 3 ? onSubmit(reason) : toast.error('Enter a reason')}>
      <Field label="Reason" required><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </ConfirmDialog>
  )
}
