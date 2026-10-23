import { Search, X } from 'lucide-react'
import { Input, NativeSelect } from '@/components/ui/input'
import { useAuth } from '@/lib/auth'
import { daysAgoISO, todayISO } from '@/lib/utils'

export function SearchInput({ value, onChange, placeholder = 'Search…', className, autoFocus }: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
  autoFocus?: boolean
}) {
  return (
    <div className={`relative ${className ?? 'w-full sm:w-72'}`}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pl-8 pr-8"
        aria-label={placeholder}
        autoFocus={autoFocus}
      />
      {value && (
        <button type="button" onClick={() => onChange('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-subtle hover:text-foreground" aria-label="Clear search">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}

/** Location picker limited to the user's scope. `allowAll` adds an "All locations" option for org-wide users. */
export function LocationSelect({ value, onChange, allowAll = true, types, className, id, label = 'Location' }: {
  value: string | null
  onChange: (v: string | null) => void
  allowAll?: boolean
  types?: ('WAREHOUSE' | 'OUTLET')[]
  className?: string
  id?: string
  label?: string
}) {
  const { me } = useAuth()
  const locs = (me?.locations ?? []).filter((l) => !types || types.includes(l.type))
  return (
    <NativeSelect id={id} aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} className={className ?? 'w-full sm:w-56'}>
      {allowAll && (me?.all_locations || locs.length > 1) && <option value="">All {types?.length === 1 && types[0] === 'OUTLET' ? 'outlets' : 'locations'}</option>}
      {locs.map((l) => (
        <option key={l.id} value={l.id}>{l.name}</option>
      ))}
    </NativeSelect>
  )
}

const PRESETS = [
  { label: 'Today', days: 0 },
  { label: 'Last 7 days', days: 6 },
  { label: 'Last 30 days', days: 29 },
  { label: 'Last 90 days', days: 89 },
]

export function DateRange({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const preset = PRESETS.find((p) => from === daysAgoISO(p.days) && to === todayISO())
  return (
    <div className="flex flex-wrap items-center gap-2">
      <NativeSelect
        aria-label="Date range preset"
        className="w-36"
        value={preset ? String(preset.days) : 'custom'}
        onChange={(e) => {
          if (e.target.value !== 'custom') onChange(daysAgoISO(Number(e.target.value)), todayISO())
        }}
      >
        {PRESETS.map((p) => <option key={p.days} value={p.days}>{p.label}</option>)}
        <option value="custom">Custom</option>
      </NativeSelect>
      <Input type="date" aria-label="From date" value={from} max={to} onChange={(e) => onChange(e.target.value, to)} className="w-38" />
      <span className="text-muted">–</span>
      <Input type="date" aria-label="To date" value={to} min={from} max={todayISO()} onChange={(e) => onChange(from, e.target.value)} className="w-38" />
    </div>
  )
}
