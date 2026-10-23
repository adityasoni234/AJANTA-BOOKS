import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DataTable } from '@/components/common/DataTable'
import { StatusBadge } from '@/components/ui/badge'
import { ApiError } from '@/lib/api'

const cols = [{ key: 'n', header: 'Name', cell: (r: { id: string; name: string }) => r.name }]

describe('DataTable states', () => {
  it('shows a loading skeleton before data arrives', () => {
    render(<DataTable columns={cols} rows={undefined} rowKey={(r) => r.id} loading />)
    expect(screen.getByLabelText('Loading')).toBeInTheDocument()
  })
  it('shows the empty state', () => {
    render(<DataTable columns={cols} rows={[]} rowKey={(r) => r.id} empty={{ title: 'No books yet' }} />)
    expect(screen.getByText('No books yet')).toBeInTheDocument()
  })
  it('shows an error with retry', async () => {
    const retry = vi.fn()
    render(<DataTable columns={cols} rows={undefined} rowKey={(r) => r.id} error={new ApiError(500, { code: 'x', message: 'Server unavailable' })} onRetry={retry} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Server unavailable')
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(retry).toHaveBeenCalled()
  })
  it('renders rows and pagination, and handles row clicks', async () => {
    const onRow = vi.fn()
    const onPage = vi.fn()
    const rows = [{ id: '1', name: 'Monsoon Archive' }, { id: '2', name: 'Salt of the Konkan' }]
    render(<DataTable columns={cols} rows={rows} rowKey={(r) => r.id} onRowClick={onRow} page={1} pageSize={2} total={5} onPageChange={onPage} />)
    expect(screen.getByText('Salt of the Konkan')).toBeInTheDocument()
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument()
    await userEvent.click(screen.getByText('Monsoon Archive'))
    expect(onRow).toHaveBeenCalledWith(rows[0])
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(onPage).toHaveBeenCalledWith(2)
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
  })
})

describe('StatusBadge', () => {
  it('humanises status codes', () => {
    render(<StatusBadge status="PENDING_APPROVAL" />)
    expect(screen.getByText('Pending approval')).toBeInTheDocument()
  })
})
