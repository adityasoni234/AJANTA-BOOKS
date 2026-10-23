import { BookOpen } from 'lucide-react'
import * as React from 'react'

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-white to-surface px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary text-white shadow-sm">
            <BookOpen className="size-5" />
          </div>
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        </div>
        <div className="rounded-lg border border-border bg-white p-6 shadow-[var(--shadow-card)]">{children}</div>
      </div>
    </div>
  )
}
