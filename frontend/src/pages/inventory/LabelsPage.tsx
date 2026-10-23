import { useQuery } from '@tanstack/react-query'
import { Printer, Trash2 } from 'lucide-react'
import * as React from 'react'
import { useSearchParams } from 'react-router-dom'
import { Barcode } from '@/components/common/Barcode'
import { BookSearch } from '@/components/common/BookSearch'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState } from '@/components/common/States'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Field, Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import type { Book } from '@/lib/types'
import { formatINR } from '@/lib/utils'

interface Label { code: string; symbology: 'EAN13' | 'CODE128'; title: string; sku: string; price: string; mrp: string }

/** Printable barcode labels (A4 sheet, 3 × 8 grid). Uses the browser print dialog — no printer driver integration. */
export default function LabelsPage() {
  const { locationId } = useAuth()
  const [params] = useSearchParams()
  const [books, setBooks] = React.useState<{ book: Book; copies: number }[]>([])
  const copyIds = (params.get('copies') ?? '').split(',').filter(Boolean)
  const presetBook = params.get('book')
  React.useEffect(() => {
    if (presetBook) api.get<Book>(`/books/${presetBook}`).then((b) => setBooks([{ book: b, copies: 1 }])).catch(() => undefined)
  }, [presetBook])
  const labels = useQuery({
    queryKey: ['labels', books.map((b) => b.book.id).join(), copyIds.join(), locationId],
    queryFn: () => api.post<Label[]>('/labels', { book_ids: books.map((b) => b.book.id), copy_ids: copyIds, location_id: locationId }),
    enabled: books.length > 0 || copyIds.length > 0,
  })
  const expanded: Label[] = []
  for (const l of labels.data ?? []) {
    const n = books.find((b) => b.book.barcode === l.code)?.copies ?? 1
    for (let i = 0; i < n; i++) expanded.push(l)
  }
  return (
    <div>
      <div className="no-print">
        <PageHeader title="Barcode labels" description="Prints on A4 label sheets (3 × 8). Use your browser’s print dialog; set margins to none for best alignment."
          actions={<Button disabled={!expanded.length} onClick={() => window.print()}><Printer /> Print {expanded.length} labels</Button>} />
        {copyIds.length === 0 && (
          <Card className="mb-4">
            <CardBody className="space-y-3">
              <BookSearch locationId={locationId} onSelect={(b) => setBooks((bs) => bs.some((x) => x.book.id === b.id) ? bs : [...bs, { book: b, copies: 1 }])} />
              {books.map((b, i) => (
                <div key={b.book.id} className="flex items-end gap-3">
                  <p className="flex-1 truncate text-sm">{b.book.title} <span className="text-muted">({b.book.barcode})</span></p>
                  <Field label="Labels" className="w-24"><Input type="number" min={1} max={200} value={b.copies} onChange={(e) => setBooks(books.map((x, j) => j === i ? { ...x, copies: Math.max(1, Math.min(200, Number(e.target.value))) } : x))} /></Field>
                  <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => setBooks(books.filter((_, j) => j !== i))}><Trash2 /></Button>
                </div>
              ))}
            </CardBody>
          </Card>
        )}
      </div>
      {expanded.length === 0 ? <div className="no-print"><EmptyState title="No labels selected" description="Search for books above, or select copies on the Copies page." /></div> : (
        <div className="grid grid-cols-3 gap-0 bg-white print:gap-0" style={{ width: '210mm' }}>
          {expanded.map((l, i) => (
            <div key={i} className="flex h-[37mm] flex-col items-center justify-center overflow-hidden border border-dashed border-border px-2 text-center print:border-0">
              <p className="line-clamp-1 w-full text-[10px] font-semibold">{l.title}</p>
              <Barcode value={l.code} format={l.symbology} height={34} width={1.3} fontSize={10} />
              <p className="text-[10px]"><span className="font-semibold">{formatINR(l.price)}</span>{l.mrp !== l.price && <span className="ml-1 text-muted">MRP {formatINR(l.mrp)}</span>}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
