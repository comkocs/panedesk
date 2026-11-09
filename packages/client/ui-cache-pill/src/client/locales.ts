/** `cachePill` namespace dictionaries. */

/** Simplified Chinese dictionary, the key-set source. */
export const zh = {
  'pill.label': '缓存',
  'pill.unknown': '缓存剩余未知',
  'pill.automatic': '自动缓存',
  'pill.disabled': '未缓存',
  'pill.estimated': '缓存估算剩余 {time}',
  'time.seconds': '{count} 秒',
  'time.minutes': '{count} 分钟',
  'time.hours': '{count} 小时',
  'time.hoursMinutes': '{hours} 小时 {minutes} 分钟',
  'time.minutesSeconds': '{minutes} 分钟 {seconds} 秒',
  'time.hoursMinutesSeconds': '{hours} 小时 {minutes} 分钟 {seconds} 秒',
  'panel.hits': '缓存命中 {count} token',
  'panel.hitsUnknown': '缓存命中未知',
  'panel.partial': '部分缓存记录不可用',
  'panel.denied': '无权限读取这个会话的缓存',
  'panel.title': '缓存剩余',
  'panel.loading': '正在读取缓存剩余时间',
  'panel.empty': '暂无缓存数据',
  'panel.error': '缓存剩余时间读取失败',
  'panel.unavailable': '当前部署没有缓存账本',
  'panel.main': '主窗口',
  'panel.subagent': '子代理 {id}',
  'panel.kind.unknown': '未知',
  'panel.kind.automatic': '自动缓存,只显示命中',
  'panel.kind.disabled': '未缓存',
  'panel.kind.estimated': '估算剩余 {time}',
  'tier.label': '缓存档',
  'tier.none': '不缓存',
  'tier.5m': '5 分钟',
  'tier.1h': '1 小时',
  'tier.30m': '30 分钟',
  'tier.12h': '12 小时',
  'tier.saved': '已保存,下一次请求生效',
  'tier.failed': '切换失败,当前档未改变',
  'tier.pending': '正在保存',
  'settings.visible': '显示「缓存剩余」标签',
  'settings.hint': '显示主窗与子代理提示缓存还剩多久;只有 Anthropic 与 DeepSeek 通路能算出剩余时间,其他提供商显示「未知」。',
  'settings.error': '保存失败,显示状态未改变',
} satisfies Record<string, string>

/** The cache pill namespace key union. */
export type CachePillKey = keyof typeof zh

declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Cache pill copy: the dock pill, the remaining-time panel, and the tier switch. */
    cachePill: CachePillKey
  }
}

/** English dictionary, complete against the zh key set. */
export const en = {
  'pill.label': 'Cache',
  'pill.unknown': 'Cache time unknown',
  'pill.automatic': 'Automatic cache',
  'pill.disabled': 'Not cached',
  'pill.estimated': 'Estimated cache left {time}',
  'time.seconds': '{count} seconds',
  'time.minutes': '{count} minutes',
  'time.hours': '{count} hours',
  'time.hoursMinutes': '{hours} hours {minutes} minutes',
  'time.minutesSeconds': '{minutes} minutes {seconds} seconds',
  'time.hoursMinutesSeconds': '{hours} hours {minutes} minutes {seconds} seconds',
  'panel.hits': 'Cache hit: {count} tokens',
  'panel.hitsUnknown': 'Cache hits unknown',
  'panel.partial': 'Some cache records are unavailable',
  'panel.denied': 'You do not have access to this session cache',
  'panel.title': 'Cache remaining',
  'panel.loading': 'Reading the cache time',
  'panel.empty': 'No cache data yet',
  'panel.error': 'The cache time could not be read',
  'panel.unavailable': 'This deployment has no cache ledger',
  'panel.main': 'Main window',
  'panel.subagent': 'Subagent {id}',
  'panel.kind.unknown': 'Unknown',
  'panel.kind.automatic': 'Automatic cache, hits only',
  'panel.kind.disabled': 'Not cached',
  'panel.kind.estimated': 'Estimated {time} left',
  'tier.label': 'Cache tier',
  'tier.none': 'No cache',
  'tier.5m': '5 minutes',
  'tier.1h': '1 hour',
  'tier.30m': '30 minutes',
  'tier.12h': '12 hours',
  'tier.saved': 'Saved; the next request uses it',
  'tier.failed': 'The switch failed; the current tier is unchanged',
  'tier.pending': 'Saving',
  'settings.visible': 'Show the "Cache remaining" label',
  'settings.hint': 'Show how long the prompt cache of the main window and subagents still has to live; only the Anthropic and DeepSeek routes can compute the remaining time, other providers show "Unknown".',
  'settings.error': 'The save failed; the visibility is unchanged',
} satisfies Record<CachePillKey, string>
