import { randomUUID } from 'node:crypto';
import { decode } from './decode.mjs';
import { SourceClient } from './transport.mjs';
import { profile } from './profile.mjs';

// 解类型优先级：最终版优先于快速版，其余按名称排在已知类型之后。
// 该顺序是领取规则的一部分，保证同一历元的归属与目录排列、读取先后无关。
const SOLUTION_RANK = { final: 0, rapid: 1, ultra: 2 };
const BASIS_FILTERS = ['agency', 'solution', 'frame', 'timeSystem'];

export function parseInstant(text, label = '时间') {
  if (typeof text !== 'string' || !text.trim()) throw new Error(`${label}不能为空`);
  // 时段按产品时间系统解释，不做时制转换；未带时区后缀的时刻按同一标度直接解析。
  const normalized = /([zZ]|[+-]\d{2}:?\d{2})$/.test(text.trim()) ? text.trim() : `${text.trim()}Z`;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) throw new Error(`${label}无法解释：${text}`);
  return ms;
}

export function epochMillis(fields) {
  const [year, month, day, hour, minute, second] = fields;
  const whole = Math.floor(second);
  return Date.UTC(year, month - 1, day, hour, minute, whole, Math.round((second - whole) * 1000));
}

// 兼容依据：解算机构、参考框架、时间系统三者齐备才允许组合；缺一项即无依据。
export function basisOf(release) {
  const { agency, frame, timeSystem } = release ?? {};
  if (!agency || !frame || !timeSystem) return null;
  return { agency, frame, timeSystem };
}

function rankOf(release) {
  const rank = SOLUTION_RANK[release?.solution];
  return rank === undefined ? Object.keys(SOLUTION_RANK).length : rank;
}

export function orderReleases(releases) {
  return [...releases].sort((a, b) =>
    rankOf(a) - rankOf(b) ||
    String(a.solution ?? '').localeCompare(String(b.solution ?? '')) ||
    String(a.id ?? '').localeCompare(String(b.id ?? '')));
}

// 从发布目录核对领取条件，选出可组合的一组产品。
// 依据不一致（多组机构/框架/时制）时拒绝猜测，要求领取条件指明。
export function planClaim(index, criteria) {
  const startMs = parseInstant(criteria?.start, '时段起点');
  const endMs = parseInstant(criteria?.end, '时段终点');
  if (!(startMs < endMs)) throw new Error('时段起点必须早于终点');
  const releases = Array.isArray(index?.releases) ? index.releases : [];
  const matched = releases.filter(release =>
    BASIS_FILTERS.every(key => criteria[key] === undefined || release[key] === criteria[key]));
  const excluded = [];
  const groups = new Map();
  for (const release of matched) {
    const basis = basisOf(release);
    if (!basis) {
      excluded.push({ release: release.id ?? null, reason: '发布目录缺少解算机构、参考框架或时间系统，未纳入组合' });
      continue;
    }
    const key = JSON.stringify(basis);
    if (!groups.has(key)) groups.set(key, { basis, releases: [] });
    groups.get(key).releases.push(release);
  }
  if (groups.size > 1) {
    const bases = [...groups.values()]
      .map(group => `${group.basis.agency}/${group.basis.frame}/${group.basis.timeSystem}`).sort();
    throw new Error(`领取依据不一致（${bases.join('；')}），请在领取条件中指明解算机构、参考框架与时间系统`);
  }
  const group = groups.size ? [...groups.values()][0] : null;
  return { startMs, endMs, basis: group?.basis ?? null,
    releases: group ? orderReleases(group.releases) : [], excluded };
}

// 历元归属：按确定性顺序先到先得，重叠历元（含跨日）只归属一次。
// 返回每个历元的归属产品与未被任何归属历元覆盖的时段缺口。
export function attributeEpochs(releases, startMs, endMs) {
  const attribution = new Map();
  for (const release of releases) {
    for (const t of release.epochsMs) {
      if (!Number.isFinite(t) || t < startMs || t > endMs || attribution.has(t)) continue;
      attribution.set(t, release.id);
    }
  }
  const epochs = [...attribution.entries()].sort((a, b) => a[0] - b[0])
    .map(([t, id]) => ({ time: new Date(t).toISOString(), release: id }));
  const spans = new Map();
  for (const [t, id] of attribution) {
    if (!spans.has(id)) spans.set(id, [t, t]);
    else {
      const span = spans.get(id);
      span[0] = Math.min(span[0], t);
      span[1] = Math.max(span[1], t);
    }
  }
  return { epochs, gaps: coverageGaps([...spans.values()], startMs, endMs) };
}

export function coverageGaps(spans, startMs, endMs) {
  const clipped = spans
    .map(([a, b]) => [Math.max(a, startMs), Math.min(b, endMs)])
    .filter(([a, b]) => a <= b)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const gaps = [];
  let cursor = startMs;
  for (const [a, b] of clipped) {
    if (a > cursor) gaps.push({ type: 'coverage', start: new Date(cursor).toISOString(), end: new Date(a).toISOString() });
    if (b > cursor) cursor = b;
  }
  if (cursor < endMs) gaps.push({ type: 'coverage', start: new Date(cursor).toISOString(), end: new Date(endMs).toISOString() });
  return gaps;
}

// 执行一次领取：读取发布目录与索引声明的原始产品（只取索引给出的路径，
// 不按文件名相近补全），原件入目录后形成一份不可变的领取版本。
export async function executeClaim({ source, catalog, criteria }) {
  if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) throw new Error('领取条件不能为空');
  const client = new SourceClient(source);
  const indexResult = await client.request(profile.indexPath);
  if (indexResult.status !== 200) throw new Error(`发布目录响应：${indexResult.status}`);
  let index;
  try {
    index = JSON.parse(indexResult.bytes.toString('utf8'));
  } catch {
    throw new Error('发布目录不是有效的结构化索引');
  }
  const indexReceipt = await catalog.accept({ source: indexResult.url, bytes: indexResult.bytes,
    mediaType: indexResult.headers['content-type'],
    preview: { releases: Array.isArray(index?.releases) ? index.releases.length : 0 } });
  const plan = planClaim(index, criteria);
  const gaps = [];
  const releases = [];
  const epochSets = [];
  for (const release of plan.releases) {
    const record = { id: release.id ?? null, solution: release.solution ?? null, orbit: null, clock: null, epochs: 0 };
    if (!release.orbit) {
      gaps.push({ type: 'dependency', release: record.id, dependency: 'orbit', reason: '发布目录未提供轨道资料路径' });
    } else {
      try {
        const result = await client.request(release.orbit);
        if (result.status !== 200) throw new Error(`来源响应：${result.status}`);
        const preview = decode(result.bytes);
        const receipt = await catalog.accept({ source: result.url, bytes: result.bytes,
          mediaType: result.headers['content-type'], preview });
        record.orbit = { path: release.orbit, digest: receipt.digest, etag: result.headers.etag ?? null };
        epochSets.push({ id: record.id, epochsMs: preview.epochs.map(epoch => epochMillis(epoch.fields)) });
      } catch (error) {
        gaps.push({ type: 'dependency', release: record.id, dependency: 'orbit', reason: `轨道资料不可用：${error.message}` });
      }
    }
    if (!release.clock) {
      gaps.push({ type: 'dependency', release: record.id, dependency: 'clock', reason: '发布目录未提供钟差资料路径' });
    } else {
      try {
        const result = await client.request(release.clock);
        if (result.status !== 200) throw new Error(`来源响应：${result.status}`);
        const receipt = await catalog.accept({ source: result.url, bytes: result.bytes,
          mediaType: result.headers['content-type'], preview: null });
        record.clock = { path: release.clock, digest: receipt.digest, etag: result.headers.etag ?? null };
      } catch (error) {
        gaps.push({ type: 'dependency', release: record.id, dependency: 'clock', reason: `钟差资料不可用：${error.message}` });
      }
    }
    releases.push(record);
  }
  const attribution = attributeEpochs(epochSets, plan.startMs, plan.endMs);
  for (const record of releases) {
    record.epochs = attribution.epochs.filter(epoch => epoch.release === record.id).length;
  }
  const manifest = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    criteria: { start: criteria.start, end: criteria.end,
      ...Object.fromEntries(BASIS_FILTERS.filter(key => criteria[key] !== undefined).map(key => [key, criteria[key]])) },
    basis: plan.basis,
    index: { path: profile.indexPath, digest: indexReceipt.digest, etag: indexResult.headers.etag ?? null },
    releases,
    excluded: plan.excluded,
    coverage: { epochs: attribution.epochs, gaps: [...gaps, ...attribution.gaps] },
    preservation: {
      originals: '发布目录、轨道与钟差原件按内容摘要保存，可随时回读复核',
      sentinels: '零位置与 999999.999999 钟差哨兵按原值保留，不解释为有效数值',
      flags: '预测、机动与精度标记按原文保留，不做推断'
    }
  };
  await catalog.recordClaim(manifest);
  return manifest;
}
