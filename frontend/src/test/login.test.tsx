import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '@/lib/auth'
import LoginPage from '@/pages/auth/LoginPage'

function json(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

function renderLogin(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(fetchImpl))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<p>Home page</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => vi.unstubAllGlobals())

const me = { id: 'u1', email: 'owner@x.test', full_name: 'Owner', role_code: 'OWNER', role_name: 'Owner', permissions: ['dashboard.view'], all_locations: true, locations: [], must_change_password: false, organization_name: 'Shop', csrf_token: 'tok' }

describe('LoginPage', () => {
  it('validates fields before calling the API', async () => {
    const fetchMock = vi.fn((url: string) => url.includes('/auth/me') ? json(401, { error: { code: 'not_authenticated', message: 'x' } }) : json(200, { needs_setup: false }))
    renderLogin(fetchMock)
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Enter a valid email')).toBeInTheDocument()
    expect(screen.getByText('Enter your password')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/auth/login'))).toBe(false)
  })

  it('shows the server error for bad credentials', async () => {
    renderLogin((url) => {
      if (url.includes('/auth/me')) return json(401, { error: { code: 'not_authenticated', message: 'x' } })
      if (url.includes('/setup/status')) return json(200, { needs_setup: false })
      return json(401, { error: { code: 'invalid_credentials', message: 'Invalid email or password' } })
    })
    await userEvent.type(await screen.findByLabelText('Email'), 'owner@x.test')
    await userEvent.type(screen.getByLabelText('Password'), 'wrong')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password')
  })

  it('signs in and redirects home', async () => {
    renderLogin((url) => {
      if (url.includes('/auth/me')) return json(401, { error: { code: 'not_authenticated', message: 'x' } })
      if (url.includes('/setup/status')) return json(200, { needs_setup: false })
      return json(200, me)
    })
    await userEvent.type(await screen.findByLabelText('Email'), 'owner@x.test')
    await userEvent.type(screen.getByLabelText('Password'), 'Correct!Pass1')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getByText('Home page')).toBeInTheDocument())
  })
})
