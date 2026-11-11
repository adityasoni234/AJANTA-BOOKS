import { useMutation, useQuery } from '@tanstack/react-query'
import { Pencil, Plus, ShoppingBag } from 'lucide-react'
import * as React from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { DataTable } from '@/components/common/DataTable'
import { LocationSelect } from '@/components/common/Filters'
import { DeleteButton } from '@/components/common/DeleteButton'
import { PageHeader } from '@/components/common/PageHeader'
import { ErrorState, PageLoader } from '@/components/common/States'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { api, ApiError, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { LIVE_REFRESH_MS } from '@/lib/queries'
import { formatDate } from '@/lib/utils'
import { SchoolDialog } from './SchoolsPage'
import { classLabel, currentAcademicYear, type ListSummary, type SchoolDetail, type SetsAt } from './types'

export function SetsCell({ s }: { s: SetsAt | undefined }) {
  if (!s || s.available === null) return <span className="text-muted">—</span>
  const extra = (s.with_on_order ?? 0) - s.available
  return (
    <span className="inline-flex flex-col items-end">
      <span className={`num font-semibold ${s.available === 0 ? 'text-danger' : ''}`}>{s.available}</span>
      {extra > 0 && <span className="text-[11px] text-muted">+{extra} on order</span>}
    </span>
  )
}

export default function SchoolDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { can } = useAuth()
  const [locationId, setLocationId] = React.useState<string | null>(null)
  const [archived, setArchived] = React.useState(false)
  const [edit, setEdit] = React.useState(false)
  const [addClass, setAddClass] = React.useState(false)
  const q = useQuery({
    queryKey: ['school', id, locationId, archived],
    queryFn: () => api.get<SchoolDetail>(`/schools/${id}`, { location_id: locationId, include_archived: archived || undefined }),
    refetchInterval: LIVE_REFRESH_MS,
  })
  if (q.isLoading) return <PageLoader />
  if (!q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const { school, locations, lists, orders } = q.data
  const manage = can('schools.manage')
  return (
    <div>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-3">{school.name} <Badge>{school.code}</Badge>{!school.is_active && <Badge tone="warning">Inactive</Badge>}</span>}
        description={[school.city, school.contact_person, school.phone].filter(Boolean).join(' · ') || undefined}
        crumbs={[{ label: 'Schools', to: '/schools' }, { label: school.code }]}
        actions={manage && <>
          <Button variant="secondary" onClick={() => setEdit(true)}><Pencil /> Edit</Button>
          <DeleteButton path={`/schools/${school.id}`} what="school" onDeleted={() => navigate('/schools')} />
          <Button variant="secondary" onClick={() => setAddClass(true)}><Plus /> Add class</Button>
          {can('purchasing.create') && (school.is_active && lists.some((l) => l.is_active && l.books > 0)
            ? <Button asChild><Link to={`/schools/${school.id}/order`}><ShoppingBag /> Order books</Link></Button>
            : <Button disabled title="Needs an active school with at least one class list"><ShoppingBag /> Order books</Button>)}
        </>}
      />
      <Card className="mb-6">
        <CardHeader title="Class book lists" description="Numbers per location are complete sets in stock: how many full sets the stock can make up (limited by the scarcest book)."
          actions={<div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Archived</label>
            <LocationSelect value={locationId} onChange={setLocationId} />
          </div>} />
        <DataTable<ListSummary>
          rows={lists}
          loading={q.isFetching}
          rowKey={(l) => l.id}
          onRowClick={(l) => navigate(`/schools/lists/${l.id}`)}
          empty={{ title: 'No class lists yet', description: manage ? 'Add a class, or import the school\'s list from Excel.' : undefined }}
          columns={[
            { key: 'c', header: 'Class', cell: (l) => <><p className="whitespace-nowrap font-medium">{classLabel(l.class_name)}</p>{!l.is_active && <Badge tone="warning">Archived</Badge>}</> },
            { key: 'y', header: 'Year', cell: (l) => <span className="whitespace-nowrap">{l.academic_year}</span> },
            { key: 'b', header: 'Books', align: 'right', cell: (l) => l.books },
            ...locations.map((loc) => ({
              key: loc.id, align: 'right' as const,
              header: <span title={`Complete sets at ${loc.name}`}>{loc.name}</span>,
              cell: (l: ListSummary) => <SetsCell s={l.sets.find((s) => s.location_id === loc.id)} />,
            })),
          ]}
        />
      </Card>
      {can('purchasing.view') && (
        <Card>
          <CardHeader title="School orders" description="Each order raised purchase orders to the authors for the chosen classes." />
          <DataTable
            rows={orders}
            rowKey={(o) => o.id}
            onRowClick={(o) => navigate(`/schools/orders/${o.id}`)}
            empty={{ title: 'No orders yet' }}
            columns={[
              { key: 'n', header: 'Order', cell: (o) => <><p className="font-medium">{o.number}</p><p className="text-xs text-muted">{formatDate(o.created_at, true)}</p></> },
              { key: 'c', header: 'Classes', cell: (o) => o.classes.map((c) => `${classLabel(c.class_name)} × ${c.sets}`).join(', ') },
              { key: 'l', header: 'Deliver to', hideBelow: 'md', cell: (o) => o.location_name },
              { key: 'u', header: 'By', hideBelow: 'lg', cell: (o) => o.created_by_name ?? '—' },
            ]}
          />
        </Card>
      )}
      <SchoolDialog open={edit} onOpenChange={setEdit} school={school} onSaved={() => void q.refetch()} />
      <AddClassDialog schoolId={school.id} open={addClass} onOpenChange={setAddClass} onCreated={(listId) => navigate(`/schools/lists/${listId}?edit=1`)} />
    </div>
  )
}

function AddClassDialog({ schoolId, open, onOpenChange, onCreated }: { schoolId: string; open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void }) {
  const [year, setYear] = React.useState(currentAcademicYear())
  const [cls, setCls] = React.useState('')
  const [errs, setErrs] = React.useState<Record<string, string>>({})
  React.useEffect(() => { if (open) { setCls(''); setErrs({}) } }, [open])
  const save = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/schools/${schoolId}/lists`, { academic_year: year, class_name: cls }),
    onSuccess: (r) => { onOpenChange(false); onCreated(r.id) },
    onError: (e) => { if (e instanceof ApiError) setErrs(e.fieldErrors()); toast.error(errorMessage(e)) },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" title="Add class list"
        footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={!cls.trim()} loading={save.isPending} onClick={() => save.mutate()}>Create and add books</Button></>}>
        <div className="grid gap-4">
          <Field label="Class" required error={errs.class_name} hint="e.g. 11, 12 Science"><Input value={cls} maxLength={40} onChange={(e) => setCls(e.target.value)} autoFocus /></Field>
          <Field label="Academic year" required error={errs.academic_year}><Input value={year} maxLength={9} onChange={(e) => setYear(e.target.value)} /></Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
