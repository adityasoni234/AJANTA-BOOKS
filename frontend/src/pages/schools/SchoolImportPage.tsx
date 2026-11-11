import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Download, FileUp, XCircle } from 'lucide-react'
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { DataTable } from '@/components/common/DataTable'
import { PageHeader } from '@/components/common/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { api, ApiError, errorMessage } from '@/lib/api'
import { classLabel } from './types'

interface PreviewRow {
  row: number; school_code: string; academic_year: string; class_name: string; title: string; author: string; isbn13: string | null
  qty_per_set: number; action: 'MATCHED' | 'NEW_BOOK' | null; book_title: string | null; book_sku: string | null; errors: string[]; warnings: string[]
}
interface Preview {
  valid: number; invalid: number; new_books: number; rows: PreviewRow[]
  schools: { code: string; name: string; action: 'CREATE' | 'EXISTING' }[]
  lists: { school_code: string; academic_year: string; class_name: string; books: number; action: 'CREATE' | 'REPLACE'; current_books: number }[]
  author_emails: { author: string; email: string; current: string | null; action: 'SET' | 'UPDATE' | 'UNCHANGED' }[]
}
interface Committed { schools_created: number; lists: number; books_created: number; rows: number }

function columnProblem(e: unknown): string | null {
  if (!(e instanceof ApiError) || !e.details || typeof e.details !== 'object' || Array.isArray(e.details)) return null
  const d = e.details as { unknown_columns?: string[]; missing_columns?: string[] }
  const parts = []
  if (d.missing_columns?.length) parts.push(`Missing: ${d.missing_columns.join(', ')}`)
  if (d.unknown_columns?.length) parts.push(`Not recognised: ${d.unknown_columns.join(', ')}`)
  return parts.length ? parts.join('. ') : null
}

export default function SchoolImportPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [file, setFile] = React.useState<File | null>(null)
  const [preview, setPreview] = React.useState<Preview | null>(null)
  const [onlyIssues, setOnlyIssues] = React.useState(false)
  const [fileError, setFileError] = React.useState<string | null>(null)
  const send = <T,>(path: string) => {
    const fd = new FormData()
    fd.append('file', file!)
    return api.post<T>(path, fd)
  }
  const validate = useMutation({
    mutationFn: () => send<Preview>('/book-lists/import/preview'),
    onSuccess: (p) => { setPreview(p); setFileError(null); setOnlyIssues(p.invalid > 0) },
    onError: (e) => { setPreview(null); setFileError([errorMessage(e), columnProblem(e)].filter(Boolean).join('. ')) },
  })
  const commit = useMutation({
    mutationFn: () => send<Committed>('/book-lists/import/commit'),
    onSuccess: (r) => {
      toast.success(`Imported ${r.lists} class list${r.lists === 1 ? '' : 's'}${r.books_created ? `, ${r.books_created} new books added to the catalog` : ''}`)
      void qc.invalidateQueries({ queryKey: ['schools'] })
      navigate('/schools')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const rows = preview ? (onlyIssues ? preview.rows.filter((r) => r.errors.length || r.warnings.length) : preview.rows) : []
  return (
    <div className="max-w-6xl">
      <PageHeader title="Import school book lists" description="Upload the school's list as an Excel file. One row per book per class."
        crumbs={[{ label: 'Schools', to: '/schools' }, { label: 'Import' }]}
        actions={<Button variant="secondary" onClick={() => api.download('/book-lists/import/template', undefined, 'school_book_list_template.xlsx')}><Download /> Excel template</Button>} />
      <Card className="mb-6">
        <CardHeader title="1. Choose the Excel file"
          description="Use the template's columns. Books are matched to the catalog by ISBN (or exact title + author); books not in the catalog are added. Nothing is saved until you confirm." />
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-border-strong px-4 py-3 text-sm hover:bg-surface">
              <FileUp className="size-4 text-muted" />
              {file ? file.name : 'Select .xlsx file'}
              <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only"
                onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setFileError(null) }} />
            </label>
            <Button disabled={!file} loading={validate.isPending} onClick={() => validate.mutate()}>Check file</Button>
          </div>
          {fileError && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-red-800">{fileError}</p>}
        </CardBody>
      </Card>

      {preview && (
        <>
          <div className="mb-6 grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader title="Schools" />
              <CardBody className="space-y-1.5 text-sm">
                {preview.schools.map((s) => (
                  <p key={s.code} className="flex items-center justify-between gap-2"><span><b>{s.code}</b> {s.name}</span>
                    <Badge tone={s.action === 'CREATE' ? 'primary' : 'neutral'}>{s.action === 'CREATE' ? 'New' : 'Existing'}</Badge></p>
                ))}
                {preview.schools.length === 0 && <p className="text-muted">None (all rows have errors)</p>}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Class lists" />
              <CardBody className="space-y-1.5 text-sm">
                {preview.lists.map((l) => (
                  <p key={`${l.school_code}-${l.academic_year}-${l.class_name}`} className="flex items-center justify-between gap-2">
                    <span>{l.school_code} · {classLabel(l.class_name)} · {l.academic_year} — {l.books} books</span>
                    {l.action === 'CREATE' ? <Badge tone="primary">New</Badge> : <Badge tone="warning">Replaces {l.current_books}</Badge>}
                  </p>
                ))}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Catalog & authors" />
              <CardBody className="space-y-1.5 text-sm">
                <p>{preview.new_books} new book{preview.new_books === 1 ? '' : 's'} will be added to the catalog</p>
                {preview.author_emails.filter((a) => a.action !== 'UNCHANGED').map((a) => (
                  <p key={a.author} className="break-words"><b>{a.author}</b>: {a.action === 'UPDATE' ? <>{a.current} → {a.email}</> : a.email}</p>
                ))}
              </CardBody>
            </Card>
          </div>
          <Card>
            <CardHeader
              title="2. Review rows"
              description={`${preview.valid} ready · ${preview.invalid} with errors`}
              actions={<>
                <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} /> Only rows with issues</label>
                <Button disabled={preview.invalid > 0} loading={commit.isPending} onClick={() => commit.mutate()}>Import {preview.valid} rows</Button>
              </>}
            />
            {preview.invalid > 0 && <CardBody className="border-b border-border text-sm text-danger">Fix the rows marked with errors in Excel and check the file again. Nothing has been imported.</CardBody>}
            <DataTable
              rows={rows}
              rowKey={(r) => String(r.row)}
              dense
              empty={{ title: 'No rows with issues' }}
              columns={[
                { key: 'r', header: 'Row', cell: (r) => r.row },
                { key: 's', header: '', cell: (r) => r.errors.length ? <XCircle className="size-4 text-danger" aria-label="Error" /> : <CheckCircle2 className="size-4 text-success" aria-label="Ready" /> },
                { key: 'c', header: 'Class', cell: (r) => <span className="whitespace-nowrap">{r.school_code} · {r.class_name}</span> },
                { key: 't', header: 'Book', cell: (r) => <><p className="font-medium">{r.title}</p><p className="text-xs text-muted">{[r.author, r.isbn13].filter(Boolean).join(' · ')}{r.qty_per_set > 1 ? ` · ${r.qty_per_set} per set` : ''}</p></> },
                { key: 'a', header: 'Catalog', cell: (r) => r.action === 'MATCHED' ? <Badge tone="success" title={r.book_title ?? undefined}>Matched {r.book_sku}</Badge> : r.action === 'NEW_BOOK' ? <Badge tone="primary">New book</Badge> : '—' },
                { key: 'e', header: 'Issues', cell: (r) => (
                  <div className="space-y-0.5">
                    {r.errors.map((e) => <p key={e} className="text-xs text-danger">{e}</p>)}
                    {r.warnings.map((w) => <p key={w} className="text-xs text-amber-700">{w}</p>)}
                  </div>
                ) },
              ]}
            />
          </Card>
        </>
      )}
    </div>
  )
}
