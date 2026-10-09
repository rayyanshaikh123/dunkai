import { test, expect } from '@playwright/test'

test('Settings pairs and revokes a computer, displays model-call pricing and downloads the runtime', async ({ page }) => {
  let connected = false, downloaded = false
  const device = { id: '123456789012345678901234', name: 'Test laptop', ready: true, connected: true, preferred: true, mode: 'hosted', expiresAt: '2026-11-07T00:00:00Z', capabilities: { boardSandbox: true } }
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '')
    let data: unknown = null
    if (path === '/auth/me') data = { _id: '123456789012345678901235', name: 'Tester', email: 'test@example.com', isVerified: true }
    else if (path === '/billing/plans') data = { billingEnabled: false, meteringEnabled: true, localRuntimeEnabled: true, currency: 'INR', tariffVersion: 3, unlimitedChats: true, freeChatsPerMonth: null, trialCredits: 500, packs: [], rates: { inference: 2, board: 0, pipeline: 0 } }
    else if (path === '/billing/usage') data = { billingEnabled: false, meteringEnabled: true, period: '2026-10', wallet: { available: 500, trialAvailable: 500, paidAvailable: 0, reserved: 0, unlimitedChats: true, freeChatsUsed: 0, freeChatsLimit: null } }
    else if (path === '/ai/providers') data = { localRuntimeEnabled: true, engineReachable: connected, boardProviders: [], runtime: connected ? device : null, chat: { byok: false, hosted: true } }
    else if (path === '/account/keys') data = []
    else if (path === '/runtime/devices' && route.request().method() === 'GET') data = { localRuntimeEnabled: true, devices: connected ? [device] : [] }
    else if (path === '/runtime/pairing/approve') {
      expect(route.request().postDataJSON().code).toBe('ABCDE-12345'); connected = true; data = device
    } else if (path.startsWith('/runtime/devices/') && route.request().method() === 'DELETE') connected = false
    else if (path === '/runtime/download') { downloaded = true; await route.fulfill({ status: 200, contentType: 'application/zip', body: 'runtime fixture' }); return }
    await route.fulfill({ json: { success: true, data } })
  })
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'This computer' })).toBeVisible()
  await expect(page.getByText('Unlimited chats', { exact: true })).toBeVisible()
  await expect(page.getByText('Free hosted model calls', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Your API keys', exact: true })).toHaveCount(0)
  await page.getByLabel('Computer pairing code').fill('ABCDE-12345')
  await page.getByRole('button', { name: 'Connect this computer' }).click()
  await expect(page.getByText('Test laptop · Default', { exact: true })).toBeVisible()
  await expect(page.getByText(/Ready · Hosted Groq/)).toBeVisible()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download local runtime' }).click()
  expect((await downloadPromise).suggestedFilename()).toBe('dunkai-runtime.zip'); expect(downloaded).toBe(true)
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(page.getByText('Test laptop · Default', { exact: true })).toHaveCount(0)
})
