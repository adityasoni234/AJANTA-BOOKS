export interface POLine { id: string; line_no: number; book_id: string; title: string; sku: string; isbn13: string | null; qty_ordered: number; qty_received: number; qty_cancelled: number; qty_outstanding: number; unit_cost: string; discount_pct: string; tax_rate: string; tracking_mode: string }
export interface PO {
  id: string; number: string; supplier_id: string; supplier_name: string; location_id: string; location_name: string; status: string
  order_date: string; expected_date: string | null; notes: string | null; subtotal: string; tax_total: string; total: string
  created_by_name: string | null; approved_at: string | null; issued_at: string | null; created_at: string; lines: POLine[]
  receipts: { id: string; number: string; received_at: string; total_landed: string; invoiced: boolean }[]; approval_request_id: string | null
}
export interface GRN {
  id: string; number: string; po_id: string | null; po_number: string | null; supplier_id: string; supplier_name: string; location_id: string; location_name: string
  supplier_ref: string | null; freight: string; other_charges: string; goods_value: string; total_landed: string; supplier_invoice_id: string | null; received_at: string
  notes: string | null; lines: { book_id: string; title: string; sku: string; qty_received: number; qty_damaged: number; unit_cost: string; landed_unit_cost: string }[]; replayed?: boolean
}
