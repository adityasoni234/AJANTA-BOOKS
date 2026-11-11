import { useMutation } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/misc'
import { api, errorMessage } from '@/lib/api'

/**
 * Deletes a record after confirmation. The server refuses records that are already in use (bills, stock,
 * orders) and says to deactivate or cancel them instead; that message is shown as is.
 */
export function DeleteButton({ path, what, onDeleted, iconOnly = false }: { path: string; what: string; onDeleted?: () => void; iconOnly?: boolean }) {
  const [open, setOpen] = React.useState(false)
  const del = useMutation({
    mutationFn: () => api.del(path),
    onSuccess: () => { toast.success(`${what} deleted`); setOpen(false); onDeleted?.() },
    onError: (e) => { toast.error(errorMessage(e)); setOpen(false) },
  })
  return (
    <>
      {iconOnly
        ? <Button size="icon-sm" variant="ghost" aria-label={`Delete ${what}`} title={`Delete ${what}`} onClick={(e) => { e.stopPropagation(); setOpen(true) }}><Trash2 /></Button>
        : <Button variant="secondary" onClick={() => setOpen(true)}><Trash2 /> Delete</Button>}
      <ConfirmDialog open={open} onOpenChange={setOpen} tone="danger" title={`Delete ${what}?`} confirmLabel="Delete" loading={del.isPending} onConfirm={() => del.mutate()}
        description="This permanently removes it. Records already used in bills, stock or orders can't be deleted; deactivate or cancel those instead." />
    </>
  )
}
