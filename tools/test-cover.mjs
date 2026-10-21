// 直接验证封面提取：从缓存读偏移，调 extractCover，检查字节
import { readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { extractCover } from '../lib/covers.mjs';
import { projectPath } from './paths.mjs';

const CACHE = projectPath('.cache', 'library.json');
const cache = JSON.parse(await readFile(CACHE, 'utf8'));
const root = Object.keys(cache.roots)[0];

let ok = 0;
let bad = 0;
let n = 0;
for (const [rel, e] of Object.entries(cache.roots[root].entries)) {
  if (!e.cover?.bytes || n >= 6) continue;
  n++;
  const abs = join(root, rel);
  const fh = await open(abs, 'r');
  const { size } = await fh.stat();
  await fh.close();

  const data = await extractCover(abs, e.cover);
  const sig = data ? data.subarray(0, 8).toString('hex') : '(null)';
  const kind = sig.startsWith('ffd8ff')
    ? 'JPEG'
    : sig.startsWith('89504e47')
      ? 'PNG'
      : sig.startsWith('474946')
        ? 'GIF'
        : '???';
  if (kind === '???') bad++;
  else ok++;

  console.log(`${kind}  mime=${e.cover.mime} bytes=${e.cover.bytes} offset=${e.cover.dataOffset} fileSize=${size}`);
  console.log(`     range check: ${e.cover.dataOffset + e.cover.bytes} <= ${size} ? ${e.cover.dataOffset + e.cover.bytes <= size}`);
  console.log(`     sig=${sig}  ${rel.slice(-50)}`);
}
console.log(`\n提取结果: ${ok} 成功 / ${bad} 失败`);
