import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/common/PageHeader'
import { LoadingRows } from '@/components/common/States'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field, Input, NativeSelect } from '@/components/ui/input'
import { Switch } from '@/components/ui/misc'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { categoryOptions, useCategories, useTaxClasses } from '@/lib/queries'

type Policy = Record<string, string | number | boolean>
interface Org { legal_name: string; trade_name: string | null; gstin: string | null; gst_registration_type: string; pan: string | null; address_line1: string | null; address_line2: string | null; city: string | null; state: string | null; state_code: string; pincode: string | null; phone: string | null; email: string | null; financial_year_start_month: number; timezone: string }

export default function SettingsPage() {
  const { can } = useAuth()
  return (
    <div className="max-w-4xl">
      <PageHeader title="Settings" description="Organisation identity, GST, pricing and approval policies." />
      <Tabs defaultValue={can('settings.manage') ? 'org' : 'catalog'}>
        <TabsList>
          {can('settings.manage') && <TabsTrigger value="org">Organisation & GST</TabsTrigger>}
          {can('settings.manage') && <TabsTrigger value="policy">Policies</TabsTrigger>}
          {can('settings.manage') && <TabsTrigger value="tax">Tax classes</TabsTrigger>}
          <TabsTrigger value="catalog">Categories</TabsTrigger>
          {can('settings.manage') && <TabsTrigger value="integrations">Integrations</TabsTrigger>}
        </TabsList>
        <TabsContent value="org"><OrgSettings /></TabsContent>
        <TabsContent value="policy"><PolicySettings /></TabsContent>
        <TabsContent value="tax"><TaxClasses /></TabsContent>
        <TabsContent value="catalog"><Categories /></TabsContent>
        <TabsContent value="integrations"><Integrations /></TabsContent>
      </Tabs>
    </div>
  )
}

function OrgSettings() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['org'], queryFn: () => api.get<Org>('/organization') })
  const states = useQuery({ queryKey: ['states'], queryFn: () => api.get<{ code: string; name: string }[]>('/reference/states') })
  const [f, setF] = React.useState<Org | null>(null)
  React.useEffect(() => { if (q.data) setF(q.data) }, [q.data])
  const save = useMutation({
    mutationFn: () => api.put('/organization', { ...f, trade_name: f!.trade_name || null, gstin: f!.gstin || null, pan: f!.pan || null, email: f!.email || null, state: states.data?.find((s) => s.code === f!.state_code)?.name ?? f!.state }),
    onSuccess: () => { toast.success('Organisation updated'); void qc.invalidateQueries({ queryKey: ['org'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (!f) return <LoadingRows />
  const set = (k: keyof Org) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: k === 'financial_year_start_month' ? Number(e.target.value) : e.target.value })
  return (
    <Card>
      <CardHeader title="Business identity" description="Printed on every invoice. Changes apply to new invoices only; issued invoices keep their snapshot."
        actions={<Button size="sm" loading={save.isPending} onClick={() => save.mutate()}>Save</Button>} />
      <CardBody className="grid gap-4 sm:grid-cols-2">
        <Field label="Legal name" required><Input value={f.legal_name} onChange={set('legal_name')} /></Field>
        <Field label="Trade name"><Input value={f.trade_name ?? ''} onChange={set('trade_name')} /></Field>
        <Field label="GST registration"><NativeSelect value={f.gst_registration_type} onChange={set('gst_registration_type')}><option value="REGULAR">Regular (tax invoices)</option><option value="COMPOSITION">Composition (bill of supply)</option><option value="UNREGISTERED">Unregistered</option></NativeSelect></Field>
        <Field label="GSTIN" hint="Format and checksum are validated"><Input value={f.gstin ?? ''} maxLength={15} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} /></Field>
        <Field label="PAN"><Input value={f.pan ?? ''} maxLength={10} onChange={(e) => setF({ ...f, pan: e.target.value.toUpperCase() })} /></Field>
        <Field label="State"><NativeSelect value={f.state_code} onChange={set('state_code')}>{(states.data ?? []).map((s) => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}</NativeSelect></Field>
        <Field label="Address" className="sm:col-span-2"><Input value={f.address_line1 ?? ''} onChange={set('address_line1')} /></Field>
        <Field label="City"><Input value={f.city ?? ''} onChange={set('city')} /></Field>
        <Field label="PIN code"><Input value={f.pincode ?? ''} onChange={set('pincode')} /></Field>
        <Field label="Phone"><Input value={f.phone ?? ''} onChange={set('phone')} /></Field>
        <Field label="Email"><Input type="email" value={f.email ?? ''} onChange={set('email')} /></Field>
        <Field label="Financial year starts"><NativeSelect value={f.financial_year_start_month} onChange={set('financial_year_start_month')}>{['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</NativeSelect></Field>
        <Field label="Timezone"><Input value={f.timezone} onChange={set('timezone')} /></Field>
      </CardBody>
    </Card>
  )
}

const POLICY_FIELDS: { key: string; label: string; hint?: string; kind: 'bool' | 'num' | 'text' | 'select'; options?: [string, string][] }[] = [
  { key: 'prices_include_tax', label: 'Selling prices include GST', kind: 'bool' },
  { key: 'rounding', label: 'Invoice rounding', kind: 'select', options: [['NEAREST_RUPEE', 'Nearest rupee'], ['NONE', 'No rounding']] },
  { key: 'max_discount_pct', label: 'Cashier discount limit (%)', kind: 'num', hint: 'Above this, a manager must approve' },
  { key: 'return_window_days', label: 'Return window (days)', kind: 'num' },
  { key: 'po_approval_threshold', label: 'PO approval above (₹)', kind: 'num', hint: '0 disables approval' },
  { key: 'refund_approval_threshold', label: 'Refund approval above (₹)', kind: 'num' },
  { key: 'expense_approval_threshold', label: 'Expense approval above (₹)', kind: 'num' },
  { key: 'adjustment_approval_threshold', label: 'Stock adjustment approval above (₹)', kind: 'num' },
  { key: 'transfer_requires_approval', label: 'Transfers require approval', kind: 'bool' },
  { key: 'register_variance_alert', label: 'Alert on cash variance above (₹)', kind: 'num' },
  { key: 'credit_sales_enabled', label: 'Allow credit sales (receivables)', kind: 'bool' },
  { key: 'loyalty_enabled', label: 'Loyalty programme', kind: 'bool' },
  { key: 'loyalty_points_per_100', label: 'Points per ₹100 spent', kind: 'num' },
  { key: 'loyalty_point_value', label: 'Value of one point (₹)', kind: 'num' },
  { key: 'dead_stock_days', label: 'Dead stock after (days without sale)', kind: 'num' },
  { key: 'slow_moving_days', label: 'Slow-moving window (days)', kind: 'num' },
  { key: 'excess_stock_multiplier', label: 'Excess stock = reorder level ×', kind: 'num' },
  { key: 'barcode_prefix', label: 'In-store barcode prefix (200–299)', kind: 'text' },
  { key: 'sku_prefix', label: 'SKU prefix', kind: 'text' },
  { key: 'copy_code_prefix', label: 'Copy code prefix', kind: 'text' },
  { key: 'opening_balances_configured', label: 'Opening balances entered (enables complete balance sheet)', kind: 'bool' },
]

function PolicySettings() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['policy'], queryFn: () => api.get<Policy>('/settings/policy') })
  const [p, setP] = React.useState<Policy | null>(null)
  React.useEffect(() => { if (q.data) setP(q.data) }, [q.data])
  const save = useMutation({
    mutationFn: () => api.put<Policy>('/settings/policy', p),
    onSuccess: () => { toast.success('Policies saved'); void qc.invalidateQueries({ queryKey: ['policy'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (!p) return <LoadingRows />
  return (
    <Card>
      <CardHeader title="Pricing, approvals and operations" description="Changes are audited and apply immediately." actions={<Button size="sm" loading={save.isPending} onClick={() => save.mutate()}>Save</Button>} />
      <CardBody className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {POLICY_FIELDS.map((fdef) => fdef.kind === 'bool' ? (
          <label key={fdef.key} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
            {fdef.label}<Switch checked={!!p[fdef.key]} onCheckedChange={(v) => setP({ ...p, [fdef.key]: v })} />
          </label>
        ) : fdef.kind === 'select' ? (
          <Field key={fdef.key} label={fdef.label}><NativeSelect value={String(p[fdef.key])} onChange={(e) => setP({ ...p, [fdef.key]: e.target.value })}>{fdef.options!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</NativeSelect></Field>
        ) : (
          <Field key={fdef.key} label={fdef.label} hint={fdef.hint}><Input inputMode={fdef.kind === 'num' ? 'decimal' : 'text'} value={String(p[fdef.key] ?? '')} onChange={(e) => setP({ ...p, [fdef.key]: e.target.value })} /></Field>
        ))}
      </CardBody>
    </Card>
  )
}

function TaxClasses() {
  const qc = useQueryClient()
  const q = useTaxClasses()
  const [n, setN] = React.useState({ code: '', name: '', rate: '' })
  const create = useMutation({
    mutationFn: () => api.post('/tax-classes', { ...n, is_exempt: Number(n.rate) === 0, is_active: true }),
    onSuccess: () => { toast.success('Tax class added'); setN({ code: '', name: '', rate: '' }); void qc.invalidateQueries({ queryKey: ['tax-classes'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const toggle = useMutation({
    mutationFn: (t: { id: string; code: string; name: string; rate: string; is_exempt: boolean; is_active: boolean }) => api.put(`/tax-classes/${t.id}`, { ...t, is_active: !t.is_active }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tax-classes'] }),
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Card>
      <CardHeader title="GST tax classes" description="Assign a class to each book. Rates are configuration, never hard-coded. Printed books are commonly nil-rated (HSN 4901) — confirm with your accountant." />
      <ul className="divide-y divide-border">
        {(q.data ?? []).map((t) => (
          <li key={t.id} className="flex items-center justify-between px-5 py-2.5 text-sm">
            <span>{t.name} <Badge className="ml-1">{t.code}</Badge></span>
            <span className="flex items-center gap-3"><span className="num">{Number(t.rate)}%</span><Switch aria-label={`Active ${t.name}`} checked={t.is_active} onCheckedChange={() => toggle.mutate(t)} /></span>
          </li>
        ))}
      </ul>
      <CardBody className="flex flex-wrap items-end gap-2 border-t border-border">
        <Field label="Code" className="w-28"><Input value={n.code} onChange={(e) => setN({ ...n, code: e.target.value.toUpperCase() })} /></Field>
        <Field label="Name" className="flex-1"><Input value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} /></Field>
        <Field label="Rate %" className="w-24"><Input inputMode="decimal" value={n.rate} onChange={(e) => setN({ ...n, rate: e.target.value })} /></Field>
        <Button disabled={!n.code || !n.name || n.rate === ''} loading={create.isPending} onClick={() => create.mutate()}><Plus /> Add</Button>
      </CardBody>
    </Card>
  )
}

function Categories() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const cats = useCategories()
  const [name, setName] = React.useState('')
  const [parent, setParent] = React.useState('')
  const create = useMutation({
    mutationFn: () => api.post('/categories', { name, parent_id: parent || null }),
    onSuccess: () => { toast.success('Category added'); setName(''); void qc.invalidateQueries({ queryKey: ['categories'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const roots = (cats.data ?? []).filter((c) => !c.parent_id)
  return (
    <Card>
      <CardHeader title="Categories" description="Two levels: category › subcategory" />
      <ul className="divide-y divide-border">{categoryOptions(cats.data).map((c) => <li key={c.id} className={`px-5 py-2 text-sm ${c.label.includes('›') ? 'pl-10 text-slate-600' : 'font-medium'}`}>{c.label}</li>)}</ul>
      {can('catalog.master_data') && (
        <CardBody className="flex flex-wrap items-end gap-2 border-t border-border">
          <Field label="Name" className="flex-1"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Parent" className="w-56"><NativeSelect value={parent} onChange={(e) => setParent(e.target.value)}><option value="">Top level</option>{roots.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</NativeSelect></Field>
          <Button disabled={!name} loading={create.isPending} onClick={() => create.mutate()}><Plus /> Add</Button>
        </CardBody>
      )}
    </Card>
  )
}

function Integrations() {
  const q = useQuery({ queryKey: ['integrations'], queryFn: () => api.get<Record<string, { configured: boolean; provider: string | null }>>('/settings/integrations') })
  const labels: Record<string, [string, string]> = {
    email: ['Email (SMTP)', 'Password-reset links and supplier reminders. Configure SMTP_HOST, SMTP_FROM and credentials in the server environment.'],
    whatsapp: ['WhatsApp', 'Not configured. Messages are never reported as sent without a verified provider.'],
    payment_gateway: ['Payment gateway', 'Not configured. Card/UPI are recorded with a reference from the terminal; online payments need a gateway with server-verified webhooks.'],
  }
  return (
    <Card>
      <CardHeader title="Integrations" description="External services stay disabled until valid credentials are supplied on the server." />
      <ul className="divide-y divide-border">
        {Object.entries(q.data ?? {}).map(([k, v]) => (
          <li key={k} className="flex items-start justify-between gap-4 px-5 py-3">
            <div><p className="text-sm font-medium">{labels[k]?.[0] ?? k}</p><p className="text-xs text-muted">{labels[k]?.[1]}</p></div>
            {v.configured ? <Badge tone="success">Configured · {v.provider}</Badge> : <Badge>Not configured</Badge>}
          </li>
        ))}
      </ul>
    </Card>
  )
}
