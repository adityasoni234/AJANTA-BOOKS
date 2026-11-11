import { useQuery } from '@tanstack/react-query'
import { Loader2, Plus, ScanLine } from 'lucide-react'
import * as React from 'react'
import { Input } from '@/components/ui/input'
import { api, type Page } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useDebounced } from '@/lib/hooks'
import { QuickAddItem } from './QuickAddItem'
import type { Book } from '@/lib/types'
import { cn, formatINR } from '@/lib/utils'

/**
 * Search-as-you-type book picker that also accepts scanner input: pressing Enter with an exact
 * ISBN/barcode/SKU/copy code resolves it via the lookup endpoint.
 */
export function BookSearch({ onSelect, locationId, placeholder = 'Search title, author, ISBN or scan barcode…', autoFocus, inStockOnly, className, inputRef, allowCreate }: {
  onSelect: (book: Book, copy?: { id: string; code: string }) => void
  locationId?: string | null
  placeholder?: string
  autoFocus?: boolean
  inStockOnly?: boolean
  className?: string
  inputRef?: React.Ref<HTMLInputElement>
  /** Offer "Add new item" (book or school supply) when the item is not in the catalog yet. */
  allowCreate?: boolean
}) {
  const { can } = useAuth()
  const canCreate = !!allowCreate && can('catalog.create')
  const [adding, setAdding] = React.useState<string | null>(null)
  const [q, setQ] = React.useState('')
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)
  const [resolving, setResolving] = React.useState(false)
  const dq = useDebounced(q.trim(), 250)
  const listId = React.useId()
  const results = useQuery({
    queryKey: ['book-search', dq, locationId, inStockOnly],
    queryFn: ({ signal }) =>
      api.get<Page<Book>>('/books', { q: dq, page_size: 8, location_id: locationId ?? undefined, in_stock: inStockOnly || undefined }, signal),
    enabled: dq.length >= 2,
    staleTime: 30_000,
  })
  const items = results.data?.items ?? []

  const choose = (b: Book, copy?: { id: string; code: string }) => {
    onSelect(b, copy)
    setQ('')
    setOpen(false)
    setActive(0)
    setError(null)
  }

  const resolveExact = async () => {
    const code = q.trim()
    if (!code) return
    setResolving(true)
    setError(null)
    try {
      const r = await api.get<{ book: Book; copy_id: string | null; copy_code: string | null; copy_status: string | null }>(
        '/books/lookup', { code, location_id: locationId ?? undefined })
      if (r.copy_id && r.copy_status !== 'AVAILABLE') {
        setError(`Copy ${r.copy_code} is ${r.copy_status?.toLowerCase().replace(/_/g, ' ')}`)
      } else {
        choose(r.book, r.copy_id ? { id: r.copy_id, code: r.copy_code! } : undefined)
      }
    } catch {
      if (items.length && open) choose(items[Math.min(active, items.length - 1)])
      else setError(`No book found for “${code}”`)
    } finally {
      setResolving(false)
    }
  }

  return (
    <div className={cn('relative', className)}>
      <ScanLine className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden />
      <Input
        ref={inputRef}
        value={q}
        autoFocus={autoFocus}
        placeholder={placeholder}
        className="pl-8"
        role="combobox"
        aria-expanded={open && items.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label="Search or scan book"
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
          setActive(0)
          setError(null)
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((a) => Math.min(a + 1, items.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => Math.max(a - 1, 0))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            // Scanners send the full code + Enter quickly; prefer exact lookup.
            void resolveExact()
          } else if (e.key === 'Escape') {
            setOpen(false)
          }
        }}
      />
      {(results.isFetching || resolving) && <Loader2 className="absolute right-2.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-subtle" />}
      {error && <p className="mt-1 text-xs text-danger" role="alert">{error}</p>}
      {canCreate && (
        <button type="button" className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline" onClick={() => setAdding(q.trim())}>
          <Plus className="size-3" /> Not in the catalog? Add a new book or school supply
        </button>
      )}
      {canCreate && <QuickAddItem open={adding !== null} initialTitle={adding ?? ''} onOpenChange={(o) => { if (!o) setAdding(null) }} onCreated={(b) => choose(b)} />}
      {open && dq.length >= 2 && (
        <ul id={listId} role="listbox" className="absolute z-40 mt-1 max-h-80 w-full overflow-auto rounded-md border border-border bg-white py-1 shadow-[var(--shadow-pop)]">
          {items.length === 0 && !results.isFetching && <li className="px-3 py-2 text-sm text-muted">No matches</li>}
          {canCreate && !results.isFetching && (
            <li role="option" aria-selected={false} className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-2 text-sm font-medium text-primary hover:bg-surface-2"
              onMouseDown={(e) => { e.preventDefault(); setOpen(false); setAdding(q.trim()) }}>
              <Plus className="size-4" /> Add “{q.trim()}” as a new book or school supply
            </li>
          )}
          {items.map((b, i) => (
            <li
              key={b.id}
              role="option"
              aria-selected={i === active}
              className={cn('flex cursor-pointer items-center justify-between gap-3 px-3 py-2', i === active && 'bg-surface-2')}
              onMouseDown={(e) => {
                e.preventDefault()
                choose(b)
              }}
              onMouseEnter={() => setActive(i)}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{b.title}</p>
                <p className="truncate text-xs text-muted">
                  {[b.authors.join(', '), b.isbn13 ?? b.sku].filter(Boolean).join(' · ')}
                  {b.tracking_mode === 'COPY' && ' · copy-tracked'}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="num text-sm">{formatINR(b.location_price ?? b.selling_price)}</p>
                {b.stock_available !== null && (
                  <p className={cn('text-xs', (b.stock_available ?? 0) > 0 ? 'text-success' : 'text-danger')}>
                    {b.stock_available} in stock
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
