/** Locale-owned database connection settings copy. */
export const en = {
  title: 'Database connections',
  intro: 'Connect your own PostgreSQL: use 127.0.0.1 for a local database; enable “Connect through SSH” when the server database port is not public. Passwords are stored in Panedesk credentials, never in the configuration file.',
  defaults: 'Defaults: PostgreSQL port 5432, user and database postgres; SSL, SSH and model access off; SSH port 22. Fill the host and password plus any non-default user or database. MCP is not required.',
  permission: 'Model access allows any SQL permitted by this database account, including writes and deletion. Use an account with the permissions you intend to grant.',
  hostHint: 'Addresses and private-key paths are relative to the Panedesk Host, not your browser. With SSH, the database host is reached from the SSH server.',
  configuration: 'Configuration file', open: 'Open file', refresh: 'Refresh',
  empty: 'No connections yet. Add one to get started.', add: 'Add connection', edit: 'Edit', remove: 'Delete',
  confirmDelete: 'Delete this connection and its saved credentials?', cancel: 'Cancel', save: 'Save', saved: 'Connection saved.',
  name: 'Connection name', uri: 'Paste a PostgreSQL connection string (automatically fills the fields)',
  host: 'Database host', port: 'Database port', user: 'Database user', password: 'Database password', database: 'Database name',
  ssl: 'Use SSL (verify the server certificate)', modelEnabled: 'Let the model query this database',
  sshEnabled: 'Connect through SSH', sshHost: 'SSH server', sshPort: 'SSH port', sshUser: 'SSH user',
  privateKeyPath: 'Private key path on the Host', passphrase: 'Private key passphrase', browse: 'Choose file',
  secretHint: 'When editing, leave a secret blank to keep it; use Clear to remove it.', clearPassword: 'Clear saved password', clearPassphrase: 'Clear saved passphrase',
  test: 'Test connection', testing: 'Connecting…', testOk: 'Connected successfully.', testFailed: 'Could not connect. Check the connection details:',
  failure: 'The operation failed. Review the error and retry:', loading: 'Loading…',
  directory: 'Host directory', parent: 'Parent directory', go: 'Browse directory', choose: 'Select',
  uriError: 'Use a postgres:// or postgresql:// URL. Only sslmode=disable, require, verify-ca or verify-full is supported; use the fields for other options.',
} satisfies Record<string, string>

export type DatabaseKey = keyof typeof en
export const zh = {
  title: '数据库连接',
  intro: '连上你自己的 PostgreSQL：本地库填 127.0.0.1；服务器上的库端口不对外时勾“经 SSH 连接”。密码存在 Panedesk 凭据里，不写进配置文件。',
  defaults: '缺省：数据库端口 5432，用户名和库名 postgres；SSL、SSH 和模型查库关闭；SSH 端口 22。填主机与密码，再补非缺省的用户名和库名即可，无需 MCP。',
  permission: '模型查库开启后，能执行这个数据库账号获准的全部 SQL，包括写入和删除。请使用权限符合你预期的账号。',
  hostHint: '地址和私钥路径均以 Panedesk 宿主所在机器为准，不是浏览器所在机器。经 SSH 连接时，数据库主机从 SSH 服务器访问。',
  configuration: '配置文件', open: '打开文件', refresh: '刷新',
  empty: '还没有连接，先添加一个。', add: '添加连接', edit: '修改', remove: '删除',
  confirmDelete: '删除这个连接及其保存的凭据？', cancel: '取消', save: '保存', saved: '连接已保存。',
  name: '连接名称', uri: '粘贴 PostgreSQL 连接串（自动拆到分项）',
  host: '数据库主机', port: '数据库端口', user: '数据库用户名', password: '数据库密码', database: '库名',
  ssl: '使用 SSL（验证服务器证书）', modelEnabled: '让模型可以查这个库',
  sshEnabled: '经 SSH 连接', sshHost: 'SSH 服务器地址', sshPort: 'SSH 端口', sshUser: 'SSH 用户',
  privateKeyPath: '宿主上的私钥文件路径', passphrase: '私钥口令', browse: '选择文件',
  secretHint: '修改时密码或口令留空表示保留原值；勾选清除才会删除已存值。', clearPassword: '清除已存密码', clearPassphrase: '清除已存私钥口令',
  test: '测试连接', testing: '正在连接…', testOk: '连接成功。', testFailed: '没连上，请核对连接信息：',
  failure: '操作失败，请核对错误后重试：', loading: '正在读取…',
  directory: '宿主目录', parent: '上级目录', go: '浏览目录', choose: '选中',
  uriError: '请使用 postgres:// 或 postgresql:// 连接串；仅支持 sslmode=disable、require、verify-ca 或 verify-full，其他选项请通过分项设置。',
} satisfies Record<DatabaseKey, string>

declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { databaseConnections: DatabaseKey }
}
