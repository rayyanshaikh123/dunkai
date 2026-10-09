import { test, expect, type Page } from '@playwright/test'

async function billingFixture(page: Page, outcome: 'paid' | 'unpaid') {
  let paid = false
  const wallet = () => ({ currency: 'INR', trialAvailable: 500, paidAvailable: paid ? 1500 : 0,
    available: paid ? 2000 : 500, reserved: 0, unlimitedChats: true, freeChatsUsed: 0, freeChatsLimit: null,
    freeAllowanceUnit: 'credits', period: '2026-10' })
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '')
    let data: unknown = null
    if (path === '/auth/me') data = { _id: '123456789012345678901235', name: 'Tester', email: 'test@example.test', isVerified: true, provider: 'google' }
    else if (path === '/billing/plans') data = { billingEnabled: true, billingMode: 'test', meteringEnabled: true, localRuntimeEnabled: false,
      currency: 'INR', tariffVersion: 3, unlimitedChats: true, freeChatsPerMonth: null, trialCredits: 500, packs: [], rates: { chat: 2, pipeline: 30, board: 101 } }
    else if (path === '/billing/usage') data = { billingEnabled: true, meteringEnabled: true, period: '2026-10', wallet: wallet(), usage: {} }
    else if (path === '/billing/reconcile') {
      const body = route.request().postDataJSON()
      if (body.sessionId) expect(body.sessionId).toBe('cs_test_fixture')
      paid = outcome === 'paid'
      data = { payments: [{ orderId: 'fixture-order', sessionId: 'cs_test_fixture', status: paid ? 'paid' : 'expired', credits: 1500 }], errors: [], wallet: wallet() }
    } else if (path === '/ai/providers') data = { localRuntimeEnabled: false, engineReachable: true, boardProviders: [], chat: { byok: false, hosted: true } }
    else if (path === '/account/keys') data = []
    await route.fulfill({ json: { success: true, data } })
  })
}

test('checkout return confirms Stripe payment, refreshes the wallet, and shows the 500-credit welcome allowance', async ({ page }) => {
  await billingFixture(page, 'paid')
  await page.goto('/settings?checkout=success&session_id=cs_test_fixture')
  await expect(page.getByRole('status').filter({ hasText: '1,500 purchased credits are available' })).toBeVisible()
  await expect(page.getByText('2000', { exact: true })).toBeVisible()
  await expect(page.getByText('500 / 1500', { exact: true })).toBeVisible()
  await expect(page.getByText(/receive 500 free credits once/)).toBeVisible()
  await expect(page.getByText('Unlimited chats', { exact: true })).toBeVisible()
  await expect(page.getByText('Free design chats', { exact: true })).toHaveCount(0)
  await expect(page).toHaveURL(/\/settings$/)
  await page.getByRole('button', { name: 'Refresh balance', exact: true }).click()
  await expect(page.getByText('2000', { exact: true })).toBeVisible()
})

test('a success URL alone cannot display purchased credits when Stripe reports an unpaid checkout', async ({ page }) => {
  await billingFixture(page, 'unpaid')
  await page.goto('/settings?checkout=success&session_id=cs_test_fixture')
  await expect(page.getByRole('status').filter({ hasText: 'No new paid checkout was found' })).toBeVisible()
  await expect(page.getByText('500 / 0', { exact: true })).toBeVisible()
  await expect(page.getByText('2000', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Payment confirmed. Your credits are available.', { exact: true })).toHaveCount(0)
})
