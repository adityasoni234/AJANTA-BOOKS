import { useQuery } from '@tanstack/react-query'
import * as React from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Field, Input, NativeSelect } from '@/components/ui/input'
import { api, errorMessage } from '@/lib/api'
import { AuthLayout } from './AuthLayout'

export default function SetupPage() {
  const navigate = useNavigate()
  const status = useQuery({ queryKey: ['setup-status'], queryFn: () => api.get<{ needs_setup: boolean; states: { code: string; name: string }[] }>('/setup/status') })
  const [f, setF] = React.useState({ setup_token: '', organization_name: '', state_code: '27', gstin: '', admin_email: '', admin_name: '', admin_password: '' })
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState<string | null>(null)
  if (status.data && !status.data.needs_setup) return <Navigate to="/login" replace />
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value })
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      await api.post('/setup', { ...f, gstin: f.gstin || null })
      toast.success('Setup complete — sign in with your administrator account')
      navigate('/login')
    } catch (e2) {
      setErr(errorMessage(e2))
    } finally {
      setBusy(false)
    }
  }
  return (
    <AuthLayout title="First-time setup" subtitle="Requires the SETUP_TOKEN configured on the server.">
      <form onSubmit={submit} className="space-y-3">
        {err && <div role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-red-700">{err}</div>}
        <Field label="Setup token" htmlFor="tok" required><Input id="tok" type="password" value={f.setup_token} onChange={set('setup_token')} required /></Field>
        <Field label="Business name" htmlFor="org" required><Input id="org" value={f.organization_name} onChange={set('organization_name')} required /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="State" htmlFor="st" required>
            <NativeSelect id="st" value={f.state_code} onChange={set('state_code')}>
              {status.data?.states.map((s) => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}
            </NativeSelect>
          </Field>
          <Field label="GSTIN (optional)" htmlFor="gstin"><Input id="gstin" value={f.gstin} onChange={set('gstin')} maxLength={15} /></Field>
        </div>
        <Field label="Administrator name" htmlFor="an" required><Input id="an" value={f.admin_name} onChange={set('admin_name')} required /></Field>
        <Field label="Administrator email" htmlFor="ae" required><Input id="ae" type="email" value={f.admin_email} onChange={set('admin_email')} required /></Field>
        <Field label="Password" htmlFor="ap" required hint="At least 10 characters; three of lowercase, uppercase, digits, symbols.">
          <Input id="ap" type="password" autoComplete="new-password" value={f.admin_password} onChange={set('admin_password')} required />
        </Field>
        <Button type="submit" className="w-full" loading={busy}>Create organisation</Button>
      </form>
    </AuthLayout>
  )
}
