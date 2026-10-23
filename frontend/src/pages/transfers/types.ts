export interface TransferLine {
  id: string; book_id: string; title: string; sku: string; isbn13: string | null; tracking_mode: string
  qty_requested: number; qty_dispatched: number; qty_received: number; qty_damaged: number; qty_lost: number; qty_returned: number; qty_outstanding: number
  unit_cost: string | null; copies: { copy_id: string; copy_code: string | null; state: string }[]
}
export interface Transfer {
  id: string; number: string; source_location_id: string; source_location_name: string; dest_location_id: string; dest_location_name: string
  status: string; notes: string | null; created_by_name: string | null; created_at: string; requested_at: string | null; approved_at: string | null
  dispatched_at: string | null; completed_at: string | null; rejection_reason: string | null; total_units: number; lines: TransferLine[]
  receipts: { id: string; kind: string; received_by: string | null; received_at: string; notes: string | null; details: { lines?: unknown[] } }[]
  approval_request_id: string | null
  can: { edit: boolean; submit: boolean; approve: boolean; dispatch: boolean; receive: boolean; resolve: boolean; cancel: boolean }
}
