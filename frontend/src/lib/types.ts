export interface LocationBrief {
  id: string
  code: string
  name: string
  type: 'WAREHOUSE' | 'OUTLET'
  state_code: string
}

export interface Me {
  id: string
  email: string
  full_name: string
  role_code: string
  role_name: string
  permissions: string[]
  all_locations: boolean
  locations: LocationBrief[]
  must_change_password: boolean
  organization_name: string | null
  csrf_token?: string | null
}

export interface Book {
  id: string
  sku: string
  barcode: string
  isbn13: string | null
  isbn10: string | null
  title: string
  subtitle: string | null
  authors: string[]
  publisher: string | null
  publisher_id: string | null
  edition: string | null
  publication_date: string | null
  language: string | null
  category_id: string | null
  category: string | null
  genre: string | null
  binding: string | null
  format: string | null
  page_count: number | null
  description: string | null
  tags: string[]
  cover_url: string | null
  hsn_code: string | null
  tax_class_id: string
  tax_class: string
  tax_rate: string
  mrp: string
  selling_price: string
  min_selling_price: string | null
  purchase_price: string | null
  default_supplier_id: string | null
  reorder_level: number
  reorder_qty: number
  tracking_mode: 'QUANTITY' | 'COPY'
  status: 'ACTIVE' | 'DISCONTINUED' | 'ARCHIVED'
  merged_into_id: string | null
  created_at: string
  updated_at: string
  stock_on_hand: number | null
  stock_available: number | null
  location_price: string | null
}

export interface PaymentMethod {
  id: string
  code: string
  name: string
  kind: string
  requires_reference: boolean
  is_active: boolean
}

export interface TaxClass {
  id: string
  code: string
  name: string
  rate: string
  is_exempt: boolean
  is_active: boolean
}

export interface Category {
  id: string
  name: string
  parent_id: string | null
}
