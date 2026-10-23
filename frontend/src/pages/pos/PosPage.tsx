import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Banknote, CheckCircle2, CreditCard, Loader2, Minus, Plus, Printer, Receipt, Smartphone, Trash2, UserPlus, Wallet, X } from 'lucide-react'
import * as React from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { BookSearch } from '@/components/common/BookSearch'
import { LocationSelect } from '@/components/common/Filters'
import { EmptyState } from '@/components/common/States'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input, NativeSelect } from '@/components/ui/input'
import { api, ApiError, errorMessage, type Page } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useDebounced, useIdempotencyKey } from '@/lib/hooks'
import { usePaymentMethods } from '@/lib/queries'
import type { Book, PaymentMethod } from '@/lib/types'
import { cn, formatINR } from '@/lib/utils'

interface CartLine { key: string; book: Book; copy?: { id: string; code: string }; qty: number; line_discount: string }
interface QuoteLine { book_id: string; title: string; qty: number; unit_price: string; tax_rate: string; line_discount: string; bill_discount_alloc: string; taxable_value: string; cgst: string; sgst: string; igst: string; line_total: string }
interface Quote {
  lines: QuoteLine[]; gross: string; discount_total: string; taxable_total: string; cgst_total: string; sgst_total: string; igst_total: string
  tax_total: string; round_off: string; grand_total: string; doc_type: string; interstate: boolean; discount_pct: string
}
interface Register { id: string; name: string; location_id: string; is_active: boolean; open_session: { id: string; opened_by: string | null; opened_by_id: string; opening_float: string } | null }
interface Customer { id: string; code: string; name: string; phone: string | null; gstin: string | null; store_credit: string | null; loyalty_points: string | null; outstanding: string | null; credit_limit: string }
interface PayRow { method_id: string; amount: string; tendered: string; reference: string }
interface Policy { max_discount_pct: string; credit_sales_enabled: boolean; prices_include_tax: boolean }

const METHOD_ICONS: Record<string, React.ComponentType<{ className?: string }>> = { CASH: Banknote, UPI: Smartphone, CARD: CreditCard, BANK_TRANSFER: Wallet, STORE_CREDIT: Wallet, EXCHANGE: Receipt }
const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2)

export default function PosPage() {
  const { me, locationId, setLocationId, outlets, can } = useAuth()
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const outletId = outlets.find((o) => o.id === locationId)?.id ?? null
  // The POS always works at a single outlet: pick one when "all locations" (or a warehouse) is selected.
  React.useEffect(() => {
    if (!outletId && outlets.length) setLocationId(outlets[0].id)
  }, [outletId, outlets, setLocationId])
  const methods = usePaymentMethods()
  const policy = useQuery({ queryKey: ['policy'], queryFn: () => api.get<Policy>('/settings/policy'), staleTime: 5 * 60_000 })
  const registers = useQuery({
    queryKey: ['registers', outletId],
    queryFn: () => api.get<Register[]>('/registers', { location_id: outletId! }),
    enabled: !!outletId,
  })
  const [registerId, setRegisterId] = React.useState<string | null>(null)
  React.useEffect(() => {
    const regs = registers.data ?? []
    if (!regs.length) return setRegisterId(null)
    const mine = regs.find((r) => r.open_session?.opened_by_id === me?.id) ?? regs.find((r) => r.open_session) ?? regs[0]
    setRegisterId((cur) => (cur && regs.some((r) => r.id === cur) ? cur : mine.id))
  }, [registers.data, me?.id])
  const register = registers.data?.find((r) => r.id === registerId)
  const session = register?.open_session ?? null

  const [cart, setCart] = React.useState<CartLine[]>([])
  const [customer, setCustomer] = React.useState<Customer | null>(null)
  const [billDiscount, setBillDiscount] = React.useState('')
  const [discountReason, setDiscountReason] = React.useState('')
  const [approvalId, setApprovalId] = React.useState<string | null>(null)
  const [pays, setPays] = React.useState<PayRow[]>([])
  const [done, setDone] = React.useState<{ id: string; number: string; total: string; change: string | null } | null>(null)
  const exchangeReturnId = params.get('exchange')
  const exchangeCredit = params.get('credit')
  const idem = useIdempotencyKey()
  const searchRef = React.useRef<HTMLInputElement>(null)

  const items = cart.map((l) => (l.copy ? { copy_id: l.copy.id, qty: 1, line_discount: l.line_discount || '0' } : { book_id: l.book.id, qty: l.qty, line_discount: l.line_discount || '0' }))
  const quotePayload = { location_id: outletId, items, customer_id: customer?.id ?? null, bill_discount: billDiscount || '0' }
  const debounced = useDebounced(JSON.stringify(quotePayload), 200)
  const quote = useQuery({
    queryKey: ['pos-quote', debounced],
    queryFn: ({ signal }) => api.post<Quote>('/pos/quote', JSON.parse(debounced), { signal }),
    // Only quote once the debounced payload has caught up with a non-empty cart (avoids stale empty requests).
    enabled: !!outletId && cart.length > 0 && (JSON.parse(debounced) as { items: unknown[] }).items.length > 0,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 0,
  })
  const q = cart.length ? quote.data : undefined
  const total = q ? Number(q.grand_total) : 0
  const exchangeMethod = methods.data?.find((m) => m.kind === 'EXCHANGE')

  // Default payment: the whole total in cash (or exchange credit first) whenever the total changes.
  React.useEffect(() => {
    if (!q || !methods.data) return
    setPays((prev) => {
      const cash = methods.data!.find((m) => m.code === 'CASH')!
      const rows: PayRow[] = []
      let remaining = Number(q.grand_total)
      if (exchangeReturnId && exchangeCredit && exchangeMethod) {
        rows.push({ method_id: exchangeMethod.id, amount: exchangeCredit, tendered: '', reference: '' })
        remaining -= Number(exchangeCredit)
      }
      const keep = prev.filter((p) => p.method_id !== exchangeMethod?.id)
      if (keep.length === 1) return [...rows, { ...keep[0], amount: money(Math.max(remaining, 0)) }]
      if (keep.length > 1) return [...rows, ...keep]
      return [...rows, { method_id: cash.id, amount: money(Math.max(remaining, 0)), tendered: '', reference: '' }]
    })
  }, [q?.grand_total, methods.data, exchangeReturnId, exchangeCredit, exchangeMethod]) // eslint-disable-line react-hooks/exhaustive-deps

  const paid = pays.reduce((a, p) => a + Number(p.amount || 0), 0)
  const due = Math.round((total - paid) * 100) / 100
  const cashRow = pays.find((p) => methods.data?.find((m) => m.id === p.method_id)?.kind === 'CASH')
  const change = cashRow && cashRow.tendered ? Number(cashRow.tendered) - Number(cashRow.amount) : 0

  const addBook = (book: Book, copy?: { id: string; code: string }) => {
    setCart((c) => {
      if (copy) {
        if (c.some((l) => l.copy?.id === copy.id)) { toast.info(`Copy ${copy.code} is already in the cart`); return c }
        return [...c, { key: copy.id, book, copy, qty: 1, line_discount: '' }]
      }
      // Copy-tracked books are always one physical copy per line (the server picks the copy).
      if (book.tracking_mode === 'COPY') return [...c, { key: `${book.id}-${Date.now()}`, book, qty: 1, line_discount: '' }]
      const existing = c.find((l) => !l.copy && l.book.id === book.id)
      if (existing) return c.map((l) => (l === existing ? { ...l, qty: l.qty + 1 } : l))
      return [...c, { key: book.id, book, qty: 1, line_discount: '' }]
    })
    setApprovalId(null)
  }

  const reset = () => {
    setCart([]); setCustomer(null); setBillDiscount(''); setDiscountReason(''); setApprovalId(null); setPays([])
    if (exchangeReturnId) setParams({})
    idem.reset()
    setTimeout(() => searchRef.current?.focus(), 50)
  }

  const checkout = useMutation({
    mutationFn: () => api.post<{ id: string; invoice: { number: string }; grand_total: string; payments: { method_kind: string; change_given: string | null }[] }>('/pos/checkout', {
      ...quotePayload,
      register_session_id: session!.id,
      discount_reason: discountReason || null,
      discount_approval_id: approvalId,
      exchange_return_id: exchangeReturnId,
      payments: pays.filter((p) => Number(p.amount) > 0).map((p) => ({ payment_method_id: p.method_id, amount: money(Number(p.amount)), tendered: p.tendered ? money(Number(p.tendered)) : null, reference: p.reference || null })),
    }, { idempotencyKey: idem.key }),
    onSuccess: (s) => {
      setDone({ id: s.id, number: s.invoice.number, total: s.grand_total, change: s.payments.find((p) => p.method_kind === 'CASH')?.change_given ?? null })
      reset()
      void qc.invalidateQueries({ queryKey: ['book-search'] })
      void qc.invalidateQueries({ queryKey: ['registers'] })
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'discount_approval_required') setNeedApproval(true)
      toast.error(errorMessage(e))
    },
  })
  const [needApproval, setNeedApproval] = React.useState(false)

  // Keyboard shortcuts: F2 search, F9 / Ctrl+Enter pay, Esc clear dialogs
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2') { e.preventDefault(); searchRef.current?.focus() }
      if ((e.key === 'F9' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) && canPay) { e.preventDefault(); checkout.mutate() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const creditAllowed = policy.data?.credit_sales_enabled && can('pos.credit_sale') && !!customer
  const refsOk = pays.every((p) => !methods.data?.find((m) => m.id === p.method_id)?.requires_reference || Number(p.amount) === 0 || p.reference.trim())
  const cashOk = !cashRow?.tendered || Number(cashRow.tendered) >= Number(cashRow.amount)
  const canPay = !!session && cart.length > 0 && !!q && !quote.isFetching && (due === 0 || (due > 0 && creditAllowed)) && due >= 0 && refsOk && cashOk && !checkout.isPending

  if (!outlets.length) return <EmptyState title="No outlet assigned" description="The point of sale is available at outlets. Ask an administrator to assign you to one." />

  return (
    <div className="-mx-4 -my-6 grid min-h-[calc(100vh-3.5rem)] lg:grid-cols-[1fr_400px] sm:-mx-6">
      {/* Cart */}
      <section className="flex min-w-0 flex-col border-r border-border bg-white" aria-label="Cart">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          {outlets.length > 1 ? (
            <LocationSelect value={outletId} onChange={(v) => { setLocationId(v); setCart([]) }} allowAll={false} types={['OUTLET']} className="w-48" label="Outlet" />
          ) : <Badge tone="primary">{outlets[0].name}</Badge>}
          <NativeSelect aria-label="Register" className="w-40" value={registerId ?? ''} onChange={(e) => setRegisterId(e.target.value)}>
            {(registers.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}{r.open_session ? '' : ' (closed)'}</option>)}
          </NativeSelect>
          {session ? <Badge tone="success">Session open · {session.opened_by}</Badge> : register && <OpenSessionButton registerId={register.id} />}
          {exchangeReturnId && <Badge tone="info">Exchange credit {formatINR(exchangeCredit)}</Badge>}
          <span className="ml-auto hidden text-xs text-subtle md:block">F2 search · F9 pay</span>
        </div>
        <div className="border-b border-border p-3">
          <BookSearch inputRef={searchRef} autoFocus locationId={outletId} onSelect={addBook} placeholder="Scan barcode / ISBN / copy code, or type to search…" />
        </div>
        <div className="flex-1 overflow-y-auto">
          {cart.length === 0 ? (
            <EmptyState icon={Receipt} title="Cart is empty" description="Scan a barcode or search for a book to start a bill." />
          ) : (
            <ul className="divide-y divide-border">
              {cart.map((l, i) => {
                const ql = q?.lines[i]
                const short = l.book.stock_available !== null && !l.copy && l.qty > (l.book.stock_available ?? 0)
                return (
                  <li key={l.key} className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 sm:grid-cols-[1fr_auto_auto_auto]">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{l.book.title}</p>
                      <p className="truncate text-xs text-muted">
                        {l.copy ? `Copy ${l.copy.code}` : l.book.isbn13 ?? l.book.sku} · {formatINR(ql?.unit_price ?? l.book.location_price ?? l.book.selling_price)}
                        {Number(l.book.tax_rate) > 0 && ` · GST ${Number(l.book.tax_rate)}%`}
                      </p>
                      {short && <p className="text-xs text-danger">Only {l.book.stock_available} available</p>}
                    </div>
                    <div className="flex items-center gap-1">
                      {l.copy || l.book.tracking_mode === 'COPY' ? <span className="w-24 text-center text-sm">1</span> : (
                        <>
                          <Button variant="secondary" size="icon-sm" aria-label="Decrease quantity" onClick={() => setCart(cart.map((x, j) => j === i ? { ...x, qty: Math.max(1, x.qty - 1) } : x))}><Minus /></Button>
                          <Input aria-label={`Quantity of ${l.book.title}`} className="h-7 w-12 text-center" inputMode="numeric" value={l.qty}
                            onChange={(e) => { const v = Number(e.target.value.replace(/\D/g, '')); setCart(cart.map((x, j) => j === i ? { ...x, qty: Math.max(1, v || 1) } : x)) }} />
                          <Button variant="secondary" size="icon-sm" aria-label="Increase quantity" onClick={() => setCart(cart.map((x, j) => j === i ? { ...x, qty: x.qty + 1 } : x))}><Plus /></Button>
                        </>
                      )}
                    </div>
                    {can('pos.discount') && (
                      <Input aria-label={`Line discount for ${l.book.title}`} placeholder="Disc ₹" inputMode="decimal" className="hidden h-8 w-20 text-right sm:block"
                        value={l.line_discount} onChange={(e) => { setApprovalId(null); setCart(cart.map((x, j) => j === i ? { ...x, line_discount: e.target.value } : x)) }} />
                    )}
                    <div className="flex items-center gap-2">
                      <span className="num w-24 text-right font-medium">{ql ? formatINR(ql.line_total) : '…'}</span>
                      <Button variant="ghost" size="icon-sm" aria-label={`Remove ${l.book.title}`} onClick={() => setCart(cart.filter((_, j) => j !== i))}><Trash2 /></Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        {quote.error && cart.length > 0 && <p role="alert" className="border-t border-red-200 bg-danger-soft px-4 py-2 text-sm text-red-700">{errorMessage(quote.error)}</p>}
      </section>

      {/* Checkout */}
      <aside className="flex flex-col bg-surface" aria-label="Checkout">
        <div className="space-y-4 overflow-y-auto p-4">
          <CustomerPicker customer={customer} onChange={(c) => { setCustomer(c); setApprovalId(null) }} />
          {can('pos.discount') && (
            <Card className="space-y-2 p-3">
              <div className="flex items-center gap-2">
                <Field label="Bill discount (₹)" className="flex-1"><Input inputMode="decimal" value={billDiscount} onChange={(e) => { setBillDiscount(e.target.value); setApprovalId(null) }} /></Field>
                {q && Number(q.discount_total) > 0 && <Badge tone={Number(q.discount_pct) > Number(policy.data?.max_discount_pct ?? 100) ? 'warning' : 'neutral'} className="mt-5">{q.discount_pct}%</Badge>}
              </div>
              {(Number(billDiscount) > 0 || cart.some((l) => Number(l.line_discount) > 0)) && (
                <Field label="Discount reason"><Input value={discountReason} onChange={(e) => setDiscountReason(e.target.value)} placeholder="e.g. Member, damaged cover" /></Field>
              )}
              {approvalId && <Badge tone="success">Manager approval attached</Badge>}
            </Card>
          )}
          <Card className="p-4">
            <dl className="space-y-1.5 text-sm">
              <Row label="Items" value={String(cart.reduce((a, l) => a + l.qty, 0))} />
              <Row label="Gross" value={formatINR(q?.gross ?? 0)} />
              {q && Number(q.discount_total) > 0 && <Row label="Discount" value={`− ${formatINR(q.discount_total)}`} />}
              <Row label="Taxable value" value={formatINR(q?.taxable_total ?? 0)} />
              {q && q.interstate ? <Row label="IGST" value={formatINR(q.igst_total)} /> : (
                <>
                  <Row label="CGST" value={formatINR(q?.cgst_total ?? 0)} />
                  <Row label="SGST" value={formatINR(q?.sgst_total ?? 0)} />
                </>
              )}
              {q && Number(q.round_off) !== 0 && <Row label="Round off" value={formatINR(q.round_off)} />}
            </dl>
            <div className="mt-3 flex items-end justify-between border-t border-border pt-3">
              <span className="text-sm font-medium">Total</span>
              <span className="num text-3xl font-semibold tracking-tight">{quote.isFetching && cart.length ? <Loader2 className="size-6 animate-spin text-subtle" /> : formatINR(total)}</span>
            </div>
            {q && <p className="mt-1 text-right text-[11px] text-muted">{q.doc_type === 'TAX_INVOICE' ? 'Tax invoice' : 'Bill of supply'} · prices {policy.data?.prices_include_tax ? 'include' : 'exclude'} GST</p>}
          </Card>
          <Payments methods={methods.data ?? []} pays={pays} setPays={setPays} total={total} exchangeMethodId={exchangeMethod?.id} />
          <div className="space-y-1 text-sm">
            {due > 0 && <p className={cn('flex justify-between', creditAllowed ? 'text-warning' : 'text-danger')}><span>{creditAllowed ? 'On credit (customer account)' : 'Remaining to collect'}</span><span className="num font-semibold">{formatINR(due)}</span></p>}
            {due < 0 && <p className="flex justify-between text-danger"><span>Payments exceed total</span><span className="num">{formatINR(-due)}</span></p>}
            {change > 0 && <p className="flex justify-between text-success"><span>Change to return</span><span className="num text-lg font-semibold">{formatINR(change)}</span></p>}
          </div>
        </div>
        <div className="mt-auto space-y-2 border-t border-border bg-white p-4">
          {!session && <p className="text-sm text-warning">Open a register session to start selling.</p>}
          <Button size="lg" className="w-full" disabled={!canPay} loading={checkout.isPending} onClick={() => checkout.mutate()}>
            <CheckCircle2 /> Complete sale {total ? formatINR(total) : ''}
          </Button>
          <Button variant="ghost" className="w-full" disabled={!cart.length} onClick={reset}><X /> Clear cart</Button>
        </div>
      </aside>

      <ApprovalDialog open={needApproval} onOpenChange={setNeedApproval} payload={{ ...quotePayload, reason: discountReason }} onApproved={(id) => { setApprovalId(id); setNeedApproval(false); toast.success('Discount approved — complete the sale') }} />
      <Dialog open={!!done} onOpenChange={(o) => !o && setDone(null)}>
        <DialogContent size="sm" title="Sale complete" description={done ? `Invoice ${done.number}` : ''}
          footer={<Button onClick={() => setDone(null)} autoFocus>New sale</Button>}>
          {done && (
            <div className="space-y-4 text-center">
              <CheckCircle2 className="mx-auto size-10 text-success" />
              <p className="num text-2xl font-semibold">{formatINR(done.total)}</p>
              {done.change && Number(done.change) > 0 && <p className="rounded-md bg-success-soft py-2 text-success">Return change: <strong>{formatINR(done.change)}</strong></p>}
              <div className="flex justify-center gap-2">
                <Button variant="secondary" asChild><a href={`/sales/${done.id}/print?format=thermal`} target="_blank" rel="noreferrer"><Printer /> Receipt</a></Button>
                <Button variant="secondary" asChild><a href={`/sales/${done.id}/print?format=a4`} target="_blank" rel="noreferrer"><Printer /> A4 invoice</a></Button>
                <Button variant="ghost" asChild><Link to={`/sales/${done.id}`}>Details</Link></Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between"><dt className="text-muted">{label}</dt><dd className="num">{value}</dd></div>
}

function Payments({ methods, pays, setPays, total, exchangeMethodId }: { methods: PaymentMethod[]; pays: PayRow[]; setPays: (p: PayRow[]) => void; total: number; exchangeMethodId?: string }) {
  const usable = methods.filter((m) => m.is_active && !['CREDIT', 'EXCHANGE'].includes(m.kind))
  const set = (i: number, patch: Partial<PayRow>) => setPays(pays.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  const quick = (m: PaymentMethod) => {
    const others = pays.filter((p) => p.method_id === exchangeMethodId)
    const rest = total - others.reduce((a, p) => a + Number(p.amount), 0)
    setPays([...others, { method_id: m.id, amount: money(Math.max(rest, 0)), tendered: '', reference: '' }])
  }
  return (
    <Card className="space-y-3 p-3">
      <div className="grid grid-cols-3 gap-2">
        {usable.slice(0, 6).map((m) => {
          const Icon = METHOD_ICONS[m.kind] ?? Wallet
          const active = pays.length === 1 && pays[0].method_id === m.id
          return (
            <button key={m.id} type="button" onClick={() => quick(m)}
              className={cn('flex flex-col items-center gap-1 rounded-md border px-2 py-2 text-xs font-medium transition-colors', active ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-white hover:bg-surface-2')}>
              <Icon className="size-4" />{m.name}
            </button>
          )
        })}
      </div>
      {pays.map((p, i) => {
        const m = methods.find((x) => x.id === p.method_id)
        const locked = p.method_id === exchangeMethodId
        return (
          <div key={i} className="space-y-2 rounded-md border border-border bg-white p-2">
            <div className="flex items-center gap-2">
              <NativeSelect aria-label="Payment method" className="h-8 flex-1" value={p.method_id} disabled={locked} onChange={(e) => set(i, { method_id: e.target.value, reference: '' })}>
                {(locked ? methods : usable).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </NativeSelect>
              <Input aria-label="Amount" className="h-8 w-28 text-right" inputMode="decimal" value={p.amount} disabled={locked} onChange={(e) => set(i, { amount: e.target.value })} />
              {pays.length > 1 && !locked && <Button variant="ghost" size="icon-sm" aria-label="Remove payment" onClick={() => setPays(pays.filter((_, j) => j !== i))}><X /></Button>}
            </div>
            {m?.kind === 'CASH' && <Input aria-label="Cash tendered" className="h-8" placeholder="Cash tendered (for change)" inputMode="decimal" value={p.tendered} onChange={(e) => set(i, { tendered: e.target.value })} />}
            {m?.requires_reference && <Input aria-label={`${m.name} reference`} className="h-8" placeholder={`${m.name} transaction ID (required)`} value={p.reference} onChange={(e) => set(i, { reference: e.target.value })} aria-invalid={!p.reference && Number(p.amount) > 0} />}
          </div>
        )
      })}
      <Button variant="link" size="sm" onClick={() => setPays([...pays, { method_id: usable[0]?.id ?? '', amount: '0', tendered: '', reference: '' }])}>+ Split payment</Button>
    </Card>
  )
}

function OpenSessionButton({ registerId }: { registerId: string }) {
  const qc = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const [float, setFloat] = React.useState('2000')
  const go = useMutation({
    mutationFn: () => api.post('/register-sessions', { register_id: registerId, opening_float: float || '0' }),
    onSuccess: () => { toast.success('Register opened'); setOpen(false); void qc.invalidateQueries({ queryKey: ['registers'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Open register</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm" title="Open register session" description="Count the cash in the drawer before you start."
          footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={go.isPending} onClick={() => go.mutate()}>Open</Button></>}>
          <Field label="Opening float (₹)"><Input inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} autoFocus /></Field>
        </DialogContent>
      </Dialog>
    </>
  )
}

function CustomerPicker({ customer, onChange }: { customer: Customer | null; onChange: (c: Customer | null) => void }) {
  const { can } = useAuth()
  const [q, setQ] = React.useState('')
  const [create, setCreate] = React.useState(false)
  const dq = useDebounced(q, 250)
  const res = useQuery({ queryKey: ['pos-customers', dq], queryFn: () => api.get<Page<Customer>>('/customers', { q: dq, page_size: 6 }), enabled: dq.length >= 3 })
  if (customer) {
    return (
      <Card className="flex items-start justify-between gap-2 p-3">
        <div className="min-w-0 text-sm">
          <p className="font-medium">{customer.name}</p>
          <p className="text-xs text-muted">{[customer.phone, customer.gstin && `GSTIN ${customer.gstin}`].filter(Boolean).join(' · ')}</p>
          <p className="mt-1 flex flex-wrap gap-1">
            {Number(customer.store_credit) > 0 && <Badge tone="success">Credit {formatINR(customer.store_credit)}</Badge>}
            {Number(customer.loyalty_points) > 0 && <Badge tone="primary">{Number(customer.loyalty_points)} pts</Badge>}
            {Number(customer.outstanding) > 0 && <Badge tone="warning">Owes {formatINR(customer.outstanding)}</Badge>}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Remove customer" onClick={() => onChange(null)}><X /></Button>
      </Card>
    )
  }
  return (
    <div className="relative">
      <div className="flex gap-2">
        <Input placeholder="Customer phone or name (optional)" aria-label="Find customer" value={q} onChange={(e) => setQ(e.target.value)} />
        {can('customers.manage') && <Button variant="secondary" size="icon" aria-label="New customer" onClick={() => setCreate(true)}><UserPlus /></Button>}
      </div>
      {dq.length >= 3 && (
        <ul className="absolute z-30 mt-1 w-full rounded-md border border-border bg-white py-1 shadow-[var(--shadow-pop)]">
          {(res.data?.items ?? []).map((c) => (
            <li key={c.id}><button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-surface-2" onClick={() => { onChange(c); setQ('') }}>{c.name} <span className="text-xs text-muted">{c.phone}</span></button></li>
          ))}
          {res.data && res.data.items.length === 0 && <li className="px-3 py-2 text-sm text-muted">No customer found</li>}
        </ul>
      )}
      <QuickCustomerDialog open={create} onOpenChange={setCreate} initial={q} onCreated={(c) => { onChange(c); setQ('') }} />
    </div>
  )
}

function QuickCustomerDialog({ open, onOpenChange, initial, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; initial: string; onCreated: (c: Customer) => void }) {
  const { locationId } = useAuth()
  const [name, setName] = React.useState('')
  const [phone, setPhone] = React.useState('')
  const [email, setEmail] = React.useState('')
  const [gstin, setGstin] = React.useState('')
  const [consent, setConsent] = React.useState(false)
  React.useEffect(() => { if (open) { const digits = /^\d+$/.test(initial); setPhone(digits ? initial : ''); setName(digits ? '' : initial); setEmail(''); setGstin(''); setConsent(false) } }, [open, initial])
  const save = useMutation({
    mutationFn: () => api.post<Customer>(`/customers${locationId ? `?location_id=${locationId}` : ''}`, { name, phone: phone || null, email: email || null, gstin: gstin ? gstin.toUpperCase() : null, marketing_consent: consent }),
    onSuccess: (c) => { toast.success('Customer added'); onCreated(c); onOpenChange(false) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" title="New customer" footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={!name} loading={save.isPending} onClick={() => save.mutate()}>Add</Button></>}>
        <div className="space-y-3">
          <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
          <Field label="Mobile"><Input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="GSTIN (for B2B invoices)"><Input value={gstin} maxLength={15} onChange={(e) => setGstin(e.target.value)} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Customer agrees to receive offers</label>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ApprovalDialog({ open, onOpenChange, payload, onApproved }: { open: boolean; onOpenChange: (o: boolean) => void; payload: Record<string, unknown>; onApproved: (id: string) => void }) {
  const [reqId, setReqId] = React.useState<string | null>(null)
  const [reason, setReason] = React.useState('')
  React.useEffect(() => { if (open) { setReqId(null); setReason(String(payload.reason ?? '')) } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const request = useMutation({
    mutationFn: () => api.post<{ id: string }>('/pos/discount-approvals', { ...payload, reason }),
    onSuccess: (r) => setReqId(r.id),
    onError: (e) => toast.error(errorMessage(e)),
  })
  const status = useQuery({
    queryKey: ['discount-approval', reqId],
    queryFn: () => api.get<{ status: string; decision_note: string | null }>(`/pos/discount-approvals/${reqId}`),
    enabled: !!reqId,
    refetchInterval: (query) => (query.state.data?.status === 'PENDING' || !query.state.data ? 3000 : false),
  })
  React.useEffect(() => { if (status.data?.status === 'APPROVED' && reqId) onApproved(reqId) }, [status.data?.status, reqId]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" title="Manager approval needed" description="This discount exceeds your limit or takes an item below its minimum price."
        footer={!reqId ? <><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={reason.length < 3} loading={request.isPending} onClick={() => request.mutate()}>Request approval</Button></> : <Button variant="secondary" onClick={() => onOpenChange(false)}>Close</Button>}>
        {!reqId ? (
          <Field label="Reason" required><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        ) : status.data?.status === 'REJECTED' ? (
          <p className="text-sm text-danger">Rejected{status.data.decision_note ? `: ${status.data.decision_note}` : ''}. Adjust the discount.</p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="size-4 animate-spin" /> Waiting for a manager to approve in the Approvals screen…</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
