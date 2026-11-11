import { useMutation, useQueryClient } from '@tanstack/react-query'
import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input, NativeSelect } from '@/components/ui/input'
import { ApiError, api, errorMessage } from '@/lib/api'
import { categoryOptions, useCategories, useTaxClasses } from '@/lib/queries'
import type { Book } from '@/lib/types'

type Kind = 'BOOK' | 'SUPPLY'

/**
 * Adds a new catalog item without leaving the current screen: a book, or a school supply (notebook, pen,
 * geometry box…). Used from every book picker so lists, stock and orders never wait for the catalog page.
 */
export function QuickAddItem({ open, initialTitle, onOpenChange, onCreated }: {
  open: boolean
  initialTitle: string
  onOpenChange: (open: boolean) => void
  onCreated: (book: Book) => void
}) {
  const qc = useQueryClient()
  const taxes = useTaxClasses()
  const cats = useCategories()
  const [kind, setKind] = React.useState<Kind>('BOOK')
  const [f, setF] = React.useState({ title: '', author: '', publisher: '', isbn: '', barcode: '', mrp: '', selling_price: '', purchase_price: '', tax_class_id: '', category_id: '' })
  const [errs, setErrs] = React.useState<Record<string, string>>({})

  const defaultTax = React.useCallback((k: Kind) => {
    const list = taxes.data ?? []
    const want = k === 'BOOK' ? '0.00' : '12.00'
    return (list.find((t) => t.is_active && t.rate === want) ?? list.find((t) => t.is_active))?.id ?? ''
  }, [taxes.data])

  React.useEffect(() => {
    if (open) {
      setKind('BOOK')
      setErrs({})
      setF({ title: initialTitle, author: '', publisher: '', isbn: '', barcode: '', mrp: '', selling_price: '', purchase_price: '', tax_class_id: defaultTax('BOOK'), category_id: '' })
    }
  }, [open, initialTitle, defaultTax])

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value })
  const switchKind = (k: Kind) => {
    setKind(k)
    setF((x) => ({ ...x, tax_class_id: defaultTax(k) }))
  }

  const save = useMutation({
    mutationFn: () => {
      const e: Record<string, string> = {}
      if (!f.title.trim()) e.title = 'Enter the name'
      if (!f.mrp.trim() || !(Number(f.mrp) >= 0)) e.mrp = 'Enter the MRP'
      if (f.selling_price && Number(f.selling_price) > Number(f.mrp)) e.selling_price = 'Cannot be more than MRP'
      if (!f.tax_class_id) e.tax_class_id = 'Choose GST'
      setErrs(e)
      if (Object.keys(e).length) return Promise.reject(new Error('Fix the highlighted fields'))
      return api.post<Book>('/books', {
        title: f.title.trim(), authors: f.author.trim() ? [f.author.trim()] : [], publisher: f.publisher.trim() || null,
        isbn13: kind === 'BOOK' ? f.isbn.trim() || null : null, barcode: f.barcode.trim() || null,
        mrp: f.mrp, selling_price: f.selling_price || f.mrp, purchase_price: f.purchase_price || null,
        tax_class_id: f.tax_class_id, category_id: f.category_id || null, hsn_code: kind === 'BOOK' ? '4901' : '4820',
      })
    },
    onSuccess: (b) => {
      toast.success(`${b.title} added to the catalog (${b.sku})`)
      void qc.invalidateQueries({ queryKey: ['book-search'] })
      onCreated(b)
      onOpenChange(false)
    },
    onError: (e) => {
      if (e instanceof ApiError) {
        const fe = e.fieldErrors()
        if (Object.keys(fe).length) setErrs((x) => ({ ...x, ...fe }))
      }
      toast.error(errorMessage(e))
    },
  })

  const isBook = kind === 'BOOK'
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" title="Add new item" description="It is saved to the catalog and added here straight away."
        footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Add item</Button></>}>
        <div className="grid gap-4">
          <div className="flex rounded-md border border-border p-0.5" role="group" aria-label="Item type">
            <Button type="button" size="sm" className="flex-1" variant={isBook ? 'primary' : 'ghost'} aria-pressed={isBook} onClick={() => switchKind('BOOK')}>Book</Button>
            <Button type="button" size="sm" className="flex-1" variant={!isBook ? 'primary' : 'ghost'} aria-pressed={!isBook} onClick={() => switchKind('SUPPLY')}>School supply</Button>
          </div>
          <Field label={isBook ? 'Title' : 'Item name'} required error={errs.title}>
            <Input value={f.title} onChange={set('title')} autoFocus placeholder={isBook ? 'e.g. Smart Maths - 3' : 'e.g. Ruled notebook 200 pages'} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={isBook ? 'Author' : 'Brand'} hint={isBook ? 'School orders are emailed to the first author' : undefined} error={errs['authors.0'] ?? errs.authors}>
              <Input value={f.author} onChange={set('author')} placeholder={isBook ? 'e.g. NCERT' : 'e.g. Classmate'} />
            </Field>
            <Field label={isBook ? 'Publisher' : 'Maker / supplier'}><Input value={f.publisher} onChange={set('publisher')} /></Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {isBook && <Field label="ISBN" hint="Optional; checked if given" error={errs.isbn13}><Input value={f.isbn} onChange={set('isbn')} inputMode="numeric" /></Field>}
            <Field label="Barcode" hint="Optional; one is generated if blank" error={errs.barcode}><Input value={f.barcode} onChange={set('barcode')} /></Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="MRP (₹)" required error={errs.mrp}><Input value={f.mrp} onChange={set('mrp')} inputMode="decimal" /></Field>
            <Field label="Selling price (₹)" hint="Blank = MRP" error={errs.selling_price}><Input value={f.selling_price} onChange={set('selling_price')} inputMode="decimal" /></Field>
            <Field label="Cost price (₹)" error={errs.purchase_price}><Input value={f.purchase_price} onChange={set('purchase_price')} inputMode="decimal" /></Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="GST" required error={errs.tax_class_id}>
              <NativeSelect value={f.tax_class_id} onChange={set('tax_class_id')}>
                <option value="">Choose…</option>
                {(taxes.data ?? []).filter((t) => t.is_active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Category">
              <NativeSelect value={f.category_id} onChange={set('category_id')}>
                <option value="">None</option>
                {categoryOptions(cats.data).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </NativeSelect>
            </Field>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
