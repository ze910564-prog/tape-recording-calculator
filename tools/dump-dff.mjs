// 按块遍历 DFF(DSDIFF) 头部，打印块树 —— 用于确认对齐规则
import { open } from 'node:fs/promises';

const path = process.argv[2];
const fh = await open(path, 'r');
const buf = Buffer.alloc(512);
await fh.read(buf, 0, 512, 0);
await fh.close();

console.log('offset  size        id      payload');
function walk(start, end, depth) {
  let off = start;
  while (off + 12 <= end) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32BE(off + 4);
    if (!/^[\x20-\x7e]{4}$/.test(id)) {
      console.log(`${' '.repeat(depth * 2)}${off}: 非法块 ID ${JSON.stringify(id)} (0x${size.toString(16)})`);
      break;
    }
    const p = off + 8;
    const preview = buf
      .subarray(p, Math.min(p + Math.min(size, 16), buf.length))
      .toString('latin1')
      .replace(/[^\x20-\x7e]/g, '.');
    console.log(
      `${' '.repeat(depth * 2)}${String(off).padStart(4)}    ${String(size).padStart(8)}    ${id}    ${JSON.stringify(preview)}`,
    );
    if (id === 'PROP') {
      console.log(`${' '.repeat(depth * 2)}  [PROP 内的 form type: ${JSON.stringify(buf.toString('latin1', p, p + 4))}]`);
      walk(p + 4, off + 8 + size, depth + 1);
    }
    if (id === 'DSD ') break;
    if (size === 0) break;
    const advance = 12 + size; // DFF 子块统一按 12 字节头（4 id + 8 size）
    if (off + advance <= off) break;
    off += advance;
  }
}
walk(0, buf.length, 0);
