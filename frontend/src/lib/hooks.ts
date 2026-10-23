import * as React from 'react'
import { daysAgoISO, newIdempotencyKey, todayISO } from './utils'

export function useDebounced<T>(value: T, delay = 300): T {
  const [v, setV] = React.useState(value)
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return v
}

/**
 * One idempotency key per logical submission. The same key is reused for retries (double clicks,
 * network failures) until `reset()` is called after a confirmed success.
 */
export function useIdempotencyKey() {
  const ref = React.useRef<string>(newIdempotencyKey())
  return {
    get key() {
      return ref.current
    },
    reset() {
      ref.current = newIdempotencyKey()
    },
  }
}

/** Date-range filter state, defaulting to the last `days` + today (India time). */
export function useDateRange(days = 29) {
  const [range, setRange] = React.useState({ from: daysAgoISO(days), to: todayISO() })
  return { ...range, set: (from: string, to: string) => setRange({ from, to }) }
}
