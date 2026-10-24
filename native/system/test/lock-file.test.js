/** Dedicated ownership files retain POSIX interoperability and Windows sharing isolation. */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireExclusiveLockFile, tryLockExclusive } from '../packages/entry/lib/flock.js';

const posix = process.platform === 'linux' || process.platform === 'darwin';

test('dedicated lock files contend with existing POSIX descriptors and release on close', { skip: !posix }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ownership-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'owner.lock');
  const owner = await acquireExclusiveLockFile(path);
  t.after(() => owner.close());
  const legacy = await open(path, 'r+');
  t.after(() => legacy.close());
  await assert.rejects(tryLockExclusive(legacy.fd), { code: 'EAGAIN' });
  await assert.rejects(acquireExclusiveLockFile(path), { code: 'EAGAIN' });
  await owner.close();
  await tryLockExclusive(legacy.fd);
  await assert.rejects(acquireExclusiveLockFile(path), { code: 'EAGAIN' });
  await legacy.close();
  const next = await acquireExclusiveLockFile(path);
  await next.close();
});

test('Windows exclusive sharing opens only the dedicated lock file and never its data', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ownership-data-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'catalog.json');
  const lock = join(root, 'catalog.lock');
  await writeFile(data, 'retained data');
  let held = false;
  const options = { platform: 'win32', timeoutMs: 0, open: async (path, flags, mode) => {
    assert.equal(path, lock);
    assert.notEqual(path, data);
    assert.equal(flags, constants.O_RDWR | constants.O_CREAT | 0x10000000);
    assert.equal(mode, 0o600);
    if (held) throw Object.assign(new Error('private path must not escape'), { code: 'EBUSY' });
    held = true;
    return { close: async () => { held = false; } };
  } };
  const owner = await acquireExclusiveLockFile(lock, options);
  await assert.rejects(acquireExclusiveLockFile(lock, options), { code: 'EAGAIN' });
  assert.equal(await readFile(data, 'utf8'), 'retained data');
  await owner.close();
  const next = await acquireExclusiveLockFile(lock, options);
  await next.close();
});

for (const code of ['EBUSY', 'EPERM']) {
  test(`Windows retries transient ${code} before granting ownership`, async () => {
    let attempts = 0;
    const handle = { close: async () => {} };
    const result = await acquireExclusiveLockFile('owner.lock', {
      platform: 'win32', timeoutMs: 100, retryMs: 1,
      open: async () => {
        if (++attempts < 3) throw Object.assign(new Error('temporary contention'), { code });
        return handle;
      },
    });
    assert.equal(result, handle);
    assert.equal(attempts, 3);
  });

  test(`Windows bounds ${code} retries and reports only the lock filename`, async () => {
    let attempts = 0;
    await assert.rejects(acquireExclusiveLockFile('C:\\private\\owner.lock', {
      platform: 'win32', timeoutMs: 15, retryMs: 5,
      open: async () => {
        attempts++;
        throw Object.assign(new Error('C:\\private\\secret contents'), { code });
      },
    }), (error) => {
      assert.equal(error.code, 'EAGAIN');
      assert.equal(error.syscall, 'open');
      assert.match(error.message, /owner\.lock/);
      assert.doesNotMatch(error.message, /private|secret|C:/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.ok(attempts >= 2 && attempts < 10);
  });
}

test('Windows does not retry unrelated I/O failures', async () => {
  let attempts = 0;
  const failure = Object.assign(new Error('I/O failed'), { code: 'EIO' });
  await assert.rejects(acquireExclusiveLockFile('owner.lock', {
    platform: 'win32', open: async () => { attempts++; throw failure; },
  }), (error) => error === failure);
  assert.equal(attempts, 1);
});
