import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as React from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { PageHeader } from '@/components/common/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field, Input } from '@/components/ui/input'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDate } from '@/lib/utils'

interface SessionRow { id: string; created_at: string; last_seen_at: string; expires_at: string; ip: string | null; user_agent: string | null; current: boolean }

export default function AccountPage() {
  const { me, refresh } = useAuth()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const required = params.get('required') === '1' || me?.must_change_password
  const [cur, setCur] = React.useState('')
  const [pw, setPw] = React.useState('')
  const [pw2, setPw2] = React.useState('')
  const sessions = useQuery({
    queryKey: ['my-sessions'],
    queryFn: () => api.get<SessionRow[]>('/auth/sessions'),
    enabled: !me?.must_change_password,
  })
  const change = useMutation({
    mutationFn: () => api.post('/auth/change-password', { current_password: cur, new_password: pw }),
    onSuccess: async () => {
      toast.success('Password updated. Other sessions were signed out.')
      setCur(''); setPw(''); setPw2('')
      await refresh()
      if (required) navigate('/', { replace: true })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/auth/sessions/${id}/revoke`),
    onSuccess: () => { toast.success('Session revoked'); void qc.invalidateQueries({ queryKey: ['my-sessions'] }) },
  })
  return (
    <div className="max-w-3xl">
      <PageHeader title="Password & sessions" description={me ? `${me.full_name} · ${me.email} · ${me.role_name}` : undefined} />
      {required && (
        <div role="alert" className="mb-4 rounded-md border border-amber-200 bg-warning-soft px-4 py-3 text-sm text-amber-800">
          You must set a new password before continuing.
        </div>
      )}
      <Card className="mb-6">
        <CardHeader title="Change password" description="At least 10 characters with three of: lowercase, uppercase, digits, symbols." />
        <CardBody>
          <form
            className="grid gap-4 sm:grid-cols-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (pw !== pw2) return toast.error('New passwords do not match')
              change.mutate()
            }}
          >
            <Field label="Current password" htmlFor="cur"><Input id="cur" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></Field>
            <Field label="New password" htmlFor="new"><Input id="new" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></Field>
            <Field label="Confirm new password" htmlFor="new2"><Input id="new2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required /></Field>
            <div className="sm:col-span-3"><Button type="submit" loading={change.isPending}>Update password</Button></div>
          </form>
        </CardBody>
      </Card>
      {!me?.must_change_password && (
        <Card>
          <CardHeader title="Active sessions" description="Sign out of devices you don’t recognise." />
          <ul className="divide-y divide-border">
            {(sessions.data ?? []).map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-4 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm">{s.user_agent ?? 'Unknown device'}</p>
                  <p className="text-xs text-muted">{s.ip ?? '—'} · last active {formatDate(s.last_seen_at, true)}</p>
                </div>
                {s.current ? <Badge tone="success">This device</Badge> : (
                  <Button size="sm" variant="secondary" onClick={() => revoke.mutate(s.id)}>Sign out</Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
