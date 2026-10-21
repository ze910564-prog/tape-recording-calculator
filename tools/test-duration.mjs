// 时长解析器自检：对指定目录抽样，打印解析结果
// 用法: node tools/test-duration.mjs [目录] [每种格式抽样数]
import { readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { readDuration, fmtDuration, SUPPORTED_EXT } from '../lib/duration.mjs';

const ROOT = process.argv[2] ?? process.env.MUSIC_DIR ?? 'music';
const SAMPLE = Number(process.argv[3] ?? 3);
const ALLOWED = new Set(SUPPORTED_EXT);

function walk(dir, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '$RECYCLE.BIN' || e.name === 'System Volume Information') continue;
      walk(p, out, depth + 1);
    } else {
      const ext = extname(e.name).slice(1).toLowerCase();
      if (ALLOWED.has(ext)) out.push(p);
    }
  }
  return out;
}

const files = walk(ROOT);
const byExt = new Map();
for (const f of files) {
  const ext = extname(f).slice(1).toLowerCase();
  if (!byExt.has(ext)) byExt.set(ext, []);
  byExt.get(ext).push(f);
}

console.log(`目录: ${ROOT}`);
console.log(`音频文件总数: ${files.length}`);
for (const [ext, list] of [...byExt.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  .${ext}: ${list.length}`);
}
console.log('');

let fails = 0;
for (const [ext, list] of [...byExt.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`=== .${ext} ===`);
  for (const f of list.slice(0, SAMPLE)) {
    const r = await readDuration(f);
    const name = f.replace(ROOT, '').replace(/^\\/, '');
    if (r.ok) {
      const extra = [
        r.codec,
        r.sampleRate ? `${r.sampleRate}Hz` : null,
        r.channels ? `${r.channels}ch` : null,
        r.bitsPerSample ? `${r.bitsPerSample}bit` : null,
        r.estimated ? '估算' : null,
      ]
        .filter(Boolean)
        .join(' ');
      console.log(`  OK  ${fmtDuration(r.seconds)}  (${r.seconds.toFixed(3)}s)  [${extra}]  ${name}`);
    } else {
      fails++;
      console.log(`  FAIL  ${r.reason}  ${name}`);
    }
  }
  console.log('');
}
console.log(fails ? `失败 ${fails} 个` : '全部解析成功');
