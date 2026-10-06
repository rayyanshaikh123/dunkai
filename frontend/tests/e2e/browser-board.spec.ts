import { expect, test } from '@playwright/test'

test('routes a passive PCB in the browser with a confirmation and no engine', async ({ page }) => {
  await page.goto('/labs/browser-compute')
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Generate on this device' }).click()
  await expect(page.getByRole('status', { name: 'Board status' })).toContainText('Finished locally')
  await expect(page.getByText('1 routed trace')).toBeVisible()
  await expect(page.getByAltText('Test PCB layout')).toBeVisible()
  await expect(page.getByAltText('Test schematic')).toBeVisible()
})

test('routes a vetted eight-pin timer in the browser', async ({ page }) => {
  await page.goto('/labs/browser-compute')
  await expect(page.locator('label[data-ready]')).toHaveAttribute('data-ready', 'true')
  const source = page.getByRole('textbox', { name: 'PCB IR for local test' })
  const input = JSON.stringify({
    components: [
      { ref_id: 'U1', part_class: 'timer', part_number: 'NE555P', package: 'DIP8' },
      { ref_id: 'R1', part_class: 'resistor', value: '1k', package: '0603' },
    ],
    nets: [{ name: 'VCC', connections: ['U1.VCC', 'R1.1'] }],
    constraints: { board_outline: { width_mm: 40, height_mm: 30 } },
  })
  await source.fill(input)
  await expect(source).toHaveValue(input)
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Generate on this device' }).click()
  await expect(page.getByRole('status', { name: 'Board status' })).toContainText('Finished locally')
  await expect(page.getByText('1 routed trace')).toBeVisible()
  await expect(page.getByAltText('Test PCB layout')).toBeVisible()
})
