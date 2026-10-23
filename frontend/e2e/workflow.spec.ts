import { expect, test } from '@playwright/test'
import { login, scan, setWorkingLocation, uniqueIsbn } from './helpers'

/**
 * Requirement 18: book setup → purchase receipt → transfer → sale with GST invoice → return → reports,
 * driven entirely through the UI against a real backend and database.
 */
test('complete bookstore workflow', async ({ page }) => {
  const isbn = uniqueIsbn()
  const title = `E2E Atlas of Indian Railways ${isbn.slice(-4)}`
  await login(page, 'owner@ajantabooks.test')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await expect(page.getByText('Sales today (incl. GST)')).toBeVisible()

  // 1. Add a new book
  await page.goto('/catalog/new')
  await page.getByLabel(/^Title/).fill(title)
  await page.getByLabel('Authors').fill('E2E Author')
  await page.getByLabel('ISBN-13').fill(isbn)
  await page.getByLabel('MRP (₹)').fill('600')
  await page.getByLabel('Selling price (₹)').fill('600')
  await page.getByRole('button', { name: 'Add book' }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  await expect(page.getByText(isbn).first()).toBeVisible()

  // 2. Purchase order → submit (owner auto-approves) → issue → receive goods
  await page.goto('/purchasing/orders/new')
  await page.getByLabel(/^Supplier/).selectOption({ index: 1 })
  await page.getByRole('combobox', { name: 'Search or scan book' }).fill(isbn)
  await page.getByRole('combobox', { name: 'Search or scan book' }).press('Enter')
  await expect(page.getByText(title)).toBeVisible()
  await page.getByLabel('Quantity', { exact: true }).fill('12')
  await page.getByLabel('Unit cost', { exact: true }).fill('350')
  await page.getByRole('button', { name: 'Save & submit' }).click()
  await expect(page.getByRole('heading', { name: /Approved/ })).toBeVisible()
  await page.getByRole('button', { name: 'Issue to supplier' }).click()
  await expect(page.getByRole('heading', { name: /Issued/ })).toBeVisible()
  await page.getByRole('button', { name: 'Receive goods' }).click()
  await page.getByRole('button', { name: 'Post goods receipt' }).click()
  await expect(page.getByRole('heading', { name: /Received/ })).toBeVisible()

  // 3. Transfer 5 copies to Fort, Mumbai: request → dispatch → receive
  await page.goto('/transfers/new')
  await page.getByLabel('From (source)').selectOption({ label: 'Central Warehouse — Bhiwandi' })
  await page.getByLabel('To (destination)').selectOption({ label: 'Fort, Mumbai' })
  await scan(page, isbn)
  await page.getByLabel(`Quantity for ${title}`).fill('5')
  await page.getByRole('button', { name: 'Submit request' }).click()
  await page.getByRole('button', { name: 'Dispatch', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Dispatch' }).click()
  await expect(page.getByRole('heading', { name: /In transit/ })).toBeVisible()
  await page.getByRole('button', { name: 'Receive', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm receipt' }).click()
  await expect(page.getByRole('heading', { name: /Completed/ })).toBeVisible()

  // 4. Sell 2 at Fort through the POS (scan ISBN, cash), check invoice
  await page.goto('/pos')
  await setWorkingLocation(page, 'Fort, Mumbai')
  const open = page.getByRole('button', { name: 'Open register' })
  if (await open.isVisible()) {
    await open.click()
    await page.getByRole('dialog').getByRole('button', { name: 'Open' }).click()
  }
  await scan(page, isbn)
  await page.getByRole('button', { name: 'Increase quantity' }).click()
  await expect(page.getByRole('button', { name: /Complete sale ₹1,200.00/ })).toBeEnabled()
  await page.getByRole('button', { name: /Complete sale/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Sale complete' })
  await expect(dialog).toBeVisible()
  const invoiceText = await dialog.getByText(/Invoice FRT\//).textContent()
  const invoiceNo = invoiceText!.replace('Invoice ', '').trim()
  expect(invoiceNo).toMatch(/^FRT\/\d{4}\/\d{6}$/)
  await dialog.getByRole('link', { name: 'Details' }).click()
  await expect(page.getByRole('heading', { name: new RegExp(invoiceNo) })).toBeVisible()
  await expect(page.getByText('Rupees One Thousand Two Hundred Only')).toBeVisible()

  // 5. Return one copy with a cash refund
  await page.getByRole('link', { name: 'Return / exchange' }).click()
  await page.getByLabel(`Return quantity for ${title}`).fill('1')
  await page.getByLabel(/^Reason/).fill('Customer bought a duplicate')
  await page.getByRole('button', { name: /Process return of 1 item/ }).click()
  await expect(page.getByText(/Return RET\//)).toBeVisible()
  await expect(page.getByText('₹600.00').first()).toBeVisible()

  // 6. Stock and reports reflect the flow
  await page.goto(`/catalog`)
  await page.getByPlaceholder(/Title, author, ISBN/).fill(isbn)
  await page.getByText(title).click()
  const fortRow = page.getByRole('row', { name: /Fort, Mumbai/ })
  await expect(fortRow.getByRole('cell').nth(1)).toHaveText('4') // 5 received − 2 sold + 1 returned
  await page.goto('/reports')
  await expect(page.getByText('Net sales (ex-GST)')).toBeVisible()
  await page.getByRole('tab', { name: 'GST' }).click()
  await expect(page.getByText('Rate & HSN-wise summary')).toBeVisible()
})
