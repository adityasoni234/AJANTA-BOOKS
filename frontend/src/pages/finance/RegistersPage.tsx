import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'
import { DataTable } from '@/components/common/DataTable'
import { DeleteButton } from '@/components/common/DeleteButton'
import { PageHeader } from '@/components/common/PageHeader'
import { Badge, StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Dialog, DialogContent, SheetContent } from '@/components/ui/dialog'
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input'
import { api, errorMessage, type Page } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDate, formatINR } from '@/lib/utils'

interface Register { id: string; location_id: string; location_name: string; name: string; is_active: boolean; open_session: { id: string; opened_at: string; opened_by: string | null; opening_float: string } | null }
interface Summary { opening_float: string; cash_in: string; cash_out: string; cash_expenses: string; expected_cash: string; sales_count: number; sales_total: string; voided_count: number; by_method: { code: string; name: string; in: string; out: string; net: string; count: number }[] }
interface Session {
  id: string; register_name: string; location_name: string; status: string; opened_by: string | null; opened_at: string; closed_by: string | null; closed_at: string | null
  opening_float: string; expected_cash: string | null; counted_cash: string | null; variance: string | null; closing_notes: string | null; summary: Summary | null
}

export default function RegistersPage() {
  const { can, locationId, me } = useAuth()
  const qc = useQueryClient()
  const [page, setPage] = React.useState(1)
  const [onlyVariance, setOnlyVariance] = React.useState(false)
  const [detail, setDetail] = React.useState<string | null>(null)
  const [addOpen, setAddOpen] = React.useState(false)
  const regs = useQuery({ queryKey: ['registers', locationId], queryFn: () => api.get<Register[]>('/registers', { location_id: locationId ?? undefined }) })
  const sessions = useQuery({
    queryKey: ['register-sessions', locationId, page, onlyVariance],
    queryFn: () => api.get<Page<Session>>('/register-sessions', { location_id: locationId ?? undefined, page, page_size: 20, discrepancy: onlyVariance || undefined }),
    placeholderData: keepPreviousData,
  })
  const open = useMutation({
    mutationFn: (registerId: string) => api.post('/register-sessions', { register_id: registerId, opening_float: '2000' }),
    onSuccess: () => { toast.success('Register opened with ₹2,000 float'); void qc.invalidateQueries({ queryKey: ['registers'] }); void qc.invalidateQueries({ queryKey: ['register-sessions'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <div>
      <PageHeader title="Registers & cash reconciliation" description="Opening float + cash sales − cash refunds − cash expenses = expected cash. Variances post to Cash Over/Short."
        actions={can('registers.manage') && <Button variant="secondary" onClick={() => setAddOpen(true)}><Plus /> Add register</Button>} />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {(regs.data ?? []).map((r) => (
          <Card key={r.id} className="p-4">
            <div className="flex items-start justify-between">
              <div><p className="font-medium">{r.name}</p><p className="text-xs text-muted">{r.location_name}</p></div>
              <div className="flex items-center gap-1">
                {r.open_session ? <Badge tone="success">Open</Badge> : <Badge>Closed</Badge>}
                {can('registers.manage') && !r.open_session && <DeleteButton iconOnly path={`/registers/${r.id}`} what="register" />}
              </div>
            </div>
            {r.open_session ? (
              <div className="mt-3 flex items-end justify-between text-sm">
                <p className="text-xs text-muted">Opened {formatDate(r.open_session.opened_at, true)}<br />by {r.open_session.opened_by} · float {formatINR(r.open_session.opening_float)}</p>
                <Button size="sm" onClick={() => setDetail(r.open_session!.id)}>Count & close</Button>
              </div>
            ) : can('registers.operate') && r.is_active && (
              <Button size="sm" variant="secondary" className="mt-3" loading={open.isPending && open.variables === r.id} onClick={() => open.mutate(r.id)}>Open session</Button>
            )}
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader title="Session history" actions={<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyVariance} onChange={(e) => setOnlyVariance(e.target.checked)} /> Discrepancies only</label>} />
        <DataTable
          rows={sessions.data?.items}
          loading={sessions.isFetching}
          error={sessions.error}
          rowKey={(s) => s.id}
          onRowClick={(s) => setDetail(s.id)}
          page={page}
          pageSize={20}
          total={sessions.data?.total}
          onPageChange={setPage}
          empty={{ title: 'No sessions yet' }}
          columns={[
            { key: 'r', header: 'Register', cell: (s) => <><p className="font-medium">{s.register_name}</p><p className="text-xs text-muted">{s.location_name}</p></> },
            { key: 'o', header: 'Opened', cell: (s) => <>{formatDate(s.opened_at, true)}<p className="text-xs text-muted">{s.opened_by}</p></> },
            { key: 'c', header: 'Closed', hideBelow: 'md', cell: (s) => s.closed_at ? <>{formatDate(s.closed_at, true)}<p className="text-xs text-muted">{s.closed_by}</p></> : '—' },
            { key: 'e', header: 'Expected', align: 'right', hideBelow: 'md', cell: (s) => formatINR(s.expected_cash) },
            { key: 'k', header: 'Counted', align: 'right', hideBelow: 'md', cell: (s) => formatINR(s.counted_cash) },
            { key: 'v', header: 'Variance', align: 'right', cell: (s) => s.variance === null ? '—' : <span className={Number(s.variance) ? 'font-medium text-danger' : 'text-success'}>{formatINR(s.variance)}</span> },
            { key: 's', header: 'Status', cell: (s) => <StatusBadge status={s.status} /> },
          ]}
        />
      </Card>
      <SessionSheet id={detail} onClose={() => setDetail(null)} myId={me?.id} />
      <AddRegisterDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  )
}

function SessionSheet({ id, onClose }: { id: string | null; onClose: () => void; myId?: string }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['register-session', id], queryFn: () => api.get<Session>(`/register-sessions/${id}`), enabled: !!id })
  const [counted, setCounted] = React.useState('')
  const [notes, setNotes] = React.useState('')
  React.useEffect(() => { setCounted(''); setNotes('') }, [id])
  const close = useMutation({
    mutationFn: () => api.post<Session>(`/register-sessions/${id}/close`, { counted_cash: counted, notes: notes || null }),
    onSuccess: (s) => {
      if (Number(s.variance) === 0) toast.success('Register closed — cash balanced')
      else toast.warning(`Register closed with variance ${formatINR(s.variance)}`)
      void qc.invalidateQueries({ queryKey: ['registers'] }); void qc.invalidateQueries({ queryKey: ['register-sessions'] }); void q.refetch()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const s = q.data
  const sm = s?.summary
  const variance = counted && sm ? Number(counted) - Number(sm.expected_cash) : null
  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={s ? `${s.register_name} · ${s.location_name}` : 'Session'} description={s ? `Opened ${formatDate(s.opened_at, true)} by ${s.opened_by}` : ''}>
        {sm && s && (
          <div className="space-y-5 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <Stat l="Sales" v={`${sm.sales_count} · ${formatINR(sm.sales_total)}`} />
              <Stat l="Voided" v={String(sm.voided_count)} />
            </div>
            <table className="w-full">
              <thead className="text-xs text-muted"><tr><th className="py-1 text-left">Method</th><th className="text-right">In</th><th className="text-right">Out</th><th className="text-right">Net</th></tr></thead>
              <tbody className="divide-y divide-border">{sm.by_method.map((m) => <tr key={m.code}><td className="py-1.5">{m.name}</td><td className="num text-right">{formatINR(m.in)}</td><td className="num text-right">{formatINR(m.out)}</td><td className="num text-right font-medium">{formatINR(m.net)}</td></tr>)}</tbody>
            </table>
            <div className="rounded-md border border-border p-3">
              <p className="mb-2 text-xs font-semibold uppercase text-muted">Cash drawer</p>
              <Row l="Opening float" v={sm.opening_float} /><Row l="+ Cash received" v={sm.cash_in} /><Row l="− Cash refunds" v={sm.cash_out} /><Row l="− Cash expenses" v={sm.cash_expenses} />
              <div className="mt-1 flex justify-between border-t border-border pt-1 font-semibold"><span>Expected in drawer</span><span className="num">{formatINR(sm.expected_cash)}</span></div>
            </div>
            {s.status === 'OPEN' ? (
              <div className="space-y-3">
                <Field label="Counted cash (₹)" required><Input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} autoFocus /></Field>
                {variance !== null && !Number.isNaN(variance) && <p className={variance === 0 ? 'text-success' : 'text-danger'}>{variance === 0 ? 'Balanced' : variance > 0 ? `Over by ${formatINR(variance)}` : `Short by ${formatINR(-variance)}`}</p>}
                <Field label="Notes"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
                <Button className="w-full" disabled={counted === ''} loading={close.isPending} onClick={() => close.mutate()}>Close register</Button>
              </div>
            ) : (
              <div className="rounded-md bg-surface p-3">
                <Row l="Counted" v={s.counted_cash} /><Row l="Variance" v={s.variance} />
                {s.closing_notes && <p className="mt-1 text-muted">{s.closing_notes}</p>}
                <p className="mt-1 text-xs text-muted">Closed {formatDate(s.closed_at, true)} by {s.closed_by}</p>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Dialog>
  )
}

const Row = ({ l, v }: { l: string; v: string | null }) => <div className="flex justify-between"><span className="text-muted">{l}</span><span className="num">{formatINR(v)}</span></div>
const Stat = ({ l, v }: { l: string; v: string }) => <div className="rounded-md bg-surface p-2"><p className="text-xs text-muted">{l}</p><p className="font-medium">{v}</p></div>

function AddRegisterDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { outlets } = useAuth()
  const qc = useQueryClient()
  const [loc, setLoc] = React.useState('')
  const [name, setName] = React.useState('')
  const save = useMutation({
    mutationFn: () => api.post('/registers', { location_id: loc, name, is_active: true }),
    onSuccess: () => { toast.success('Register added'); onOpenChange(false); void qc.invalidateQueries({ queryKey: ['registers'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" title="Add register" footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={!loc || !name} loading={save.isPending} onClick={() => save.mutate()}>Add</Button></>}>
        <div className="space-y-3">
          <Field label="Outlet"><NativeSelect value={loc} onChange={(e) => setLoc(e.target.value)}><option value="">Choose…</option>{outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</NativeSelect></Field>
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Counter 2" /></Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
