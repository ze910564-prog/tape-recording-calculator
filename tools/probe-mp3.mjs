// 诊断 MP3：定位 ID3 结束位置，扫描后续同步字，试解帧头
import { open } from 'node:fs/promises';

const path = process.argv[2];
const fh = await open(path, 'r');
const { size: fileSize } = await fh.stat();
const buf = Buffer.alloc(Math.min(fileSize, 1024 * 1024 + 65536));
await fh.read(buf, 0, buf.length, 0);
await fh.close();

console.log(`文件大小 ${fileSize} 字节，读入 ${buf.length}`);

let start = 0;
if (buf.toString('latin1', 0, 3) === 'ID3') {
  const major = buf[3];
  const flags = buf[5];
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  console.log(`ID3v2.${major} flags=0x${flags.toString(16)} size=${size} => 音频起点 ${10 + size}`);
  start = 10 + size;
}

console.log('\n--- ID3 结束位置附近 32 字节 ---');
for (let i = Math.max(0, start - 8); i < Math.min(buf.length, start + 24); i += 16) {
  const slice = buf.subarray(i, i + 16);
  const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const ascii = [...slice].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
  console.log(`${String(i).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
}

const BITRATES = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SR = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };

function tryDecode(i) {
  if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) return null;
  const b1 = buf[i + 1], b2 = buf[i + 2];
  const vb = (b1 >> 3) & 3;
  if (vb === 1) return { why: 'reserved version' };
  const version = vb === 3 ? 1 : vb === 2 ? 2 : 2.5;
  const lb = (b1 >> 1) & 3;
  if (lb === 0) return { why: 'reserved layer' };
  const layer = 4 - lb;
  const brIdx = (b2 >> 4) & 0xf;
  const srIdx = (b2 >> 2) & 3;
  if (srIdx === 3) return { why: 'reserved samplerate' };
  const vKey = version === 1 ? '1' : '2';
  const table = BITRATES[`${vKey}-${layer}`];
  const bitrate = table ? table[brIdx] : 0;
  return { version, layer, brIdx, bitrate, srIdx, sampleRate: SR[version][srIdx] };
}

console.log('\n--- 从音频起点开始找同步字 (前 20 个候选) ---');
let found = 0;
for (let i = start; i < Math.min(buf.length - 4, start + 400000) && found < 20; i++) {
  if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
  const r = tryDecode(i);
  if (!r) continue;
  console.log(`  @${i} (相对起点 +${i - start})  ${JSON.stringify(r)}`);
  found++;
}
if (!found) console.log('  400KB 内没有找到任何合法帧头');

console.log('\n--- 全文件 ff 字节分布（前 12 个） ---');
let n = 0;
for (let i = 0; i < buf.length - 1 && n < 12; i++) {
  if (buf[i] === 0xff) {
    console.log(`  @${i}  next=0x${buf[i + 1].toString(16).padStart(2, '0')}`);
    n++;
  }
}
