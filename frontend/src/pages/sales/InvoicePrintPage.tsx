import { useQuery } from '@tanstack/react-query'
import { Printer } from 'lucide-react'
import * as React from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { ErrorState, PageLoader } from '@/components/common/States'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { formatDate, formatINR } from '@/lib/utils'
import type { Party, ReturnDetail, SaleDetail } from './types'

interface DocLine { title: string; hsn: string | null; qty: number; rate: string; disc: number; taxable: string; taxRate: string; cgst: string; sgst: string; igst: string; total: string }
interface Doc {
  title: string; number: string; date: string; seller: Party; buyer: Party; pos: string; lines: DocLine[]; interstate: boolean
  taxable: string; cgst: string; sgst: string; igst: string; roundOff: string; total: string; words: string; reference?: string; status?: string
  payments?: { method: string; amount: string; change?: string | null }[]; footer?: string
}

function fromSale(s: SaleDetail): Doc {
  return {
    title: s.invoice?.doc_type === 'TAX_INVOICE' ? 'Tax Invoice' : 'Bill of Supply', number: s.invoice!.number, date: s.invoice!.issued_at,
    seller: s.invoice!.seller, buyer: s.invoice!.buyer, pos: s.invoice!.place_of_supply, interstate: s.is_interstate,
    lines: s.lines.map((l) => ({ title: l.title + (l.copy_code ? ` [${l.copy_code}]` : ''), hsn: l.hsn_code, qty: l.qty, rate: l.unit_price, disc: Number(l.line_discount) + Number(l.bill_discount_alloc), taxable: l.taxable_value, taxRate: l.tax_rate, cgst: l.cgst, sgst: l.sgst, igst: l.igst, total: l.line_total })),
    taxable: s.taxable_total, cgst: s.cgst_total, sgst: s.sgst_total, igst: s.igst_total, roundOff: s.round_off, total: s.grand_total, words: s.amount_in_words,
    status: s.status === 'CANCELLED' ? 'CANCELLED' : undefined,
    payments: s.payments.filter((p) => p.direction === 'IN').map((p) => ({ method: p.method, amount: p.amount, change: p.change_given })),
    footer: s.prices_include_tax ? 'Prices are inclusive of GST where applicable.' : undefined,
  }
}

function fromReturn(r: ReturnDetail): Doc {
  return {
    title: 'Credit Note', number: r.credit_note!.number, date: r.credit_note!.issued_at, seller: r.credit_note!.seller, buyer: r.credit_note!.buyer,
    pos: r.credit_note!.place_of_supply, interstate: Number(r.igst_total) > 0, reference: `Against invoice ${r.original_invoice_number} · ${r.reason}`,
    lines: r.lines.map((l) => ({ title: l.title, hsn: l.hsn_code, qty: l.qty, rate: '', disc: 0, taxable: l.taxable_value, taxRate: l.tax_rate, cgst: l.cgst, sgst: l.sgst, igst: l.igst, total: l.line_total })),
    taxable: r.taxable_total, cgst: r.cgst_total, sgst: r.sgst_total, igst: r.igst_total, roundOff: r.round_off, total: r.refund_total, words: r.amount_in_words,
    payments: [{ method: `Refund via ${r.refund_method}`, amount: r.refund_total }],
  }
}

export default function InvoicePrintPage({ kind = 'invoice' }: { kind?: string }) {
  const { id } = useParams()
  const [params] = useSearchParams()
  const format = params.get('format') === 'thermal' ? 'thermal' : 'a4'
  const autoPrint = params.get('preview') !== '1'
  const q = useQuery({
    queryKey: [kind, id],
    queryFn: async () => (kind === 'credit-note' ? fromReturn(await api.get<ReturnDetail>(`/returns/${id}`)) : fromSale(await api.get<SaleDetail>(`/sales/${id}`))),
  })
  React.useEffect(() => {
    if (!q.data) return
    const style = document.createElement('style')
    style.textContent = format === 'thermal' ? '@page { size: 80mm auto; margin: 2mm; }' : '@page { size: A4; margin: 12mm; }'
    document.head.appendChild(style)
    document.title = `${q.data.title} ${q.data.number}`
    const t = autoPrint ? setTimeout(() => window.print(), 400) : undefined
    return () => { clearTimeout(t); style.remove() }
  }, [q.data, format, autoPrint])
  if (q.isLoading) return <div className="p-8"><PageLoader /></div>
  if (!q.data) return <ErrorState error={q.error} />
  const d = q.data
  return (
    <div className="min-h-screen bg-surface-2 py-6 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-[210mm] justify-end gap-2 px-4">
        <Button onClick={() => window.print()}><Printer /> Print / Save PDF</Button>
      </div>
      {format === 'thermal' ? <Thermal d={d} /> : <A4 d={d} />}
    </div>
  )
}

function SellerBlock({ s }: { s: Party }) {
  return (
    <div>
      <p className="text-base font-bold">{s.trade_name || s.legal_name}</p>
      {s.trade_name && s.legal_name && s.trade_name !== s.legal_name && <p className="text-xs">{s.legal_name}</p>}
      <p className="text-xs">{s.location_name}{s.address ? `, ${s.address}` : ''}</p>
      <p className="text-xs">{s.state ? `${s.state} (${s.state_code})` : ''}{s.phone ? ` · ${s.phone}` : ''}</p>
      {s.gstin ? <p className="text-xs font-semibold">GSTIN: {s.gstin}</p> : <p className="text-xs">Not registered under GST</p>}
    </div>
  )
}

function A4({ d }: { d: Doc }) {
  return (
    <article className="mx-auto max-w-[210mm] bg-white p-8 text-[12px] text-black shadow print:max-w-none print:p-0 print:shadow-none">
      <header className="flex items-start justify-between border-b-2 border-black pb-3">
        <SellerBlock s={d.seller} />
        <div className="text-right">
          <p className="text-lg font-bold uppercase tracking-wide">{d.title}</p>
          {d.status && <p className="text-sm font-bold text-red-700">{d.status}</p>}
          <p>No: <strong>{d.number}</strong></p>
          <p>Date: {formatDate(d.date, true)}</p>
          <p>Place of supply: {d.pos}</p>
        </div>
      </header>
      <section className="grid grid-cols-2 gap-4 border-b border-black py-3">
        <div>
          <p className="text-[11px] font-semibold uppercase">Billed to</p>
          <p className="font-semibold">{d.buyer.name}</p>
          {d.buyer.address && <p>{d.buyer.address}</p>}
          {d.buyer.phone && <p>{d.buyer.phone}</p>}
          {d.buyer.gstin && <p className="font-semibold">GSTIN: {d.buyer.gstin}</p>}
        </div>
        {d.reference && <div><p className="text-[11px] font-semibold uppercase">Reference</p><p>{d.reference}</p></div>}
      </section>
      <table className="mt-3 w-full border-collapse">
        <thead>
          <tr className="border-y border-black text-left text-[11px]">
            <th className="py-1">#</th><th>Description</th><th>HSN</th><th className="text-right">Qty</th><th className="text-right">Rate</th><th className="text-right">Disc</th>
            <th className="text-right">Taxable</th><th className="text-right">GST %</th>
            {d.interstate ? <th className="text-right">IGST</th> : <><th className="text-right">CGST</th><th className="text-right">SGST</th></>}
            <th className="text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l, i) => (
            <tr key={i} className="border-b border-gray-300 align-top">
              <td className="py-1">{i + 1}</td><td>{l.title}</td><td>{l.hsn ?? ''}</td><td className="text-right">{l.qty}</td>
              <td className="text-right">{l.rate ? Number(l.rate).toFixed(2) : ''}</td><td className="text-right">{l.disc ? l.disc.toFixed(2) : ''}</td>
              <td className="text-right">{Number(l.taxable).toFixed(2)}</td><td className="text-right">{Number(l.taxRate)}</td>
              {d.interstate ? <td className="text-right">{Number(l.igst).toFixed(2)}</td> : <><td className="text-right">{Number(l.cgst).toFixed(2)}</td><td className="text-right">{Number(l.sgst).toFixed(2)}</td></>}
              <td className="text-right">{Number(l.total).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <section className="mt-3 flex justify-between gap-6">
        <div className="max-w-[55%]">
          <p className="font-semibold">Amount in words</p><p>{d.words}</p>
          {d.payments && <p className="mt-2">Paid: {d.payments.map((p) => `${p.method} ${formatINR(p.amount)}`).join(', ')}</p>}
          {d.footer && <p className="mt-2 text-[11px]">{d.footer}</p>}
        </div>
        <table className="w-64">
          <tbody>
            <tr><td>Taxable value</td><td className="text-right">{formatINR(d.taxable)}</td></tr>
            {d.interstate ? <tr><td>IGST</td><td className="text-right">{formatINR(d.igst)}</td></tr> : <><tr><td>CGST</td><td className="text-right">{formatINR(d.cgst)}</td></tr><tr><td>SGST</td><td className="text-right">{formatINR(d.sgst)}</td></tr></>}
            {Number(d.roundOff) !== 0 && <tr><td>Round off</td><td className="text-right">{formatINR(d.roundOff)}</td></tr>}
            <tr className="border-t border-black text-sm font-bold"><td>Total</td><td className="text-right">{formatINR(d.total)}</td></tr>
          </tbody>
        </table>
      </section>
      <footer className="mt-10 flex items-end justify-between text-[11px]">
        <p>This is a computer-generated document.</p>
        <p className="border-t border-black pt-1">Authorised signatory</p>
      </footer>
    </article>
  )
}

function Thermal({ d }: { d: Doc }) {
  return (
    <article className="receipt-80 mx-auto bg-white p-3 font-mono text-black shadow print:p-0 print:shadow-none">
      <div className="text-center">
        <p className="text-sm font-bold">{d.seller.trade_name || d.seller.legal_name}</p>
        <p>{d.seller.location_name}</p>
        {d.seller.gstin && <p>GSTIN {d.seller.gstin}</p>}
        <p className="mt-1 font-bold uppercase">{d.title}</p>
        {d.status && <p className="font-bold">*** {d.status} ***</p>}
        <p>{d.number}</p><p>{formatDate(d.date, true)}</p>
      </div>
      {d.buyer.name && d.buyer.name !== 'Walk-in customer' && <p className="mt-1">To: {d.buyer.name}{d.buyer.gstin ? ` (${d.buyer.gstin})` : ''}</p>}
      <div className="my-1 border-t border-dashed border-black" />
      {d.lines.map((l, i) => (
        <div key={i} className="mb-1">
          <p>{l.title}</p>
          <p className="flex justify-between"><span>{l.qty} x {l.rate ? Number(l.rate).toFixed(2) : ''}{l.disc ? ` -${l.disc.toFixed(2)}` : ''}{Number(l.taxRate) ? ` GST${Number(l.taxRate)}%` : ''}</span><span>{Number(l.total).toFixed(2)}</span></p>
        </div>
      ))}
      <div className="my-1 border-t border-dashed border-black" />
      <p className="flex justify-between"><span>Taxable</span><span>{Number(d.taxable).toFixed(2)}</span></p>
      {d.interstate ? <p className="flex justify-between"><span>IGST</span><span>{Number(d.igst).toFixed(2)}</span></p> : <>
        <p className="flex justify-between"><span>CGST</span><span>{Number(d.cgst).toFixed(2)}</span></p>
        <p className="flex justify-between"><span>SGST</span><span>{Number(d.sgst).toFixed(2)}</span></p></>}
      {Number(d.roundOff) !== 0 && <p className="flex justify-between"><span>Round off</span><span>{Number(d.roundOff).toFixed(2)}</span></p>}
      <p className="flex justify-between text-sm font-bold"><span>TOTAL</span><span>{formatINR(d.total)}</span></p>
      {d.payments?.map((p, i) => <p key={i} className="flex justify-between"><span>{p.method}</span><span>{Number(p.amount).toFixed(2)}</span></p>)}
      {d.payments?.some((p) => p.change && Number(p.change) > 0) && <p className="flex justify-between"><span>Change</span><span>{Number(d.payments.find((p) => p.change)!.change).toFixed(2)}</span></p>}
      <div className="my-1 border-t border-dashed border-black" />
      <p className="text-center">Thank you! Returns within the store policy with this receipt.</p>
    </article>
  )
}
