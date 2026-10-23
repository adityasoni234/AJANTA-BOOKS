import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Paperclip, Plus } from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'
import { DataTable } from '@/components/common/DataTable'
import { DateRange, LocationSelect } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input, NativeSelect } from '@/components/ui/input'
import { api, errorMessage, type Page } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useDateRange, useIdempotencyKey } from '@/lib/hooks'
import { useCashAccounts } from '@/lib/queries'
import { formatDate, formatINR, todayISO } from '@/lib/utils'

interface Expense { id: string; number: string; location_name: string; category: string; expense_date: string; amount: string; description: string; vendor: string | null; paid_from: string; status: string; has_receipt: boolean; created_by: string | null; approved_by: string | null; rejection_reason: string | null }

export default function ExpensesPage() {
  const { can, locationId } = useAuth()
  const range = useDateRange(29)
  const [status, setStatus] = React.useState('')
  const [page, setPage] = React.useState(1)
  const [open, setOpen] = React.useState(false)
  const qc = useQueryClient()
  React.useEffect(() => setPage(1), [status, range.from, range.to, locationId])
  const list = useQuery({
    queryKey: ['expenses', status, range.from, range.to, page, locationId],
    queryFn: () => api.get<Page<Expense>>('/expenses', { status, date_from: range.from, date_to: range.to, page, page_size: 25, location_id: locationId ?? undefined }),
    placeholderData: keepPreviousData,
  })
  const upload = useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) => { const fd = new FormData(); fd.append('file', file); return api.post(`/expenses/${id}/receipt`, fd) },
    onSuccess: () => { toast.success('Receipt attached'); void qc.invalidateQueries({ queryKey: ['expenses'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const total = (list.data?.items ?? []).filter((e) => e.status === 'POSTED').reduce((a, e) => a + Number(e.amount), 0)
  return (
    <div>
      <PageHeader title="Expenses" description="Posted expenses hit the P&L once; expenses above the approval limit wait in the Approvals center."
        actions={<><DateRange from={range.from} to={range.to} onChange={range.set} />{can('expenses.create') && <Button onClick={() => setOpen(true)}><Plus /> Record expense</Button>}</>} />
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-3">
          <NativeSelect aria-label="Status" className="w-full sm:w-48" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option><option value="POSTED">Posted</option><option value="PENDING_APPROVAL">Pending approval</option><option value="REJECTED">Rejected</option>
          </NativeSelect>
          <p className="text-sm text-muted">Posted on this page: <span className="num font-medium text-foreground">{formatINR(total)}</span></p>
        </div>
        <DataTable
          rows={list.data?.items}
          loading={list.isFetching}
          error={list.error}
          rowKey={(e) => e.id}
          page={page}
          pageSize={25}
          total={list.data?.total}
          onPageChange={setPage}
          empty={{ title: 'No expenses in this period' }}
          columns={[
            { key: 'n', header: 'Expense', cell: (e) => <><p className="font-medium">{e.description}</p><p className="text-xs text-muted">{e.number} · {e.category}{e.vendor ? ` · ${e.vendor}` : ''}</p></> },
            { key: 'd', header: 'Date', cell: (e) => formatDate(e.expense_date) },
            { key: 'l', header: 'Location', hideBelow: 'md', cell: (e) => e.location_name },
            { key: 'p', header: 'Paid from', hideBelow: 'lg', cell: (e) => e.paid_from },
            { key: 'a', header: 'Amount', align: 'right', cell: (e) => formatINR(e.amount) },
            { key: 's', header: 'Status', cell: (e) => <><StatusBadge status={e.status} />{e.rejection_reason && <p className="text-xs text-danger">{e.rejection_reason}</p>}</> },
            { key: 'r', header: 'Receipt', cell: (e) => e.has_receipt ? <a className="text-primary hover:underline" href={`/api/v1/expenses/${e.id}/receipt`} target="_blank" rel="noreferrer">View</a> : can('expenses.create') ? (
              <label className="inline-flex cursor-pointer items-center gap-1 text-xs text-muted hover:text-foreground"><Paperclip className="size-3.5" /> Attach
                <input type="file" accept="application/pdf,image/jpeg,image/png" className="sr-only" onChange={(ev) => ev.target.files?.[0] && upload.mutate({ id: e.id, file: ev.target.files[0] })} /></label>
            ) : '—' },
          ]}
        />
      </Card>
      <ExpenseDialog open={open} onOpenChange={setOpen} />
    </div>
  )
}

function ExpenseDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { locationId } = useAuth()
  const qc = useQueryClient()
  const idem = useIdempotencyKey()
  const cats = useQuery({ queryKey: ['expense-categories'], queryFn: () => api.get<{ id: string; name: string; is_active: boolean }[]>('/expense-categories') })
  const accounts = useCashAccounts()
  const [f, setF] = React.useState({ category_id: '', expense_date: todayISO(), amount: '', description: '', vendor: '', paid_from_account_id: '', reference: '', from_register: false })
  const [loc, setLoc] = React.useState<string | null>(locationId)
  const regs = useQuery({ queryKey: ['registers', loc], queryFn: () => api.get<{ name: string; open_session: { id: string } | null }[]>('/registers', { location_id: loc! }), enabled: !!loc && f.from_register })
  const session = regs.data?.find((r) => r.open_session)?.open_session?.id
  const cashAcc = accounts.data?.find((a) => a.system_key === 'CASH')
  const save = useMutation({
    mutationFn: () => api.post<{ number: string; status: string }>('/expenses', {
      location_id: loc, category_id: f.category_id, expense_date: f.expense_date, amount: f.amount, description: f.description, vendor: f.vendor || null,
      paid_from_account_id: f.from_register ? cashAcc?.id : f.paid_from_account_id, register_session_id: f.from_register ? session : null, reference: f.reference || null,
    }, { idempotencyKey: idem.key }),
    onSuccess: (r) => { idem.reset(); toast.success(r.status === 'POSTED' ? `${r.number} posted` : `${r.number} sent for approval`); onOpenChange(false); void qc.invalidateQueries({ queryKey: ['expenses'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value })
  const valid = loc && f.category_id && Number(f.amount) > 0 && f.description.length >= 3 && (f.from_register ? !!session : !!f.paid_from_account_id)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Record expense" footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Location" required><LocationSelect value={loc} onChange={setLoc} allowAll={false} className="w-full" /></Field>
          <Field label="Category" required><NativeSelect value={f.category_id} onChange={set('category_id')}><option value="">Choose…</option>{(cats.data ?? []).filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</NativeSelect></Field>
          <Field label="Description" required className="sm:col-span-2"><Input value={f.description} onChange={set('description')} /></Field>
          <Field label="Amount (₹)" required><Input inputMode="decimal" value={f.amount} onChange={set('amount')} /></Field>
          <Field label="Date" required><Input type="date" value={f.expense_date} max={todayISO()} onChange={set('expense_date')} /></Field>
          <Field label="Vendor"><Input value={f.vendor} onChange={set('vendor')} /></Field>
          <Field label="Reference / bill no."><Input value={f.reference} onChange={set('reference')} /></Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.from_register} onChange={(e) => setF({ ...f, from_register: e.target.checked })} /> Paid from the register cash drawer</label>
          {f.from_register ? (
            <p className={`text-sm sm:col-span-2 ${session ? 'text-muted' : 'text-danger'}`}>{session ? 'Will be deducted from the open register session’s expected cash.' : 'No open register session at this location.'}</p>
          ) : (
            <Field label="Paid from account" required className="sm:col-span-2"><NativeSelect value={f.paid_from_account_id} onChange={set('paid_from_account_id')}><option value="">Choose…</option>{(accounts.data ?? []).filter((a) => a.is_active).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</NativeSelect></Field>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
