/** Uninstall copy preserves owner storage and directs manual label cleanup. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('includes localized owner-label guidance in the uninstall log and finish page', () => {
  const script = readFileSync(new URL('../installer/uninstall.nsh', import.meta.url), 'utf8')
  const strings = readFileSync(new URL('../installer/strings.nsh', import.meta.url), 'utf8')
  expect(script).toContain('DetailPrint "$(INSTALLER_OWNER_RETAINED)"')
  expect(script).toContain('!define MUI_FINISHPAGE_TEXT "$(INSTALLER_OWNER_RETAINED)"')
  expect(strings).toContain('LangString INSTALLER_OWNER_RETAINED ${LANG_ENGLISH} "The Harness home and credential-directory read protection have been preserved. To remove them completely, stop all Panedesk processes, run panedesk cleanup-owner-labels --stopped <directory>, then delete the home."')
  expect(strings).toContain('LangString INSTALLER_OWNER_RETAINED ${LANG_SIMPCHINESE} "已保留 Harness home 及其中凭据目录的读保护。要彻底移除，请先停掉全部 Panedesk 进程，运行 panedesk cleanup-owner-labels --stopped <目录>，再删除 home。"')
})
