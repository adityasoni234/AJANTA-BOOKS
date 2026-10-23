import * as React from 'react'
import { formatINR, formatNumber } from '@/lib/utils'

/** Validated categorical palette (dataviz reference instance, light mode), fixed order. */
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
export const GRID = '#e2e8f0'
export const AXIS = '#64748b'

export const axisProps = {
  stroke: GRID,
  tick: { fill: AXIS, fontSize: 11 },
  tickLine: false,
  axisLine: false,
} as const

interface TooltipPayload {
  name?: string
  value?: number
  color?: string
  payload?: Record<string, unknown>
}

/** Text in ink colours; the coloured swatch carries identity. */
export function ChartTooltip({ active, payload, label, money = true, labelFormatter }: {
  active?: boolean
  payload?: TooltipPayload[]
  label?: string | number
  money?: boolean
  labelFormatter?: (l: string | number) => string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-md border border-border bg-white px-3 py-2 text-xs shadow-[var(--shadow-pop)]">
      {label !== undefined && <p className="mb-1 font-medium text-foreground">{labelFormatter ? labelFormatter(label) : label}</p>}
      {payload.map((p, i) => (
        <p key={i} className="flex items-center gap-2 text-slate-600">
          <span className="inline-block size-2 rounded-full" style={{ background: p.color }} aria-hidden />
          <span>{p.name}</span>
          <span className="num ml-auto pl-3 font-medium text-foreground">{money ? formatINR(p.value ?? 0) : formatNumber(p.value ?? 0)}</span>
        </p>
      ))}
    </div>
  )
}

export function compactINR(v: number) {
  return formatINR(v, { compact: true })
}

export function ChartFrame({ height = 260, children, label }: { height?: number; children: React.ReactNode; label: string }) {
  return (
    <div style={{ height }} role="img" aria-label={label}>
      {children}
    </div>
  )
}
