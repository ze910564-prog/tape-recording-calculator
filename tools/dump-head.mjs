// dump 音频文件头字节，用于排查解析偏移
import { open } from 'node:fs/promises';

const path = process.argv[2];
const LEN = Number(process.argv[3] ?? 256);
const fh = await open(path, 'r');
const buf = Buffer.alloc(LEN);
await fh.read(buf, 0, LEN, 0);
await fh.close();

for (let i = 0; i < LEN; i += 16) {
  const slice = buf.subarray(i, i + 16);
  const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const ascii = [...slice].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
  console.log(`${String(i).padStart(4, '0')}  ${hex.padEnd(47)}  ${ascii}`);
}
console.log('');
console.log('--- 直接读取关键位置 ---');
const u32le = (o) => buf.readUInt32LE(o);
const u32be = (o) => buf.readUInt32BE(o);
const u64le = (o) => Number(buf.readBigUInt64LE(o));
console.log('magic:', JSON.stringify(buf.toString('latin1', 0, 4)));
console.log('@4  u64le =', u64le(4), ' u32le =', u32le(4), ' u32be =', u32be(4));
console.log('@8  u64le =', u64le(8), ' u32le =', u32le(8));
console.log('@12 tag =', JSON.stringify(buf.toString('latin1', 12, 16)));
console.log('@16 u64le =', u64le(16), ' u32le =', u32le(16));
console.log('@20 tag =', JSON.stringify(buf.toString('latin1', 20, 24)));
console.log('@24 u64le =', u64le(24), ' u32le =', u32le(24));
console.log('@28 tag =', JSON.stringify(buf.toString('latin1', 28, 32)));
console.log('@32 u64le =', u64le(32), ' u32le =', u32le(32));
