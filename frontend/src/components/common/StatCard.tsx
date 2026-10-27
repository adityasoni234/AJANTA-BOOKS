import type { LucideIcon } from 'lucide-react'
import * as React from 'react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export function StatCard({ label, value, hint, icon: Icon, tone = 'primary', warning }: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  icon?: LucideIcon
  tone?: 'primary' | 'success' | 'warning' | 'danger' | 'info'
  warning?: string
}) {
  const tones = {
    primary: 'bg-primary-soft text-primary', success: 'bg-success-soft text-success', warning: 'bg-warning-soft text-warning',
    danger: 'bg-danger-soft text-danger', info: 'bg-info-soft text-info',
  }
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted">{label}</p>
          <p className="num mt-1.5 break-words text-lg font-semibold text-foreground sm:text-xl">{value}</p>
          {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
          {warning && <p className="mt-1 text-xs text-warning">{warning}</p>}
        </div>
        {Icon && (
          <div className={cn('rounded-md p-2', tones[tone])}>
            <Icon className="size-4" />
          </div>
        )}
      </div>
    </Card>
  )
}
