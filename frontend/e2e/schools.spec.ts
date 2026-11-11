import path from 'node:path'
import { expect, test } from '@playwright/test'
import { login } from './helpers'

test('owner imports a school list from Excel, orders sets and opens the author email', async ({ page }) => {
  await login(page, 'owner@ajantabooks.test')
  await page.goto('/schools/import')
  await page.locator('input[type=file]').setInputFiles(path.join(import.meta.dirname, 'fixtures', 'school_book_list.xlsx'))
  await page.getByRole('button', { name: 'Check file' }).click()
  await expect(page.getByText('2 ready · 0 with errors')).toBeVisible()
  await expect(page.getByText('New book', { exact: true })).toBeVisible()
  await expect(page.getByText(/^Matched AB-/)).toBeVisible()
  await page.getByRole('button', { name: 'Import 2 rows' }).click()
  await expect(page).toHaveURL(/\/schools$/)

  await page.getByRole('cell', { name: /E2E Test School/ }).click()
  await expect(page.getByRole('heading', { name: /E2E Test School/ })).toBeVisible()
  await page.getByRole('link', { name: 'Order books' }).click()
  await page.getByLabel('Sets for Class 9').fill('10')
  await page.getByRole('button', { name: 'Calculate quantities' }).click()
  const row = page.getByRole('row', { name: /E2E Workbook/ })
  await expect(row.getByRole('cell').nth(1)).toHaveText('20') // 10 sets × 2 per set
  await expect(row.getByLabel('Order quantity for E2E Workbook')).toHaveValue('20')
  await page.getByRole('button', { name: 'Create purchase orders' }).click()
  await expect(page).toHaveURL(/\/schools\/orders\//)

  await page.getByRole('row', { name: /Test Author/ }).getByRole('button', { name: 'Email author' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('test.author@authors.test')).toBeVisible()
  await expect(dialog.getByText(/Book order PO\/\d{4}\/\d+: E2E Test School, Class 9 \(10 sets\)/)).toBeVisible()
  await expect(dialog.getByText(/1\. E2E Workbook \(ISBN \d{13}\) - 20 copies/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Open in mail app' })).toBeEnabled()
})

test('shop owner sees school sets for their own shop only and cannot order', async ({ page }) => {
  await login(page, 'fort.manager@ajantabooks.test')
  await page.goto('/schools')
  await page.getByRole('cell', { name: /MMPS Senior Secondary School/ }).click()
  await expect(page.getByRole('columnheader', { name: 'Fort, Mumbai' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: /Bhiwandi|Pune|Bengaluru/ })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Order books' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Add class' })).toHaveCount(0)
  await page.getByRole('cell', { name: 'Class 11' }).click()
  await expect(page.getByText('Complete sets · Fort, Mumbai')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edit books' })).toHaveCount(0)
})
