import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftRight, Scale } from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'
import { DataTable } from '@/components/common/DataTable'
import { DateRange, LocationSelect } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { StatCard } from '@/components/common/StatCard'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input'
import { useDateRange } from '@/lib/hooks'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useCashAccounts } from '@/lib/queries'
import { formatDate, formatINR, titleCase, todayISO } from '@/lib/utils'

interface Cashbook { opening_balance: string; closing_balance: string; total_receipts: string; total_payments: string; entries: { date: string; number: string; source_type: string; memo: string | null; receipt: string; payment: string; balance: string; journal_id: string }[] }

export default function CashbookPage() {
  const { can, locationId } = useAuth()
  const accounts = useCashAccounts()
  const [account, setAccount] = React.useState('')
  const range = useDateRange(29)
  const [dlg, setDlg] = React.useState<null | 'transfer' | 'rec'>(null)
  React.useEffect(() => { if (!account && accounts.data?.length) setAccount(accounts.data[0].id) }, [accounts.data, account])
  const book = useQuery({
    queryKey: ['cashbook', account, range.from, range.to, locationId],
    queryFn: () => api.get<Cashbook>('/cashbook', { account_id: account, date_from: range.from, date_to: range.to, location_id: locationId ?? undefined }),
    enabled: !!account,
  })
  const recs = useQuery({ queryKey: ['bank-recs', account], queryFn: () => api.get<{ id: string; account: string; statement_date: string; statement_balance: string; book_balance: string; difference: string; notes: string | null }[]>('/bank-reconciliations', { account_id: account }), enabled: !!account })
  return (
    <div>
      <PageHeader title="Cashbook & bank accounts" description="Every receipt and payment through cash, bank, UPI and card clearing accounts."
        actions={<>
          <DateRange from={range.from} to={range.to} onChange={range.set} />
          {can('finance.manage') && <><Button variant="secondary" onClick={() => setDlg('rec')}><Scale /> Reconcile</Button><Button onClick={() => setDlg('transfer')}><ArrowLeftRight /> Transfer funds</Button></>}
        </>} />
      <div className="mb-4 flex flex-wrap gap-2">
        {(accounts.data ?? []).map((a) => (
          <button key={a.id} onClick={() => setAccount(a.id)} className={`rounded-full border px-3 py-1 text-sm ${a.id === account ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-white hover:bg-surface-2'}`}>{a.name}</button>
        ))}
      </div>
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Opening balance" value={formatINR(book.data?.opening_balance)} />
        <StatCard label="Receipts" value={formatINR(book.data?.total_receipts)} tone="success" />
        <StatCard label="Payments" value={formatINR(book.data?.total_payments)} tone="danger" />
        <StatCard label="Closing balance" value={formatINR(book.data?.closing_balance)} tone="info" />
      </div>
      <Card className="mb-6">
        <DataTable rows={book.data?.entries} loading={book.isFetching} error={book.error} rowKey={(e) => e.journal_id + e.balance} dense empty={{ title: 'No movements in this period' }}
          columns={[
            { key: 'd', header: 'Date', cell: (e) => formatDate(e.date) },
            { key: 'n', header: 'Voucher', cell: (e) => <span className="num text-xs">{e.number}</span> },
            { key: 't', header: 'Type', hideBelow: 'md', cell: (e) => titleCase(e.source_type) },
            { key: 'm', header: 'Particulars', cell: (e) => <span className="line-clamp-1">{e.memo}</span> },
            { key: 'r', header: 'Receipt', align: 'right', cell: (e) => Number(e.receipt) ? formatINR(e.receipt) : '' },
            { key: 'p', header: 'Payment', align: 'right', cell: (e) => Number(e.payment) ? formatINR(e.payment) : '' },
            { key: 'b', header: 'Balance', align: 'right', cell: (e) => formatINR(e.balance) },
          ]} />
      </Card>
      <Card>
        <CardHeader title="Reconciliation history" />
        <DataTable rows={recs.data} loading={recs.isLoading} rowKey={(r) => r.id} empty={{ title: 'No reconciliations recorded' }}
          columns={[
            { key: 'd', header: 'Statement date', cell: (r) => formatDate(r.statement_date) },
            { key: 's', header: 'Statement', align: 'right', cell: (r) => formatINR(r.statement_balance) },
            { key: 'b', header: 'Books', align: 'right', cell: (r) => formatINR(r.book_balance) },
            { key: 'x', header: 'Difference', align: 'right', cell: (r) => <span className={Number(r.difference) ? 'text-danger' : 'text-success'}>{formatINR(r.difference)}</span> },
            { key: 'n', header: 'Notes', cell: (r) => r.notes ?? '—' },
          ]} />
      </Card>
      {dlg === 'transfer' && <TransferDialog onClose={() => setDlg(null)} />}
      {dlg === 'rec' && <RecDialog account={account} onClose={() => setDlg(null)} />}
    </div>
  )
}

function TransferDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const accounts = useCashAccounts()
  const { locationId } = useAuth()
  const [f, setF] = React.useState({ from_account_id: '', to_account_id: '', amount: '', entry_date: todayISO(), memo: '' })
  const [loc, setLoc] = React.useState<string | null>(locationId)
  const save = useMutation({
    mutationFn: () => api.post<{ journal_number: string }>('/fund-transfers', { ...f, location_id: loc }),
    onSuccess: (r) => { toast.success(`Posted ${r.journal_number}`); void qc.invalidateQueries({ queryKey: ['cashbook'] }); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Transfer between accounts" description="e.g. deposit outlet cash into the bank, or settle UPI collections."
        footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!f.from_account_id || !f.to_account_id || !(Number(f.amount) > 0)} loading={save.isPending} onClick={() => save.mutate()}>Post transfer</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="From"><NativeSelect value={f.from_account_id} onChange={set('from_account_id')}><option value="">Choose…</option>{(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</NativeSelect></Field>
          <Field label="To"><NativeSelect value={f.to_account_id} onChange={set('to_account_id')}><option value="">Choose…</option>{(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</NativeSelect></Field>
          <Field label="Amount (₹)"><Input inputMode="decimal" value={f.amount} onChange={set('amount')} /></Field>
          <Field label="Date"><Input type="date" value={f.entry_date} onChange={set('entry_date')} /></Field>
          <Field label="Location (for outlet cash)" className="sm:col-span-2"><LocationSelect value={loc} onChange={setLoc} className="w-full" /></Field>
          <Field label="Memo" className="sm:col-span-2"><Textarea rows={2} value={f.memo} onChange={set('memo')} /></Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function RecDialog({ account, onClose }: { account: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [date, setDate] = React.useState(todayISO())
  const [bal, setBal] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const save = useMutation({
    mutationFn: () => api.post<{ difference: string; book_balance: string }>('/bank-reconciliations', { account_id: account, statement_date: date, statement_balance: bal, notes: notes || null }),
    onSuccess: (r) => { if (Number(r.difference) === 0) toast.success('Reconciled — books match the statement'); else toast.warning(`Difference of ${formatINR(r.difference)} (books ${formatINR(r.book_balance)})`); void qc.invalidateQueries({ queryKey: ['bank-recs'] }); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm" title="Reconcile with statement" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={bal === ''} loading={save.isPending} onClick={() => save.mutate()}>Compare</Button></>}>
        <div className="space-y-3">
          <Field label="Statement date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Statement closing balance (₹)"><Input inputMode="decimal" value={bal} onChange={(e) => setBal(e.target.value)} /></Field>
          <Field label="Notes"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
