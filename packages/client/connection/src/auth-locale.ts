/** Host authentication refusal text, paired for CLI and browser entry points. */
export const authLocale = {
  en: {
    macosSourceLimitation: 'Known limitation: macOS cannot identify product-sandbox connections; a valid owner cookie can still be replayed. Connection-source enforcement is required before the M9 stable release.',
    sandboxSource: 'This request comes from a sandbox process and cannot act as owner.',
    unknownSource: 'The connection source could not be verified and cannot act as owner.',
    confirm: 'Allow this browser to act as owner?',
    pending: 'Owner confirmation is required. Confirm in the host terminal and reload. Without a safe terminal, set requireOwnerConfirmation: false in protected host configuration only if you accept launch-link theft risk.',
    required: 'Panedesk authentication required. The launch link is single-use and expires after five minutes; restart the host for a new link. API connections require an authenticated owner cookie.',
  },
  zh: {
    macosSourceLimitation: '已知限制：macOS 无法识别本产品沙箱连接；有效 owner cookie 仍可被回放。M9 正式发布前必须补齐连接来源拦截。',
    sandboxSource: '本请求来自沙箱进程，不能以 owner 身份执行。',
    unknownSource: '本请求的连接来源查不出，不能以 owner 身份执行。',
    confirm: '允许此浏览器作为所有者操作吗？',
    pending: '需要所有者确认。请在宿主终端确认后刷新。没有安全终端时，仅在接受启动链接被盗风险的前提下，才可在受保护的宿主配置中设置 requireOwnerConfirmation: false。',
    required: '需要 Panedesk 身份认证。启动链接仅可使用一次，五分钟后失效；请重启宿主取得新链接。API 连接需要已认证所有者的 cookie。',
  },
} as const
