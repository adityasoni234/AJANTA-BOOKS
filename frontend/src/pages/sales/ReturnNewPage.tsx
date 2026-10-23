import { useMutation, useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import * as React from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState, ErrorState } from '@/components/common/States'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field, Input, NativeSelect } from '@/components/ui/input'
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table'
import { api, errorMessage } from '@/lib/api'
import { useIdempotencyKey } from '@/lib/hooks'
import { usePaymentMethods } from '@/lib/queries'
import { formatDate, formatINR } from '@/lib/utils'
import type { ReturnDetail, SaleDetail } from './types'

interface LineState { qty: number; disposition: string; condition: string }

export default function ReturnNewPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const saleId = params.get('sale')
  const [invoiceNo, setInvoiceNo] = React.useState('')
  const methods = usePaymentMethods()
  const idem = useIdempotencyKey()
  const sale = useQuery({ queryKey: ['sale', saleId], queryFn: () => api.get<SaleDetail>(`/sales/${saleId}`), enabled: !!saleId })
  const registers = useQuery({
    queryKey: ['registers', sale.data?.location_id],
    queryFn: () => api.get<{ id: string; name: string; open_session: { id: string } | null }[]>('/registers', { location_id: sale.data!.location_id }),
    enabled: !!sale.data,
  })
  const [lines, setLines] = React.useState<Record<string, LineState>>({})
  const [reason, setReason] = React.useState('')
  const [method, setMethod] = React.useState('')
  const [reference, setReference] = React.useState('')
  const openSession = registers.data?.find((r) => r.open_session)?.open_session?.id ?? null
  const selected = Object.entries(lines).filter(([, l]) => l.qty > 0)
  const m = methods.data?.find((x) => x.id === method)
  React.useEffect(() => { if (methods.data && !method) setMethod(methods.data.find((x) => x.code === 'CASH')?.id ?? '') }, [methods.data, method])

  const find = async () => {
    try {
      const s = await api.get<SaleDetail>(`/sales/by-invoice/${encodeURIComponent(invoiceNo.trim().toUpperCase())}`)
      setParams({ sale: s.id })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const submit = useMutation({
    mutationFn: () => api.post<ReturnDetail>('/returns', {
      sale_id: saleId, reason, refund_method_id: method, refund_reference: reference || null,
      register_session_id: m?.kind === 'CASH' ? openSession : null,
      lines: selected.map(([id, l]) => ({ sale_line_id: id, qty: l.qty, disposition: l.disposition, condition: l.condition })),
    }, { idempotencyKey: idem.key }),
    onSuccess: (r) => {
      idem.reset()
      if (r.status === 'PENDING_APPROVAL') toast.info(`${r.number} needs manager approval before the refund is paid`)
      else toast.success(`${r.number} completed — refund ${formatINR(r.refund_total)}`)
      if (r.refund_method_kind === 'EXCHANGE' && r.status === 'COMPLETED') navigate(`/pos?exchange=${r.id}&credit=${r.refund_total}`)
      else navigate(`/returns/${r.id}`)
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const usable = (methods.data ?? []).filter((x) => x.kind !== 'CREDIT' && (x.kind !== 'STORE_CREDIT' || sale.data?.customer_id))
  return (
    <div className="max-w-5xl">
      <PageHeader title="Process a return" crumbs={[{ label: 'Returns', to: '/returns' }, { label: 'New' }]} />
      <Card className="mb-4">
        <CardBody>
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void find() }}>
            <Field label="Original invoice number" className="w-full sm:w-72"><Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} placeholder="e.g. FRT/2627/000123" autoFocus={!saleId} /></Field>
            <Button type="submit" variant="secondary"><Search /> Find invoice</Button>
          </form>
        </CardBody>
      </Card>
      {!saleId ? <EmptyState title="Find the original invoice" description="Returns are always linked to the original sale so the refund and tax are calculated exactly." /> : sale.error ? <ErrorState error={sale.error} /> : sale.data && (
        <>
          <Card className="mb-4">
            <CardHeader title={`Invoice ${sale.data.invoice?.number}`} description={`${sale.data.location_name} · ${formatDate(sale.data.created_at, true)} · ${sale.data.customer_name ?? 'Walk-in'} · ${formatINR(sale.data.grand_total)}`} />
            <Table>
              <THead><TR><TH>Item</TH><TH className="text-right">Sold</TH><TH className="text-right">Returned</TH><TH className="text-right">Line total</TH><TH className="text-right">Return qty</TH><TH>Disposition</TH><TH>Condition</TH></TR></THead>
              <TBody>
                {sale.data.lines.map((l) => {
                  const max = l.qty - l.qty_returned
                  const st = lines[l.id] ?? { qty: 0, disposition: 'RESTOCK', condition: 'GOOD' }
                  const set = (patch: Partial<LineState>) => setLines({ ...lines, [l.id]: { ...st, ...patch } })
                  return (
                    <TR key={l.id}>
                      <TD><p className="font-medium">{l.title}</p>{l.copy_code && <p className="text-xs text-muted">Copy {l.copy_code}</p>}</TD>
                      <TD className="num text-right">{l.qty}</TD>
                      <TD className="num text-right">{l.qty_returned || '—'}</TD>
                      <TD className="num text-right">{formatINR(l.line_total)}</TD>
                      <TD className="text-right">{max > 0 ? <Input aria-label={`Return quantity for ${l.title}`} type="number" min={0} max={max} className="ml-auto w-20 text-right" value={st.qty} onChange={(e) => set({ qty: Math.max(0, Math.min(max, Number(e.target.value))) })} /> : <Badge>Fully returned</Badge>}</TD>
                      <TD>
                        <NativeSelect aria-label="Disposition" className="w-36" value={st.disposition} disabled={max <= 0} onChange={(e) => set({ disposition: e.target.value, condition: e.target.value === 'DAMAGED' ? 'DAMAGED' : st.condition === 'DAMAGED' ? 'GOOD' : st.condition })}>
                          <option value="RESTOCK">Restock (sellable)</option><option value="QUARANTINE">Quarantine</option><option value="DAMAGED">Damaged</option>
                        </NativeSelect>
                      </TD>
                      <TD>
                        <NativeSelect aria-label="Condition" className="w-28" value={st.condition} disabled={max <= 0} onChange={(e) => set({ condition: e.target.value })}>
                          {['NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED'].map((c) => <option key={c} value={c}>{c.charAt(0) + c.slice(1).toLowerCase()}</option>)}
                        </NativeSelect>
                      </TD>
                    </TR>
                  )
                })}
              </TBody>
            </Table>
          </Card>
          <Card>
            <CardBody className="grid gap-4 sm:grid-cols-3">
              <Field label="Reason" required><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Duplicate gift" /></Field>
              <Field label="Refund method" required hint={m?.kind === 'EXCHANGE' ? 'Credit will be applied to a new sale in the POS' : m?.kind === 'CASH' && !openSession ? 'No open register at this outlet — open one first' : undefined}>
                <NativeSelect value={method} onChange={(e) => setMethod(e.target.value)}>
                  {usable.map((x) => <option key={x.id} value={x.id}>{x.kind === 'EXCHANGE' ? 'Exchange for other items' : x.name}</option>)}
                </NativeSelect>
              </Field>
              {m?.requires_reference && <Field label={`${m.name} refund reference`} required><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>}
              <div className="flex items-end justify-end sm:col-span-3">
                <Button disabled={!selected.length || reason.length < 3 || (m?.kind === 'CASH' && !openSession) || (!!m?.requires_reference && !reference)} loading={submit.isPending} onClick={() => submit.mutate()}>
                  Process return of {selected.reduce((a, [, l]) => a + l.qty, 0)} item(s)
                </Button>
              </div>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  )
}
