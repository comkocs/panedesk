/** Data storage page labels. */
export const en = {
  title: 'Data storage',
  intro: 'Data stays on this computer by default. Enter your own PostgreSQL connection to store it there for shared access and easier backups. Conversation bodies stay on this computer.',
  local: 'Local (default)', postgres: 'PostgreSQL', backend: 'Storage backend',
  defaults: 'Default: local storage. PostgreSQL is used only after a successful startup connection; otherwise local storage is retained.',
  scope: 'Applies to', scopeHint: 'All storage-domain units on this host. Conversation bodies and local ledger files remain local. Shared database changes are loaded when each application restarts.',
  configuration: 'Configuration file', open: 'Open file', openFolder: 'Open containing folder',
  host: 'Host', port: 'Port (default: 5432)', database: 'Database', user: 'Username', password: 'Password', ssl: 'SSL',
  passwordHint: 'Passwords use the existing Panedesk credential store, never this configuration file. Leave untouched to retain the saved password.',
  passwordSaved: 'A password is stored.', passwordEmpty: 'No password is stored.',
  save: 'Save', test: 'Test connection', migrate: 'Copy existing local data to PostgreSQL',
  migrationHint: 'Save the connection first. Copies all local storage units without deleting local files or replacing existing PostgreSQL keys. Restart after migration.',
  restart: 'Takes effect after restart.', saved: 'Saved. Restart to apply.', connected: 'Connected.', failed: 'Failed',
  copied: 'Rows copied: {count}', loading: 'Loading…', refresh: 'Refresh', active: 'Active backend',
  fallback: 'PostgreSQL is unavailable; using local storage.', error: 'Could not complete the operation.',
} satisfies Record<string, string>
export type StorageKey = keyof typeof en
export const zh: Record<StorageKey, string> = {
  title: '数据存储',
  intro: '数据默认存在本机；填了自己的 PostgreSQL 就存到那里，多台机器可共用、好备份。会话正文仍留本机。',
  local: '本机（缺省）', postgres: 'PostgreSQL', backend: '存储后端',
  defaults: '缺省使用本机。启动时 PostgreSQL 连接成功才使用数据库；连不上则继续使用本机数据。',
  scope: '适用范围', scopeHint: '本主机所有 storage-domain 存储单元。会话正文和本机账本文件仍留本机；共享数据库的其他机器改动在各应用重启时读取。',
  configuration: '配置文件', open: '打开文件', openFolder: '打开所在目录',
  host: '主机', port: '端口（缺省 5432）', database: '库名', user: '用户名', password: '密码', ssl: 'SSL',
  passwordHint: '密码进入 Panedesk 现有凭据存储，不写入此配置文件；不编辑则保留已存密码。',
  passwordSaved: '已存密码。', passwordEmpty: '尚未存密码。',
  save: '保存', test: '测试连接', migrate: '把本机现有数据迁过去',
  migrationHint: '先保存连接配置。复制本机各存储单元，不删本机文件、不覆盖 PostgreSQL 已有键；迁移后请重启。',
  restart: '重启后生效。', saved: '已保存，重启后生效。', connected: '连上了。', failed: '失败',
  copied: '已写入 {count} 条', loading: '正在读取…', refresh: '刷新', active: '当前后端',
  fallback: 'PostgreSQL 不可用，已退回本机。', error: '操作未完成。',
}
