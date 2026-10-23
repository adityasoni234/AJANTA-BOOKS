import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as React from 'react'
import { api, ApiError, setCsrfToken, setUnauthorizedHandler } from './api'
import type { LocationBrief, Me } from './types'

interface AuthState {
  me: Me | null
  loading: boolean
  can: (...perms: string[]) => boolean
  canAny: (...perms: string[]) => boolean
  login: (email: string, password: string) => Promise<Me>
  logout: () => Promise<void>
  refresh: () => Promise<unknown>
  /** Selected location for location-scoped screens. null = all permitted locations. */
  locationId: string | null
  setLocationId: (id: string | null) => void
  location: LocationBrief | null
  outlets: LocationBrief[]
}

const AuthContext = React.createContext<AuthState | null>(null)
const LOC_KEY = 'ab.location'

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient()
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const me = await api.get<Me>('/auth/me')
        if (me.csrf_token) setCsrfToken(me.csrf_token)
        return me
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null
        throw e
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  })
  const me = meQuery.data ?? null

  React.useEffect(() => {
    setUnauthorizedHandler(() => {
      if (qc.getQueryData(['me'])) {
        qc.setQueryData(['me'], null)
        qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' })
      }
    })
    return () => setUnauthorizedHandler(null)
  }, [qc])

  const [locationId, setLocationIdState] = React.useState<string | null>(() => {
    try {
      return localStorage.getItem(LOC_KEY)
    } catch {
      return null
    }
  })

  // Keep the selection valid for the signed-in user's scope.
  React.useEffect(() => {
    if (!me) return
    const valid = me.locations.some((l) => l.id === locationId)
    if (locationId && !valid) setLocationIdState(null)
    if (!locationId && !me.all_locations && me.locations.length) {
      const first = me.locations.find((l) => l.type === 'OUTLET') ?? me.locations[0]
      setLocationIdState(first.id)
    }
  }, [me, locationId])

  const setLocationId = React.useCallback((id: string | null) => {
    setLocationIdState(id)
    try {
      if (id) localStorage.setItem(LOC_KEY, id)
      else localStorage.removeItem(LOC_KEY)
    } catch {
      /* storage unavailable */
    }
  }, [])

  const value = React.useMemo<AuthState>(() => {
    const perms = new Set(me?.permissions ?? [])
    return {
      me,
      loading: meQuery.isLoading,
      can: (...p) => p.every((x) => perms.has(x)),
      canAny: (...p) => p.some((x) => perms.has(x)),
      login: async (email, password) => {
        const res = await api.post<Me>('/auth/login', { email, password })
        if (res.csrf_token) setCsrfToken(res.csrf_token)
        qc.setQueryData(['me'], res)
        return res
      },
      logout: async () => {
        try {
          await api.post('/auth/logout')
        } finally {
          setCsrfToken(null)
          qc.clear()
          qc.setQueryData(['me'], null)
        }
      },
      refresh: () => meQuery.refetch(),
      locationId,
      setLocationId,
      location: me?.locations.find((l) => l.id === locationId) ?? null,
      outlets: me?.locations.filter((l) => l.type === 'OUTLET') ?? [],
    }
  }, [me, meQuery, qc, locationId, setLocationId])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = React.useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
