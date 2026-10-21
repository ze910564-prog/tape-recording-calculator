// 排查 ID3 APIC 封面的偏移计算
import { open } from 'node:fs/promises';
import { readTagsAndCover } from '../lib/tags.mjs';

const path = process.argv[2];
const ext = process.argv[3] ?? path.split('.').pop().toLowerCase();

const fh = await open(path, 'r');
const { size } = await fh.stat();
const tailLen = Math.min(size, 2 * 1024 * 1024);
const buf = Buffer.alloc(tailLen);
await fh.read(buf, 0, tailLen, size - tailLen);
await fh.close();

const tailOffset = size - tailLen;
console.log(`文件 ${size} 字节，尾部窗口起点 ${tailOffset}\n`);

// 找尾部的 ID3 标记
const hits = [];
for (let i = buf.length - 10; i >= 0; i--) {
  if (buf[i] === 0x49 && buf[i + 1] === 0x44 && buf[i + 2] === 0x33) hits.push(i);
}
console.log(`尾部窗口内找到 ${hits.length} 个 'ID3' 候选: ${hits.slice(0, 5).join(', ')}`);

for (const at of hits.slice(0, 2)) {
  const major = buf[at + 3];
  const tagSize = ((buf[at + 6] & 0x7f) << 21) | ((buf[at + 7] & 0x7f) << 14) | ((buf[at + 8] & 0x7f) << 7) | (buf[at + 9] & 0x7f);
  console.log(`\n@${at} (绝对 ${tailOffset + at}) ID3v2.${major} size=${tagSize}`);

  // 遍历帧
  let off = at + 10;
  const idLen = major === 2 ? 3 : 4;
  const end = Math.min(at + 10 + tagSize, buf.length);
  let guard = 0;
  while (off + idLen + 6 <= end && guard++ < 40) {
    const id = buf.toString('latin1', off, off + idLen);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) {
      console.log(`  帧解析终止于 @${off}: ${JSON.stringify(id)}`);
      break;
    }
    let frameSize;
    let headerLen;
    if (major === 2) {
      frameSize = (buf[off + 3] << 16) | (buf[off + 4] << 8) | buf[off + 5];
      headerLen = 6;
    } else if (major === 4) {
      frameSize = ((buf[off + 4] & 0x7f) << 21) | ((buf[off + 5] & 0x7f) << 14) | ((buf[off + 6] & 0x7f) << 7) | (buf[off + 7] & 0x7f);
      headerLen = 10;
    } else {
      frameSize = buf.readUInt32BE(off + 4);
      headerLen = 10;
    }
    console.log(`  ${id} @${off} size=${frameSize} hdr=${headerLen}`);
    if (id === 'APIC') {
      const p = off + headerLen;
      const enc = buf[p];
      const mimeEnd = buf.indexOf(0, p + 1);
      const mime = buf.toString('latin1', p + 1, mimeEnd);
      let q = mimeEnd + 1;
      const picType = buf[q];
      q += 1;
      let descEnd;
      if (enc === 1 || enc === 2) {
        while (q + 1 < buf.length && !(buf[q] === 0 && buf[q + 1] === 0)) q += 2;
        descEnd = q;
        q += 2;
      } else {
        descEnd = buf.indexOf(0, q);
        q = descEnd + 1;
      }
      const declared = off + headerLen + frameSize - q;
      console.log(`    enc=${enc} mime=${JSON.stringify(mime)} picType=${picType}`);
      console.log(`    描述区 ${q - (descEnd + (enc === 1 || enc === 2 ? 2 : 1))} 字节，数据起点 @${q}`);
      console.log(`    按帧头推算数据长度 ${declared}`);
      console.log(`    实际剩余字节 ${end - q}`);
      console.log(`    数据前 8 字节: ${buf.subarray(q, q + 8).toString('hex')}  (JPEG 应为 ffd8ff, PNG 应为 89504e47)`);
      if (q + 8 <= buf.length) {
        console.log(`    相对尾部窗口偏移 ${q}，绝对偏移 ${tailOffset + q}`);
      }
    }
    off += headerLen + frameSize;
  }
}

const r = await readTagsAndCover(path, ext);
console.log('\n--- readTagsAndCover 的结论 ---');
console.log(`tags: ${JSON.stringify(r.tags)}`);
console.log(`cover: ${JSON.stringify(r.cover)}`);
