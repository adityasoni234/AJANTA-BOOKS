import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as React from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { DataTable } from '@/components/common/DataTable'
import { SearchInput } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { api, ApiError, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useDebounced } from '@/lib/hooks'

interface Author { id: string; name: string; email: string | null; phone: string | null; books: number | null; supplier_id: string | null; supplier_code: string | null }

export default function AuthorsPage() {
  const { can } = useAuth()
  const [params] = useSearchParams()
  const [q, setQ] = React.useState(params.get('q') ?? '')
  const [missing, setMissing] = React.useState(false)
  const [edit, setEdit] = React.useState<Author | null>(null)
  const dq = useDebounced(q)
  const list = useQuery({
    queryKey: ['authors', dq, missing],
    queryFn: () => api.get<Author[]>('/authors', { q: dq, missing_email: missing || undefined, limit: 200 }),
    placeholderData: keepPreviousData,
  })
  const canEdit = can('catalog.master_data') || can('schools.manage')
  return (
    <div>
      <PageHeader title="Authors" description="School-book order emails go to a book's first author, so each author needs an email address."
        crumbs={[{ label: 'Catalog', to: '/catalog' }, { label: 'Authors' }]} />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
          <SearchInput value={q} onChange={setQ} placeholder="Author name or email…" />
          <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={missing} onChange={(e) => setMissing(e.target.checked)} /> Missing email only</label>
        </div>
        <DataTable
          rows={list.data}
          loading={list.isFetching}
          error={list.error}
          onRetry={() => list.refetch()}
          rowKey={(a) => a.id}
          onRowClick={canEdit ? setEdit : undefined}
          empty={{ title: 'No authors found' }}
          columns={[
            { key: 'n', header: 'Author', cell: (a) => <span className="font-medium">{a.name}</span> },
            { key: 'e', header: 'Email', cell: (a) => a.email ? <span className="break-all">{a.email}</span> : <Badge tone="warning">No email</Badge> },
            { key: 'p', header: 'Phone', hideBelow: 'md', cell: (a) => a.phone ?? '—' },
            { key: 'b', header: 'Books', align: 'right', cell: (a) => a.books ?? 0 },
            { key: 's', header: 'Supplier account', hideBelow: 'lg', cell: (a) => a.supplier_code ?? <span className="text-muted">Created on first order</span> },
            ...(canEdit ? [{ key: 'x', header: '', align: 'right' as const, cell: (a: Author) => <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); setEdit(a) }}>Edit</Button> }] : []),
          ]}
        />
      </Card>
      <AuthorDialog author={edit} onClose={() => setEdit(null)} />
    </div>
  )
}

function AuthorDialog({ author, onClose }: { author: Author | null; onClose: () => void }) {
  const qc = useQueryClient()
  const [email, setEmail] = React.useState('')
  const [phone, setPhone] = React.useState('')
  const [errs, setErrs] = React.useState<Record<string, string>>({})
  React.useEffect(() => { if (author) { setEmail(author.email ?? ''); setPhone(author.phone ?? ''); setErrs({}) } }, [author])
  const save = useMutation({
    mutationFn: () => api.put(`/authors/${author!.id}`, { email: email.trim() || null, phone: phone.trim() || null }),
    onSuccess: () => { toast.success('Author saved'); void qc.invalidateQueries({ queryKey: ['authors'] }); onClose() },
    onError: (e) => { if (e instanceof ApiError) setErrs(e.fieldErrors()); toast.error(errorMessage(e)) },
  })
  return (
    <Dialog open={author !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm" title={author?.name ?? ''}
        footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
        <div className="grid gap-4">
          <Field label="Email" error={errs.email} hint="Order emails are addressed here"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></Field>
          <Field label="Phone"><Input value={phone} maxLength={30} onChange={(e) => setPhone(e.target.value)} /></Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
