// 标签读取自检
import { readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { readTags } from '../lib/tags.mjs';

const ROOT = process.argv[2] ?? process.env.MUSIC_DIR ?? 'music';
const SAMPLE = Number(process.argv[3] ?? 3);
const EXTS = new Set(['flac', 'mp3', 'dsf', 'dff', 'm4a', 'aac']);

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
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (EXTS.has(extname(e.name).slice(1).toLowerCase())) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const seen = new Set();
let shown = 0;
for (const f of files) {
  const ext = extname(f).slice(1).toLowerCase();
  if (seen.has(ext)) continue;
  seen.add(ext);
  const t = await readTags(f, ext);
  const ok = t.title || t.artist || t.album;
  console.log(`[${ext}] ${ok ? 'OK ' : '空 '} title=${JSON.stringify(t.title)} artist=${JSON.stringify(t.artist)} album=${JSON.stringify(t.album)} track=${JSON.stringify(t.track)}`);
  console.log(`      ${f.replace(ROOT, '')}`);
  if (++shown >= SAMPLE * EXTS.size) break;
}
