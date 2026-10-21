// 深入探测：看页面内容流里到底有没有文本绘制指令，以及 ToUnicode 映射的规模。
//
// 上一轮已经确认：49 页、49 个 JBIG2 图像（扫描件特征）、只有 1 个 ToUnicode。
// 关键问题是：那唯一的文本层是全篇 OCR 的，还是只有零星几个字（比如页码/标题）？

import { open } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

const path = process.argv[2];
const fh = await open(path, 'r');
const { size } = await fh.stat();
const buf = Buffer.alloc(size);
await fh.read(buf, 0, size, 0);
await fh.close();

/** 把 {n} 或 {n} {m} R 形式的间接引用解出来 */
function refs(text) {
  return [...text.matchAll(/(\d+)\s+(\d+)\s+R/g)].map((m) => `${m[1]} ${m[2]}`);
}

// ── 1. 抓出所有对象的位置 ───────────────────────────────────────────────────
const objOffsets = new Map();
for (const m of buf.toString('latin1').matchAll(/(\d+)\s+(\d+)\s+obj/g)) {
  objOffsets.set(`${m[1]} ${m[2]}`, m.index);
}
console.log(`共 ${objOffsets.size} 个对象`);

/** 取对象体（字典 + 流） */
function getObject(key) {
  const off = objOffsets.get(key);
  if (off == null) return null;
  const end = buf.indexOf('endobj', off);
  return buf.subarray(off, end < 0 ? undefined : end);
}

// ── 2. 找 /ToUnicode 指向的流 ───────────────────────────────────────────────
const all = buf.toString('latin1');
const tuRefs = [...all.matchAll(/\/ToUnicode\s+(\d+)\s+(\d+)\s+R/g)].map((m) => `${m[1]} ${m[2]}`);
console.log(`ToUnicode 引用: ${tuRefs.length} 个 -> ${[...new Set(tuRefs)].join(', ') || '(无)'}`);

for (const key of [...new Set(tuRefs)]) {
  const obj = getObject(key);
  if (!obj) continue;
  const text = obj.toString('latin1');
  const sIdx = text.indexOf('stream');
  const dict = text.slice(0, sIdx).replace(/\s+/g, ' ');
  console.log(`\n对象 ${key} 的字典: ${dict.slice(0, 200)}`);

  // 解压流内容
  let start = sIdx + 'stream'.length;
  if (obj[start] === 0x0d) start++;
  if (obj[start] === 0x0a) start++;
  const endIdx = obj.indexOf('endstream', start);
  const raw = obj.subarray(start, endIdx);
  try {
    const data = inflateSync(raw);
    const cmap = data.toString('latin1');
    console.log(`解压后 ${data.length} 字节，CMap 前 400 字符:`);
    console.log(cmap.slice(0, 400));
    const bfchar = (cmap.match(/beginbfchar/g) ?? []).length;
    const bfrange = (cmap.match(/beginbfrange/g) ?? []).length;
    console.log(`\nbeginbfchar 段: ${bfchar}, beginbfrange 段: ${bfrange}`);
  } catch (e) {
    console.log(`解压失败: ${e.message}（可能不是 Flate）`);
  }
}

// ── 3. 看看页面对象与内容流 ─────────────────────────────────────────────────
const pageRefs = [...all.matchAll(/\/Type\s*\/Page[^s][\s\S]{0,300}?\/Contents\s+(\d+)\s+(\d+)\s+R/g)].map(
  (m) => `${m[1]} ${m[2]}`,
);
console.log(`\n找到 ${pageRefs.length} 个页面内容流引用`);

// 统计内容流里出现的文本操作符
let textOps = 0;
let totalContentBytes = 0;
const samples = [];
for (const key of pageRefs.slice(0, 49)) {
  const obj = getObject(key);
  if (!obj) continue;
  const text = obj.toString('latin1');
  const sIdx = text.indexOf('stream');
  if (sIdx < 0) continue;
  let start = sIdx + 6;
  if (obj[start] === 0x0d) start++;
  if (obj[start] === 0x0a) start++;
  const endIdx = obj.indexOf('endstream', start);
  const raw = obj.subarray(start, endIdx);
  let data;
  try {
    data = inflateSync(raw);
  } catch {
    continue;
  }
  totalContentBytes += data.length;
  const content = data.toString('latin1');
  const tj = (content.match(/\bTj\b/g) ?? []).length;
  const tjArr = (content.match(/\bTJ\b/g) ?? []).length;
  const bt = (content.match(/\bBT\b/g) ?? []).length;
  textOps += tj + tjArr;
  if (samples.length < 3 && (tj + tjArr) > 0) samples.push({ key, tj, tjArr, bt, preview: content.slice(0, 300) });
}

console.log(`内容流总大小: ${(totalContentBytes / 1024).toFixed(1)} KB`);
console.log(`文本绘制指令总数 (Tj+TJ): ${textOps}`);
console.log(`平均每页: ${(textOps / 49).toFixed(1)} 个`);

for (const s of samples) {
  console.log(`\n对象 ${s.key}: BT=${s.bt} Tj=${s.tj} TJ=${s.tjArr}`);
  console.log('  内容预览: ' + JSON.stringify(s.preview.slice(0, 260)));
}
