import { expect, test } from '@playwright/test'

test('a rejected inference displays the server credit error in one toast',async({page})=>{
  const message='This run needs 2 credits. Add credits to continue.'
  let calls=0
  await page.route('**/api/v1/auth/me',route=>route.fulfill({json:{data:{_id:'507f1f77bcf86cd799439011',name:'Tester',isVerified:true}}}))
  await page.route('**/api/v1/ai/browser-inference',route=>{
    calls+=1
    return route.fulfill({status:402,json:{success:false,message,errors:[{code:'insufficient_credits',required:2,available:0}]}})
  })
  await page.goto('/labs/browser-compute')
  await expect(page.getByRole('button',{name:'Run browser agents'})).toBeEnabled()
  page.once('dialog',dialog=>void dialog.accept())
  await page.getByRole('button',{name:'Run browser agents'}).click()
  const toast=page.locator('[data-sonner-toast]')
  await expect(toast).toHaveCount(1)
  await expect(toast).toContainText(message)
  await expect(toast).toContainText('Groq key in Settings')
  await expect(page.getByRole('status',{name:'Agent status'})).toContainText(message)
  expect(calls).toBe(1)
})
