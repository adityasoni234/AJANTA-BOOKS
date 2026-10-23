export interface SaleLine {
  id: string; line_no: number; book_id: string; title: string; hsn_code: string | null; copy_id: string | null; copy_code: string | null; qty: number
  unit_price: string; mrp: string; line_discount: string; bill_discount_alloc: string; taxable_value: string; tax_rate: string
  cgst: string; sgst: string; igst: string; line_total: string; qty_returned: number; unit_cost: string | null
}
export interface Party { name?: string; legal_name?: string; trade_name?: string; gstin?: string | null; address?: string | null; state_code?: string | null; state?: string | null; phone?: string | null; email?: string | null; location_name?: string; registration_type?: string }
export interface SaleDetail {
  id: string; status: string; location_id: string; location_name: string; register_session_id: string; customer_id: string | null; customer_name: string | null
  invoice: { id: string; number: string; doc_type: string; issued_at: string; seller: Party; buyer: Party; place_of_supply: string; status: string; financial_year: string } | null
  prices_include_tax: boolean; is_interstate: boolean; lines: SaleLine[]
  tax_summary: { hsn_code: string; tax_rate: string; taxable_value: string; cgst: string; sgst: string; igst: string }[]
  gross_amount: string; line_discount_total: string; bill_discount: string; discount_total: string; taxable_total: string; cgst_total: string; sgst_total: string
  igst_total: string; tax_total: string; round_off: string; grand_total: string; amount_in_words: string; amount_paid: string; balance_due: string
  discount_reason: string | null; cogs_total: string | null; cost_complete: boolean
  payments: { id: string; number: string; direction: string; purpose: string; method: string; method_kind: string; amount: string; tendered: string | null; change_given: string | null; reference: string | null; created_at: string }[]
  returns: { id: string; number: string; status: string; refund_total: string; created_at: string }[]
  cashier: string | null; created_at: string; cancelled_at: string | null; cancel_reason: string | null; notes: string | null
}
export interface ReturnDetail {
  id: string; number: string; status: string; sale_id: string; original_invoice_number: string | null
  credit_note: { id: string; number: string; issued_at: string; seller: Party; buyer: Party; place_of_supply: string } | null
  location_name: string; reason: string; refund_method: string; refund_method_kind: string; refund_reference: string | null
  taxable_total: string; cgst_total: string; sgst_total: string; igst_total: string; round_off: string; refund_total: string; amount_in_words: string
  customer_name: string | null; created_by: string | null; created_at: string; completed_at: string | null; approval_request_id: string | null
  lines: { sale_line_id: string; title: string; hsn_code: string | null; qty: number; disposition: string; condition: string; taxable_value: string; tax_rate: string; cgst: string; sgst: string; igst: string; line_total: string }[]
}
