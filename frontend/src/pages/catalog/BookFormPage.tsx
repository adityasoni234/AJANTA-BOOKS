import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import * as React from 'react'
import { useForm } from 'react-hook-form'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { z } from 'zod'
import { PageHeader } from '@/components/common/PageHeader'
import { PageLoader } from '@/components/common/States'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input'
import { api, ApiError, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useDebounced } from '@/lib/hooks'
import { categoryOptions, useCategories, useSuppliers, useTaxClasses } from '@/lib/queries'
import type { Book } from '@/lib/types'
import { isbn13Valid } from '@/lib/utils'

const money = z.string().trim().regex(/^\d+(\.\d{1,2})?$/, 'Enter an amount like 499 or 499.00')
const optMoney = z.string().trim().regex(/^(\d+(\.\d{1,2})?)?$/, 'Enter an amount like 499.00').optional()


const schema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(300),
  subtitle: z.string().max(300).optional(),
  authors: z.string().optional(),
  publisher: z.string().max(200).optional(),
  isbn13: z.string().trim().optional().refine((v) => !v || isbn13Valid(v), 'Invalid ISBN-13 checksum'),
  isbn10: z.string().trim().optional(),
  barcode: z.string().trim().max(40).optional(),
  edition: z.string().max(60).optional(),
  publication_date: z.string().optional(),
  language: z.string().max(40).optional(),
  category_id: z.string().optional(),
  binding: z.string().max(40).optional(),
  page_count: z.string().regex(/^\d*$/, 'Whole number').optional(),
  description: z.string().max(5000).optional(),
  tags: z.string().optional(),
  hsn_code: z.string().regex(/^(\d{4,8})?$/, '4–8 digits').optional(),
  tax_class_id: z.string().min(1, 'Choose a GST class'),
  mrp: money,
  selling_price: money,
  min_selling_price: optMoney,
  purchase_price: optMoney,
  default_supplier_id: z.string().optional(),
  reorder_level: z.string().regex(/^\d+$/, 'Whole number'),
  reorder_qty: z.string().regex(/^\d+$/, 'Whole number'),
  tracking_mode: z.enum(['QUANTITY', 'COPY']),
  status: z.enum(['ACTIVE', 'DISCONTINUED', 'ARCHIVED']),
  change_reason: z.string().max(300).optional(),
}).superRefine((v, ctx) => {
  if (Number(v.selling_price) > Number(v.mrp)) ctx.addIssue({ code: 'custom', path: ['selling_price'], message: 'Cannot exceed MRP' })
  if (v.min_selling_price && Number(v.min_selling_price) > Number(v.selling_price)) ctx.addIssue({ code: 'custom', path: ['min_selling_price'], message: 'Cannot exceed selling price' })
})
type Values = z.infer<typeof schema>

function toValues(b?: Book): Values {
  return {
    title: b?.title ?? '', subtitle: b?.subtitle ?? '', authors: b?.authors.join('; ') ?? '', publisher: b?.publisher ?? '',
    isbn13: b?.isbn13 ?? '', isbn10: b?.isbn10 ?? '', barcode: b?.barcode ?? '', edition: b?.edition ?? '',
    publication_date: b?.publication_date ?? '', language: b?.language ?? 'English', category_id: b?.category_id ?? '',
    binding: b?.binding ?? '', page_count: b?.page_count ? String(b.page_count) : '', description: b?.description ?? '',
    tags: b?.tags.join('; ') ?? '', hsn_code: b?.hsn_code ?? '4901', tax_class_id: b?.tax_class_id ?? '',
    mrp: b?.mrp ?? '', selling_price: b?.selling_price ?? '', min_selling_price: b?.min_selling_price ?? '',
    purchase_price: b?.purchase_price ?? '', default_supplier_id: b?.default_supplier_id ?? '',
    reorder_level: String(b?.reorder_level ?? 0), reorder_qty: String(b?.reorder_qty ?? 0),
    tracking_mode: b?.tracking_mode ?? 'QUANTITY', status: b?.status ?? 'ACTIVE', change_reason: '',
  }
}

export default function BookFormPage() {
  const { id } = useParams()
  const editing = !!id
  const { can } = useAuth()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const book = useQuery({ queryKey: ['book', id], queryFn: () => api.get<Book>(`/books/${id}`), enabled: editing })
  const tax = useTaxClasses()
  const cats = useCategories()
  const sups = useSuppliers(can('suppliers.view'))
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: toValues() })
  const { register, handleSubmit, formState: { errors }, reset, watch, setError } = form

  React.useEffect(() => {
    if (book.data) reset(toValues(book.data))
  }, [book.data, reset])
  React.useEffect(() => {
    if (!editing && tax.data && !form.getValues('tax_class_id')) {
      form.setValue('tax_class_id', tax.data.find((t) => t.code === 'GST0')?.id ?? tax.data[0]?.id ?? '')
    }
  }, [tax.data, editing, form])

  const title = useDebounced(watch('title'), 500)
  const isbn = useDebounced(watch('isbn13'), 500)
  const dups = useQuery({
    queryKey: ['dup-check', title, isbn, id],
    queryFn: () => api.post<Book[]>('/books/check-duplicates', { title, isbn13: isbn || null, exclude_id: id ?? null }),
    enabled: (title?.length ?? 0) >= 4,
  })

  const save = useMutation({
    mutationFn: (v: Values) => {
      const payload = {
        ...v,
        authors: (v.authors ?? '').split(/[;,]/).map((s) => s.trim()).filter(Boolean),
        tags: (v.tags ?? '').split(/[;,]/).map((s) => s.trim()).filter(Boolean),
        page_count: v.page_count ? Number(v.page_count) : null,
        publication_date: v.publication_date || null,
        category_id: v.category_id || null,
        default_supplier_id: v.default_supplier_id || null,
        min_selling_price: v.min_selling_price || null,
        purchase_price: v.purchase_price || null,
        isbn13: v.isbn13 || null, isbn10: v.isbn10 || null, barcode: v.barcode || null,
        reorder_level: Number(v.reorder_level), reorder_qty: Number(v.reorder_qty),
        hsn_code: v.hsn_code || null,
      }
      return editing ? api.put<Book>(`/books/${id}`, payload) : api.post<Book>('/books', payload)
    },
    onSuccess: (b) => {
      toast.success(editing ? 'Book updated' : 'Book added')
      void qc.invalidateQueries({ queryKey: ['books'] })
      void qc.invalidateQueries({ queryKey: ['book', b.id] })
      navigate(`/catalog/${b.id}`)
    },
    onError: (e) => {
      if (e instanceof ApiError) {
        for (const [k, msg] of Object.entries(e.fieldErrors())) setError(k as keyof Values, { message: msg })
      }
      toast.error(errorMessage(e))
    },
  })

  if (editing && book.isLoading) return <PageLoader />
  const possibleDups = (dups.data ?? []).filter((d) => d.id !== id)
  const canPrice = !editing || can('catalog.price_edit')

  return (
    <div className="max-w-5xl">
      <PageHeader title={editing ? `Edit: ${book.data?.title ?? ''}` : 'Add book'} crumbs={[{ label: 'Catalog', to: '/catalog' }, { label: editing ? 'Edit' : 'New' }]} />
      <form onSubmit={handleSubmit((v) => save.mutate(v))} className="space-y-6" noValidate>
        {possibleDups.length > 0 && (
          <div role="status" className="flex gap-3 rounded-md border border-amber-200 bg-warning-soft px-4 py-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-medium">Possible duplicates in the catalog</p>
              <ul className="mt-1 space-y-0.5">
                {possibleDups.slice(0, 4).map((d) => (
                  <li key={d.id}><Link className="underline" to={`/catalog/${d.id}`} target="_blank">{d.title}</Link> — {d.authors.join(', ')} {d.isbn13 && `(${d.isbn13})`}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
        <Card>
          <CardHeader title="Bibliographic details" />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Title" htmlFor="title" required error={errors.title?.message} className="sm:col-span-2"><Input id="title" aria-invalid={!!errors.title} {...register('title')} /></Field>
            <Field label="Subtitle" htmlFor="subtitle" className="sm:col-span-2"><Input id="subtitle" {...register('subtitle')} /></Field>
            <Field label="Authors" htmlFor="authors" hint="Separate multiple authors with ;"><Input id="authors" {...register('authors')} /></Field>
            <Field label="Publisher" htmlFor="publisher"><Input id="publisher" {...register('publisher')} /></Field>
            <Field label="ISBN-13" htmlFor="isbn13" error={errors.isbn13?.message} hint="Checksum validated; leave blank for items without ISBN"><Input id="isbn13" inputMode="numeric" aria-invalid={!!errors.isbn13} {...register('isbn13')} /></Field>
            <Field label="ISBN-10" htmlFor="isbn10" error={errors.isbn10?.message}><Input id="isbn10" {...register('isbn10')} /></Field>
            <Field label="Barcode" htmlFor="barcode" hint="Defaults to ISBN-13, or an in-store EAN-13 is generated"><Input id="barcode" {...register('barcode')} /></Field>
            <Field label="Category" htmlFor="category_id">
              <NativeSelect id="category_id" {...register('category_id')}>
                <option value="">Uncategorised</option>
                {categoryOptions(cats.data).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Edition" htmlFor="edition"><Input id="edition" {...register('edition')} /></Field>
            <Field label="Publication date" htmlFor="publication_date"><Input id="publication_date" type="date" {...register('publication_date')} /></Field>
            <Field label="Language" htmlFor="language"><Input id="language" {...register('language')} /></Field>
            <Field label="Binding / format" htmlFor="binding"><Input id="binding" placeholder="Paperback, Hardcover…" {...register('binding')} /></Field>
            <Field label="Pages" htmlFor="page_count" error={errors.page_count?.message}><Input id="page_count" inputMode="numeric" {...register('page_count')} /></Field>
            <Field label="Tags" htmlFor="tags" hint="Separate with ;"><Input id="tags" {...register('tags')} /></Field>
            <Field label="Description" htmlFor="description" className="sm:col-span-2"><Textarea id="description" rows={3} {...register('description')} /></Field>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Pricing & tax" description={canPrice ? 'Selling price may not exceed MRP. Minimum price limits cashier discounts.' : 'You do not have permission to change prices.'} />
          <CardBody className="grid gap-4 sm:grid-cols-3">
            <Field label="MRP (₹)" htmlFor="mrp" required error={errors.mrp?.message}><Input id="mrp" inputMode="decimal" readOnly={!canPrice} aria-invalid={!!errors.mrp} {...register('mrp')} /></Field>
            <Field label="Selling price (₹)" htmlFor="selling_price" required error={errors.selling_price?.message}><Input id="selling_price" inputMode="decimal" readOnly={!canPrice} aria-invalid={!!errors.selling_price} {...register('selling_price')} /></Field>
            <Field label="Minimum price (₹)" htmlFor="min_selling_price" error={errors.min_selling_price?.message}><Input id="min_selling_price" inputMode="decimal" readOnly={!canPrice} {...register('min_selling_price')} /></Field>
            <Field label="Standard purchase price (₹)" htmlFor="purchase_price" error={errors.purchase_price?.message}><Input id="purchase_price" inputMode="decimal" readOnly={!canPrice} {...register('purchase_price')} /></Field>
            <Field label="GST class" htmlFor="tax_class_id" required error={errors.tax_class_id?.message}>
              <NativeSelect id="tax_class_id" {...register('tax_class_id')}>
                {(tax.data ?? []).filter((t) => t.is_active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </NativeSelect>
            </Field>
            <Field label="HSN code" htmlFor="hsn_code" error={errors.hsn_code?.message} hint="Printed books: 4901 (verify with your accountant)"><Input id="hsn_code" {...register('hsn_code')} /></Field>
            {editing && canPrice && <Field label="Reason for price change" htmlFor="change_reason" className="sm:col-span-3"><Input id="change_reason" {...register('change_reason')} /></Field>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Inventory" />
          <CardBody className="grid gap-4 sm:grid-cols-3">
            <Field label="Tracking" htmlFor="tracking_mode" hint="Copy tracking assigns a unique barcode to every physical copy">
              <NativeSelect id="tracking_mode" {...register('tracking_mode')}>
                <option value="QUANTITY">Quantity (shared barcode)</option>
                <option value="COPY">Individual copies</option>
              </NativeSelect>
            </Field>
            <Field label="Default reorder level" htmlFor="reorder_level" error={errors.reorder_level?.message}><Input id="reorder_level" inputMode="numeric" {...register('reorder_level')} /></Field>
            <Field label="Default reorder quantity" htmlFor="reorder_qty" error={errors.reorder_qty?.message}><Input id="reorder_qty" inputMode="numeric" {...register('reorder_qty')} /></Field>
            {can('suppliers.view') && (
              <Field label="Default supplier" htmlFor="default_supplier_id">
                <NativeSelect id="default_supplier_id" {...register('default_supplier_id')}>
                  <option value="">None</option>
                  {(sups.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </NativeSelect>
              </Field>
            )}
            <Field label="Status" htmlFor="status">
              <NativeSelect id="status" {...register('status')}>
                <option value="ACTIVE">Active</option>
                <option value="DISCONTINUED">Discontinued (sell remaining stock)</option>
                {(can('catalog.archive') || book.data?.status === 'ARCHIVED') && <option value="ARCHIVED">Archived</option>}
              </NativeSelect>
            </Field>
          </CardBody>
        </Card>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => navigate(-1)}>Cancel</Button>
          <Button type="submit" loading={save.isPending}>{editing ? 'Save changes' : 'Add book'}</Button>
        </div>
      </form>
    </div>
  )
}
