// PDF 结构探测：先搞清楚这份 PDF 是"有文本层的原生 PDF"还是"扫描件"。
//
// 这个判断决定了后面怎么取内容：
//   有文本层 -> 直接抽文本
//   扫描件   -> 只有图片，得走 OCR（或者只能看图片本身）
//
// 用法: node tools/pdf-probe.mjs <file.pdf>

import { open } from 'node:fs/promises';

const path = process.argv[2];
if (!path) {
  console.error('用法: node tools/pdf-probe.mjs <file.pdf>');
  process.exit(1);
}

const fh = await open(path, 'r');
const { size } = await fh.stat();
const buf = Buffer.alloc(size);
await fh.read(buf, 0, size, 0);
await fh.close();

console.log(`文件 ${path}`);
console.log(`大小 ${(size / 1024 / 1024).toFixed(2)} MB`);
console.log(`头部 ${JSON.stringify(buf.subarray(0, 16).toString('latin1'))}`);

// 尾部：trailer / startxref
const tail = buf.subarray(Math.max(0, size - 2048));
const tailText = tail.toString('latin1');
console.log(`尾部含 startxref: ${tailText.includes('startxref')}`);
console.log(`尾部含 /Encrypt: ${tailText.includes('/Encrypt')}`);

// 统计对象数量与类型
const countOf = (re) => (buf.toString('latin1').match(re) ?? []).length;
const stats = {
  'obj 对象': countOf(/\d+\s+\d+\s+obj/g),
  'Type /Page': countOf(/\/Type\s*\/Page[^s]/g),
  'Type /Pages': countOf(/\/Type\s*\/Pages/g),
  'Type /XObject': countOf(/\/Subtype\s*\/Image/g),
  'Image (DCTDecode=JPEG)': countOf(/\/DCTDecode/g),
  'Image (CCITTFax=传真压缩)': countOf(/\/CCITTFaxDecode/g),
  'Image (JBIG2)': countOf(/\/JBIG2Decode/g),
  'Image (FlateDecode)': countOf(/\/FlateDecode/g),
  'Font': countOf(/\/Type\s*\/Font/g),
  'ToUnicode (可提取文本的标志)': countOf(/\/ToUnicode/g),
  'ObjStm (对象流)': countOf(/\/Type\s*\/ObjStm/g),
  'XRefStm (交叉引用流)': countOf(/\/Type\s*\/XRef/g),
};
console.log('\n对象统计:');
for (const [k, v] of Object.entries(stats)) console.log(`  ${k.padEnd(28)} ${v}`);

// 找一个内容流看看是文本还是图片
const firstStream = buf.indexOf('stream');
if (firstStream > 0) {
  const dictStart = Math.max(0, buf.lastIndexOf('<<', firstStream));
  const dict = buf.subarray(dictStart, firstStream).toString('latin1').replace(/\s+/g, ' ').slice(0, 300);
  console.log('\n第一个流的字典（截断）:');
  console.log('  ' + dict);
}

console.log('\n=== 判读 ===');
const hasText = stats['ToUnicode (可提取文本的标志)'] > 0;
const hasImages = stats['Type /XObject'] > 0;
if (hasText) {
  console.log('  ✓ 有 ToUnicode 映射 —— 存在文本层，可以直接抽取文字');
} else if (hasImages) {
  console.log('  ✗ 没有 ToUnicode —— 大概率是扫描件，只有图片，文字需要 OCR');
} else {
  console.log('  ? 既没有 ToUnicode 也没有图片，结构可能不常见，需要进一步看');
}
