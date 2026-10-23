import { useQuery } from '@tanstack/react-query'
import { BookOpen, Receipt, Search, User } from 'lucide-react'
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type Page } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useDebounced } from '@/lib/hooks'
import type { Book } from '@/lib/types'
import { cn } from '@/lib/utils'

interface Result {
  kind: 'book' | 'customer' | 'invoice'
  id: string
  title: string
  subtitle: string
  to: string
}

/** Header search across books, customers and invoice numbers (press "/" to focus). */
export function GlobalSearch() {
  const { can, canAny } = useAuth()
  const navigate = useNavigate()
  const [q, setQ] = React.useState('')
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const dq = useDebounced(q.trim(), 250)

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const results = useQuery({
    queryKey: ['global-search', dq],
    enabled: dq.length >= 2,
    queryFn: async ({ signal }) => {
      const out: Result[] = []
      const tasks: Promise<void>[] = []
      if (can('catalog.view')) {
        tasks.push(api.get<Page<Book>>('/books', { q: dq, page_size: 5 }, signal).then((r) => {
          out.push(...r.items.map((b) => ({ kind: 'book' as const, id: b.id, title: b.title, subtitle: [b.authors.join(', '), b.isbn13 ?? b.sku].filter(Boolean).join(' · '), to: `/catalog/${b.id}` })))
        }).catch(() => undefined))
      }
      if (canAny('customers.view')) {
        tasks.push(api.get<Page<{ id: string; name: string; phone: string | null; code: string }>>('/customers', { q: dq, page_size: 4 }, signal).then((r) => {
          out.push(...r.items.map((c) => ({ kind: 'customer' as const, id: c.id, title: c.name, subtitle: [c.code, c.phone].filter(Boolean).join(' · '), to: `/customers/${c.id}` })))
        }).catch(() => undefined))
      }
      if (can('sales.view') && /[/\d]/.test(dq)) {
        tasks.push(api.get<Page<{ id: string; invoice_number: string | null; customer_name: string | null; grand_total: string }>>('/sales', { q: dq, page_size: 4 }, signal).then((r) => {
          out.push(...r.items.map((s) => ({ kind: 'invoice' as const, id: s.id, title: s.invoice_number ?? 'Sale', subtitle: `${s.customer_name ?? 'Walk-in'} · ₹${s.grand_total}`, to: `/sales/${s.id}` })))
        }).catch(() => undefined))
      }
      await Promise.all(tasks)
      return out
    },
  })
  const items = results.data ?? []
  const icons = { book: BookOpen, customer: User, invoice: Receipt }

  const go = (r: Result) => {
    navigate(r.to)
    setQ('')
    setOpen(false)
    inputRef.current?.blur()
  }

  return (
    <div className="relative w-full max-w-md">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
          setActive(0)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
          if (e.key === 'Enter' && items[active]) go(items[active])
          if (e.key === 'Escape') inputRef.current?.blur()
        }}
        placeholder="Search books, customers, invoices…  ( / )"
        aria-label="Global search"
        className="h-9 w-full rounded-md border border-border bg-surface pl-8 pr-3 text-sm placeholder:text-subtle focus:border-primary focus:bg-white focus:outline-none"
      />
      {open && dq.length >= 2 && (
        <ul className="absolute z-40 mt-1 w-full overflow-hidden rounded-md border border-border bg-white py-1 shadow-[var(--shadow-pop)]" role="listbox">
          {results.isFetching && items.length === 0 && <li className="px-3 py-2 text-sm text-muted">Searching…</li>}
          {!results.isFetching && items.length === 0 && <li className="px-3 py-2 text-sm text-muted">No results for “{dq}”</li>}
          {items.map((r, i) => {
            const Icon = icons[r.kind]
            return (
              <li
                key={`${r.kind}-${r.id}`}
                role="option"
                aria-selected={i === active}
                className={cn('flex cursor-pointer items-center gap-3 px-3 py-2', i === active && 'bg-surface-2')}
                onMouseDown={(e) => { e.preventDefault(); go(r) }}
                onMouseEnter={() => setActive(i)}
              >
                <Icon className="size-4 shrink-0 text-muted" />
                <div className="min-w-0">
                  <p className="truncate text-sm">{r.title}</p>
                  <p className="truncate text-xs text-muted">{r.subtitle}</p>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
