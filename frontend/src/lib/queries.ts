import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import type { Category, PaymentMethod, TaxClass } from './types'

const LONG = 10 * 60_000
/** Screens showing stock, sets or takings reload this often while open, so other users' changes appear. */
export const LIVE_REFRESH_MS = 30_000

export const useTaxClasses = () => useQuery({ queryKey: ['tax-classes'], queryFn: () => api.get<TaxClass[]>('/tax-classes'), staleTime: LONG })
export const useCategories = () => useQuery({ queryKey: ['categories'], queryFn: () => api.get<Category[]>('/categories'), staleTime: LONG })
export const usePaymentMethods = () => useQuery({ queryKey: ['payment-methods'], queryFn: () => api.get<PaymentMethod[]>('/payment-methods'), staleTime: LONG })

export interface SupplierLite { id: string; code: string; name: string; is_active: boolean }
export const useSuppliers = (enabled = true) =>
  useQuery({ queryKey: ['suppliers-all'], queryFn: () => api.get<{ items: SupplierLite[] }>('/suppliers', { page_size: 200, active: true }).then((r) => r.items), staleTime: LONG, enabled })

export interface LocationFull { id: string; code: string; name: string; type: 'WAREHOUSE' | 'OUTLET'; is_active: boolean; state_code: string }
export const useLocationDirectory = () =>
  useQuery({ queryKey: ['location-directory'], queryFn: () => api.get<LocationFull[]>('/locations/directory'), staleTime: LONG })

export interface AccountLite { id: string; code: string; name: string; type: string; system_key: string | null; is_cash_or_bank: boolean; is_active: boolean; balance?: string | null }
export const useCashAccounts = () =>
  useQuery({ queryKey: ['cash-accounts'], queryFn: () => api.get<AccountLite[]>('/accounts', { cash_or_bank: true }), staleTime: LONG })

export function categoryLabel(cats: Category[] | undefined, id: string | null) {
  if (!cats || !id) return ''
  const c = cats.find((x) => x.id === id)
  if (!c) return ''
  const p = c.parent_id ? cats.find((x) => x.id === c.parent_id) : null
  return p ? `${p.name} › ${c.name}` : c.name
}

export function categoryOptions(cats: Category[] | undefined) {
  if (!cats) return []
  const parents = cats.filter((c) => !c.parent_id).sort((a, b) => a.name.localeCompare(b.name))
  const out: { id: string; label: string }[] = []
  for (const p of parents) {
    out.push({ id: p.id, label: p.name })
    for (const c of cats.filter((x) => x.parent_id === p.id).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({ id: c.id, label: `${p.name} › ${c.name}` })
    }
  }
  return out
}
