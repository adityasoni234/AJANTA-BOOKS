import { useMutation } from '@tanstack/react-query'
import { CheckCircle2, Download, FileUp, XCircle } from 'lucide-react'
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { DataTable } from '@/components/common/DataTable'
import { PageHeader } from '@/components/common/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { api, errorMessage } from '@/lib/api'

interface PreviewRow { row: number; title: string | null; isbn13: string | null; errors: string[]; warnings: string[] }
interface Preview { rows: PreviewRow[]; valid: number; invalid: number }

export default function ImportPage() {
  const navigate = useNavigate()
  const [file, setFile] = React.useState<File | null>(null)
  const [preview, setPreview] = React.useState<Preview | null>(null)
  const send = (path: string) => {
    const fd = new FormData()
    fd.append('file', file!)
    return api.post<Preview & { created?: number }>(path, fd)
  }
  const validate = useMutation({ mutationFn: () => send('/books/import/preview'), onSuccess: setPreview, onError: (e) => toast.error(errorMessage(e)) })
  const commit = useMutation({
    mutationFn: () => send('/books/import/commit'),
    onSuccess: (r) => { toast.success(`${r.created} books imported`); navigate('/catalog') },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <div className="max-w-5xl">
      <PageHeader title="Import books from CSV" crumbs={[{ label: 'Catalog', to: '/catalog' }, { label: 'Import' }]}
        actions={<Button variant="secondary" onClick={() => api.download('/books/import/template', undefined, 'book_import_template.csv')}><Download /> Template</Button>} />
      <Card className="mb-6">
        <CardHeader title="1. Choose file" description="UTF-8 CSV, up to 5,000 rows. Authors and tags are separated with semicolons. Imports are all-or-nothing." />
        <CardBody className="flex flex-wrap items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-border-strong px-4 py-3 text-sm hover:bg-surface">
            <FileUp className="size-4 text-muted" />
            {file ? file.name : 'Select CSV file'}
            <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null) }} />
          </label>
          <Button disabled={!file} loading={validate.isPending} onClick={() => validate.mutate()}>Validate</Button>
        </CardBody>
      </Card>
      {preview && (
        <Card>
          <CardHeader
            title="2. Review"
            description={`${preview.valid} valid · ${preview.invalid} with errors`}
            actions={<Button disabled={preview.invalid > 0 || preview.valid === 0} loading={commit.isPending} onClick={() => commit.mutate()}>Import {preview.valid} books</Button>}
          />
          <DataTable
            rows={preview.rows}
            rowKey={(r) => String(r.row)}
            dense
            columns={[
              { key: 'r', header: 'Row', cell: (r) => r.row },
              { key: 's', header: '', cell: (r) => r.errors.length ? <XCircle className="size-4 text-danger" aria-label="Error" /> : <CheckCircle2 className="size-4 text-success" aria-label="Valid" /> },
              { key: 't', header: 'Title', cell: (r) => r.title ?? '—' },
              { key: 'i', header: 'ISBN', cell: (r) => r.isbn13 ?? '—' },
              { key: 'e', header: 'Issues', cell: (r) => (
                <div className="space-y-0.5">
                  {r.errors.map((e) => <p key={e} className="text-xs text-danger">{e}</p>)}
                  {r.warnings.map((w) => <Badge key={w} tone="warning">{w}</Badge>)}
                </div>
              ) },
            ]}
          />
          {preview.invalid > 0 && <CardBody className="text-sm text-danger">Fix the rows with errors and re-upload. Nothing has been imported.</CardBody>}
        </Card>
      )}
    </div>
  )
}
