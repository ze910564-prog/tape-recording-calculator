// 判定与实际装法的一致性自检
//
// 存在的意义：判定（verdict）必须和「界面实际展示的那套装法」一致。
// 之前均衡模式拿顺序切分的结果去判，于是明明装得下也报「需要重排」。
// 这类"显示与判定对不上"的问题很难靠肉眼发现，所以固化成检查。
const BASE = process.env.BASE ?? 'http://127.0.0.1:7788';

const all = await (await fetch(`${BASE}/api/tracks`)).json();
const plan = async (body) =>
  (
    await fetch(`${BASE}/api/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  ).json();

const idsOf = (n) => all.tracks.slice(0, n).map((t) => t.id);

const cases = [
  { label: '均衡·7 首（大量空余）', ids: idsOf(7), fill: 'balance' },
  { label: '均衡·20 首（有富余）', ids: idsOf(20), fill: 'balance' },
  { label: '均衡·60 首（超量）', ids: idsOf(60), fill: 'balance' },
  { label: '塞满·20 首', ids: idsOf(20), fill: 'pack' },
  { label: '塞满·12 首（全在 A 面）', ids: idsOf(12), fill: 'pack' },
  { label: '自动排布·20 首', ids: idsOf(20), fill: 'pack', forceReorder: true },
];

let bad = 0;
console.log('判定 vs 实际装法 一致性检查\n');
for (const c of cases) {
  const r = await plan({ ...c, minutes: 120, offset: 'nominal', mode: 'value', gapSeconds: 3 });
  const placed = r.assignment.a.placed.length + r.assignment.b.placed.length;
  const notPlaced = c.ids.length - placed;

  // 判定与实际是否自洽：说 fits 就必须真的一首不丢
  const consistent = r.verdict === 'fits' ? notPlaced === 0 : true;
  const flag = consistent ? '✓' : '✗';
  if (!consistent) bad++;

  console.log(
    `${flag} ${c.label.padEnd(22)} 判定=${String(r.verdict).padEnd(9)} 装入 ${placed}/${c.ids.length}` +
      `  A ${(r.assignment.a.usedSeconds / 60).toFixed(1)}分 / B ${(r.assignment.b.usedSeconds / 60).toFixed(1)}分` +
      (notPlaced ? `  未装入 ${notPlaced}` : ''),
  );
  if (r.diagnosis) console.log(`    诊断: ${r.diagnosis.message}`);
  if (!consistent) console.log(`    ! 判定说"录得下"但实际有 ${notPlaced} 首未装入`);
}

// ── 顺序同步检查 ────────────────────────────────────────────────────────────
//
// reordered 是前端决定"中间清单按哪个顺序显示"的依据：
//   true  -> 按服务端算出的顺序显示（并高亮被挪动的曲子）
//   false -> 按用户点选的顺序显示
// 如果服务端实际打乱了顺序、reordered 却是 false，中间清单就会和右侧清单对不上。
console.log('\n顺序同步检查（reordered 必须反映真实的顺序变化）\n');
for (const c of cases) {
  const r = await plan({ ...c, minutes: 120, offset: 'nominal', mode: 'value', gapSeconds: 3 });
  const planOrder = [...r.assignment.a.placed, ...r.assignment.b.placed].map((x) => x.id);
  const actualChanged =
    planOrder.length === c.ids.length && planOrder.some((id, i) => id !== c.ids[i]);
  const declared = Boolean(r.assignment.reordered);
  const ok = declared === actualChanged;
  if (!ok) bad++;
  console.log(
    `${ok ? '✓' : '✗'} ${c.label.padEnd(22)} reordered=${String(declared).padEnd(5)} 实际顺序变化=${String(actualChanged).padEnd(5)}` +
      (ok ? '' : '  ← 前端会按错误的顺序渲染清单'),
  );
}

// ── 拖动微调之后的高亮依据 ──────────────────────────────────────────────────
//
// 用户在自动模式下拖动微调后，前端的 selected 会变成"服务端排好的顺序"。
// 这时再请求一次，服务端算出来的顺序往往和输入完全一致（reordered 变 false）。
// 如果高亮跟着 reordered 走，用户就会看到"拖了一下高亮全没了"。
// 所以高亮必须看 autoApplied（自动模式有没有生效），这里验证它不会跟着掉。
console.log('\n拖动微调后的高亮依据（autoApplied 不该掉）\n');
// 只有会让软件重排的模式才需要这个检查：均衡、以及开了自动排布
const reorderCases = cases.filter((x) => x.fill === 'balance' || x.forceReorder);
for (const c of reorderCases) {
  const first = await plan({ ...c, minutes: 120, offset: 'nominal', mode: 'value', gapSeconds: 3 });
  const afterDrag = [...first.assignment.a.placed, ...first.assignment.b.placed].map((x) => x.id);
  const second = await plan({ ...c, ids: afterDrag, minutes: 120, offset: 'nominal', mode: 'value', gapSeconds: 3 });

  const ok = second.assignment.autoApplied === true;
  if (!ok) bad++;
  console.log(
    `${ok ? '✓' : '✗'} ${c.label.padEnd(22)} 第一次 reordered=${first.assignment.reordered}  ` +
      `拖动后重算 reordered=${second.assignment.reordered} autoApplied=${second.assignment.autoApplied}` +
      (ok ? '' : '  ← 高亮会消失'),
  );
}

console.log(bad ? `\n发现 ${bad} 处不一致` : '\n判定与实际装法全部一致');
process.exit(bad ? 1 : 0);
