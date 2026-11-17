import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/service.mjs';
import { startApplication } from '../src/app.mjs';
import { SourceClient } from '../src/transport.mjs';
import { decode } from '../src/decode.mjs';
import { planClaim, orderReleases, attributeEpochs, coverageGaps } from '../src/claim.mjs';

const CRITERIA = { start: '2026-10-12T23:00:00', end: '2026-10-13T00:30:00',
  agency: 'lab-igs', frame: 'IGS20', timeSystem: 'GPS' };

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'claim-test-'));
  const source = await startSource({ scenario: 'claim' });
  const app = await startApplication({ source: source.base, root: directory });
  return { directory, source, app };
}

async function postClaim(app, criteria) {
  const response = await fetch(`${app.base}/claims`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(criteria) });
  return { status: response.status, body: await response.json() };
}

test('按实验时段领取：核对依据、保留哨兵与标记、不拼接无依据资料', async () => {
  const { directory, source, app } = await setup();
  try {
    const { status, body: manifest } = await postClaim(app, CRITERIA);
    assert.equal(status, 201);
    assert.deepEqual(manifest.basis, { agency: 'lab-igs', frame: 'IGS20', timeSystem: 'GPS' });
    assert.deepEqual(manifest.releases.map(item => item.id), ['rapid-a']);
    assert.equal(manifest.releases[0].epochs, 4);
    assert.match(manifest.releases[0].orbit.digest, /^[a-f0-9]{64}$/);
    assert.match(manifest.releases[0].clock.digest, /^[a-f0-9]{64}$/);
    assert.equal(manifest.coverage.epochs.length, 4);
    assert.ok(manifest.coverage.epochs.every(epoch => epoch.release === 'rapid-a'));
    assert.deepEqual(manifest.coverage.gaps, []);
    assert.deepEqual(manifest.coverage.epochs.map(epoch => epoch.time), [
      '2026-10-12T23:00:00.000Z', '2026-10-12T23:30:00.000Z',
      '2026-10-13T00:00:00.000Z', '2026-10-13T00:30:00.000Z']);
    const orbit = decode(await app.catalog.object(manifest.releases[0].orbit.digest));
    assert.equal(orbit.epochs[0].satellites[1].clockMicroseconds, 999999.999999);
    assert.deepEqual(orbit.epochs[1].satellites[1].positionKm, [0, 0, 0]);
    const flags = orbit.epochs.flatMap(epoch => epoch.satellites.map(satellite => satellite.flags));
    assert.ok(flags.some(flag => flag.includes('P')));
    assert.ok(flags.some(flag => flag.includes('M')));
    const audit = await new SourceClient(source.base).control({ action: 'inspect' });
    assert.ok(!audit.requests.some(item => item.path === '/products/final.sp3'));
    assert.equal((await app.catalog.list()).length, 3);
    const reread = await fetch(`${app.base}/claims/${manifest.id}`).then(response => response.json());
    assert.deepEqual(reread, manifest);
    assert.equal((await fetch(`${app.base}/claims`).then(response => response.json())).length, 1);
  } finally {
    await app.close(); await source.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('发布目录存在多套依据时拒绝领取并列出候选', async () => {
  const { directory, source, app } = await setup();
  try {
    const { status, body } = await postClaim(app, { start: CRITERIA.start, end: CRITERIA.end });
    assert.equal(status, 422);
    assert.match(body.error, /依据不一致/);
    assert.match(body.error, /lab-igs\/IGS20\/GPS/);
    assert.match(body.error, /other\/IGb20\/GPS/);
    assert.equal((await app.catalog.claims()).length, 0);
  } finally {
    await app.close(); await source.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('后续产品到齐形成新领取版本，原实验引用保持不变', async () => {
  const { directory, source, app } = await setup();
  try {
    const first = (await postClaim(app, CRITERIA)).body;
    await new SourceClient(source.base).control({ action: 'advance' });
    const { status, body: second } = await postClaim(app, CRITERIA);
    assert.equal(status, 201);
    assert.notEqual(second.id, first.id);
    assert.deepEqual(second.releases.map(item => item.id), ['final-a', 'rapid-a']);
    assert.ok(second.coverage.epochs.every(epoch => epoch.release === 'final-a'));
    assert.equal(second.releases.find(item => item.id === 'rapid-a').epochs, 0);
    assert.equal(second.releases.find(item => item.id === 'final-a').clock, null);
    assert.ok(second.coverage.gaps.some(gap =>
      gap.type === 'dependency' && gap.dependency === 'clock' && gap.release === 'final-a'));
    const reread = await fetch(`${app.base}/claims/${first.id}`).then(response => response.json());
    assert.deepEqual(reread, first);
    const versions = await fetch(`${app.base}/claims`).then(response => response.json());
    assert.equal(versions.length, 2);
    assert.deepEqual(versions.map(version => version.id), [first.id, second.id]);
  } finally {
    await app.close(); await source.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('时段超出产品覆盖范围时保留缺口，不用相近资料补齐', async () => {
  const { directory, source, app } = await setup();
  try {
    const { status, body: manifest } = await postClaim(app, { ...CRITERIA, end: '2026-10-13T02:00:00' });
    assert.equal(status, 201);
    assert.deepEqual(manifest.coverage.gaps, [
      { type: 'coverage', start: '2026-10-13T00:30:00.000Z', end: '2026-10-13T02:00:00.000Z' }]);
    assert.equal(manifest.coverage.epochs.length, 4);
  } finally {
    await app.close(); await source.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('领取选择只取决于领取规则，与目录排列顺序无关', () => {
  const rapid = { id: 'rapid-a', agency: 'lab-igs', solution: 'rapid', frame: 'IGS20', timeSystem: 'GPS' };
  const final = { id: 'final-a', agency: 'lab-igs', solution: 'final', frame: 'IGS20', timeSystem: 'GPS' };
  const other = { id: 'final-b', agency: 'other', solution: 'final', frame: 'IGb20', timeSystem: 'GPS' };
  const criteria = { start: '2026-10-12T23:00:00', end: '2026-10-13T00:30:00', agency: 'lab-igs' };
  const forward = planClaim({ releases: [rapid, final, other] }, criteria);
  const reversed = planClaim({ releases: [other, final, rapid] }, criteria);
  assert.deepEqual(forward.releases, reversed.releases);
  assert.deepEqual(forward.releases.map(item => item.id), ['final-a', 'rapid-a']);
  assert.deepEqual(orderReleases([rapid, final]), orderReleases([final, rapid]));
  assert.throws(() => planClaim({ releases: [rapid, other] }, { start: criteria.start, end: criteria.end }), /依据不一致/);
  const incomplete = planClaim({ releases: [{ id: 'x', agency: 'lab-igs', solution: 'rapid' }] }, criteria);
  assert.equal(incomplete.basis, null);
  assert.equal(incomplete.releases.length, 0);
  assert.equal(incomplete.excluded.length, 1);
});

test('历元归属与时段缺口按确定规则计算', () => {
  const start = Date.parse('2026-10-12T23:00:00Z');
  const end = Date.parse('2026-10-13T00:30:00Z');
  const hour = 30 * 60 * 1000;
  const epochs = [0, 1, 2, 3].map(index => start + index * hour);
  const attribution = attributeEpochs([
    { id: 'final-a', epochsMs: epochs },
    { id: 'rapid-a', epochsMs: epochs }], start, end);
  assert.ok(attribution.epochs.every(epoch => epoch.release === 'final-a'));
  assert.deepEqual(attribution.gaps, []);
  const partial = attributeEpochs([{ id: 'rapid-a', epochsMs: [start, start + hour] }], start, end);
  assert.deepEqual(partial.gaps, [
    { type: 'coverage', start: new Date(start + hour).toISOString(), end: new Date(end).toISOString() }]);
  assert.deepEqual(coverageGaps([], start, end), [
    { type: 'coverage', start: new Date(start).toISOString(), end: new Date(end).toISOString() }]);
  assert.deepEqual(coverageGaps([[start, end]], start, end), []);
});

test('无效的领取编号返回 404，不泄露目录结构', async () => {
  const { directory, source, app } = await setup();
  try {
    const missing = await fetch(`${app.base}/claims/${crypto.randomUUID()}`);
    assert.equal(missing.status, 404);
    const invalid = await fetch(`${app.base}/claims/..%2F..%2Fetc`);
    assert.equal(invalid.status, 404);
  } finally {
    await app.close(); await source.close(); await rm(directory, { recursive: true, force: true });
  }
});
