import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Download, Plus, Upload } from 'lucide-react'
import * as React from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { DataTable, type Column } from '@/components/common/DataTable'
import { SearchInput } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { Badge, StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { NativeSelect } from '@/components/ui/input'
import { api, errorMessage, type Page } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useDebounced } from '@/lib/hooks'
import { categoryOptions, useCategories } from '@/lib/queries'
import type { Book } from '@/lib/types'
import { formatINR } from '@/lib/utils'

export default function BooksPage() {
  const { can, locationId, location } = useAuth()
  const navigate = useNavigate()
  const [q, setQ] = React.useState('')
  const [category, setCategory] = React.useState('')
  const [status, setStatus] = React.useState('')
  const [sort, setSort] = React.useState('title')
  const [page, setPage] = React.useState(1)
  const dq = useDebounced(q)
  const cats = useCategories()
  React.useEffect(() => setPage(1), [dq, category, status, sort, locationId])
  const query = useQuery({
    queryKey: ['books', dq, category, status, sort, page, locationId],
    queryFn: ({ signal }) => api.get<Page<Book>>('/books', { q: dq, category_id: category, status, sort, page, page_size: 25, location_id: locationId ?? undefined }, signal),
    placeholderData: keepPreviousData,
  })

  const cols: Column<Book>[] = [
    {
      key: 'title', header: 'Title',
      cell: (b) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{b.title}</p>
          <p className="truncate text-xs text-muted">{b.authors.join(', ') || '—'}{b.publisher ? ` · ${b.publisher}` : ''}</p>
        </div>
      ),
    },
    { key: 'isbn', header: 'ISBN / SKU', hideBelow: 'md', cell: (b) => <span className="num text-xs">{b.isbn13 ?? '—'}<br /><span className="text-muted">{b.sku}</span></span> },
    { key: 'cat', header: 'Category', hideBelow: 'lg', cell: (b) => b.category ?? <span className="text-muted">—</span> },
    { key: 'price', header: 'Price', align: 'right', cell: (b) => <><span>{formatINR(b.location_price ?? b.selling_price)}</span>{b.mrp !== b.selling_price && <span className="block text-xs text-muted line-through">{formatINR(b.mrp)}</span>}</> },
    { key: 'tax', header: 'GST', align: 'right', hideBelow: 'md', cell: (b) => `${Number(b.tax_rate)}%` },
    ...(locationId ? [{ key: 'stock', header: `Stock · ${location?.name ?? ''}`, align: 'right' as const, cell: (b: Book) => <span className={b.stock_available ? '' : 'text-danger'}>{b.stock_available ?? 0}</span> }] : []),
    { key: 'status', header: 'Status', cell: (b) => <div className="flex gap-1"><StatusBadge status={b.status} />{b.tracking_mode === 'COPY' && <Badge tone="primary">Copies</Badge>}</div> },
  ]

  const exportCsv = async () => {
    try {
      await api.download('/books/export.csv', { q: dq, status }, 'catalog.csv')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <div>
      <PageHeader
        title="Book catalog"
        description="Organisation-wide catalog. Stock and price shown for the selected location."
        actions={
          <>
            {can('catalog.import', 'reports.export') && <Button variant="secondary" onClick={exportCsv}><Download /> Export</Button>}
            {can('catalog.import') && <Button variant="secondary" asChild><Link to="/catalog/import"><Upload /> Import</Link></Button>}
            {can('catalog.create') && <Button asChild><Link to="/catalog/new"><Plus /> Add book</Link></Button>}
          </>
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <SearchInput value={q} onChange={setQ} placeholder="Title, author, ISBN, SKU, publisher…" className="w-full sm:w-80" />
          <NativeSelect aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} className="w-full sm:w-56">
            <option value="">All categories</option>
            {categoryOptions(cats.data).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </NativeSelect>
          <NativeSelect aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-full sm:w-40">
            <option value="">Active & discontinued</option>
            <option value="ACTIVE">Active</option>
            <option value="DISCONTINUED">Discontinued</option>
            <option value="ARCHIVED">Archived</option>
          </NativeSelect>
          <NativeSelect aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)} className="w-full sm:w-40">
            <option value="title">Title A–Z</option>
            <option value="-created">Newest first</option>
            <option value="price">Price low–high</option>
            <option value="-price">Price high–low</option>
          </NativeSelect>
        </div>
        <DataTable
          columns={cols}
          rows={query.data?.items}
          rowKey={(b) => b.id}
          loading={query.isFetching}
          error={query.error}
          onRetry={() => query.refetch()}
          onRowClick={(b) => navigate(`/catalog/${b.id}`)}
          page={page}
          pageSize={25}
          total={query.data?.total}
          onPageChange={setPage}
          empty={{ title: dq ? 'No books match your search' : 'No books yet', description: dq ? 'Try a different title, author or ISBN.' : 'Add your first book or import a CSV.' }}
        />
      </Card>
    </div>
  )
}
