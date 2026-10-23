import { useMutation } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { BookSearch } from '@/components/common/BookSearch'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState } from '@/components/common/States'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input'
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useLocationDirectory } from '@/lib/queries'
import type { Book } from '@/lib/types'
import type { Transfer } from './types'

export default function TransferNewPage() {
  const { me, locationId } = useAuth()
  const navigate = useNavigate()
  const dir = useLocationDirectory()
  const all = React.useMemo(() => dir.data ?? [], [dir.data])
  const warehouse = all.find((l) => l.type === 'WAREHOUSE')
  const myLocs = new Set(me?.locations.map((l) => l.id))
  const [source, setSource] = React.useState('')
  const [dest, setDest] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [lines, setLines] = React.useState<{ book: Book; qty: string }[]>([])
  React.useEffect(() => {
    if (!all.length || source || dest) return
    const mine = locationId ? all.find((l) => l.id === locationId) : undefined
    if (mine && mine.type === 'OUTLET') {
      setDest(mine.id)
      setSource(warehouse?.id ?? '')
    } else {
      setSource(mine?.id ?? warehouse?.id ?? '')
    }
  }, [all, locationId, warehouse, source, dest])
  const sourceOk = me?.all_locations || myLocs.has(source) || myLocs.has(dest)
  const create = useMutation({
    mutationFn: (submit: boolean) => api.post<Transfer>('/transfers', {
      source_location_id: source, dest_location_id: dest, notes: notes || null, submit,
      lines: lines.map((l) => ({ book_id: l.book.id, qty: Number(l.qty) })),
    }),
    onSuccess: (t) => { toast.success(`${t.number} ${t.status === 'DRAFT' ? 'saved as draft' : t.status === 'APPROVED' ? 'approved and ready to dispatch' : 'submitted for approval'}`); navigate(`/transfers/${t.id}`) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const valid = source && dest && source !== dest && lines.length > 0 && lines.every((l) => Number(l.qty) > 0) && sourceOk
  return (
    <div className="max-w-4xl">
      <PageHeader title="New stock transfer" crumbs={[{ label: 'Transfers', to: '/transfers' }, { label: 'New' }]} />
      <Card className="mb-4">
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="From (source)" required>
            <NativeSelect value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">Choose…</option>
              {all.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </NativeSelect>
          </Field>
          <Field label="To (destination)" required error={source && dest && source === dest ? 'Choose a different destination' : undefined}>
            <NativeSelect value={dest} onChange={(e) => setDest(e.target.value)}>
              <option value="">Choose…</option>
              {all.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </NativeSelect>
          </Field>
          {!sourceOk && source && dest && <p className="text-sm text-danger sm:col-span-2">You must belong to the source or destination location.</p>}
          <Field label="Notes" className="sm:col-span-2"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Items" description="Availability shown is at the source location." />
        <CardBody>
          <BookSearch locationId={source && myLocs.has(source) ? source : null} onSelect={(b) => setLines((ls) => ls.some((x) => x.book.id === b.id) ? ls : [...ls, { book: b, qty: '1' }])} />
        </CardBody>
        {lines.length === 0 ? <EmptyState title="No items added" description="Search or scan books to add them." /> : (
          <Table>
            <THead><TR><TH>Book</TH><TH className="text-right">Available at source</TH><TH className="text-right">Quantity</TH><TH /></TR></THead>
            <TBody>
              {lines.map((l, i) => (
                <TR key={l.book.id}>
                  <TD><p className="font-medium">{l.book.title}</p><p className="text-xs text-muted">{l.book.isbn13 ?? l.book.sku}</p></TD>
                  <TD className="num text-right">{l.book.stock_available ?? '—'}</TD>
                  <TD className="text-right"><Input aria-label={`Quantity for ${l.book.title}`} className="ml-auto w-24 text-right" inputMode="numeric" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} /></TD>
                  <TD className="w-10"><Button variant="ghost" size="icon" aria-label="Remove" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 /></Button></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" disabled={!valid} loading={create.isPending && create.variables === false} onClick={() => create.mutate(false)}>Save draft</Button>
        <Button disabled={!valid} loading={create.isPending && create.variables === true} onClick={() => create.mutate(true)}>Submit request</Button>
      </div>
    </div>
  )
}
