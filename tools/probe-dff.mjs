// 手工探查 DFF 关键偏移（不依赖对齐假设）
import { open } from 'node:fs/promises';
const path = process.argv[2];
const fh = await open(path, 'r');
const buf = Buffer.alloc(256);
await fh.read(buf, 0, 256, 0);
await fh.close();

const be32 = (o) => `0x${buf.readUInt32BE(o).toString(16).padStart(8, '0')} (${buf.readUInt32BE(o)})`;
const be64 = (o) => {
  const hi = buf.readUInt32BE(o);
  const lo = buf.readUInt32BE(o + 4);
  return `hi=0x${hi.toString(16)} lo=0x${lo.toString(16)} => ${hi * 2 ** 32 + lo}`;
};
const tag = (o) => JSON.stringify(buf.toString('latin1', o, o + 4));

for (const [label, o] of [
  ["FRM8 id (0)", 0],
  ["FRM8 size hi (4)", 4],
  ["FRM8 size lo (8)", 8],
  ["formtype (12)", 12],
  ["FVER id (16)", 16],
  ["FVER size hi (20)", 20],
  ["FVER size lo (24)", 24],
  ["FVER payload (28)", 28],
  ["PROP id (32)", 32],
  ["PROP size hi (36)", 36],
  ["PROP size lo (40)", 40],
  ["PROP formtype (44)", 44],
  ["FS id (48)", 48],
  ["FS size hi (52)", 52],
  ["FS size lo (56)", 56],
  ["FS payload (60)", 60],
  ["CHNL id (64)", 64],
  ["CHNL size hi (68)", 68],
  ["CHNL size lo (72)", 72],
  ["CHNL payload (76)", 76],
  ["(80) tag", 80],
  ["(84) hi", 84],
  ["(88) lo", 88],
  ["(92) tag", 92],
]) {
  console.log(`${label.padEnd(20)} ${tag(o).padEnd(10)} be32=${be32(o).padEnd(20)} be64=${be64(o)}`);
}
