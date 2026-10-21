// 两面分配模式的端到端自检。
//
// 「两面分配」现在只有两个档：塞满 A 面 / 两面均衡。
// 界面上已经没有「录音机类型」开关 —— 那个参数从未参与计算，
// 只把状态空间从 2 种撑成 6 种，是前几轮状态打架的根源。
// 机器差异现在写在选项文案里（哪档适合哪种机器）。
//
// 判据：均衡模式下两面的音乐时长必须接近相等 ——
// 这样手动反面机听完 B 面翻过来，磁带正好回到起点，不用倒带。
//
// 用法: node tools/test-fill-mode.mjs [BASE]

const BASE = process.env.BASE ?? process.argv[2] ?? 'http://127.0.0.1:7788';

const all = await (await fetch(`${BASE}/api/tracks`)).json();
const plan = async (body) =>
  (
    await fetch(`${BASE}/api/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  ).json();

const fmt = (s) => `${(s / 60).toFixed(2)}分`;
const diffOf = (r) => Math.abs(r.assignment.a.usedSeconds - r.assignment.b.usedSeconds);

let bad = 0;
const brief = (label, r) => {
  if (!r.ok) {
    console.log(`  ✗ ${label}: 请求失败 — ${r.message}`);
    bad++;
    return null;
  }
  const a = r.assignment.a;
  const b = r.assignment.b;
  console.log(
    `  ${label.padEnd(10)} A ${String(a.placed.length).padStart(2)}首/${fmt(a.usedSeconds)}  ` +
      `B ${String(b.placed.length).padStart(2)}首/${fmt(b.usedSeconds)}  ` +
      `两面差 ${fmt(diffOf(r))}  fill=${r.assignment.fill}  判定=${r.verdict}`,
  );
  return r;
};

const idsOf = (n) => all.tracks.slice(0, n).map((t) => t.id);
const base = { minutes: 120, offset: 'nominal', mode: 'value', gapSeconds: 3 };

console.log(`曲库 ${all.tracks.length} 首\n`);

// 场景 1：各组规模的选歌，均衡都应把两面拉平
console.log('—— 均衡模式：两面差应接近 0 ——');
for (const n of [7, 12, 20, 34]) {
  const ids = idsOf(n);
  const pack = await plan({ ...base, ids, fill: 'pack' });
  const bal = await plan({ ...base, ids, fill: 'balance' });
  const rp = brief(`塞满·${n}首`, pack);
  const rb = brief(`均衡·${n}首`, bal);
  if (rp && rb) {
    const d = diffOf(rb);
    // 均衡的判据就是两面差：允许一首歌粒度的误差，超过 2 分钟说明算法没起作用
    if (d > 120) {
      console.log(`     ✗ 均衡后两面差 ${fmt(d)}，超过 2 分钟 —— 算法没起作用`);
      bad++;
    }
    // 均衡不应该丢歌
    if (rb.totals.notPlacedCount > 0 && pack.totals.notPlacedCount === 0) {
      console.log(`     ✗ 均衡丢了 ${rb.totals.notPlacedCount} 首，而塞满一首没丢`);
      bad++;
    }
  }
  console.log('');
}

// 场景 2：均衡 + 自动排布的组合（两者互斥，后端应忽略 forceReorder）
console.log('—— 均衡模式下 forceReorder 应被忽略 ——');
{
  const ids = idsOf(20);
  const a = await plan({ ...base, ids, fill: 'balance' });
  const b = await plan({ ...base, ids, fill: 'balance', forceReorder: true });
  const same =
    JSON.stringify([a.assignment.a.placed.map((x) => x.id), a.assignment.b.placed.map((x) => x.id)]) ===
    JSON.stringify([b.assignment.a.placed.map((x) => x.id), b.assignment.b.placed.map((x) => x.id)]);
  console.log(`  两次结果一致: ${same ? '✓' : '✗'}`);
  if (!same) bad++;
}

// 场景 3：导出要跟随当前的分配方式
console.log('\n—— 导出跟随分配方式 ——');
for (const fill of ['pack', 'balance']) {
  const res = await fetch(`${BASE}/api/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...base, ids: idsOf(12), fill, format: 'txt' }),
  });
  const text = await res.text();
  const good = res.status === 200 && text.includes('A 面');
  console.log(`  ${fill.padEnd(8)} HTTP ${res.status} ${good ? '✓' : '✗'}`);
  if (!good) bad++;
}

console.log(bad ? `\n发现 ${bad} 处问题` : '\n两面分配自检通过');
process.exit(bad ? 1 : 0);
