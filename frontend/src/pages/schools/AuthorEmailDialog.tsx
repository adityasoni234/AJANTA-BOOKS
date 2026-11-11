import { useMutation, useQuery } from '@tanstack/react-query'
import { Copy, Mail } from 'lucide-react'
import { toast } from 'sonner'
import { ErrorState, PageLoader } from '@/components/common/States'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { api, errorMessage } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import type { EmailDraft } from './types'

// Mail apps differ in how long a mailto: link they accept; beyond this, suggest copy & paste.
const SAFE_MAILTO_LENGTH = 1800

function mailtoHref(d: Pick<EmailDraft, 'to' | 'subject' | 'body'>) {
  const body = d.body.replace(/\r?\n/g, '\r\n')
  return `mailto:${encodeURIComponent(d.to)}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(body)}`
}

/**
 * Shows the order email for one purchase order (rendered by the server from the saved template) and opens
 * it in the user's mail app. The system records that the draft was opened; it cannot know if it was sent.
 */
export function AuthorEmailDialog({ poId, open, onOpenChange, onOpened }: {
  poId: string | null; open: boolean; onOpenChange: (o: boolean) => void; onOpened?: () => void
}) {
  const draft = useQuery({
    queryKey: ['po-author-email', poId],
    queryFn: () => api.get<EmailDraft>(`/purchase-orders/${poId}/author-email`),
    enabled: open && !!poId,
    staleTime: 0,
  })
  const opened = useMutation({
    mutationFn: () => api.post(`/purchase-orders/${poId}/author-email/opened`),
    onSuccess: () => { onOpened?.(); void draft.refetch() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const d = draft.data
  const href = d ? mailtoHref(d) : ''
  const openMail = () => {
    window.location.href = href
    opened.mutate()
  }
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${what} copied`)
    } catch {
      toast.error('Copy failed. Select the text and copy it manually.')
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" title={d ? `Order email to ${d.author_name}` : 'Order email'}
        description="Opens a ready-written email in your mail app. Check it, then press Send there."
        footer={d && <>
          <Button variant="secondary" onClick={() => copy(`${d.subject}\n\n${d.body}`, 'Email text')}><Copy /> Copy text</Button>
          <Button disabled={!d.can_open} loading={opened.isPending} onClick={openMail}><Mail /> Open in mail app</Button>
        </>}>
        {draft.isLoading && <PageLoader />}
        {draft.error && <ErrorState error={draft.error} onRetry={() => draft.refetch()} />}
        {d && (
          <div className="space-y-3 text-sm">
            {!d.can_open && <p className="rounded-md bg-warning-soft px-3 py-2 text-amber-800">This purchase order is {d.status.toLowerCase().replace(/_/g, ' ')}, so it can't be emailed.</p>}
            {d.email_opened_at && <p className="rounded-md bg-info-soft px-3 py-2 text-sky-800">Opened in a mail app on {formatDate(d.email_opened_at, true)}. The system can't confirm it was sent.</p>}
            <div className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1">
              <span className="text-muted">To</span>
              <span className="flex items-center gap-2 break-all font-medium">{d.to}
                <button type="button" className="text-muted hover:text-primary" aria-label="Copy email address" onClick={() => copy(d.to, 'Address')}><Copy className="size-3.5" /></button>
              </span>
              <span className="text-muted">Subject</span>
              <span className="break-words font-medium">{d.subject}</span>
            </div>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface p-3 font-sans text-sm leading-relaxed">{d.body}</pre>
            {href.length > SAFE_MAILTO_LENGTH && <p className="text-xs text-muted">This email is long. If your mail app cuts it short, use Copy text and paste it into a new email.</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
