// 库扫描自检：走完整缓存流程，输出统计
// 用法: node tools/test-scan.mjs [--force] [根目录...]
import { scanAll } from '../lib/library.mjs';
import { projectPath } from './paths.mjs';

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const roots = argv.filter((a) => !a.startsWith('--'));
if (!roots.length) roots.push(process.env.MUSIC_DIR ?? 'music');

const CACHE = projectPath('.cache', 'library.json');

const t0 = Date.now();
let lastLog = 0;
const { tracks, perRoot } = await scanAll(roots, CACHE, {
  force,
  onProgress: (info) => {
    const now = Date.now();
    if (now - lastLog < 5000) return;
    lastLog = now;
    if (info.phase === 'walk') console.log(`  遍历中... 已找到 ${info.done} 个音频文件`);
    else console.log(`  解析 ${info.done}/${info.total}  ${info.name ?? ''}`);
  },
});

console.log('');
console.log(`总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const [root, s] of Object.entries(perRoot)) {
  console.log(`${root}: 共 ${s.total} 个, 命中缓存 ${s.cached}, 新解析 ${s.parsed}, 失败 ${s.failed}`);
}
console.log(`曲目总数 ${tracks.length}`);

const withTags = tracks.filter((t) => t.title || t.artist);
console.log(`有标签的 ${withTags.length} / ${tracks.length}`);
const withCover = tracks.filter((t) => t.cover?.bytes);
console.log(`有封面的 ${withCover.length} / ${tracks.length}`);
if (withCover.length) {
  const sample = withCover.slice(0, 3);
  for (const t of sample) console.log(`   封面样例: ${t.cover.mime} ${(t.cover.bytes / 1024).toFixed(1)}KB @${t.cover.dataOffset}  ${t.name}`);
}
console.log('');

console.log('=== 样例（前 12 条）===');
for (const t of tracks.slice(0, 12)) {
  const dur = t.seconds != null ? `${Math.floor(t.seconds / 60)}:${String(Math.round(t.seconds % 60)).padStart(2, '0')}` : '--:--';
  console.log(`  ${dur.padStart(6)}  ${(t.artist ?? '?').slice(0, 18).padEnd(18)} | ${(t.title ?? t.name).slice(0, 40)}`);
}

const bad = tracks.filter((t) => !t.ok);
if (bad.length) {
  console.log('');
  console.log(`=== 解析失败 ${bad.length} 个 ===`);
  for (const t of bad.slice(0, 10)) console.log(`  ${t.reason}  ${t.rel}`);
}
