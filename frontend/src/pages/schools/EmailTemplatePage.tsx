import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RotateCcw, Save } from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/common/PageHeader'
import { ErrorState, PageLoader } from '@/components/common/States'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field, Input, Textarea } from '@/components/ui/input'
import { api, ApiError, errorMessage } from '@/lib/api'
import { useDebounced } from '@/lib/hooks'

interface Template {
  subject: string; body: string; customised: boolean
  placeholders: { name: string; description: string }[]
  default: { subject: string; body: string }
}

const BODY_ONLY = ['book_lines', 'delivery_address']

export default function EmailTemplatePage() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['school-email-template'], queryFn: () => api.get<Template>('/school-order-email-template') })
  const [subject, setSubject] = React.useState('')
  const [body, setBody] = React.useState('')
  const [focus, setFocus] = React.useState<'subject' | 'body'>('body')
  const subjectRef = React.useRef<HTMLInputElement>(null)
  const bodyRef = React.useRef<HTMLTextAreaElement>(null)
  React.useEffect(() => { if (q.data) { setSubject(q.data.subject); setBody(q.data.body) } }, [q.data])

  const draft = useDebounced({ subject, body }, 400)
  const preview = useQuery({
    queryKey: ['school-email-template-preview', draft],
    queryFn: () => api.post<{ subject: string; body: string }>('/school-order-email-template/preview', draft),
    enabled: draft.subject.length >= 3 && draft.body.length >= 10,
    retry: false,
  })
  const save = useMutation({
    mutationFn: () => api.put<Template>('/school-order-email-template', { subject, body }),
    onSuccess: (t) => { qc.setQueryData(['school-email-template'], t); toast.success('Template saved. New order emails will use it.') },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const insert = (name: string) => {
    const token = `{${name}}`
    const target = focus === 'subject' && !BODY_ONLY.includes(name) ? 'subject' : 'body'
    const el = target === 'subject' ? subjectRef.current : bodyRef.current
    const value = target === 'subject' ? subject : body
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    const next = value.slice(0, start) + token + value.slice(end)
    if (target === 'subject') setSubject(next)
    else setBody(next)
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + token.length, start + token.length) })
  }

  if (q.isLoading) return <PageLoader />
  if (!q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const t = q.data
  const dirty = subject !== t.subject || body !== t.body
  const previewError = preview.error instanceof ApiError ? preview.error.fullMessage() : null

  return (
    <div>
      <PageHeader title="Order email template" description="Used for every order email to an author. Placeholders in {braces} are filled in from each purchase order."
        crumbs={[{ label: 'Schools', to: '/schools' }, { label: 'Order email template' }]}
        actions={<>
          {t.customised ? <Badge tone="primary">Customised</Badge> : <Badge>Predefined template</Badge>}
          <Button variant="secondary" onClick={() => { setSubject(t.default.subject); setBody(t.default.body) }}><RotateCcw /> Restore predefined</Button>
          <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}><Save /> Save template</Button>
        </>} />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Template" />
          <CardBody className="space-y-4">
            <Field label="Subject" required><Input ref={subjectRef} value={subject} maxLength={200} onFocus={() => setFocus('subject')} onChange={(e) => setSubject(e.target.value)} /></Field>
            <Field label="Message" required><Textarea ref={bodyRef} rows={18} value={body} maxLength={5000} className="font-mono text-[13px]"
              onFocus={() => setFocus('body')} onChange={(e) => setBody(e.target.value)} /></Field>
            <div>
              <p className="mb-2 text-xs font-medium text-muted">Insert a placeholder at the cursor</p>
              <div className="flex flex-wrap gap-1.5">
                {t.placeholders.map((p) => (
                  <button key={p.name} type="button" title={p.description + (BODY_ONLY.includes(p.name) ? ' (message only)' : '')}
                    className="rounded-full border border-border bg-surface px-2.5 py-1 font-mono text-xs hover:border-primary hover:text-primary"
                    onClick={() => insert(p.name)}>{`{${p.name}}`}</button>
                ))}
              </div>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Preview with sample order" description="Real emails use the purchase order's author, books, quantities and delivery location." />
          <CardBody className="space-y-3 text-sm">
            {previewError && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-red-800">{previewError}</p>}
            {preview.data && !previewError && (
              <>
                <p><span className="text-muted">Subject:</span> <b className="break-words">{preview.data.subject}</b></p>
                <pre className="whitespace-pre-wrap rounded-md border border-border bg-surface p-3 font-sans leading-relaxed">{preview.data.body}</pre>
              </>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  )
}
