import { useMutation, useQueryClient } from '@tanstack/react-query'
import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table'
import { api, errorMessage } from '@/lib/api'
import { useIdempotencyKey } from '@/lib/hooks'
import type { GRN, PO } from './types'

/** Goods receipt against a PO. The idempotency key makes retries safe: stock is added exactly once. */
export function ReceiveGoodsDialog({ po, open, onOpenChange }: { po: PO; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient()
  const idem = useIdempotencyKey()
  const lines = po.lines.filter((l) => l.qty_outstanding > 0)
  const [rec, setRec] = React.useState<Record<string, string>>({})
  const [dmg, setDmg] = React.useState<Record<string, string>>({})
  const [freight, setFreight] = React.useState('0')
  const [other, setOther] = React.useState('0')
  const [ref, setRef] = React.useState('')
  React.useEffect(() => {
    if (open) {
      setRec(Object.fromEntries(lines.map((l) => [l.id, String(l.qty_outstanding)])))
      setDmg({}); setFreight('0'); setOther('0'); setRef('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const save = useMutation({
    mutationFn: () => api.post<GRN>('/goods-receipts', {
      location_id: po.location_id, po_id: po.id, supplier_ref: ref || null, freight: freight || '0', other_charges: other || '0',
      lines: lines.map((l) => ({ po_line_id: l.id, qty_received: Number(rec[l.id] || 0), qty_damaged: Number(dmg[l.id] || 0) }))
        .filter((l) => l.qty_received + l.qty_damaged > 0),
    }, { idempotencyKey: idem.key }),
    onSuccess: (g) => {
      idem.reset()
      toast.success(`Goods receipt ${g.number} posted`)
      onOpenChange(false)
      void qc.invalidateQueries({ queryKey: ['po', po.id] })
      void qc.invalidateQueries({ queryKey: ['grns'] })
      void qc.invalidateQueries({ queryKey: ['inventory'] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" title={`Receive goods — ${po.number}`} description={`Into ${po.location_name}. Freight and other charges are added to landed cost (weighted-average valuation).`}
        footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Post goods receipt</Button></>}>
        <div className="mb-4 grid gap-4 sm:grid-cols-3">
          <Field label="Supplier delivery / invoice ref"><Input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
          <Field label="Freight (₹)"><Input inputMode="decimal" value={freight} onChange={(e) => setFreight(e.target.value)} /></Field>
          <Field label="Other charges (₹)"><Input inputMode="decimal" value={other} onChange={(e) => setOther(e.target.value)} /></Field>
        </div>
        <Table>
          <THead><TR><TH>Book</TH><TH className="text-right">Outstanding</TH><TH className="text-right">Received good</TH><TH className="text-right">Received damaged</TH></TR></THead>
          <TBody>
            {lines.map((l) => (
              <TR key={l.id}>
                <TD><p className="text-sm font-medium">{l.title}</p><p className="text-xs text-muted">{l.isbn13 ?? l.sku}{l.tracking_mode === 'COPY' && ' · copy IDs will be generated'}</p></TD>
                <TD className="num text-right">{l.qty_outstanding}</TD>
                <TD className="text-right"><Input aria-label={`Received ${l.title}`} type="number" min={0} className="ml-auto w-20 text-right" value={rec[l.id] ?? ''} onChange={(e) => setRec({ ...rec, [l.id]: e.target.value })} /></TD>
                <TD className="text-right"><Input aria-label={`Damaged ${l.title}`} type="number" min={0} className="ml-auto w-20 text-right" value={dmg[l.id] ?? ''} onChange={(e) => setDmg({ ...dmg, [l.id]: e.target.value })} /></TD>
              </TR>
            ))}
          </TBody>
        </Table>
        <p className="mt-3 text-xs text-muted">Quantities not received stay on backorder. Close the PO short if the supplier won’t deliver them.</p>
      </DialogContent>
    </Dialog>
  )
}
