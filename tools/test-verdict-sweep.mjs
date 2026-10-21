// 判定扫描：随机采样大量选歌组合，检查有没有误判。
//
// 存在的意义：「明明装得下却报需要重排」这类误判，靠手点几个案例是发现不了的
// —— 它只在特定时长组合下出现。这里用几千组随机采样去撞它。
//
// 判据（两种都算误判）：
//   1. 总量 ≤ 容量，却判成 overflow
//   2. 总量 ≤ 容量、且重新划分两面确实装得下，却仍判成 reorder（开了自动排布时）
//
// 用法: node tools/test-verdict-sweep.mjs [采样次数]

import { readFile } from 'node:fs/promises';
import { planRecording } from '../lib/plan.mjs';
import { projectPath } from './paths.mjs';

const TRIALS = Number(process.argv[2] ?? 3000);

const cache = JSON.parse(await readFile(projectPath('.cache', 'library.json'), 'utf8'));
const root = Object.keys(cache.roots)[0];
const all = Object.entries(cache.roots[root].entries)
  .filter(([, e]) => e.ok && e.seconds > 0)
  .map(([rel, e]) => ({ id: rel, title: e.title ?? rel.split('\\').pop(), seconds: e.seconds }));

console.log(`曲库 ${all.length} 首，随机采样 ${TRIALS} 组...\n`);

// 固定种子，保证可重复 —— 出问题时能照着复现
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const problems = [];
for (let trial = 0; trial < TRIALS; trial++) {
  const n = 10 + Math.floor(rnd() * 70);
  const start = Math.floor(rnd() * Math.max(1, all.length - n));
  const pick = all.slice(start, start + n);
  if (pick.length < n) continue;

  const base = { tracks: pick, minutes: 120, offset: 'nominal', mode: 'value', gapSeconds: 3, machine: 'manual-reverse', fill: 'pack' };
  const manual = planRecording(base);
  const auto = planRecording({ ...base, forceReorder: true });
  const totalFits = manual.totals.requiredSeconds <= manual.totals.totalAvailable + 1e-6;

  const report = (kind, r) =>
    problems.push({
      kind,
      trial,
      start,
      n,
      totalMinutes: manual.totals.requiredSeconds / 60,
      verdict: r.verdict,
      debug: r._debug,
    });

  // 1. 总量够却判 overflow
  if (totalFits && manual.verdict === 'overflow') report('总量够却判录不下', manual);

  // 2. 开了自动排布、结果确实装得下，判定却不是 fits
  if (auto._debug.dpPlanFits === true && auto.verdict !== 'fits') report('重排能装下却判没装下', auto);

  // 3. 判 fits 却真有歌没排进去
  if (manual.verdict === 'fits' && manual.totals.notPlacedCount > 0) report('判录得下却有歌未排入', manual);
  if (auto.verdict === 'fits' && auto.totals.notPlacedCount > 0) report('判录得下却有歌未排入', auto);

  // 4. 诊断说"救不了"，但重新划分其实装得下 —— 文案自相矛盾，会误导用户白删歌
  const msg = manual.diagnosis?.message ?? '';
  if (msg.includes('无论怎么排都放不进') && manual._debug.dpPlanFits === true) {
    report('诊断说救不了、其实重排能装下', manual);
  }
}

if (problems.length) {
  console.log(`发现 ${problems.length} 处误判：\n`);
  for (const p of problems.slice(0, 8)) {
    console.log(`✗ [${p.kind}] 第 ${p.trial} 次采样：起点 ${p.start}、${p.n} 首、需求 ${p.totalMinutes.toFixed(2)} 分`);
    console.log(`   判定=${p.verdict}  ${JSON.stringify(p.debug)}\n`);
  }
} else {
  console.log(`✓ ${TRIALS} 组采样未发现误判`);
}

// 顺手统计一下各判定的分布，全落在同一档说明采样没覆盖到情况
const stats = { fits: 0, reorder: 0, overflow: 0 };
for (let i = 0; i < 300; i++) {
  const n = 10 + Math.floor(rnd() * 70);
  const start = Math.floor(rnd() * Math.max(1, all.length - n));
  const pick = all.slice(start, start + n);
  const r = planRecording({ tracks: pick, minutes: 120, offset: 'nominal', mode: 'value', gapSeconds: 3 });
  if (r.ok) stats[r.verdict]++;
}
console.log(`判定分布（300 组抽样）: 录得下 ${stats.fits} / 需要重排 ${stats.reorder} / 录不下 ${stats.overflow}`);

process.exit(problems.length ? 1 : 0);
