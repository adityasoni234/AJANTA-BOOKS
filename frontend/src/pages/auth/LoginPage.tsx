import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import * as React from 'react'
import { useForm } from 'react-hook-form'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { AuthLayout } from './AuthLayout'

const schema = z.object({
  email: z.string().trim().email('Enter a valid email'),
  password: z.string().min(1, 'Enter your password'),
})
type Values = z.infer<typeof schema>

export default function LoginPage() {
  const { me, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [error, setError] = React.useState<string | null>(null)
  const setup = useQuery({ queryKey: ['setup-status'], queryFn: () => api.get<{ needs_setup: boolean }>('/setup/status') })
  const { register, handleSubmit, formState } = useForm<Values>({ resolver: zodResolver(schema) })
  const from = (location.state as { from?: string } | null)?.from ?? '/'

  if (me) return <Navigate to={me.must_change_password ? '/account?required=1' : from} replace />
  if (setup.data?.needs_setup) return <Navigate to="/setup" replace />

  const onSubmit = handleSubmit(async (v) => {
    setError(null)
    try {
      const res = await login(v.email, v.password)
      navigate(res.must_change_password ? '/account?required=1' : from, { replace: true })
    } catch (e) {
      setError(errorMessage(e))
    }
  })

  return (
    <AuthLayout title="Sign in" subtitle="Bookstore operations, inventory and finance">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error && <div role="alert" className="rounded-md border border-red-200 bg-danger-soft px-3 py-2 text-sm text-red-700">{error}</div>}
        <Field label="Email" htmlFor="email" error={formState.errors.email?.message}>
          <Input id="email" type="email" autoComplete="username" autoFocus aria-invalid={!!formState.errors.email} {...register('email')} />
        </Field>
        <Field label="Password" htmlFor="password" error={formState.errors.password?.message}>
          <Input id="password" type="password" autoComplete="current-password" aria-invalid={!!formState.errors.password} {...register('password')} />
        </Field>
        <Button type="submit" className="w-full" loading={formState.isSubmitting}>Sign in</Button>
        <p className="text-center text-xs text-muted">
          <Link to="/reset-password" className="text-primary hover:underline">Forgot password?</Link>
        </p>
        <p className="border-t border-border pt-4 text-center text-sm text-muted">
          New to the team? <Link to="/signup" className="font-medium text-primary hover:underline">Create an account</Link>
        </p>
      </form>
    </AuthLayout>
  )
}
