import { useQuery } from '@tanstack/react-query'
import { Pencil, Plus } from 'lucide-react'
import * as React from 'react'
import { Link, useParams } from 'react-router-dom'
import { DataTable } from '@/components/common/DataTable'
import { PageHeader } from '@/components/common/PageHeader'
import { StatCard } from '@/components/common/StatCard'
import { ErrorState, PageLoader } from '@/components/common/States'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { api, type Page } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDate, formatINR } from '@/lib/utils'
import { SupplierDialog, type Supplier } from './SuppliersPage'

interface Entry { date: string; type: string; ref: string; id: string; credit: string; debit: string; balance: string; status: string | null; due_date: string | null }

export default function SupplierDetailPage() {
  const { id } = useParams()
  const { can, canAny } = useAuth()
  const [edit, setEdit] = React.useState(false)
  const s = useQuery({ queryKey: ['supplier', id], queryFn: () => api.get<Supplier>(`/suppliers/${id}`) })
  const st = useQuery({ queryKey: ['supplier-statement', id], queryFn: () => api.get<{ entries: Entry[]; closing_balance: string }>(`/suppliers/${id}/statement`), enabled: canAny('finance.view', 'purchasing.view') })
  const pos = useQuery({ queryKey: ['supplier-pos', id], queryFn: () => api.get<Page<{ id: string; number: string; status: string; total: string; order_date: string; location_name: string }>>('/purchase-orders', { supplier_id: id, page_size: 10 }), enabled: can('purchasing.view') })
  if (s.isLoading) return <PageLoader />
  if (!s.data) return <ErrorState error={s.error} />
  const sup = s.data
  return (
    <div>
      <PageHeader title={sup.name} description={[sup.code, sup.gstin, sup.city].filter(Boolean).join(' · ')} crumbs={[{ label: 'Suppliers', to: '/suppliers' }, { label: sup.code }]}
        actions={<>
          {can('purchasing.create') && <Button variant="secondary" asChild><Link to={`/purchasing/orders/new?supplier=${sup.id}`}><Plus /> Purchase order</Link></Button>}
          {can('suppliers.manage') && <Button onClick={() => setEdit(true)}><Pencil /> Edit</Button>}
        </>} />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Outstanding payable" value={formatINR(sup.outstanding)} />
        <StatCard label="Overdue" value={formatINR(sup.overdue)} tone={Number(sup.overdue) > 0 ? 'danger' : 'success'} />
        <StatCard label="Payment terms" value={`${sup.payment_terms_days} days`} tone="info" />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader title="Contact" />
          <CardBody className="space-y-2 text-sm">
            <p>{sup.contact_person ?? '—'}</p><p className="text-muted">{sup.phone ?? '—'} · {sup.email ?? '—'}</p>
            <p className="text-muted">{[sup.address_line1, sup.city, sup.pincode].filter(Boolean).join(', ') || '—'}</p>
            <p>PAN: {sup.pan ?? '—'} · State {sup.state_code ?? '—'}</p>
            {sup.notes && <p className="text-slate-600">{sup.notes}</p>}
            <StatusBadge status={sup.is_active ? 'ACTIVE' : 'ARCHIVED'} label={sup.is_active ? 'Active' : 'Inactive'} />
          </CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Statement of account" description={st.data ? `Closing balance ${formatINR(st.data.closing_balance)}` : undefined}
            actions={can('finance.manage') && <Button size="sm" variant="secondary" asChild><Link to={`/finance/payables?supplier=${sup.id}`}>Record invoice / payment</Link></Button>} />
          <DataTable
            rows={st.data?.entries}
            loading={st.isLoading}
            error={st.error}
            rowKey={(e) => `${e.type}-${e.id}`}
            dense
            empty={{ title: 'No invoices or payments yet' }}
            columns={[
              { key: 'd', header: 'Date', cell: (e) => formatDate(e.date) },
              { key: 't', header: 'Type', cell: (e) => e.type === 'INVOICE' ? 'Invoice' : e.type === 'PAYMENT' ? 'Payment' : 'Debit note' },
              { key: 'r', header: 'Reference', cell: (e) => e.ref },
              { key: 'c', header: 'Billed', align: 'right', cell: (e) => Number(e.credit) ? formatINR(e.credit) : '' },
              { key: 'p', header: 'Paid / debit', align: 'right', cell: (e) => Number(e.debit) ? formatINR(e.debit) : '' },
              { key: 'b', header: 'Balance', align: 'right', cell: (e) => formatINR(e.balance) },
            ]}
          />
        </Card>
      </div>
      {can('purchasing.view') && (
        <Card className="mt-6">
          <CardHeader title="Recent purchase orders" />
          <DataTable
            rows={pos.data?.items}
            loading={pos.isLoading}
            rowKey={(p) => p.id}
            dense
            empty={{ title: 'No purchase orders' }}
            columns={[
              { key: 'n', header: 'PO', cell: (p) => <Link className="font-medium hover:text-primary" to={`/purchasing/orders/${p.id}`}>{p.number}</Link> },
              { key: 'd', header: 'Date', cell: (p) => formatDate(p.order_date) },
              { key: 'l', header: 'Deliver to', cell: (p) => p.location_name },
              { key: 't', header: 'Total', align: 'right', cell: (p) => formatINR(p.total) },
              { key: 's', header: 'Status', cell: (p) => <StatusBadge status={p.status} /> },
            ]}
          />
        </Card>
      )}
      <SupplierDialog open={edit} onOpenChange={setEdit} supplier={sup} />
    </div>
  )
}
