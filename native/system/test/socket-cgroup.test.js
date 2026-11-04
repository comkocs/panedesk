/** Real TCP attribution through the published Linux socket-query entry. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync, statSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import test from 'node:test';
import { loadSocketCgroupQuery } from '../packages/entry/lib/socket-cgroup.js';

for (const family of [4, 6]) {
  test(`attributes IPv${family} sockets and refuses missing tuples`, async t => {
    if (process.platform !== 'linux') {
      assert.throws(() => loadSocketCgroupQuery(), /require Linux/);
      return;
    }
    const query = loadSocketCgroupQuery();
    const supported = query.probe();
    assert.equal(typeof supported, 'boolean');
    if (!supported) {
      t.diagnostic('Kernel socket cgroup attribution is unavailable; no enforcement claim.');
      return;
    }
    const host = family === 4 ? '127.0.0.1' : '::1';
    const server = createServer();
    let client;
    let accepted;
    t.after(async () => {
      client?.destroy();
      accepted?.destroy();
      await new Promise(resolve => server.close(resolve));
    });
    server.listen(0, host);
    await once(server, 'listening');
    const connection = once(server, 'connection');
    client = connect(server.address().port, host);
    await once(client, 'connect');
    [accepted] = await connection;
    const membership = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find(line => line.startsWith('0::/'));
    assert.ok(membership);
    const expected = statSync(`/sys/fs/cgroup${membership.slice(3)}`, { bigint: true }).ino;
    const tuple = { sourceAddress: client.localAddress, sourcePort: client.localPort,
      destinationAddress: client.remoteAddress, destinationPort: client.remotePort };
    assert.equal(query.query(tuple), expected);
    assert.throws(() => query.query({ ...tuple, sourcePort: 0 }), TypeError);
    const destination = tuple.destinationPort;
    client.destroy();
    accepted.destroy();
    await Promise.all([once(client, 'close'), once(accepted, 'close')]);
    assert.throws(() => query.query({ ...tuple, destinationPort: destination === 65535 ? 65534 : destination + 1 }),
      { code: 'ERR_SOCKET_CGROUP_QUERY' });
  });
}
