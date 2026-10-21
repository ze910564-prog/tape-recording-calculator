// 导出功能自检：三种格式都拉一遍，检查内容结构
const BASE = process.env.BASE ?? 'http://127.0.0.1:7788';

const tracks = await (await fetch(`${BASE}/api/tracks`)).json();
const ids = tracks.tracks.slice(0, 12).map((t) => t.id);
const params = { ids, minutes: 120, offset: 'nominal', mode: 'value', gapSeconds: 3, leadSeconds: 0 };

console.log('—— 判定结果 ——');
const plan = await (await fetch(`${BASE}/api/plan`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(params),
})).json();
console.log(`verdict=${plan.verdict} reordered=${plan.assignment.reordered}`);
console.log(`已占用 ${(plan.totals.usedSeconds / 60).toFixed(2)} 分  剩余 ${(plan.totals.remainingSeconds / 60).toFixed(2)} 分`);
console.log(`需要的字段 remainingSeconds/usedSeconds 都在: ${plan.totals.remainingSeconds !== undefined && plan.totals.usedSeconds !== undefined}`);

for (const format of ['txt', 'csv', 'm3u']) {
  console.log(`\n—— 导出 ${format} ——`);
  const res = await fetch(`${BASE}/api/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, format }),
  });
  console.log(`HTTP ${res.status}  ${res.headers.get('content-type')}`);

  if (format === 'm3u') {
    const data = await res.json();
    console.log(`返回 JSON: ${data.filename}, A面 ${data.assignment.a.placed.length} 首, B面 ${data.assignment.b.placed.length} 首`);
    const first = data.assignment.a.placed[0];
    console.log(`首曲字段: title=${JSON.stringify(first.title)} absPath=${first.absPath ? 'ok' : '缺失'}`);
    continue;
  }

  const cd = res.headers.get('content-disposition');
  const nameMatch = /filename\*=UTF-8''([^;]+)/i.exec(cd ?? '');
  console.log(`下载名: ${nameMatch ? decodeURIComponent(nameMatch[1]) : '(没有)'}`);

  const text = await res.text();
  const hasBom = text.charCodeAt(0) === 0xfeff;
  console.log(`带 BOM: ${hasBom}   行数: ${text.split(/\r?\n/).length}`);
  console.log('前 12 行:');
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/).slice(0, 12)) console.log('  ' + line);
}

console.log('\n导出自检完成');
