import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { findPort, isPortFree, DEFAULT_PORT, PORT_RANGE_END } from '../src/main/lib/ports.mjs';

/** 指定ポートを占有するサーバを立てる（0 なら任意ポート） */
function occupy(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

function close(srv) {
  return new Promise((resolve) => srv.close(() => resolve()));
}

test('isPortFree は使用中ポートで false、空きで true', async () => {
  const srv = await occupy(0);
  const used = srv.address().port;
  assert.equal(await isPortFree(used), false);
  await close(srv);
  assert.equal(await isPortFree(used), true);
});

test('findPort は使用中の希望ポートを避けて次を返す', async () => {
  const base = 47_701; // 既定レンジと重ならない試験用レンジ
  const s1 = await occupy(base);
  try {
    const p = await findPort({ preferred: base, rangeStart: base, rangeEnd: base + 5 });
    assert.notEqual(p, base);
    assert.ok(p > base && p <= base + 5, `got ${p}`);
    assert.equal(await isPortFree(p), true);
  } finally {
    await close(s1);
  }
});

test('findPort はレンジが全部埋まっていれば 0（OS 任せ）を返す', async () => {
  const base = 47_711;
  const servers = [];
  try {
    for (let p = base; p <= base + 2; p += 1) {
      // eslint-disable-next-line no-await-in-loop
      servers.push(await occupy(p));
    }
    const p = await findPort({ preferred: base, rangeStart: base, rangeEnd: base + 2 });
    assert.equal(p, 0);
  } finally {
    await Promise.all(servers.map(close));
  }
});

test('既定値は設計書どおり', () => {
  assert.equal(DEFAULT_PORT, 47811);
  assert.equal(PORT_RANGE_END, 47899);
});
