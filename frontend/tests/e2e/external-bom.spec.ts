import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'

test('the system BOM displays and exports every required external device and its board path', async ({ page }) => {
  const projectId = '123456789012345678901234', chatId = '123456789012345678901236'
  const rows = [
    { reference: 'U2', subsystem: 'TDS Sensor', mfr_part: 'SEN0244', pcb_references: ['J1'], manufacturer: 'DFRobot' },
    { reference: 'U3', subsystem: 'pH Sensor', mfr_part: 'SEN0161-V2', pcb_references: ['J2'], manufacturer: 'DFRobot' },
    { reference: 'U4', subsystem: 'Battery', mfr_part: '353', pcb_references: ['J3'], via_reference: 'U6', manufacturer: 'Adafruit' },
    { reference: 'U5', subsystem: 'Solar Panel', mfr_part: 'FIT0601', pcb_references: ['J3'], via_reference: 'U6', manufacturer: 'DFRobot' },
  ].map(row => ({ ...row, external: true, build_quantity: 1, status: 'DOCUMENTED_DEFAULT',
    unit_price_usd: null, extended_price_usd: null, stock: null, category: 'External',
    assembly: 'Connect using the documented module terminals and PCB harness.' }))
  const chat = { _id: chatId, project: projectId, title: 'Purifier', designModel: 'gpt-4.1-mini',
    bom: { rows, summary: { total_cost_usd: null, cost_complete: false, unpriced_references: rows.map(r => r.reference) } },
    pcb_ir: { components: [{ ref_id: 'J1', part_number: 'Header' }] } }
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '')
    let data: unknown = null
    if (path === '/auth/me') data = { _id: '123456789012345678901235', name: 'Tester', email: 'test@example.test', isVerified: true }
    else if (path === '/projects') data = { items: [{ _id: projectId, title: 'Purifier', status: 'active' }] }
    else if (path === '/projects/' + projectId) data = { _id: projectId, title: 'Purifier' }
    else if (path === '/chats/project/' + projectId) data = { items: [chat] }
    else if (path === '/chats/' + chatId) data = chat
    else if (path.endsWith('/messages')) data = { items: [] }
    else if (path === '/billing/plans') data = { billingEnabled: false, meteringEnabled: false, localRuntimeEnabled: false, packs: [] }
    else if (path === '/billing/quote') data = { credits: 20, kind: 'board' }
    else if (path === '/notifications/unread/count') data = { count: 0 }
    else if (path === '/account/keys') data = []
    await route.fulfill({ json: { success: true, data } })
  })
  await page.goto('/workspace')
  await page.getByRole('main').getByRole('button', { name: 'BOM', exact: true }).click()
  await expect(page.getByText('Required external devices', { exact: true })).toBeVisible()
  for (const part of ['SEN0244', 'SEN0161-V2', '353', 'FIT0601']) {
    await expect(page.getByRole('cell').filter({ hasText: part }).first()).toBeVisible()
  }
  await expect(page.getByText(/Battery · Adafruit 353 → U6 → PCB J3/)).toBeVisible()
  await expect(page.getByText(/Solar Panel · DFRobot FIT0601 → U6 → PCB J3/)).toBeVisible()
  await expect(page.getByText(/4 parts need supplier quotes/)).toBeVisible()
  await expect(page.getByText('Priced subtotal (USD)', { exact: true })).toBeVisible()
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const csv = await readFile((await (await downloading).path())!, 'utf8')
  for (const subsystem of ['TDS Sensor', 'pH Sensor', 'Battery', 'Solar Panel']) expect(csv).toContain(subsystem)
  expect(csv).toContain('External device')
  expect(csv).toContain('J3')
})
