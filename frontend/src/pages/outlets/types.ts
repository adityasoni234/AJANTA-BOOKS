type Money = string

export interface OutletLocation {
  id: string; code: string; name: string; type: 'WAREHOUSE' | 'OUTLET'; is_active: boolean; city: string | null; state: string | null
  address_line1: string | null; address_line2: string | null; pincode: string | null; phone: string | null; email: string | null; gstin: string | null
}
export interface StockState {
  units: number; retail_value: Money; cost_value: Money | null; items_missing_cost: number | null
  on_hand: number; reserved: number; available: number; damaged: number; quarantined: number; in_transit: number; titles_available: number
}
export type PeriodKey = 'today' | 'week' | 'month'
export const PERIOD_LABELS: Record<PeriodKey, string> = { today: 'Today', week: 'This week', month: 'This month' }

export interface OutletsSummary {
  as_of: string
  periods: Record<PeriodKey, { from: string; to: string }>
  locations: {
    location: OutletLocation
    sales: Record<PeriodKey, { transactions: number; invoice_value: Money; net_sales: Money; returns_value: Money }>
    stock: StockState
    alerts: { low: number; out: number }
    open_registers: number; pending_transfers: number; pending_approvals: number
  }[]
}

export interface SalesSummary {
  transactions: number; gross_sales: Money; discounts: Money; invoice_value: Money; returns_value: Money; returns_count: number
  net_sales: Money; gst_collected: Money; cogs: Money | null; gross_profit: Money | null; gross_margin_pct: Money | null; avg_basket: Money; voided: number
}
export interface SalesByRow { key: string | null; label: string; transactions: number; units: number; net_sales: Money; invoice_value: Money; sku?: string }
export interface StockAlert { book_id: string; title: string; sku: string; available: number; on_hand: number; reorder_level: number; reorder_qty: number; in_transit: number }

export interface OutletOverview {
  location: OutletLocation
  as_of: string
  periods: Record<PeriodKey, { from: string; to: string }>
  sales: Record<PeriodKey, SalesSummary>
  trend: { date: string; transactions: number; net_sales: Money; invoice_value: Money }[]
  payments_month: { code: string; method: string; collected: Money; refunded: Money; net: Money; count: number }[]
  top_books_month: SalesByRow[]
  categories_month: SalesByRow[]
  cashiers_month: SalesByRow[]
  stock: StockState
  stock_by_category: { category_id: string | null; category: string; titles: number; units: number; retail_value: Money; cost_value: Money | null }[]
  low_stock: StockAlert[]
  out_of_stock: StockAlert[]
  alerts: { low: number; out: number; dead: number }
  pending: { transfers: number; approvals: number; open_register_sessions: number }
  open_registers: { session_id: string; register: string; cashier: string; opened_at: string; opening_float: Money }[]
  staff: { id: string; full_name: string; email: string; role: string; designation: string | null; last_login_at: string | null }[] | null
  purchase_commitments?: { open_orders: number; units_outstanding: number; value_outstanding: Money }
  expenses_month?: Money | number
}
