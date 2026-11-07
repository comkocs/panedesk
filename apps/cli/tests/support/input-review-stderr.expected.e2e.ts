/** Startup-review output remains observable before exact business-output comparison. */
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@panedesk/dsh-loader-smoke'
import { expect, it } from 'vitest'
import { isInputReviewBanner, isInputReviewProgress, stripInputReviewStderr } from './input-review-stderr.ts'

it('prints the startup banner before the first review progress line', async () => {
  const result = await runLoaderSmoke({
    label: 'startup review diagnostic ordering',
    tempDirPrefix: 'input-review-stderr-',
    binScript: fileURLToPath(new URL('../../src/bin.ts', import.meta.url)),
    configPath: '',
    binArgs: [
      '--profile', 'headless', '--patch',
      fileURLToPath(new URL('../profiles/headless/tests/fixtures/headless-profile.patch.yml', import.meta.url)),
      '--json', 'Complete the keyless startup review check.',
    ],
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
    env: { PANEDESK_PERMISSION_MODE: 'danger-full-access', PANEDESK_TELEMETRY_DISABLED: '1' },
  })
  const lines = result.stderr.split(/\r?\n/u)
  const bannerIndex = lines.findIndex(isInputReviewBanner)
  const progressIndex = lines.findIndex(isInputReviewProgress)
  expect(bannerIndex, result.stderr).toBeGreaterThanOrEqual(0)
  expect(progressIndex, result.stderr).toBeGreaterThan(bannerIndex)
  expect(stripInputReviewStderr(result.stderr)).toBe('')

  const banner = 'Panedesk starting; protected input review precedes application startup. / Panedesk 正在启动；应用启动前先复核受保护输入。'
  const counted = 'Reviewing protected host inputs: 12 checked, 34 remaining. / 正在复核受保护宿主输入：已核 12，还剩 34。'
  const pending = 'Reviewing protected host inputs: 56 review steps completed; remaining work is being determined. / 正在复核受保护宿主输入：已完成 56 个复核步骤；剩余工作量正在确定。'
  const business = 'panedesk: reasoning:\nKeep this diagnostic.\n\n'
  expect(stripInputReviewStderr(`${banner}\n${business}${counted}\n${pending}\n`)).toBe(business)
  expect(stripInputReviewStderr(`${banner}\r\n${business}${counted}\r\n${pending}`)).toBe(business)
  const nearMatches = [
    `prefix ${banner}`,
    `${banner} suffix`,
    counted.replace('已核 12', '已核 13'),
    counted.replaceAll('12', '012'),
    counted.replaceAll('12', '-12'),
    counted.replaceAll('12', '1.2'),
    pending.replace('已完成 56', '已完成 57'),
    pending.replace('56 review', '56e0 review'),
    `${pending} `,
    'Protected host input review stalled.',
  ].join('\n')
  expect(stripInputReviewStderr(nearMatches)).toBe(nearMatches)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
