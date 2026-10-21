// 理顺页面结构：页面对象长什么样、内容流在哪、那些 FlateDecode 对象是什么。
//
// 背景：上一轮发现唯一的 ToUnicode 是恒等映射（<0000><FFFF><0000>），
// 等于没有真实字符映射 —— 文本抽取这条路走不通。
// 所以现在要确认：是不是纯扫描件（只有图），以及图能不能拿出来看。

import { open } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

const path = process.argv[2];
const fh = await open(path, 'r');
const { size } = await fh.stat();
const buf = Buffer.alloc(size);
await fh.read(buf, 0, size, 0);
await fh.close();

const objOffsets = new Map();
for (const m of buf.toString('latin1').matchAll(/(\d+)\s+(\d+)\s+obj/g)) {
  objOffsets.set(`${m[1]} ${m[2]}`, m.index);
}

function getObject(key) {
  const off = objOffsets.get(key);
  if (off == null) return null;
  const end = buf.indexOf('endobj', off);
  return buf.subarray(off, end < 0 ? undefined : end);
}

// ── 1. 列出所有 /Type /Page 对象及其字典 ────────────────────────────────────
console.log('=== 页面对象 ===');
const pageKeys = [];
for (const [key, off] of objOffsets) {
  const seg = buf.subarray(off, Math.min(off + 600, buf.length)).toString('latin1');
  if (/\/Type\s*\/Page(?![s])/.test(seg)) {
    pageKeys.push(key);
    if (pageKeys.length <= 2) {
      console.log(`\n${key}:`);
      console.log('  ' + seg.replace(/\s+/g, ' ').slice(0, 420));
    }
  }
}
console.log(`\n共 ${pageKeys.length} 个页面对象`);

// ── 2. 统计对象类型分布 ─────────────────────────────────────────────────────
const kinds = new Map();
for (const [key] of objOffsets) {
  const obj = getObject(key);
  if (!obj) continue;
  const head = obj.subarray(0, 400).toString('latin1');
  let kind = '其他';
  if (/\/Subtype\s*\/Image/.test(head)) {
    const filt = /\/Filter\s*\/(\w+)/.exec(head)?.[1] ?? '?';
    kind = `图像(${filt})`;
  } else if (/\/Type\s*\/Page(?![s])/.test(head)) kind = '页面';
  else if (/\/Type\s*\/Pages/.test(head)) kind = '页面树';
  else if (/\/Type\s*\/Font/.test(head)) kind = '字体';
  else if (/\/Type\s*\/Metadata/.test(head)) kind = '元数据';
  else if (/\/Type\s*\/Catalog/.test(head)) kind = '目录';
  else if (/\/XObject/.test(head)) kind = 'XObject字典';
  else if (/stream/.test(head)) kind = '内容流';
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
}
console.log('\n=== 对象类型分布 ===');
for (const [k, v] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);

// ── 3. 列出图像对象的尺寸信息 ───────────────────────────────────────────────
console.log('\n=== 图像对象（前 5 个）===');
let imgCount = 0;
for (const [key] of objOffsets) {
  const obj = getObject(key);
  if (!obj) continue;
  const head = obj.subarray(0, 400).toString('latin1');
  if (!/\/Subtype\s*\/Image/.test(head)) continue;
  imgCount++;
  if (imgCount <= 5) {
    const w = /\/Width\s+(\d+)/.exec(head)?.[1];
    const h = /\/Height\s+(\d+)/.exec(head)?.[1];
    const bpc = /\/BitsPerComponent\s+(\d+)/.exec(head)?.[1];
    const filt = /\/Filter\s*\/(\w+)/.exec(head)?.[1];
    const len = /\/Length\s+(\d+)/.exec(head)?.[1];
    console.log(`  ${key}: ${w}x${h} ${bpc}bpc ${filt} length=${len}`);
  }
}
console.log(`  共 ${imgCount} 个图像`);

// ── 4. 那些 FlateDecode 对象是什么 ──────────────────────────────────────────
console.log('\n=== 非图像的对象（前 8 个）===');
let shown = 0;
for (const [key] of objOffsets) {
  const obj = getObject(key);
  if (!obj) continue;
  const head = obj.subarray(0, 400).toString('latin1');
  if (/\/Subtype\s*\/Image/.test(head) || /\/Type\s*\/Page/.test(head)) continue;
  if (!/stream/.test(head)) {
    console.log(`  ${key}: ${head.replace(/\s+/g, ' ').slice(0, 120)}`);
    if (++shown >= 8) break;
  }
}
