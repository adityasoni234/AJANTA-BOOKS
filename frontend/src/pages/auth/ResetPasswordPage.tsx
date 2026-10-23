import * as React from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { api, errorMessage } from '@/lib/api'
import { AuthLayout } from './AuthLayout'

export default function ResetPasswordPage() {
  const [params] = useSearchParams()
  const token = params.get('token')
  const [email, setEmail] = React.useState('')
  const [pw, setPw] = React.useState('')
  const [pw2, setPw2] = React.useState('')
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = React.useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setMsg(null)
    if (token && pw !== pw2) return setMsg({ ok: false, text: 'Passwords do not match' })
    setBusy(true)
    try {
      if (token) {
        const r = await api.post<{ message: string }>('/auth/password-reset/confirm', { token, new_password: pw })
        setMsg({ ok: true, text: r.message })
      } else {
        const r = await api.post<{ message: string }>('/auth/password-reset/request', { email })
        setMsg({ ok: true, text: r.message })
      }
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout title={token ? 'Choose a new password' : 'Reset password'} subtitle={token ? 'At least 10 characters, mixing letters, numbers and symbols.' : 'We’ll send a reset link if email is configured.'}>
      <form onSubmit={submit} className="space-y-4">
        {msg && <div role="status" className={`rounded-md px-3 py-2 text-sm ${msg.ok ? 'bg-success-soft text-emerald-800' : 'bg-danger-soft text-red-700'}`}>{msg.text}</div>}
        {token ? (
          <>
            <Field label="New password" htmlFor="pw"><Input id="pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></Field>
            <Field label="Confirm password" htmlFor="pw2"><Input id="pw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required /></Field>
          </>
        ) : (
          <Field label="Email" htmlFor="email"><Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        )}
        <Button type="submit" className="w-full" loading={busy}>{token ? 'Set password' : 'Send reset link'}</Button>
        <p className="text-center text-xs"><Link to="/login" className="text-primary hover:underline">Back to sign in</Link></p>
      </form>
    </AuthLayout>
  )
}
