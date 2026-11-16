import test from 'node:test';
import assert from 'node:assert/strict';
import { startSource } from '../source/service.mjs';
import { SourceClient } from '../src/transport.mjs';
import { decode } from '../src/decode.mjs';

test('轨道产品保留缺测与钟差哨兵，产品目录可晚于观测时段发布', async () => {
  const source = await startSource({ scenario: 'transition' });
  try {
    const client = new SourceClient(source.base);
    const first = decode((await client.request('/products/rapid.sp3')).bytes);
    assert.equal(first.epochs.length, 2);
    assert.equal(first.epochs[0].satellites[1].clockMicroseconds, 999999.999999);
    assert.deepEqual(first.epochs[1].satellites[1].positionKm, [0, 0, 0]);
    const before = JSON.parse((await client.request('/releases')).bytes);
    assert.equal(before.releases.length, 1);
    await client.control({ action: 'advance' });
    const after = JSON.parse((await client.request('/releases')).bytes);
    assert.equal(after.releases.length, 2);
    assert.notEqual(before.releases[0].frame, after.releases[0].frame);
  } finally { await source.close(); }
});
