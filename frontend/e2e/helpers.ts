import { expect, type Page } from '@playwright/test'

export const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo@Books2026'

export async function login(page: Page, email: string, password = DEMO_PASSWORD) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/login/)
}

export async function setWorkingLocation(page: Page, name: string) {
  await page.getByLabel('Working location').selectOption({ label: name })
}

/** Type into the scan box and press Enter like a barcode scanner. */
export async function scan(page: Page, code: string) {
  const box = page.getByRole('combobox', { name: 'Search or scan book' })
  await box.fill(code)
  await box.press('Enter')
}

export function uniqueIsbn(): string {
  // 979-8 prefix (valid ISBN-13 space), random body, correct check digit.
  const body = '9798' + String(Date.now()).slice(-8)
  const sum = body.split('').reduce((a, c, i) => a + Number(c) * (i % 2 ? 3 : 1), 0)
  return body + String((10 - (sum % 10)) % 10)
}
