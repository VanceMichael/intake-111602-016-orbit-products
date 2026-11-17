import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/service.mjs';
import { startApplication } from '../src/app.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-'));
const source = await startSource();
const app = await startApplication({ source: source.base, root: directory });
try {
  const preview = await fetch(`${app.base}/preview`).then(response => response.json());
  process.stdout.write(`当前资料预览\n${JSON.stringify(preview, null, 2)}\n`);
  const saved = await fetch(`${app.base}/receipts`, { method: 'POST', body: '{}' }).then(response => response.json());
  const body = await fetch(`${app.base}/objects/${saved.digest}`).then(response => response.arrayBuffer());
  if (body.byteLength !== saved.bytes) throw new Error('原始资料长度不符');
  process.stdout.write(`原件已接收：${saved.digest}，${saved.bytes} 字节\n`);
  const claim = await fetch(`${app.base}/claims`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ start: '2026-10-12T00:00:00', end: '2026-10-12T00:15:00',
      agency: 'lab-igs', frame: 'IGS20', timeSystem: 'GPS' }) }).then(response => response.json());
  process.stdout.write(`时段领取版本：${claim.id}\n${JSON.stringify({ basis: claim.basis, releases: claim.releases, gaps: claim.coverage.gaps }, null, 2)}\n`);
} finally {
  await app.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
