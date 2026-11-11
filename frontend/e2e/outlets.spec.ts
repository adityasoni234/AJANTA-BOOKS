import { expect, test } from '@playwright/test'
import { login } from './helpers'

test('owner supervises every outlet from the sidebar, including a newly opened one', async ({ page }) => {
  await login(page, 'owner@ajantabooks.test')
  // Open a new outlet the way an admin would (Administration → Outlets & warehouses uses this API).
  const status = await page.evaluate(async () => {
    const csrf = decodeURIComponent(document.cookie.match(/ab_csrf=([^;]+)/)?.[1] ?? '')
    const r = await fetch('/api/v1/locations', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ code: 'OUT-AMD', name: 'CG Road, Ahmedabad', type: 'OUTLET', city: 'Ahmedabad', state: 'Gujarat', state_code: '24', invoice_prefix: 'AMD' }),
    })
    return r.status
  })
  expect(status).toBe(201)
  await page.reload()

  const nav = page.getByRole('navigation', { name: 'Main navigation' })
  for (const name of ['All outlets', 'Central Warehouse — Bhiwandi', 'Fort, Mumbai', 'FC Road, Pune', 'Church Street, Bengaluru', 'CG Road, Ahmedabad']) {
    await expect(nav.getByRole('link', { name })).toBeVisible()
  }

  await nav.getByRole('link', { name: 'All outlets' }).click()
  await expect(page.getByRole('heading', { name: 'Outlets' })).toBeVisible()
  await expect(page.getByRole('row', { name: /All locations/ })).toBeVisible()

  await nav.getByRole('link', { name: 'Fort, Mumbai' }).click()
  await expect(page.getByRole('heading', { name: /Fort, Mumbai/ })).toBeVisible()
  await expect(page.getByText(/^Today ·/)).toBeVisible()
  await expect(page.getByText(/^This month ·/)).toBeVisible()
  await expect(page.getByText('Stock ready to sell')).toBeVisible()
  await page.getByRole('tab', { name: 'Stock' }).click()
  await expect(page.getByText('What kind of stock')).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Stationery' })).toBeVisible()
  await page.getByRole('tab', { name: 'Sales' }).click()
  await page.getByRole('button', { name: 'This month' }).click()
  await page.getByRole('tab', { name: /Staff/ }).click()
  await expect(page.getByRole('cell', { name: /Nikhil Patil/ })).toBeVisible()

  await nav.getByRole('link', { name: 'CG Road, Ahmedabad' }).click()
  await expect(page.getByRole('heading', { name: /CG Road, Ahmedabad/ })).toBeVisible()
  await expect(page.locator('p', { hasText: 'Stock ready to sell' }).locator('xpath=..')).toContainText('0 units')
  await expect(page.getByText('₹0.00').first()).toBeVisible()
})

test('shop owner sees only their own outlet in the sidebar', async ({ page }) => {
  await login(page, 'fort.manager@ajantabooks.test')
  const nav = page.getByRole('navigation', { name: 'Main navigation' })
  await expect(nav.getByRole('link', { name: 'Fort, Mumbai' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'All outlets' })).toHaveCount(0)
  await expect(nav.getByRole('link', { name: 'FC Road, Pune' })).toHaveCount(0)
})
