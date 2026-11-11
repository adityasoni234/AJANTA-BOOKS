import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileSpreadsheet, Mail, Plus } from 'lucide-react'
import * as React from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { DataTable } from '@/components/common/DataTable'
import { SearchInput } from '@/components/common/Filters'
import { PageHeader } from '@/components/common/PageHeader'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/input'
import { api, ApiError, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useDebounced } from '@/lib/hooks'
import type { School } from './types'

export default function SchoolsPage() {
  const { can } = useAuth()
  const navigate = useNavigate()
  const [q, setQ] = React.useState('')
  const [inactive, setInactive] = React.useState(false)
  const [open, setOpen] = React.useState(false)
  const dq = useDebounced(q)
  const list = useQuery({
    queryKey: ['schools', dq, inactive],
    queryFn: () => api.get<School[]>('/schools', { q: dq, include_inactive: inactive || undefined }),
    placeholderData: keepPreviousData,
  })
  const manage = can('schools.manage')
  return (
    <div>
      <PageHeader title="Schools" description="Schools with a book tie-up, their class book lists and how many complete sets are in stock."
        actions={manage && <>
          <Button variant="secondary" asChild><Link to="/schools/email-template"><Mail /> Order email template</Link></Button>
          <Button variant="secondary" asChild><Link to="/schools/import"><FileSpreadsheet /> Import Excel</Link></Button>
          <Button onClick={() => setOpen(true)}><Plus /> Add school</Button>
        </>} />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
          <SearchInput value={q} onChange={setQ} placeholder="School name or code…" />
          <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> Show inactive</label>
        </div>
        <DataTable
          rows={list.data}
          loading={list.isFetching}
          error={list.error}
          onRetry={() => list.refetch()}
          rowKey={(s) => s.id}
          onRowClick={(s) => navigate(`/schools/${s.id}`)}
          empty={{ title: 'No schools yet', description: manage ? 'Add a school, or import a school book list from Excel.' : undefined }}
          columns={[
            { key: 'n', header: 'School', cell: (s) => <><p className="font-medium">{s.name}</p><p className="text-xs text-muted">{s.code}</p></> },
            { key: 'c', header: 'City', hideBelow: 'md', cell: (s) => s.city ?? '—' },
            { key: 'p', header: 'Contact', hideBelow: 'lg', cell: (s) => <><p>{s.contact_person ?? '—'}</p><p className="text-xs text-muted">{s.phone ?? s.email ?? ''}</p></> },
            { key: 'l', header: 'Class lists', align: 'right', cell: (s) => s.lists ?? 0 },
            { key: 's', header: 'Status', cell: (s) => <StatusBadge status={s.is_active ? 'ACTIVE' : 'ARCHIVED'} label={s.is_active ? 'Active' : 'Inactive'} /> },
          ]}
        />
      </Card>
      <SchoolDialog open={open} onOpenChange={setOpen} onSaved={(s) => navigate(`/schools/${s.id}`)} />
    </div>
  )
}

const EMPTY = { code: '', name: '', city: '', contact_person: '', phone: '', email: '', notes: '', is_active: true }

export function SchoolDialog({ open, onOpenChange, school, onSaved }: {
  open: boolean; onOpenChange: (o: boolean) => void; school?: School; onSaved?: (s: School) => void
}) {
  const qc = useQueryClient()
  const [f, setF] = React.useState(EMPTY)
  const [errs, setErrs] = React.useState<Record<string, string>>({})
  React.useEffect(() => {
    if (!open) return
    setErrs({})
    setF(school ? { code: school.code, name: school.name, city: school.city ?? '', contact_person: school.contact_person ?? '', phone: school.phone ?? '',
      email: school.email ?? '', notes: school.notes ?? '', is_active: school.is_active } : EMPTY)
  }, [open, school])
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value })
  const save = useMutation({
    mutationFn: () => {
      const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v === '' ? null : v]))
      return school ? api.put<School>(`/schools/${school.id}`, body) : api.post<School>('/schools', body)
    },
    onSuccess: (s) => {
      toast.success('School saved')
      onOpenChange(false)
      void qc.invalidateQueries({ queryKey: ['schools'] })
      void qc.invalidateQueries({ queryKey: ['school', s.id] })
      onSaved?.(s)
    },
    onError: (e) => { if (e instanceof ApiError) setErrs(e.fieldErrors()); toast.error(errorMessage(e)) },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" title={school ? 'Edit school' : 'Add school'}
        footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={f.code.trim().length < 2 || f.name.trim().length < 2} loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" required error={errs.code} hint="Short code used in Excel imports, e.g. MMPS"><Input value={f.code} maxLength={20} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="City"><Input value={f.city} onChange={set('city')} /></Field>
          <Field label="School name" required error={errs.name} className="sm:col-span-2"><Input value={f.name} onChange={set('name')} /></Field>
          <Field label="Contact person"><Input value={f.contact_person} onChange={set('contact_person')} /></Field>
          <Field label="Phone"><Input value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Email" error={errs.email} className="sm:col-span-2"><Input type="email" value={f.email} onChange={set('email')} /></Field>
          <Field label="Notes" className="sm:col-span-2"><Textarea rows={2} value={f.notes} onChange={set('notes')} /></Field>
          {school && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Active</label>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
