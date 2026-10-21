// 端到端 API 自检（服务需已在 127.0.0.1:7788 运行）
const BASE = process.env.BASE ?? 'http://127.0.0.1:7788';

async function get(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

console.log('—— /api/state ——');
let state = await get('/api/state');
console.log(`曲库: ${state.config.libraries.join(', ')}`);
console.log(`容量: ${state.capacity.formula} 单面 ${(state.capacity.perSideSeconds / 60).toFixed(2)} 分`);

// 服务启动时会自动做增量扫描；等它跑完再测其余接口
if (state.library.scanning) {
  process.stdout.write('等待扫描完成');
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    state = await get('/api/state');
    const pr = state.library.progress ?? {};
    process.stdout.write(`\r等待扫描完成… ${pr.done ?? 0}/${pr.total ?? 0}   `);
    if (!state.library.scanning) break;
  }
  console.log('');
}
console.log(`曲目数: ${state.library.count}  合计 ${(state.library.totalSeconds / 60).toFixed(1)} 分钟`);

console.log('\n—— /api/tracks ——');
const all = await get('/api/tracks');
console.log(`返回 ${all.tracks.length} 首，目录 ${all.dirs.length} 个`);
const withCover = all.tracks.filter((t) => t.hasCover).length;
console.log(`带封面: ${withCover} 首`);
console.log(`样例: ${all.tracks[0].title ?? all.tracks[0].name} | ${all.tracks[0].artist ?? '?'} | ${all.tracks[0].seconds.toFixed(1)}s | cover=${all.tracks[0].hasCover}`);

const search = await get('/api/tracks?q=' + encodeURIComponent('周杰伦'));
console.log(`搜索"周杰伦": ${search.tracks.length} 首`);

console.log('\n—— /api/plan（20 首塞 120 分钟）——');
const ids = all.tracks.slice(0, 20).map((t) => t.id);
const plan = await post('/api/plan', { ids, minutes: 120, offset: 'nominal', mode: 'value', gapSeconds: 3 });
console.log(`判定: ${plan.verdict}`);
console.log(`需要 ${(plan.totals.requiredSeconds / 60).toFixed(2)} 分 / 可用 ${(plan.totals.totalAvailable / 60).toFixed(2)} 分`);
console.log(`A面 ${plan.assignment.a.placed.length} 首 用 ${(plan.assignment.a.usedSeconds / 60).toFixed(2)} 分`);
console.log(`B面 ${plan.assignment.b.placed.length} 首 用 ${(plan.assignment.b.usedSeconds / 60).toFixed(2)} 分`);
console.log(`首曲: ${plan.assignment.a.placed[0]?.title} @${plan.assignment.a.placed[0]?.startAt}s`);

console.log('\n—— /api/plan（塞爆）——');
const big = all.tracks.slice(0, 80).map((t) => t.id);
const over = await post('/api/plan', { ids: big, minutes: 120, offset: 'nominal', mode: 'value', gapSeconds: 3 });
console.log(`判定: ${over.verdict} | ${over.diagnosis.message}`);
console.log(`需要少录 ${over.diagnosis.mustRemoveCount} 首，最小代价候选 ${over.diagnosis.suggestions.length} 个`);

console.log('\n—— /api/plan（自动排布 forceReorder）——');
const auto = await post('/api/plan', { ids, minutes: 120, offset: 'nominal', mode: 'value', gapSeconds: 3, forceReorder: true });
console.log(`判定: ${auto.verdict} | reordered=${auto.assignment.reordered}`);
console.log(`A面 ${auto.assignment.a.placed.length} 首 ${(auto.assignment.a.usedSeconds / 60).toFixed(2)} 分 | B面 ${auto.assignment.b.placed.length} 首 ${(auto.assignment.b.usedSeconds / 60).toFixed(2)} 分`);

console.log('\n—— /api/cover ——');
// 抽查多个封面，确认都能提取出真正的图片字节（而不是错误偏移读到的垃圾）
const coverTracks = all.tracks.filter((t) => t.hasCover);
let coverOk = 0;
let coverBad = 0;
for (const t of coverTracks.slice(0, 6)) {
  const r = await fetch(`${BASE}/api/cover?id=${encodeURIComponent(t.id)}`);
  if (!r.ok) {
    coverBad++;
    console.log(`  ✗ HTTP ${r.status}  ${t.title ?? t.name}`);
    continue;
  }
  const bytes = Buffer.from(await r.arrayBuffer());
  const sig = bytes.subarray(0, 4).toString('hex');
  const kind = sig.startsWith('ffd8ff')
    ? 'JPEG'
    : sig.startsWith('89504e47')
      ? 'PNG'
      : sig.startsWith('474946')
        ? 'GIF'
        : null;
  if (kind) {
    coverOk++;
    console.log(`  ✓ ${kind} ${(bytes.length / 1024).toFixed(1)}KB  ${(t.title ?? t.name).slice(0, 42)}`);
  } else {
    coverBad++;
    console.log(`  ✗ 非图片数据 (${sig})  ${t.title ?? t.name}`);
  }
}
console.log(`封面抽查: ${coverOk} 成功 / ${coverBad} 失败`);

console.log('\n—— 静态资源版本戳 ——');
{
  const res = await fetch(BASE + '/');
  const html = await res.text();
  const cc = res.headers.get('cache-control') ?? '';
  console.log(`Cache-Control: ${cc}`);
  console.log(`禁用缓存头齐全: ${cc.includes('no-store') ? '✓' : '✗'}`);

  // 注意别写成 [^"]+\.(js|css) —— 带 ?v= 之后 .js 不再是引用结尾，会一个都匹配不到
  const refs = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css)(?:\?[^"]*)?)"/g)].map((m) => m[1]);
  console.log(`资源引用: ${refs.join(', ') || '(没找到，检查 index.html 的引用格式)'}`);

  const stamped = refs.filter((r) => /[?&]v=\d+/.test(r));
  console.log(`带版本戳: ${stamped.length}/${refs.length} ${stamped.length === refs.length ? '✓' : '✗ 浏览器可能用缓存里的旧代码'}`);

  const stateRes = await (await fetch(BASE + '/api/state')).json();
  const ver = html.match(/app\.js\?v=(\d+)/);
  const match = ver && Number(ver[1]) === stateRes.startedAt;
  console.log(`版本戳与服务启动时间一致: ${match ? '✓' : '✗'}（重启服务后会变，浏览器就会重新下载）`);
}

console.log('\n全部接口自检完成');
