// 判定逻辑自检：用真实库数据跑几个典型场景
import { readFile } from 'node:fs/promises';
import { planRecording, computeCapacity } from '../lib/plan.mjs';
import { projectPath } from './paths.mjs';

const CACHE = projectPath('.cache', 'library.json');
const cache = JSON.parse(await readFile(CACHE, 'utf8'));
const root = Object.keys(cache.roots)[0];
const entries = cache.roots[root].entries;
const tracks = Object.entries(entries)
  .filter(([, e]) => e.ok && e.seconds > 0)
  .map(([rel, e]) => ({ id: rel, title: e.title ?? rel.split('\\').pop(), seconds: e.seconds }))
  .sort((a, b) => a.id.localeCompare(b.id));

console.log(`可用曲目 ${tracks.length} 首，总时长 ${(tracks.reduce((a, t) => a + t.seconds, 0) / 60).toFixed(1)} 分钟\n`);

console.log('=== 容量计算 ===');
for (const cfg of [
  { minutes: 120, offset: 'nominal', mode: 'value' },
  { minutes: 120, offset: '-1m', mode: 'value' },
  { minutes: 90, offset: '+30s', mode: 'value' },
  { minutes: 90, offset: '-1m', mode: 'percent' },
  { minutes: 120, offset: '+1m', mode: 'percent' },
]) {
  const c = computeCapacity(cfg);
  console.log(`  ${String(cfg.minutes).padStart(3)}分 ${cfg.offset.padEnd(8)} ${cfg.mode.padEnd(7)} => 单面 ${(c.perSideSeconds / 60).toFixed(2)}分  (${c.formula})`);
}

function show(label, result) {
  console.log(`\n=== ${label} ===`);
  if (!result.ok) {
    console.log(`  错误: ${result.message}`);
    return;
  }
  const t = result.totals;
  console.log(`  判定: ${result.verdict}`);
  console.log(`  需要 ${(t.requiredSeconds / 60).toFixed(2)}分 / 可用 ${(t.totalAvailable / 60).toFixed(2)}分  超出 ${t.overflowSeconds.toFixed(1)}s`);
  console.log(`  A面: ${result.assignment.a.placed.length}首 用 ${(result.assignment.a.usedSeconds / 60).toFixed(2)}分 余 ${(result.assignment.a.remainingSeconds).toFixed(1)}s`);
  console.log(`  B面: ${result.assignment.b.placed.length}首 用 ${(result.assignment.b.usedSeconds / 60).toFixed(2)}分 余 ${(result.assignment.b.remainingSeconds).toFixed(1)}s`);
  if (result.diagnosis) {
    console.log(`  诊断: ${result.diagnosis.message}`);
    if (result.diagnosis.suggestions.length) {
      console.log('  最小代价删除建议:');
      for (const s of result.diagnosis.suggestions.slice(0, 3)) {
        console.log(`    删《${s.track.title}》(${(s.track.seconds / 60).toFixed(2)}分) 后余量 ${s.margin.toFixed(1)}s`);
      }
    }
  }
}

// 场景 1：随便挑 20 首，看能不能装进 120 分钟带
show('场景1: 20首塞 120 分钟带（标称）', {
  ...planRecording({ tracks: tracks.slice(0, 20), minutes: 120, offset: 'nominal', mode: 'value', gapSeconds: 3 }),
});

// 场景 2：故意塞爆
show('场景2: 60首塞 120 分钟带（必然超）', {
  ...planRecording({ tracks: tracks.slice(0, 60), minutes: 120, offset: 'nominal', mode: 'value', gapSeconds: 3 }),
});

// 场景 3：挑几首刚好接近单面容量，测试分配
const shortOnes = [...tracks].sort((a, b) => a.seconds - b.seconds).slice(0, 8);
show('场景3: 8首短曲塞 60 分钟带（宽松）', {
  ...planRecording({ tracks: shortOnes, minutes: 60, offset: 'nominal', mode: 'value', gapSeconds: 3 }),
});

// 场景 4：手动顺序导致分不下的情况（长曲排前面）
const longFirst = [...tracks].sort((a, b) => b.seconds - a.seconds).slice(0, 12);
show('场景4: 12首长曲降序塞 90 分钟带（测试分配问题）', {
  ...planRecording({ tracks: longFirst, minutes: 90, offset: 'nominal', mode: 'value', gapSeconds: 3 }),
});

// 场景 5：引导段 + 留白
show('场景5: 带 5 秒引导段和 5 秒留白', {
  ...planRecording({ tracks: tracks.slice(0, 15), minutes: 120, offset: '-1m', mode: 'value', gapSeconds: 5, leadSeconds: 5 }),
});

// 场景 6：搜一个「总量够但手动顺序分不下」的用例，验证自动排布确实改变了划分
console.log('\n=== 场景6: 搜索需要重排的用例（总量够、顺序分不下）===');
let found = null;
for (let start = 0; start < tracks.length && !found; start += 7) {
  for (let n = 12; n <= 26 && !found; n += 2) {
    const pick = tracks.slice(start, start + n);
    if (pick.length < n) break;
    const r = planRecording({ tracks: pick, minutes: 90, offset: 'nominal', mode: 'value', gapSeconds: 3 });
    if (r.ok && r.verdict === 'reorder') found = { pick, r };
  }
}
if (!found) {
  console.log('  没找到需要重排的用例（当前曲目分布下顺序折点总能装下）');
} else {
  const { pick, r } = found;
  const total = pick.reduce((a, t) => a + t.seconds, 0);
  console.log(`  用 ${pick.length} 首（合计 ${(total / 60).toFixed(1)} 分）塞 90 分钟带`);
  console.log(`  手动顺序: ${r.verdict} — A面 ${r.assignment.a.placed.length} 首 / B面 ${r.assignment.b.placed.length} 首`);
  console.log(`  诊断: ${r.diagnosis?.message ?? '(无)'}`);
  console.log(`  unusable=${r.diagnosis?.unusable.length ?? 0}  a.skipped=${r.assignment.a.skipped.length}  b.skipped=${r.assignment.b.skipped.length}`);
  console.log(`  A面用 ${(r.assignment.a.usedSeconds / 60).toFixed(2)} 分 / 单面容量 ${(r.capacity.perSideSeconds / 60).toFixed(2)} 分`);

  const auto = planRecording({ tracks: pick, minutes: 90, offset: 'nominal', mode: 'value', gapSeconds: 3, forceReorder: true });
  console.log(`  自动排布: ${auto.verdict} (reordered=${auto.assignment.reordered})`);
  console.log(`    A面 ${auto.assignment.a.placed.length} 首 用 ${(auto.assignment.a.usedSeconds / 60).toFixed(2)} 分`);
  console.log(`    B面 ${auto.assignment.b.placed.length} 首 用 ${(auto.assignment.b.usedSeconds / 60).toFixed(2)} 分`);
  console.log(`    合计装入 ${auto.assignment.a.placed.length + auto.assignment.b.placed.length} / ${pick.length} 首`);
}

// 场景 7：手动反面机型的两种分配方式对照
//
// 「两面均衡」是为了这种听法：听完 B 面翻过来，磁带正好回到起点，不用倒带。
// 所以判据是两面时长差，不是总占用。
console.log('\n=== 场景7: 两种两面分配方式对照 ===');
const pick7 = tracks.slice(0, 16);
const base7 = { tracks: pick7, minutes: 120, offset: 'nominal', mode: 'value', gapSeconds: 3 };
const pack = planRecording({ ...base7, fill: 'pack' });
const bal = planRecording({ ...base7, fill: 'balance' });

const brief = (label, r) => {
  const a = r.assignment.a;
  const b = r.assignment.b;
  const diff = Math.abs(a.usedSeconds - b.usedSeconds);
  console.log(`  ${label}  A面 ${a.placed.length} 首 ${(a.usedSeconds / 60).toFixed(2)} 分 | B面 ${b.placed.length} 首 ${(b.usedSeconds / 60).toFixed(2)} 分 | 两面差 ${(diff / 60).toFixed(2)} 分 | ${r.verdict}`);
};
brief('塞满 A 面 ', pack);
brief('两面均衡 ', bal);

const packDiff = Math.abs(pack.assignment.a.usedSeconds - pack.assignment.b.usedSeconds);
const balDiff = Math.abs(bal.assignment.a.usedSeconds - bal.assignment.b.usedSeconds);
console.log(`  → 两面差：塞满 ${(packDiff / 60).toFixed(2)} 分 → 均衡 ${(balDiff / 60).toFixed(2)} 分`);
console.log(`  → 均衡是否生效: ${bal.assignment.balanceApplied}`);
for (const n of bal.notes ?? []) console.log(`  → 说明: ${n.message}`);

// 再试一组总量小的（远小于单面容量），确认均衡不会把它们全塞进 A 面
const pick7b = tracks.slice(0, 8);
const small = planRecording({ tracks: pick7b, minutes: 120, offset: 'nominal', mode: 'value', gapSeconds: 3, fill: 'balance' });
const smallPack = planRecording({ tracks: pick7b, minutes: 120, offset: 'nominal', mode: 'value', gapSeconds: 3, fill: 'pack' });
const sDiff = Math.abs(small.assignment.a.usedSeconds - small.assignment.b.usedSeconds);
const spDiff = Math.abs(smallPack.assignment.a.usedSeconds - smallPack.assignment.b.usedSeconds);
console.log(`\n  换成 8 首（总量远小于单面容量）:`);
console.log(`    塞满: A ${(smallPack.assignment.a.usedSeconds / 60).toFixed(2)} 分 / B ${(smallPack.assignment.b.usedSeconds / 60).toFixed(2)} 分  差 ${(spDiff / 60).toFixed(2)} 分`);
console.log(`    均衡: A ${(small.assignment.a.usedSeconds / 60).toFixed(2)} 分 / B ${(small.assignment.b.usedSeconds / 60).toFixed(2)} 分  差 ${(sDiff / 60).toFixed(2)} 分`);

// 均衡的判据是两面差，不是"有没有生效"：所有能均衡的场景差都应该接近 0
if (sDiff > 60 || balDiff > 60) {
  console.log('  ! 均衡后两面差超过 1 分钟，算法可能有问题');
  process.exitCode = 1;
} else {
  console.log('  ✓ 均衡把两面差压到 1 分钟以内');
}
