import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, Calculator, Send } from 'lucide-react'
import * as React from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { LocationSelect } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState, ErrorState, PageLoader } from '@/components/common/States'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input'
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useIdempotencyKey } from '@/lib/hooks'
import { formatINR } from '@/lib/utils'
import { classLabel, type OrderLine, type OrderPreview, type SchoolDetail, type SchoolOrder } from './types'

interface Edit { qty: string; unit_cost: string }

export default function SchoolOrderNewPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { me } = useAuth()
  const idem = useIdempotencyKey()
  const school = useQuery({ queryKey: ['school', id, 'order-setup'], queryFn: () => api.get<SchoolDetail>(`/schools/${id}`) })
  const lists = React.useMemo(() => (school.data?.lists ?? []).filter((l) => l.is_active && l.books > 0), [school.data])
  const years = React.useMemo(() => [...new Set(lists.map((l) => l.academic_year))].sort().reverse(), [lists])
  const [year, setYear] = React.useState<string | null>(null)
  const [locationId, setLocationId] = React.useState<string | null>(null)
  const [sets, setSets] = React.useState<Record<string, string>>({})
  const [preview, setPreview] = React.useState<OrderPreview | null>(null)
  const [edits, setEdits] = React.useState<Record<string, Edit>>({})
  const [notes, setNotes] = React.useState('')
  const [expected, setExpected] = React.useState('')

  React.useEffect(() => { if (!year && years.length) setYear(years[0]) }, [year, years])
  React.useEffect(() => {
    if (!locationId && me?.locations.length) setLocationId((me.locations.find((l) => l.type === 'WAREHOUSE') ?? me.locations[0]).id)
  }, [locationId, me])

  const yearLists = lists.filter((l) => l.academic_year === year)
  const chosen = yearLists.filter((l) => Number(sets[l.id]) > 0).map((l) => ({ list_id: l.id, sets: Number(sets[l.id]) }))
  const scope = { school_id: id, location_id: locationId, classes: chosen }
  const scopeKey = JSON.stringify(scope)
  const lastScope = React.useRef('')
  React.useEffect(() => { if (preview && scopeKey !== lastScope.current) setPreview(null) }, [scopeKey, preview])

  const calc = useMutation({
    mutationFn: () => api.post<OrderPreview>('/school-orders/preview', scope),
    onSuccess: (p) => {
      lastScope.current = scopeKey
      setPreview(p)
      setEdits(Object.fromEntries(p.lines.map((l) => [l.book_id, { qty: String(l.suggested), unit_cost: l.unit_cost ?? '' }])))
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const create = useMutation({
    mutationFn: () => api.post<SchoolOrder>('/school-orders', {
      ...scope, notes: notes || null, expected_date: expected || null,
      lines: preview!.lines.map((l) => ({ book_id: l.book_id, qty: Number(edits[l.book_id].qty || 0), unit_cost: edits[l.book_id].unit_cost || '0' })),
    }, { idempotencyKey: idem.key }),
    onSuccess: (o) => { idem.reset(); toast.success(`${o.number}: ${o.purchase_orders.length} purchase order${o.purchase_orders.length === 1 ? '' : 's'} raised`); navigate(`/schools/orders/${o.id}`) },
    onError: (e) => toast.error(errorMessage(e)),
  })

  if (school.isLoading) return <PageLoader />
  if (!school.data) return <ErrorState error={school.error} onRetry={() => school.refetch()} />
  const s = school.data.school

  const ordered = (preview?.lines ?? []).filter((l) => Number(edits[l.book_id]?.qty) > 0)
  const blocking = ordered.filter((l) => l.problems.length > 0)
  const missingCost = ordered.filter((l) => edits[l.book_id].unit_cost === '' || Number.isNaN(Number(edits[l.book_id].unit_cost)))
  const groups = new Map<string, OrderLine[]>()
  for (const l of preview?.lines ?? []) groups.set(l.author_name ?? 'No author', [...(groups.get(l.author_name ?? 'No author') ?? []), l])
  const lineValue = (l: OrderLine) => Number(edits[l.book_id]?.qty || 0) * Number(edits[l.book_id]?.unit_cost || 0)
  const total = ordered.reduce((a, l) => a + lineValue(l), 0)
  const set = (bookId: string, k: keyof Edit, v: string) => setEdits({ ...edits, [bookId]: { ...edits[bookId], [k]: v } })

  return (
    <div>
      <PageHeader title={`Order books for ${s.name}`} description="Raises one purchase order per author. Receiving those orders adds the stock that makes up the sets."
        crumbs={[{ label: 'Schools', to: '/schools' }, { label: s.code, to: `/schools/${s.id}` }, { label: 'Order books' }]} />
      <Card className="mb-6">
        <CardHeader title="1. Classes and number of sets" />
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Deliver to" required><LocationSelect value={locationId} onChange={setLocationId} allowAll={false} className="w-full" label="Deliver to" /></Field>
            <Field label="Academic year" required>
              <NativeSelect value={year ?? ''} onChange={(e) => { setYear(e.target.value); setSets({}) }}>
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
              </NativeSelect>
            </Field>
          </div>
          {yearLists.length === 0
            ? <EmptyState title="No class lists with books" description="Add books to a class list first." />
            : (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {yearLists.map((l) => (
                  <label key={l.id} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                    <span className="text-sm"><b>{classLabel(l.class_name)}</b> <span className="text-muted">· {l.books} books</span></span>
                    <span className="flex items-center gap-2 text-sm text-muted">
                      <Input type="number" min={0} max={100000} inputMode="numeric" aria-label={`Sets for ${classLabel(l.class_name)}`} className="w-24 text-right"
                        placeholder="0" value={sets[l.id] ?? ''} onChange={(e) => setSets({ ...sets, [l.id]: e.target.value })} /> sets
                    </span>
                  </label>
                ))}
              </div>
            )}
          <Button disabled={!locationId || chosen.length === 0} loading={calc.isPending} onClick={() => calc.mutate()}><Calculator /> Calculate quantities</Button>
        </CardBody>
      </Card>

      {preview && (
        <Card>
          <CardHeader title="2. Review the order"
            description={`Suggested = copies needed − stock at ${preview.location.name} − already on order. Change any quantity; 0 leaves the book out.`} />
          <Table>
            <THead><TR>
              <TH>Book</TH><TH className="text-right">Needed</TH><TH className="text-right">In stock</TH><TH className="text-right">On order</TH>
              <TH className="w-28 text-right">Order qty</TH><TH className="w-32 text-right">Unit cost ₹</TH><TH className="hidden text-right md:table-cell">Value</TH>
            </TR></THead>
            <TBody>
              {[...groups.entries()].map(([author, lines]) => {
                const first = lines[0]
                return (
                  <React.Fragment key={author}>
                    <TR className="bg-surface">
                      <TD colSpan={7} className="py-2">
                        <span className="font-semibold">{author}</span>
                        <span className="ml-2 text-xs text-muted">{first.author_email ?? (first.author_id ? 'no email address' : '')}</span>
                        {first.author_id && !first.author_email && <Link to={`/catalog/authors?q=${encodeURIComponent(author)}`} className="ml-2 text-xs font-medium text-primary hover:underline">Add email</Link>}
                      </TD>
                    </TR>
                    {lines.map((l) => (
                      <TR key={l.book_id}>
                        <TD>
                          <p className="font-medium">{l.title}</p>
                          <p className="text-xs text-muted">{[l.isbn13 ?? l.sku, l.classes.map(classLabel).join(', ')].join(' · ')}</p>
                          {l.problems.map((p) => <p key={p} className="flex items-center gap-1 text-xs text-danger"><AlertTriangle className="size-3" />{p}</p>)}
                        </TD>
                        <TD className="num text-right">{l.required}</TD>
                        <TD className="num text-right">{l.available}</TD>
                        <TD className="num text-right">{l.on_order}</TD>
                        <TD className="text-right"><Input type="number" min={0} inputMode="numeric" aria-label={`Order quantity for ${l.title}`} className="ml-auto w-24 text-right"
                          value={edits[l.book_id]?.qty ?? ''} onChange={(e) => set(l.book_id, 'qty', e.target.value)} /></TD>
                        <TD className="text-right"><Input inputMode="decimal" aria-label={`Unit cost for ${l.title}`} className="ml-auto w-28 text-right"
                          value={edits[l.book_id]?.unit_cost ?? ''} placeholder="Required" onChange={(e) => set(l.book_id, 'unit_cost', e.target.value)} /></TD>
                        <TD className="num hidden text-right md:table-cell">{formatINR(lineValue(l))}</TD>
                      </TR>
                    ))}
                  </React.Fragment>
                )
              })}
            </TBody>
          </Table>
          <CardBody className="grid gap-4 border-t border-border sm:grid-cols-2">
            <Field label="Expected delivery"><Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
            <Field label="Notes (internal)"><Textarea rows={2} value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} /></Field>
          </CardBody>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-4">
            <div className="text-sm">
              <p><b>{ordered.length}</b> books · <b>{ordered.reduce((a, l) => a + Number(edits[l.book_id].qty), 0)}</b> copies · <b>{new Set(ordered.map((l) => l.author_id)).size}</b> purchase orders · <span className="num font-semibold">{formatINR(total)}</span> before GST</p>
              {blocking.length > 0 && <p className="text-danger">Fix the problems marked in red (or set those quantities to 0) before ordering.</p>}
              {missingCost.length > 0 && <p className="text-danger">Enter a unit cost for every book you order.</p>}
            </div>
            <Button disabled={ordered.length === 0 || blocking.length > 0 || missingCost.length > 0} loading={create.isPending} onClick={() => create.mutate()}>
              <Send /> Create purchase orders
            </Button>
          </div>
        </Card>
      )}
    </div>
  )
}
