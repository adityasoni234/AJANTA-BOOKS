import * as React from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { PageLoader } from './components/common/States'
import { AppShell } from './components/layout/AppShell'
import { useAuth } from './lib/auth'
import LoginPage from './pages/auth/LoginPage'

const lazy = (f: () => Promise<{ default: React.ComponentType<{ kind?: string }> }>) => React.lazy(f)

const ResetPasswordPage = lazy(() => import('./pages/auth/ResetPasswordPage'))
const SetupPage = lazy(() => import('./pages/auth/SetupPage'))
const SignupPage = lazy(() => import('./pages/auth/SignupPage'))
const AccountPage = lazy(() => import('./pages/auth/AccountPage'))
const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const OutletsPage = lazy(() => import('./pages/outlets/OutletsPage'))
const OutletPage = lazy(() => import('./pages/outlets/OutletPage'))
const BooksPage = lazy(() => import('./pages/catalog/BooksPage'))
const BookDetailPage = lazy(() => import('./pages/catalog/BookDetailPage'))
const BookFormPage = lazy(() => import('./pages/catalog/BookFormPage'))
const ImportPage = lazy(() => import('./pages/catalog/ImportPage'))
const AuthorsPage = lazy(() => import('./pages/catalog/AuthorsPage'))
const SchoolsPage = lazy(() => import('./pages/schools/SchoolsPage'))
const SchoolDetailPage = lazy(() => import('./pages/schools/SchoolDetailPage'))
const BookListPage = lazy(() => import('./pages/schools/BookListPage'))
const SchoolImportPage = lazy(() => import('./pages/schools/SchoolImportPage'))
const SchoolOrderNewPage = lazy(() => import('./pages/schools/SchoolOrderNewPage'))
const SchoolOrderDetailPage = lazy(() => import('./pages/schools/SchoolOrderDetailPage'))
const EmailTemplatePage = lazy(() => import('./pages/schools/EmailTemplatePage'))
const StockPage = lazy(() => import('./pages/inventory/StockPage'))
const CopiesPage = lazy(() => import('./pages/inventory/CopiesPage'))
const LabelsPage = lazy(() => import('./pages/inventory/LabelsPage'))
const AdjustmentsPage = lazy(() => import('./pages/inventory/AdjustmentsPage'))
const StocktakePage = lazy(() => import('./pages/inventory/StocktakePage'))
const TransfersPage = lazy(() => import('./pages/transfers/TransfersPage'))
const TransferNewPage = lazy(() => import('./pages/transfers/TransferNewPage'))
const TransferDetailPage = lazy(() => import('./pages/transfers/TransferDetailPage'))
const SuppliersPage = lazy(() => import('./pages/purchasing/SuppliersPage'))
const SupplierDetailPage = lazy(() => import('./pages/purchasing/SupplierDetailPage'))
const PurchaseOrdersPage = lazy(() => import('./pages/purchasing/PurchaseOrdersPage'))
const PurchaseOrderFormPage = lazy(() => import('./pages/purchasing/PurchaseOrderFormPage'))
const PurchaseOrderDetailPage = lazy(() => import('./pages/purchasing/PurchaseOrderDetailPage'))
const GoodsReceiptsPage = lazy(() => import('./pages/purchasing/GoodsReceiptsPage'))
const PosPage = lazy(() => import('./pages/pos/PosPage'))
const SalesPage = lazy(() => import('./pages/sales/SalesPage'))
const SaleDetailPage = lazy(() => import('./pages/sales/SaleDetailPage'))
const InvoicePrintPage = lazy(() => import('./pages/sales/InvoicePrintPage'))
const ReturnsPage = lazy(() => import('./pages/sales/ReturnsPage'))
const ReturnNewPage = lazy(() => import('./pages/sales/ReturnNewPage'))
const ReturnDetailPage = lazy(() => import('./pages/sales/ReturnDetailPage'))
const CustomersPage = lazy(() => import('./pages/customers/CustomersPage'))
const CustomerDetailPage = lazy(() => import('./pages/customers/CustomerDetailPage'))
const RegistersPage = lazy(() => import('./pages/finance/RegistersPage'))
const ExpensesPage = lazy(() => import('./pages/finance/ExpensesPage'))
const PayablesPage = lazy(() => import('./pages/finance/PayablesPage'))
const CashbookPage = lazy(() => import('./pages/finance/CashbookPage'))
const AccountingPage = lazy(() => import('./pages/finance/AccountingPage'))
const ReportsPage = lazy(() => import('./pages/reports/ReportsPage'))
const ApprovalsPage = lazy(() => import('./pages/ApprovalsPage'))
const UsersPage = lazy(() => import('./pages/admin/UsersPage'))
const RolesPage = lazy(() => import('./pages/admin/RolesPage'))
const LocationsPage = lazy(() => import('./pages/admin/LocationsPage'))
const SettingsPage = lazy(() => import('./pages/admin/SettingsPage'))
const AuditPage = lazy(() => import('./pages/admin/AuditPage'))
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'))

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { me, loading } = useAuth()
  const location = useLocation()
  if (loading) return <div className="p-8"><PageLoader /></div>
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  if (me.must_change_password && location.pathname !== '/account') return <Navigate to="/account?required=1" replace />
  return <>{children}</>
}

function Home() {
  const { can } = useAuth()
  if (can('dashboard.view')) return <DashboardPage />
  if (can('pos.sell')) return <Navigate to="/pos" replace />
  return <Navigate to="/catalog" replace />
}

export default function App() {
  return (
    <React.Suspense fallback={<div className="p-8"><PageLoader /></div>}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/sales/:id/print" element={<RequireAuth><InvoicePrintPage /></RequireAuth>} />
        <Route path="/returns/:id/print" element={<RequireAuth><InvoicePrintPage kind="credit-note" /></RequireAuth>} />
        <Route element={<RequireAuth><AppShell /></RequireAuth>}>
          <Route index element={<Home />} />
          <Route path="account" element={<AccountPage />} />
          <Route path="approvals" element={<ApprovalsPage />} />
          <Route path="outlets" element={<OutletsPage />} />
          <Route path="outlets/:id" element={<OutletPage />} />
          <Route path="catalog" element={<BooksPage />} />
          <Route path="catalog/new" element={<BookFormPage />} />
          <Route path="catalog/import" element={<ImportPage />} />
          <Route path="catalog/authors" element={<AuthorsPage />} />
          <Route path="schools" element={<SchoolsPage />} />
          <Route path="schools/import" element={<SchoolImportPage />} />
          <Route path="schools/email-template" element={<EmailTemplatePage />} />
          <Route path="schools/lists/:id" element={<BookListPage />} />
          <Route path="schools/orders/:id" element={<SchoolOrderDetailPage />} />
          <Route path="schools/:id" element={<SchoolDetailPage />} />
          <Route path="schools/:id/order" element={<SchoolOrderNewPage />} />
          <Route path="catalog/:id" element={<BookDetailPage />} />
          <Route path="catalog/:id/edit" element={<BookFormPage />} />
          <Route path="inventory" element={<StockPage />} />
          <Route path="inventory/copies" element={<CopiesPage />} />
          <Route path="inventory/labels" element={<LabelsPage />} />
          <Route path="inventory/adjustments" element={<AdjustmentsPage />} />
          <Route path="inventory/stocktakes/:id" element={<StocktakePage />} />
          <Route path="transfers" element={<TransfersPage />} />
          <Route path="transfers/new" element={<TransferNewPage />} />
          <Route path="transfers/:id" element={<TransferDetailPage />} />
          <Route path="suppliers" element={<SuppliersPage />} />
          <Route path="suppliers/:id" element={<SupplierDetailPage />} />
          <Route path="purchasing/orders" element={<PurchaseOrdersPage />} />
          <Route path="purchasing/orders/new" element={<PurchaseOrderFormPage />} />
          <Route path="purchasing/orders/:id" element={<PurchaseOrderDetailPage />} />
          <Route path="purchasing/orders/:id/edit" element={<PurchaseOrderFormPage />} />
          <Route path="purchasing/receipts" element={<GoodsReceiptsPage />} />
          <Route path="pos" element={<PosPage />} />
          <Route path="sales" element={<SalesPage />} />
          <Route path="sales/:id" element={<SaleDetailPage />} />
          <Route path="returns" element={<ReturnsPage />} />
          <Route path="returns/new" element={<ReturnNewPage />} />
          <Route path="returns/:id" element={<ReturnDetailPage />} />
          <Route path="customers" element={<CustomersPage />} />
          <Route path="customers/:id" element={<CustomerDetailPage />} />
          <Route path="finance/registers" element={<RegistersPage />} />
          <Route path="finance/expenses" element={<ExpensesPage />} />
          <Route path="finance/payables" element={<PayablesPage />} />
          <Route path="finance/cashbook" element={<CashbookPage />} />
          <Route path="finance/accounting" element={<AccountingPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="admin/users" element={<UsersPage />} />
          <Route path="admin/roles" element={<RolesPage />} />
          <Route path="admin/locations" element={<LocationsPage />} />
          <Route path="admin/settings" element={<SettingsPage />} />
          <Route path="admin/audit" element={<AuditPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </React.Suspense>
  )
}
