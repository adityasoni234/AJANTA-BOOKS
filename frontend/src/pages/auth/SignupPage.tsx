import { useQuery } from '@tanstack/react-query'
import { CheckCircle2 } from 'lucide-react'
import * as React from 'react'
import { Link, Navigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { ApiError, api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { AuthLayout } from './AuthLayout'

/** Staff create their own login; the owner approves it (and picks role and store) before it can be used. */
export default function SignupPage() {
  const { me } = useAuth()
  const setup = useQuery({ queryKey: ['setup-status'], queryFn: () => api.get<{ needs_setup: boolean }>('/setup/status') })
  const [f, setF] = React.useState({ full_name: '', email: '', phone: '', note: '', password: '', confirm: '' })
  const [errs, setErrs] = React.useState<Record<string, string>>({})
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [done, setDone] = React.useState(false)

  if (me) return <Navigate to="/" replace />
  if (setup.data?.needs_setup) return <Navigate to="/setup" replace />
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const v: Record<string, string> = {}
    if (f.full_name.trim().length < 2) v.full_name = 'Enter your full name'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) v.email = 'Enter a valid email'
    if (f.password.length < 10) v.password = 'At least 10 characters'
    if (f.password !== f.confirm) v.confirm = 'Passwords do not match'
    setErrs(v)
    setError(null)
    if (Object.keys(v).length) return
    setBusy(true)
    try {
      await api.post('/auth/signup', { full_name: f.full_name, email: f.email, phone: f.phone || null, note: f.note || null, password: f.password })
      setDone(true)
    } catch (e2) {
      if (e2 instanceof ApiError) setErrs(e2.fieldErrors())
      setError(errorMessage(e2))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <AuthLayout title="Request sent" subtitle="Your account has been created">
        <div className="space-y-4 text-center">
          <CheckCircle2 className="mx-auto size-10 text-success" aria-hidden />
          <p className="text-sm text-muted">The store owner will approve your account and choose your role and store. After that, sign in with the email and password you just set.</p>
          <Button asChild className="w-full"><Link to="/login">Go to sign in</Link></Button>
        </div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title="Create an account" subtitle="For staff of this bookstore. The owner approves new accounts.">
      <form onSubmit={submit} className="space-y-3" noValidate>
        {error && <div role="alert" className="rounded-md border border-red-200 bg-danger-soft px-3 py-2 text-sm text-red-700">{error}</div>}
        <Field label="Full name" htmlFor="su-name" required error={errs.full_name}><Input id="su-name" autoComplete="name" autoFocus value={f.full_name} onChange={set('full_name')} /></Field>
        <Field label="Email" htmlFor="su-email" required error={errs.email}><Input id="su-email" type="email" autoComplete="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Phone" htmlFor="su-phone" error={errs.phone}><Input id="su-phone" type="tel" autoComplete="tel" inputMode="tel" value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Which store do you work at?" htmlFor="su-note" hint="Optional message for the owner"><Input id="su-note" value={f.note} onChange={set('note')} placeholder="e.g. Fort, Mumbai — cashier" /></Field>
        <Field label="Password" htmlFor="su-pw" required error={errs.password} hint="At least 10 characters; three of lowercase, uppercase, digits, symbols.">
          <Input id="su-pw" type="password" autoComplete="new-password" value={f.password} onChange={set('password')} />
        </Field>
        <Field label="Confirm password" htmlFor="su-pw2" required error={errs.confirm}><Input id="su-pw2" type="password" autoComplete="new-password" value={f.confirm} onChange={set('confirm')} /></Field>
        <Button type="submit" className="w-full" loading={busy}>Create account</Button>
        <p className="text-center text-xs text-muted">Already have an account? <Link to="/login" className="text-primary hover:underline">Sign in</Link></p>
      </form>
    </AuthLayout>
  )
}
