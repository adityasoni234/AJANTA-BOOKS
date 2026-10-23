import { ApiError, qs } from '@/lib/api'
import { formatINR, isbn13Valid, titleCase } from '@/lib/utils'

describe('formatINR', () => {
  it('formats rupees with Indian digit grouping', () => {
    expect(formatINR('1234567.5')).toBe('₹12,34,567.50')
    expect(formatINR(0)).toBe('₹0.00')
  })
  it('renders a dash for missing values', () => {
    expect(formatINR(null)).toBe('—')
    expect(formatINR('')).toBe('—')
    expect(formatINR('abc')).toBe('—')
  })
})

describe('isbn13Valid', () => {
  it('accepts valid ISBN-13 with or without hyphens', () => {
    expect(isbn13Valid('9780306406157')).toBe(true)
    expect(isbn13Valid('978-0-306-40615-7')).toBe(true)
  })
  it('rejects bad checksums and non-book prefixes', () => {
    expect(isbn13Valid('9780306406158')).toBe(false)
    expect(isbn13Valid('2001234567890')).toBe(false)
  })
})

describe('ApiError', () => {
  it('maps validation details to field errors', () => {
    const e = new ApiError(422, { code: 'validation_failed', message: 'Request validation failed', details: [
      { loc: ['body', 'mrp'], msg: 'Field required' }, { loc: ['body', 'isbn13'], msg: 'Value error, Invalid ISBN-13' },
    ] })
    expect(e.fieldErrors()).toEqual({ mrp: 'Field required', isbn13: 'Invalid ISBN-13' })
    expect(e.fullMessage()).toContain('mrp: Field required')
  })
  it('joins string details such as password rules', () => {
    const e = new ApiError(422, { code: 'validation_failed', message: 'Password does not meet requirements', details: ['Too short', 'Too common'] })
    expect(e.fullMessage()).toBe('Password does not meet requirements: Too short; Too common')
  })
})

describe('helpers', () => {
  it('builds query strings without empty values', () => {
    expect(qs({ a: 1, b: '', c: undefined, d: 'x y' })).toBe('?a=1&d=x+y')
  })
  it('title-cases enum values', () => {
    expect(titleCase('PENDING_APPROVAL')).toBe('Pending Approval')
  })
})
