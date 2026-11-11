import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftRight, BadgeCheck, Banknote, Bell, BookOpen, Boxes, Building2, ChartColumn, ClipboardCheck, ClipboardList,
  FileClock, KeyRound, Landmark, LayoutDashboard, LayoutGrid, LogOut, Menu, PackageCheck, PenLine, Receipt, RotateCcw, ScanBarcode,
  School, Settings, Warehouse, ShieldCheck, ShoppingCart, Store, Tag, Truck, UserCog, Users, Wallet, X,
} from 'lucide-react'
import * as React from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { LocationSelect } from '@/components/common/Filters'
import { GlobalSearch } from '@/components/layout/GlobalSearch'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import type { LocationBrief } from '@/lib/types'
import { cn, formatDate } from '@/lib/utils'

interface NavItem {
  to: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  perms?: string[] // any of
}

const NAV: { group: string; items: NavItem[] }[] = [
  { group: 'Overview', items: [
    { to: '/', label: 'Dashboard', icon: LayoutDashboard, perms: ['dashboard.view'] },
    { to: '/approvals', label: 'Approvals', icon: BadgeCheck, perms: ['approvals.view'] },
  ] },
  { group: 'Sales', items: [
    { to: '/pos', label: 'Point of sale', icon: ShoppingCart, perms: ['pos.sell'] },
    { to: '/sales', label: 'Sales & invoices', icon: Receipt, perms: ['sales.view'] },
    { to: '/returns', label: 'Returns', icon: RotateCcw, perms: ['returns.create', 'sales.view'] },
    { to: '/customers', label: 'Customers', icon: Users, perms: ['customers.view'] },
  ] },
  { group: 'Inventory', items: [
    { to: '/catalog', label: 'Book catalog', icon: BookOpen, perms: ['catalog.view'] },
    { to: '/catalog/authors', label: 'Authors', icon: PenLine, perms: ['catalog.view'] },
    { to: '/schools', label: 'Schools & book lists', icon: School, perms: ['schools.view'] },
    { to: '/inventory', label: 'Stock', icon: Boxes, perms: ['inventory.view'] },
    { to: '/inventory/copies', label: 'Copies & labels', icon: ScanBarcode, perms: ['inventory.view'] },
    { to: '/transfers', label: 'Transfers', icon: ArrowLeftRight, perms: ['transfers.view'] },
    { to: '/inventory/adjustments', label: 'Adjustments & counts', icon: ClipboardCheck, perms: ['inventory.view'] },
  ] },
  { group: 'Purchasing', items: [
    { to: '/suppliers', label: 'Suppliers', icon: Truck, perms: ['suppliers.view'] },
    { to: '/purchasing/orders', label: 'Purchase orders', icon: ClipboardList, perms: ['purchasing.view'] },
    { to: '/purchasing/receipts', label: 'Goods receipts', icon: PackageCheck, perms: ['purchasing.view'] },
  ] },
  { group: 'Finance', items: [
    { to: '/finance/registers', label: 'Registers', icon: Store, perms: ['registers.operate', 'registers.manage'] },
    { to: '/finance/expenses', label: 'Expenses', icon: Wallet, perms: ['expenses.view'] },
    { to: '/finance/payables', label: 'Payables', icon: Banknote, perms: ['finance.view'] },
    { to: '/finance/cashbook', label: 'Cashbook & banks', icon: Landmark, perms: ['finance.view'] },
    { to: '/finance/accounting', label: 'Accounting', icon: FileClock, perms: ['accounting.view'] },
  ] },
  { group: 'Insights', items: [
    { to: '/reports', label: 'Reports', icon: ChartColumn, perms: ['reports.view', 'reports.financial'] },
  ] },
  { group: 'Administration', items: [
    { to: '/admin/users', label: 'Employees & users', icon: UserCog, perms: ['users.view'] },
    { to: '/admin/roles', label: 'Roles & permissions', icon: ShieldCheck, perms: ['roles.manage'] },
    { to: '/admin/locations', label: 'Outlets & warehouses', icon: Building2, perms: ['locations.manage'] },
    { to: '/admin/settings', label: 'Settings', icon: Settings, perms: ['settings.manage', 'catalog.master_data'] },
    { to: '/admin/audit', label: 'Audit log', icon: Tag, perms: ['audit.view'] },
  ] },
]

/** One entry per location the user can supervise, built from their live location access. */
function outletGroup(locations: LocationBrief[]): { group: string; items: NavItem[] } {
  const sorted = [...locations].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'WAREHOUSE' ? -1 : 1))
  return {
    group: 'Outlets',
    items: [
      ...(sorted.length > 1 ? [{ to: '/outlets', label: 'All outlets', icon: LayoutGrid, perms: ['dashboard.view'] }] : []),
      ...sorted.map((l) => ({ to: `/outlets/${l.id}`, label: l.name, icon: l.type === 'WAREHOUSE' ? Warehouse : Store, perms: ['dashboard.view'] })),
    ],
  }
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { canAny, me } = useAuth()
  const groups = [NAV[0], outletGroup(me?.locations ?? []), ...NAV.slice(1)]
  return (
    <nav aria-label="Main navigation" className="flex h-full flex-col">
      <Link to="/" className="flex items-center gap-2.5 px-5 py-4" onClick={onNavigate}>
        <div className="flex size-8 items-center justify-center rounded-md bg-primary text-white">
          <BookOpen className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{me?.organization_name ?? 'Bookstore ERP'}</p>
          <p className="text-[11px] text-muted">Retail & warehouse</p>
        </div>
      </Link>
      <div className="flex-1 space-y-5 overflow-y-auto px-3 pb-6">
        {groups.map((g) => {
          const items = g.items.filter((i) => !i.perms || canAny(...i.perms))
          if (!items.length) return null
          return (
            <div key={g.group}>
              <p className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">{g.group}</p>
              <ul className="space-y-0.5">
                {items.map((i) => (
                  <li key={i.to}>
                    <NavLink
                      to={i.to}
                      end={i.to === '/' || i.to === '/inventory' || i.to === '/catalog' || i.to === '/outlets'}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        cn('flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-slate-600 transition-colors hover:bg-surface-2 hover:text-foreground',
                          isActive && 'bg-primary-soft font-medium text-primary hover:bg-primary-soft hover:text-primary')
                      }
                    >
                      <i.icon className="size-4 shrink-0" />
                      {i.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </div>
    </nav>
  )
}

interface Notification {
  id: string
  kind: string
  title: string
  body: string | null
  link: string | null
  created_at: string
  read_at: string | null
}

function Notifications() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ items: Notification[]; unread: number }>('/notifications', { page_size: 15 }),
    refetchInterval: 60_000,
  })
  const markAll = async () => {
    await api.post('/notifications/read', undefined)
    void qc.invalidateQueries({ queryKey: ['notifications'] })
  }
  const unread = q.data?.unread ?? 0
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} className="relative">
          <Bell />
          {unread > 0 && (
            <span className="absolute right-1.5 top-1.5 flex size-4 items-center justify-center rounded-full bg-danger text-[10px] font-semibold text-white">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <p className="text-sm font-semibold">Notifications</p>
          {unread > 0 && <button className="text-xs text-primary hover:underline" onClick={markAll}>Mark all read</button>}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {(q.data?.items ?? []).length === 0 && <p className="px-3 py-6 text-center text-sm text-muted">You’re all caught up.</p>}
          {(q.data?.items ?? []).map((n) => (
            <DropdownMenuItem
              key={n.id}
              className="flex-col items-start gap-0.5 rounded-none border-b border-border px-3 py-2 last:border-0"
              onSelect={async () => {
                if (!n.read_at) {
                  await api.post('/notifications/read', [n.id])
                  void qc.invalidateQueries({ queryKey: ['notifications'] })
                }
                if (n.link) navigate(n.link)
              }}
            >
              <span className={cn('text-sm', !n.read_at && 'font-semibold')}>{n.title}</span>
              {n.body && <span className="text-xs text-muted">{n.body}</span>}
              <span className="text-[11px] text-subtle">{formatDate(n.created_at, true)}</span>
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AccountMenu() {
  const { me, logout } = useAuth()
  const navigate = useNavigate()
  if (!me) return null
  const initials = me.full_name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-surface-2" aria-label="Account menu">
          <span className="flex size-8 items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-primary">{initials}</span>
          <span className="hidden text-left md:block">
            <span className="block text-sm font-medium leading-tight">{me.full_name}</span>
            <span className="block text-[11px] text-muted leading-tight">{me.role_name}</span>
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>{me.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/account')}><KeyRound /> Password & sessions</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={async () => {
            try {
              await logout()
            } finally {
              // Full navigation guarantees no cached data from this session survives in memory.
              window.location.assign('/login')
            }
          }}
        >
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AppShell() {
  const [mobileOpen, setMobileOpen] = React.useState(false)
  const { locationId, setLocationId } = useAuth()
  const loc = useLocation()
  React.useEffect(() => setMobileOpen(false), [loc.pathname])
  return (
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside className="no-print fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-border bg-white lg:block">
        <Sidebar />
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-border bg-white">
            <button className="absolute right-2 top-3 rounded p-1 text-muted" onClick={() => setMobileOpen(false)} aria-label="Close navigation">
              <X className="size-4" />
            </button>
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col lg:pl-60">
        <header className="no-print sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-white/90 px-4 backdrop-blur sm:px-6">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <Menu />
          </Button>
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-2">
            <LocationSelect value={locationId} onChange={setLocationId} className="hidden w-52 sm:block" label="Working location" />
            <Notifications />
            <AccountMenu />
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6">
          <ErrorBoundary key={loc.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  )
}
