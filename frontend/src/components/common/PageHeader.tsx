import { ChevronRight } from 'lucide-react'
import * as React from 'react'
import { Link } from 'react-router-dom'

interface Crumb {
  label: string
  to?: string
}

export function PageHeader({ title, description, actions, crumbs }: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  crumbs?: Crumb[]
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {crumbs && crumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-1 flex items-center gap-1 text-xs text-muted">
            {crumbs.map((c, i) => (
              <React.Fragment key={i}>
                {i > 0 && <ChevronRight className="size-3" aria-hidden />}
                {c.to ? <Link to={c.to} className="hover:text-foreground">{c.label}</Link> : <span>{c.label}</span>}
              </React.Fragment>
            ))}
          </nav>
        )}
        <h1 className="truncate text-xl font-semibold text-foreground">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
