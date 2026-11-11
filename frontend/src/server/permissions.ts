/** Permission catalog and system role templates (unchanged from the Python backend). */
export const PERMISSIONS: Record<string, [string, string]> = {
  'dashboard.view': ['dashboard', 'View dashboards'],
  'catalog.view': ['catalog', 'View book catalog'], 'catalog.create': ['catalog', 'Add books'], 'catalog.edit': ['catalog', 'Edit book details'],
  'catalog.price_edit': ['catalog', 'Change prices and location price overrides'], 'catalog.archive': ['catalog', 'Archive/discontinue books'],
  'catalog.merge': ['catalog', 'Merge duplicate books'], 'catalog.import': ['catalog', 'Bulk import/export catalog'], 'catalog.master_data': ['catalog', 'Manage categories, publishers, tax classes'],
  'inventory.view': ['inventory', 'View stock levels and ledger'], 'inventory.adjust': ['inventory', 'Create stock adjustments'], 'inventory.approve': ['inventory', 'Approve stock adjustments'],
  'inventory.stocktake': ['inventory', 'Run stocktakes'], 'inventory.copies': ['inventory', 'Manage individual copies and labels'], 'inventory.settings': ['inventory', 'Set reorder levels per location'],
  'suppliers.view': ['purchasing', 'View suppliers'], 'suppliers.manage': ['purchasing', 'Create/edit suppliers'], 'purchasing.view': ['purchasing', 'View purchase orders and receipts'],
  'purchasing.create': ['purchasing', 'Create purchase orders'], 'purchasing.approve': ['purchasing', 'Approve purchase orders'], 'purchasing.receive': ['purchasing', 'Receive goods (GRN)'],
  'purchasing.return': ['purchasing', 'Return goods to supplier'],
  'schools.view': ['schools', 'View schools, class book lists and sets available'], 'schools.manage': ['schools', 'Manage schools and book lists, import lists, order school books'],
  'transfers.view': ['transfers', 'View stock transfers'], 'transfers.create': ['transfers', 'Request stock transfers'], 'transfers.approve': ['transfers', 'Approve stock transfers'],
  'transfers.dispatch': ['transfers', 'Dispatch stock transfers'], 'transfers.receive': ['transfers', 'Receive stock transfers / resolve discrepancies'],
  'pos.sell': ['pos', 'Operate point of sale'], 'pos.discount': ['pos', 'Apply discounts within configured limit'], 'pos.discount_override': ['pos', 'Apply discounts beyond limit / below minimum price'],
  'pos.void': ['pos', 'Cancel (void) a completed sale'], 'pos.credit_sale': ['pos', 'Create credit sales (when enabled)'], 'sales.view': ['pos', 'View sales and invoices'],
  'returns.create': ['returns', 'Process returns'], 'returns.approve': ['returns', 'Approve refunds above limit'],
  'registers.operate': ['registers', 'Open/close own register sessions'], 'registers.manage': ['registers', 'Manage registers and view all sessions'],
  'customers.view': ['customers', 'View customers'], 'customers.manage': ['customers', 'Create/edit customers, adjust store credit'],
  'expenses.view': ['finance', 'View expenses'], 'expenses.create': ['finance', 'Record expenses'], 'expenses.approve': ['finance', 'Approve expenses'],
  'finance.view': ['finance', 'View payables, receivables, cashbook'], 'finance.manage': ['finance', 'Record supplier invoices/payments, transfers, reconciliations'],
  'accounting.view': ['accounting', 'View chart of accounts, journals, financial statements'], 'accounting.manage': ['accounting', 'Manage chart of accounts, post/reverse manual journals'],
  'reports.view': ['reports', 'View reports and analytics'], 'reports.financial': ['reports', 'View confidential financial reports (profit, valuation)'], 'reports.export': ['reports', 'Export reports'],
  'users.view': ['admin', 'View employees and users'], 'users.manage': ['admin', 'Create/edit users, reset passwords'], 'roles.manage': ['admin', 'Manage roles and permissions'],
  'locations.manage': ['admin', 'Create/configure outlets and warehouses'], 'settings.manage': ['admin', 'Manage organisation, GST, pricing and policy settings'],
  'audit.view': ['admin', 'View audit logs'], 'approvals.view': ['approvals', 'View approval center'],
}
const ALL = Object.keys(PERMISSIONS)

export const ROLE_TEMPLATES: Record<string, { name: string; description: string; permissions: string[] }> = {
  OWNER: { name: 'Super Admin / Owner', description: 'Complete organisation-wide access.', permissions: ALL },
  INVENTORY_MANAGER: {
    name: 'Central Inventory Manager', description: 'Warehouse inventory, catalog, purchasing, suppliers and transfers.',
    permissions: ['dashboard.view', 'catalog.view', 'catalog.create', 'catalog.edit', 'catalog.archive', 'catalog.merge', 'catalog.import', 'catalog.master_data', 'inventory.view', 'inventory.adjust', 'inventory.approve',
      'inventory.stocktake', 'inventory.copies', 'inventory.settings', 'suppliers.view', 'suppliers.manage', 'purchasing.view', 'purchasing.create', 'purchasing.approve', 'purchasing.receive', 'purchasing.return',
      'schools.view', 'schools.manage', 'transfers.view', 'transfers.create', 'transfers.approve', 'transfers.dispatch', 'transfers.receive', 'reports.view', 'reports.export', 'approvals.view'],
  },
  STORE_MANAGER: {
    name: 'Store Manager', description: 'Runs assigned outlet(s): stock, sales, returns, registers, expenses, reports.',
    permissions: ['dashboard.view', 'catalog.view', 'inventory.view', 'inventory.adjust', 'inventory.stocktake', 'inventory.copies', 'inventory.settings', 'suppliers.view', 'purchasing.view', 'purchasing.receive',
      'schools.view', 'transfers.view', 'transfers.create', 'transfers.dispatch', 'transfers.receive', 'pos.sell', 'pos.discount', 'pos.discount_override', 'pos.void', 'pos.credit_sale', 'sales.view', 'returns.create', 'returns.approve',
      'registers.operate', 'registers.manage', 'customers.view', 'customers.manage', 'expenses.view', 'expenses.create', 'reports.view', 'reports.export', 'approvals.view', 'users.view'],
  },
  CASHIER: {
    name: 'Cashier', description: 'Point of sale, receipts and eligible returns at assigned outlet.',
    permissions: ['catalog.view', 'inventory.view', 'schools.view', 'pos.sell', 'pos.discount', 'sales.view', 'returns.create', 'registers.operate', 'customers.view', 'customers.manage'],
  },
  ACCOUNTANT: {
    name: 'Accountant', description: 'Financial records, tax reports, supplier balances, reconciliation and exports.',
    permissions: ['dashboard.view', 'catalog.view', 'inventory.view', 'suppliers.view', 'purchasing.view', 'sales.view', 'customers.view', 'expenses.view', 'expenses.create', 'expenses.approve', 'finance.view',
      'finance.manage', 'accounting.view', 'accounting.manage', 'reports.view', 'reports.financial', 'reports.export', 'registers.manage', 'approvals.view', 'transfers.view', 'schools.view'],
  },
  AUDITOR: {
    name: 'Auditor / Viewer', description: 'Read-only access to authorised records and locations.',
    permissions: ['dashboard.view', 'catalog.view', 'inventory.view', 'suppliers.view', 'purchasing.view', 'transfers.view', 'sales.view', 'customers.view', 'expenses.view', 'finance.view', 'accounting.view',
      'reports.view', 'reports.financial', 'audit.view', 'schools.view'],
  },
}

export const DEFAULT_POLICY = {
  prices_include_tax: true, rounding: 'NEAREST_RUPEE', max_discount_pct: '10', allow_below_min_price_with_override: true,
  po_approval_threshold: '50000', refund_approval_threshold: '2000', expense_approval_threshold: '5000', adjustment_approval_threshold: '1000',
  transfer_requires_approval: true, return_window_days: 15, credit_sales_enabled: false, loyalty_enabled: false, loyalty_points_per_100: '1', loyalty_point_value: '0.25',
  barcode_prefix: '200', sku_prefix: 'AB', copy_code_prefix: 'CP', register_variance_alert: '100', dead_stock_days: 180, slow_moving_days: 90, excess_stock_multiplier: 4,
  opening_balances_configured: false,
}
export type Policy = typeof DEFAULT_POLICY
