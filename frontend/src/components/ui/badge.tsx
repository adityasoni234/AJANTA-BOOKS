import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'
import { cn } from '@/lib/utils'

const badgeVariants = cva('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset whitespace-nowrap', {
  variants: {
    tone: {
      neutral: 'bg-surface-2 text-slate-700 ring-slate-200',
      primary: 'bg-primary-soft text-indigo-700 ring-indigo-200',
      success: 'bg-success-soft text-emerald-700 ring-emerald-200',
      warning: 'bg-warning-soft text-amber-700 ring-amber-200',
      danger: 'bg-danger-soft text-red-700 ring-red-200',
      info: 'bg-info-soft text-sky-700 ring-sky-200',
    },
  },
  defaultVariants: { tone: 'neutral' },
})

export function Badge({ className, tone, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />
}

const STATUS_TONES: Record<string, VariantProps<typeof badgeVariants>['tone']> = {
  ACTIVE: 'success', COMPLETED: 'success', POSTED: 'success', APPROVED: 'success', PAID: 'success', RECEIVED: 'success',
  ISSUED: 'info', IN_TRANSIT: 'info', OPEN: 'info', PARTIALLY_RECEIVED: 'info', PARTIALLY_PAID: 'info', REQUESTED: 'info', AVAILABLE: 'success',
  PENDING: 'warning', PENDING_APPROVAL: 'warning', DRAFT: 'neutral', LOW: 'warning', DISCREPANCY: 'warning', QUARANTINED: 'warning',
  DISCONTINUED: 'warning', RESERVED: 'warning',
  CANCELLED: 'danger', REJECTED: 'danger', OUT: 'danger', DAMAGED: 'danger', LOST: 'danger', WRITTEN_OFF: 'danger', OVERDUE: 'danger',
  CLOSED: 'neutral', ARCHIVED: 'neutral', SOLD: 'neutral', OK: 'success', RETURNED_TO_SUPPLIER: 'neutral',
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const text = label ?? status.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())
  return <Badge tone={STATUS_TONES[status] ?? 'neutral'}>{text}</Badge>
}
