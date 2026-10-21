// 列出 PDF 里每张图的原始像素尺寸 —— 决定渲染 dpi 上限的依据。
//
// 逻辑：如果原图已经是 3344x4504，那渲染到 400dpi 就是"原样取出"，
// 再往上（600/800）只是无意义的插值放大，不会增加信息量。
// 反过来，渲染 dpi 低于原图就等于丢细节 —— 140dpi 那种就是在丢。

import { open } from 'node:fs/promises';

const path = process.argv[2];
const fh = await open(path, 'r');
const { size } = await fh.stat();
const buf = Buffer.alloc(size);
await fh.read(buf, 0, size, 0);
await fh.close();

const text = buf.toString('latin1');
const objs = new Map();
for (const m of text.matchAll(/(\d+)\s+(\d+)\s+obj/g)) objs.set(`${m[1]} ${m[2]}`, m.index);

const images = [];
for (const [key, off] of objs) {
  const seg = buf.subarray(off, Math.min(off + 1500, size)).toString('latin1');
  if (!/\/Subtype\s*\/Image/.test(seg)) continue;
  const w = Number(/\/Width\s+(\d+)/.exec(seg)?.[1] ?? 0);
  const h = Number(/\/Height\s+(\d+)/.exec(seg)?.[1] ?? 0);
  const bpc = /\/BitsPerComponent\s+(\d+)/.exec(seg)?.[1] ?? '?';
  const filt = /\/Filter\s*\/(\w+)/.exec(seg)?.[1] ?? '?';
  const cs = /\/ColorSpace\s*\/(\w+)/.exec(seg)?.[1] ?? '?';
  const len = Number(/\/Length\s+(\d+)/.exec(seg)?.[1] ?? 0);
  images.push({ key, w, h, bpc, filt, cs, len });
}

console.log(`图像对象 ${images.length} 个\n`);
console.log('对象      尺寸            bpc  色彩       压缩        大小');
for (const im of images) {
  console.log(
    `${im.key.padEnd(9)} ${String(im.w + 'x' + im.h).padEnd(15)} ${String(im.bpc).padEnd(5)} ${String(im.cs).padEnd(11)} ${String(im.filt).padEnd(11)} ${(im.len / 1024).toFixed(0)} KB`,
  );
}

// 页面尺寸（MediaBox）用来换算 dpi
const mediaBoxes = [...text.matchAll(/\/MediaBox\s*\[\s*([\d.\s]+)\]/g)]
  .map((m) => m[1].trim().split(/\s+/).map(Number))
  .filter((b) => b.length === 4);
if (mediaBoxes.length) {
  const b = mediaBoxes[0];
  const wPt = b[2] - b[0];
  const hPt = b[3] - b[1];
  const maxImg = images.reduce((a, im) => (im.w * im.h > a.w * a.h ? im : a), { w: 0, h: 0 });

  console.log(`\n页面 MediaBox: ${wPt} x ${hPt} pt  (${(wPt / 72).toFixed(2)} x ${(hPt / 72).toFixed(2)} 英寸)`);
  if (maxImg.w) {
    const dpiX = maxImg.w / (wPt / 72);
    const dpiY = maxImg.h / (hPt / 72);
    console.log(`最大图像: ${maxImg.w}x${maxImg.h}`);
    console.log(`\n=== 这份 PDF 的实际扫描分辨率约为 ${Math.round(dpiX)} x ${Math.round(dpiY)} dpi ===`);
    console.log(`  渲染 dpi 高于 ${Math.round(Math.min(dpiX, dpiY))} 只是插值，不会更清楚`);
    console.log(`  渲染 dpi 低于它就是在丢细节（之前用 140 就是在丢）`);
  }
}
