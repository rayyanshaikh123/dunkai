import { test, expect } from '@playwright/test'

test('Auto is the default, ignores old PCB preferences, and can be restored after an explicit override', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('dunkai-board-provider', 'groq'))
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '')
    let data: unknown = null
    if (path === '/auth/me') data = { _id: '123456789012345678901235', name: 'Tester', email: 'test@example.test', isVerified: true }
    else if (path === '/billing/plans') data = { billingEnabled: false, meteringEnabled: false, localRuntimeEnabled: false, currency: 'INR', trialCredits: 500, packs: [], rates: {} }
    else if (path === '/ai/providers') data = { engineReachable: true, defaultBoardProvider: 'groq', boardProviders: [{ id: 'groq', available: true, source: 'hosted', reason: null }], chat: { byok: false, hosted: true } }
    else if (path === '/account/keys') data = []
    await route.fulfill({ json: { success: true, data } })
  })
  await page.goto('/settings')
  const picker = page.getByRole('combobox', { name: 'Board generation model' })
  await expect(picker).toHaveText(/Auto · chat model/)
  await picker.click()
  await page.getByRole('option', { name: /^Groq/ }).click()
  await expect(picker).toHaveText(/Groq/)
  await page.reload()
  await expect(picker).toHaveText(/Groq/)
  await picker.click()
  await page.getByRole('option', { name: /^Auto/ }).click()
  await page.reload()
  await expect(picker).toHaveText(/Auto · chat model/)
})
