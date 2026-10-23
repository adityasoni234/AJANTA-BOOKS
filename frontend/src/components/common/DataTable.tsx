import { ChevronLeft, ChevronRight } from 'lucide-react'
import * as React from 'react'
import { Button } from '@/components/ui/button'
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table'
import { cn, formatNumber } from '@/lib/utils'
import { EmptyState, ErrorState, LoadingRows } from './States'

export interface Column<T> {
  key: string
  header: React.ReactNode
  cell: (row: T) => React.ReactNode
  align?: 'left' | 'right' | 'center'
  className?: string
  hideBelow?: 'sm' | 'md' | 'lg'
}

interface Props<T> {
  columns: Column<T>[]
  rows: T[] | undefined
  rowKey: (row: T) => string
  loading?: boolean
  error?: unknown
  onRetry?: () => void
  onRowClick?: (row: T) => void
  empty?: { title: string; description?: string; action?: React.ReactNode }
  page?: number
  pageSize?: number
  total?: number
  onPageChange?: (page: number) => void
  footer?: React.ReactNode
  dense?: boolean
}

const HIDE = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell' }

export function DataTable<T>({ columns, rows, rowKey, loading, error, onRetry, onRowClick, empty, page, pageSize, total, onPageChange, footer, dense }: Props<T>) {
  if (error) return <ErrorState error={error} onRetry={onRetry} />
  if (loading && !rows) return <LoadingRows cols={Math.min(columns.length, 6)} />
  if (!rows || rows.length === 0) {
    return <EmptyState title={empty?.title ?? 'Nothing here yet'} description={empty?.description} action={empty?.action} />
  }
  const pages = total && pageSize ? Math.max(1, Math.ceil(total / pageSize)) : 1
  return (
    <div className={cn(loading && 'opacity-60 transition-opacity')}>
      <Table>
        <THead>
          <TR>
            {columns.map((c) => (
              <TH key={c.key} className={cn(c.align === 'right' && 'text-right', c.align === 'center' && 'text-center', c.hideBelow && HIDE[c.hideBelow], c.className)}>
                {c.header}
              </TH>
            ))}
          </TR>
        </THead>
        <TBody>
          {rows.map((row) => (
            <TR
              key={rowKey(row)}
              className={cn(onRowClick && 'cursor-pointer hover:bg-surface')}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(row) } : undefined}
            >
              {columns.map((c) => (
                <TD key={c.key} className={cn(dense && 'py-1.5', c.align === 'right' && 'text-right num', c.align === 'center' && 'text-center', c.hideBelow && HIDE[c.hideBelow], c.className)}>
                  {c.cell(row)}
                </TD>
              ))}
            </TR>
          ))}
        </TBody>
        {footer}
      </Table>
      {onPageChange && total !== undefined && pageSize && total > pageSize && (
        <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs text-muted">
          <span>
            {formatNumber((page! - 1) * pageSize + 1)}–{formatNumber(Math.min(page! * pageSize, total))} of {formatNumber(total)}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" aria-label="Previous page" disabled={page! <= 1} onClick={() => onPageChange(page! - 1)}>
              <ChevronLeft />
            </Button>
            <span className="px-2">Page {page} of {pages}</span>
            <Button variant="ghost" size="icon-sm" aria-label="Next page" disabled={page! >= pages} onClick={() => onPageChange(page! + 1)}>
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
