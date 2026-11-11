import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, ArchiveRestore, Pencil, Save, Trash2, X } from 'lucide-react'
import * as React from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { BookSearch } from '@/components/common/BookSearch'
import { LocationSelect } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState, ErrorState, PageLoader } from '@/components/common/States'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { LIVE_REFRESH_MS } from '@/lib/queries'
import { formatINR } from '@/lib/utils'
import { SetsCell } from './SchoolDetailPage'
import { classLabel, type BookListDetail } from './types'

interface Draft { book_id: string; title: string; isbn13: string | null; author: string | null; qty_per_set: number }

export default function BookListPage() {
  const { id } = useParams()
  const [params, setParams] = useSearchParams()
  const { can } = useAuth()
  const qc = useQueryClient()
  const [locationId, setLocationId] = React.useState<string | null>(null)
  const q = useQuery({ queryKey: ['book-list', id, locationId], queryFn: () => api.get<BookListDetail>(`/book-lists/${id}`, { location_id: locationId }), refetchInterval: LIVE_REFRESH_MS })
  const [draft, setDraft] = React.useState<Draft[] | null>(null)
  const editing = draft !== null
  const startEdit = React.useCallback((d: BookListDetail) => {
    setDraft(d.items.map((i) => ({ book_id: i.book_id, title: i.title, isbn13: i.isbn13, author: i.author, qty_per_set: i.qty_per_set })))
  }, [])
  React.useEffect(() => {
    if (params.get('edit') === '1' && q.data && !editing) {
      startEdit(q.data)
      setParams({}, { replace: true })
    }
  }, [params, q.data, editing, startEdit, setParams])

  const refresh = () => {
    void q.refetch()
    void qc.invalidateQueries({ queryKey: ['school', q.data?.school.id] })
  }
  const save = useMutation({
    mutationFn: () => api.put(`/book-lists/${id}/items`, { items: draft!.map((d) => ({ book_id: d.book_id, qty_per_set: d.qty_per_set })) }),
    onSuccess: () => { toast.success('Book list saved'); setDraft(null); refresh() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const archive = useMutation({
    mutationFn: (active: boolean) => api.put(`/book-lists/${id}`, { academic_year: q.data!.academic_year, class_name: q.data!.class_name, is_active: active }),
    onSuccess: (_, active) => { toast.success(active ? 'List restored' : 'List archived'); refresh() },
    onError: (e) => toast.error(errorMessage(e)),
  })

  if (q.isLoading) return <PageLoader />
  if (!q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const d = q.data
  const manage = can('schools.manage')
  const title = `${classLabel(d.class_name)} · ${d.academic_year}`
  const setsFor = (locId: string) => d.sets.find((s) => s.location_id === locId)

  return (
    <div>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-3">{title}{!d.is_active && <Badge tone="warning">Archived</Badge>}</span>}
        description={d.school.name}
        crumbs={[{ label: 'Schools', to: '/schools' }, { label: d.school.code, to: `/schools/${d.school.id}` }, { label: classLabel(d.class_name) }]}
        actions={manage && !editing && <>
          <Button variant="secondary" loading={archive.isPending} onClick={() => archive.mutate(!d.is_active)}>
            {d.is_active ? <><Archive /> Archive</> : <><ArchiveRestore /> Restore</>}
          </Button>
          <Button onClick={() => startEdit(d)}><Pencil /> Edit books</Button>
        </>}
      />

      {!editing && (
        <>
          <div className="mb-4 flex justify-end"><LocationSelect value={locationId} onChange={setLocationId} /></div>
          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {d.locations.map((loc) => {
              const s = setsFor(loc.id)
              return (
                <Card key={loc.id} className="px-4 py-3">
                  <p className="text-xs text-muted">Complete sets · {loc.name}</p>
                  <p className={`num mt-1 text-2xl font-semibold ${s?.available === 0 ? 'text-danger' : ''}`}>{s?.available ?? '—'}</p>
                  {s && s.with_on_order !== null && s.available !== null && s.with_on_order > s.available &&
                    <p className="text-xs text-muted">{s.with_on_order} once orders arrive</p>}
                </Card>
              )
            })}
          </div>
          <Card>
            <CardHeader title={`${d.items.length} books per set`} description="Stock available for sale at each location. Red marks the book that limits the number of complete sets." />
            {d.items.length === 0
              ? <EmptyState title="No books on this list" description={manage ? 'Use Edit books to add the books the school prescribes.' : undefined} />
              : (
                <Table>
                  <THead><TR>
                    <TH>Book</TH><TH className="text-right">Per set</TH><TH className="hidden text-right md:table-cell">MRP</TH>
                    {d.locations.map((loc) => <TH key={loc.id} className="text-right">{loc.name}</TH>)}
                  </TR></THead>
                  <TBody>
                    {d.items.map((it) => (
                      <TR key={it.id}>
                        <TD>
                          <Link to={`/catalog/${it.book_id}`} className="font-medium hover:text-primary">{it.title}</Link>
                          <p className="text-xs text-muted">{[it.author, it.isbn13 ?? it.sku].filter(Boolean).join(' · ')}</p>
                          {it.book_status !== 'ACTIVE' && <Badge tone="warning">{it.book_status.toLowerCase()}</Badge>}
                        </TD>
                        <TD className="num text-right">{it.qty_per_set}</TD>
                        <TD className="num hidden text-right md:table-cell">{formatINR(it.mrp)}</TD>
                        {it.stock.map((st) => {
                          const limiting = setsFor(st.location_id)?.available === Math.floor(st.available / it.qty_per_set)
                          return (
                            <TD key={st.location_id} className="text-right">
                              <span className={`num ${limiting ? 'font-semibold text-danger' : ''}`}>{st.available}</span>
                              {st.on_order > 0 && <span className="block text-[11px] text-muted">+{st.on_order} on order</span>}
                            </TD>
                          )
                        })}
                      </TR>
                    ))}
                    <TR className="bg-surface">
                      <TD className="font-semibold">Complete sets</TD><TD /><TD className="hidden md:table-cell" />
                      {d.locations.map((loc) => <TD key={loc.id} className="text-right"><SetsCell s={setsFor(loc.id)} /></TD>)}
                    </TR>
                  </TBody>
                </Table>
              )}
          </Card>
        </>
      )}

      {editing && (
        <Card>
          <CardHeader title="Edit books" description="Add every book in one student set. Per set = copies of that book one student needs."
            actions={<>
              <Button variant="secondary" onClick={() => setDraft(null)}><X /> Cancel</Button>
              <Button loading={save.isPending} onClick={() => save.mutate()}><Save /> Save list</Button>
            </>} />
          <CardBody className="border-b border-border">
            <BookSearch placeholder="Add a book: search title, author, ISBN or scan…" onSelect={(b) => {
              if (draft!.some((x) => x.book_id === b.id)) { toast.info(`'${b.title}' is already on the list`); return }
              setDraft([...draft!, { book_id: b.id, title: b.title, isbn13: b.isbn13, author: b.authors[0] ?? null, qty_per_set: 1 }])
            }} />
          </CardBody>
          {draft!.length === 0
            ? <EmptyState title="No books yet" description="Search above to add books." />
            : (
              <Table>
                <THead><TR><TH>Book</TH><TH className="w-28 text-right">Per set</TH><TH className="w-12" /></TR></THead>
                <TBody>
                  {draft!.map((x, i) => (
                    <TR key={x.book_id}>
                      <TD><p className="font-medium">{x.title}</p><p className="text-xs text-muted">{[x.author ?? 'No author', x.isbn13].filter(Boolean).join(' · ')}</p></TD>
                      <TD className="text-right">
                        <Input type="number" min={1} max={50} aria-label={`Copies per set of ${x.title}`} className="ml-auto w-20 text-right" value={x.qty_per_set}
                          onChange={(e) => setDraft(draft!.map((y, j) => j === i ? { ...y, qty_per_set: Math.max(1, Math.min(50, Number(e.target.value) || 1)) } : y))} />
                      </TD>
                      <TD><Button variant="ghost" size="icon" aria-label={`Remove ${x.title}`} onClick={() => setDraft(draft!.filter((_, j) => j !== i))}><Trash2 /></Button></TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
        </Card>
      )}
    </div>
  )
}
