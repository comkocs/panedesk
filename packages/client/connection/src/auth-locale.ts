/** Host authentication refusal text, paired for CLI and browser entry points. */
export const authLocale = {
  en: {
    required: 'Panedesk authentication required. API connections require an authenticated owner cookie.',
    unauthorized: 'Panedesk authentication required. API connections require an authenticated owner cookie.',
    forbidden: 'This request is not trusted. Use the host loopback address, the listener bind address, or a configured trusted host.',
  },
  zh: {
    required: '需要 Panedesk 身份认证。API 连接需要已认证所有者的 cookie。',
    unauthorized: '需要 Panedesk 身份认证。API 连接需要已认证所有者的 cookie。',
    forbidden: '此请求不受信任。请使用宿主回环地址、监听器绑定地址，或已配置的受信任主机。',
  },
} as const

/** HTTP status whose admission body is a bilingual refusal sentence. */
export type AuthAdmissionStatus = 401 | 403

/**
 * Bilingual body for an authentication or trust refusal. Status stays on the response.
 * @param status - 401 when unauthenticated, 403 when the request is not trusted.
 * @returns English and Chinese sentences separated by ` / `, ending in a newline.
 */
export function authAdmissionBody(status: AuthAdmissionStatus): string {
  const key = status === 401 ? 'unauthorized' : 'forbidden'
  return `${authLocale.en[key]} / ${authLocale.zh[key]}\n`
}
