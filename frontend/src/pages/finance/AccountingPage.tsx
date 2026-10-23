import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Undo2 } from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'
import { DataTable } from '@/components/common/DataTable'
import { SearchInput } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, SheetContent } from '@/components/ui/dialog'
import { Field, Input, NativeSelect } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, errorMessage, type Page } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useDebounced } from '@/lib/hooks'
import type { AccountLite } from '@/lib/queries'
import { formatDate, formatINR, titleCase, todayISO } from '@/lib/utils'

interface Journal { id: string; number: string; entry_date: string; source_type: string; memo: string | null; location_name: string | null; reversal_of_id: string | null; reversed_by_id: string | null; created_by: string | null; posted_at: string; total: string; lines: { account_code: string; account_name: string; debit: string; credit: string; location_name: string | null; memo: string | null }[] }

export default function AccountingPage() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const [q, setQ] = React.useState('')
  const [source, setSource] = React.useState('')
  const [page, setPage] = React.useState(1)
  const [detail, setDetail] = React.useState<Journal | null>(null)
  const [manual, setManual] = React.useState(false)
  const [newAcc, setNewAcc] = React.useState(false)
  const dq = useDebounced(q)
  React.useEffect(() => setPage(1), [dq, source])
  const accounts = useQuery({ queryKey: ['accounts-balances'], queryFn: () => api.get<(AccountLite & { description: string | null })[]>('/accounts', { with_balances: true }) })
  const journals = useQuery({ queryKey: ['journals', dq, source, page], queryFn: () => api.get<Page<Journal>>('/journals', { q: dq, source_type: source, page, page_size: 25 }), placeholderData: keepPreviousData })
  const reverse = useMutation({
    mutationFn: (id: string) => api.post<Journal>(`/journals/${id}/reverse`, { reason: 'Correction' }),
    onSuccess: (j) => { toast.success(`Reversed by ${j.number}`); setDetail(null); void qc.invalidateQueries({ queryKey: ['journals'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const groups = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']
  return (
    <div>
      <PageHeader title="Accounting" description="Double-entry general ledger. Posted entries are immutable; corrections use reversal entries."
        actions={can('accounting.manage') && <><Button variant="secondary" onClick={() => setNewAcc(true)}><Plus /> Account</Button><Button onClick={() => setManual(true)}><Plus /> Manual journal</Button></>} />
      <Tabs defaultValue="journals">
        <TabsList><TabsTrigger value="journals">Journal entries</TabsTrigger><TabsTrigger value="coa">Chart of accounts</TabsTrigger></TabsList>
        <TabsContent value="journals">
          <Card>
            <div className="flex flex-wrap gap-2 border-b border-border p-3">
              <SearchInput value={q} onChange={setQ} placeholder="Voucher number or memo…" />
              <NativeSelect aria-label="Source" className="w-full sm:w-52" value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">All sources</option>
                {['SALE', 'RETURN', 'SALE_VOID', 'GOODS_RECEIPT', 'SUPPLIER_INVOICE', 'SUPPLIER_PAYMENT', 'SUPPLIER_RETURN', 'EXPENSE', 'STOCK_ADJUSTMENT', 'TRANSFER_DISPATCH', 'TRANSFER_RESOLUTION', 'REGISTER_CLOSE', 'CUSTOMER_RECEIPT', 'FUND_TRANSFER', 'MANUAL'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
              </NativeSelect>
            </div>
            <DataTable rows={journals.data?.items} loading={journals.isFetching} error={journals.error} rowKey={(j) => j.id} onRowClick={setDetail}
              page={page} pageSize={25} total={journals.data?.total} onPageChange={setPage} empty={{ title: 'No journal entries' }}
              columns={[
                { key: 'n', header: 'Voucher', cell: (j) => <span className="num font-medium">{j.number}</span> },
                { key: 'd', header: 'Date', cell: (j) => formatDate(j.entry_date) },
                { key: 's', header: 'Source', cell: (j) => <>{titleCase(j.source_type)}{j.reversal_of_id && <Badge tone="warning" className="ml-1">Reversal</Badge>}{j.reversed_by_id && <Badge className="ml-1">Reversed</Badge>}</> },
                { key: 'm', header: 'Memo', hideBelow: 'md', cell: (j) => <span className="line-clamp-1">{j.memo}</span> },
                { key: 'l', header: 'Location', hideBelow: 'lg', cell: (j) => j.location_name ?? '—' },
                { key: 't', header: 'Amount', align: 'right', cell: (j) => formatINR(j.total) },
              ]} />
          </Card>
        </TabsContent>
        <TabsContent value="coa">
          <div className="grid gap-4 lg:grid-cols-2">
            {groups.map((g) => (
              <Card key={g}>
                <div className="border-b border-border px-5 py-3 text-sm font-semibold">{titleCase(g)}</div>
                <ul className="divide-y divide-border">
                  {(accounts.data ?? []).filter((a) => a.type === g).map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-3 px-5 py-2 text-sm">
                      <span><span className="num mr-2 text-xs text-muted">{a.code}</span>{a.name}{a.is_cash_or_bank && <Badge tone="info" className="ml-2">Cash/bank</Badge>}{a.system_key && <Badge className="ml-1">System</Badge>}</span>
                      <span className="num">{formatINR(a.balance)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">Balances are debit-positive (credit balances shown as negative).</p>
        </TabsContent>
      </Tabs>
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <SheetContent title={detail?.number ?? ''} description={detail ? `${titleCase(detail.source_type)} · ${formatDate(detail.entry_date)} · ${detail.created_by ?? 'system'}` : ''}
          footer={detail && detail.source_type === 'MANUAL' && !detail.reversed_by_id && !detail.reversal_of_id && can('accounting.manage') ? <Button variant="danger-outline" loading={reverse.isPending} onClick={() => reverse.mutate(detail.id)}><Undo2 /> Reverse entry</Button> : undefined}>
          {detail && (
            <div className="space-y-3 text-sm">
              {detail.memo && <p className="text-slate-600">{detail.memo}</p>}
              <table className="w-full">
                <thead className="text-xs text-muted"><tr><th className="py-1 text-left">Account</th><th className="text-right">Debit</th><th className="text-right">Credit</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {detail.lines.map((l, i) => <tr key={i}><td className="py-1.5">{l.account_code} {l.account_name}{l.location_name && <span className="block text-xs text-muted">{l.location_name}</span>}</td><td className="num text-right">{Number(l.debit) ? formatINR(l.debit) : ''}</td><td className="num text-right">{Number(l.credit) ? formatINR(l.credit) : ''}</td></tr>)}
                </tbody>
                <tfoot className="font-semibold"><tr><td className="py-1.5">Total</td><td className="num text-right">{formatINR(detail.total)}</td><td className="num text-right">{formatINR(detail.total)}</td></tr></tfoot>
              </table>
              {detail.source_type !== 'MANUAL' && <p className="text-xs text-muted">System entries are corrected through their source document (void, return, adjustment), not edited here.</p>}
            </div>
          )}
        </SheetContent>
      </Dialog>
      {manual && <ManualJournal accounts={accounts.data ?? []} onClose={() => setManual(false)} />}
      {newAcc && <NewAccount onClose={() => setNewAcc(false)} />}
    </div>
  )
}

function ManualJournal({ accounts, onClose }: { accounts: AccountLite[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [date, setDate] = React.useState(todayISO())
  const [memo, setMemo] = React.useState('')
  const [lines, setLines] = React.useState([{ account_id: '', debit: '', credit: '' }, { account_id: '', debit: '', credit: '' }])
  const dr = lines.reduce((a, l) => a + Number(l.debit || 0), 0)
  const cr = lines.reduce((a, l) => a + Number(l.credit || 0), 0)
  const balanced = Math.abs(dr - cr) < 0.005 && dr > 0
  const save = useMutation({
    mutationFn: () => api.post('/journals', { entry_date: date, memo, lines: lines.filter((l) => l.account_id).map((l) => ({ account_id: l.account_id, debit: l.debit || '0', credit: l.credit || '0' })) }),
    onSuccess: () => { toast.success('Journal posted'); void qc.invalidateQueries({ queryKey: ['journals'] }); void qc.invalidateQueries({ queryKey: ['accounts-balances'] }); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg" title="Manual journal entry" description="Use for opening balances, owner capital, accruals and corrections. Debits must equal credits."
        footer={<><span className={`mr-auto self-center text-sm ${balanced ? 'text-success' : 'text-danger'}`}>Dr {formatINR(dr)} · Cr {formatINR(cr)}</span><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!balanced || memo.length < 3} loading={save.isPending} onClick={() => save.mutate()}>Post</Button></>}>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
            <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Narration" required><Input value={memo} onChange={(e) => setMemo(e.target.value)} /></Field>
          </div>
          {lines.map((l, i) => (
            <div key={i} className="flex items-end gap-2">
              <Field label={i === 0 ? 'Account' : ''} className="flex-1"><NativeSelect aria-label="Account" value={l.account_id} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, account_id: e.target.value } : x))}><option value="">Choose…</option>{accounts.filter((a) => a.is_active).map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</NativeSelect></Field>
              <Field label={i === 0 ? 'Debit' : ''} className="w-28"><Input aria-label="Debit" inputMode="decimal" value={l.debit} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, debit: e.target.value, credit: '' } : x))} /></Field>
              <Field label={i === 0 ? 'Credit' : ''} className="w-28"><Input aria-label="Credit" inputMode="decimal" value={l.credit} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, credit: e.target.value, debit: '' } : x))} /></Field>
              <Button variant="ghost" size="icon" aria-label="Remove line" disabled={lines.length <= 2} onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 /></Button>
            </div>
          ))}
          <Button variant="link" size="sm" onClick={() => setLines([...lines, { account_id: '', debit: '', credit: '' }])}>+ Add line</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function NewAccount({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [f, setF] = React.useState({ code: '', name: '', type: 'EXPENSE', is_cash_or_bank: false, description: '' })
  const save = useMutation({
    mutationFn: () => api.post('/accounts', { ...f, description: f.description || null }),
    onSuccess: () => { toast.success('Account created'); void qc.invalidateQueries({ queryKey: ['accounts-balances'] }); void qc.invalidateQueries({ queryKey: ['cash-accounts'] }); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm" title="New ledger account" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!f.code || !f.name} loading={save.isPending} onClick={() => save.mutate()}>Create</Button></>}>
        <div className="space-y-3">
          <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} placeholder="e.g. 1015" /></Field>
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Type"><NativeSelect value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'].map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}</NativeSelect></Field>
          {f.type === 'ASSET' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.is_cash_or_bank} onChange={(e) => setF({ ...f, is_cash_or_bank: e.target.checked })} /> Cash or bank account (appears in cashbook)</label>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
