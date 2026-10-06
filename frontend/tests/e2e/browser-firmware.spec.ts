import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

test('compiles a multi-file Uno project locally and downloads valid Intel HEX', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  let serverBuilds = 0
  page.on('request', (request) => { if (request.url().includes('/firmware/compile')) serverBuilds += 1 })
  await page.goto('/labs/browser-compute')
  await expect(page.getByRole('button', { name: 'Compile locally' })).toBeEnabled()
  await page.getByRole('textbox', { name: 'Firmware source files' }).fill(JSON.stringify([
    { filename: 'main.ino', code: '#include "helper.h"\nvoid setup(){pinMode(13,OUTPUT);}\nvoid loop(){blink();}' },
    { filename: 'helper.h', code: 'void blink();' },
    { filename: 'helper.cpp', code: '#include <Arduino.h>\n#include <Wire.h>\n#include <SPI.h>\n#include "helper.h"\nvoid blink(){Wire.begin();SPI.begin();digitalWrite(13,HIGH);delay(100);digitalWrite(13,LOW);delay(100);}' },
  ]))
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Compile locally' }).click()
  await expect(page.getByRole('status', { name: 'Firmware status' })).toContainText('application flash on this device', { timeout: 150_000 })
  const downloading = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download HEX' }).click()
  const download = await downloading
  const path = testInfo.outputPath('firmware.hex')
  await download.saveAs(path)
  const hex = await readFile(path, 'utf8')
  expect(hex).toContain(':00000001FF')
  for (const line of hex.trim().split('\n')) {
    expect(line).toMatch(/^:[0-9A-F]+$/)
    const bytes = line.slice(1).match(/../g)!.map((value) => Number.parseInt(value, 16))
    expect(bytes.reduce((sum, byte) => sum + byte, 0) & 255).toBe(0)
  }
  expect(serverBuilds).toBe(0)
})
