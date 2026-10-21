// 把 PowerShell 脚本里的非 ASCII 字符清掉。
//
// 为什么要专门做这件事：Windows PowerShell 5.1 在没有 BOM 时按 ANSI 读 .ps1，
// 非 ASCII 字符会被读成乱码并破坏引号配对，报出莫名其妙的语法错误。
// 而编辑器和补丁工具会悄悄丢掉 BOM，所以只能从源头保证脚本是纯 ASCII。
//
// 用法: node tools/ascii-clean.mjs <文件...>

import { readFile, writeFile } from 'node:fs/promises';

const MAP = new Map([
  ['×', 'x'], ['—', '--'], ['–', '-'], ['·', '*'],
  ['≥', '>='], ['≤', '<='], ['→', '->'], ['←', '<-'],
  ['✓', 'OK'], ['✗', 'X'], ['⚠', '!'],
  ['“', '"'], ['”', '"'], ['‘', "'"], ['’', "'"],
  ['（', '('], ['）', ')'], ['，', ','], ['：', ':'],
]);

let total = 0;
for (const file of process.argv.slice(2)) {
  const raw = await readFile(file, 'utf8');
  const bad = [...raw].filter((c) => c.charCodeAt(0) > 127);
  if (!bad.length) {
    console.log(`${file}: 已经是纯 ASCII`);
    continue;
  }

  const unique = [...new Set(bad)];
  console.log(`${file}: ${bad.length} 个非 ASCII 字符，种类 ${unique.length}`);
  console.log('  ' + unique.map((c) => `${JSON.stringify(c)}(U+${c.charCodeAt(0).toString(16)})`).join(' '));

  let out = raw;
  for (const [from, to] of MAP) out = out.split(from).join(to);
  // 兜底：剩下的任何非 ASCII 换成 '-'
  out = out.replace(/[^\x00-\x7F]/g, '-');
  await writeFile(file, out, 'utf8');

  const after = [...out].filter((c) => c.charCodeAt(0) > 127).length;
  console.log(`  -> 清理完成，剩余非 ASCII: ${after}`);
  total += bad.length;
}
console.log(`\n合计清理 ${total} 个字符`);
