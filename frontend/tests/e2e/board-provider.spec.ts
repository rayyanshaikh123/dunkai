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

test('an OpenAI PCB preference keeps the GPT mini model restored from the chat', async ({ page }) => {
  const projectId = '123456789012345678901234', chatId = '123456789012345678901236'
  await page.addInitScript(() => localStorage.setItem('dunkai-board-provider-v2', 'openai'))
  let requested: Record<string, unknown> | null = null
  const chat = { _id: chatId, project: projectId, title: 'Sensor chat', designModel: 'gpt-4.1-mini',
    bom: { rows: [{ reference: 'R1', mfr_part: '10k resistor', unit_price_usd: 0.1, build_quantity: 1 }] },
    pcb_ir: { components: [{ ref_id: 'R1', part_number: '10k resistor' }] } }
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '')
    let data: unknown = null
    if (path === '/auth/me') data = { _id: '123456789012345678901235', name: 'Tester', email: 'test@example.test', isVerified: true }
    else if (path === '/projects') data = { items: [{ _id: projectId, title: 'Sensor', status: 'active' }] }
    else if (path === '/projects/' + projectId) data = { _id: projectId, title: 'Sensor' }
    else if (path === '/chats/project/' + projectId) data = { items: [chat] }
    else if (path === '/chats/' + chatId) data = chat
    else if (path.endsWith('/messages')) data = { items: [] }
    else if (path === '/billing/plans') data = { billingEnabled: false, meteringEnabled: false, localRuntimeEnabled: false, packs: [] }
    else if (path === '/billing/quote') data = { credits: 20, kind: 'board' }
    else if (path === '/ai/run-stream') { requested = route.request().postDataJSON(); data = {} }
    else if (path === '/notifications/unread/count') data = { count: 0 }
    else if (path === '/account/keys') data = []
    await route.fulfill({ json: { success: true, data } })
  })
  await page.goto('/workspace')
  await expect(page.getByRole('button', { name: 'Select AI Model' })).toHaveText(/GPT-4.1 mini/)
  await page.getByRole('main').getByRole('button', { name: 'BOM', exact: true }).click()
  await page.getByRole('button', { name: /Generate PCB/ }).click()
  await expect.poll(() => requested).not.toBeNull()
  expect(requested).toMatchObject({ action: 'generate_board', provider: 'openai', model: 'gpt-4.1-mini', chatId })
})
