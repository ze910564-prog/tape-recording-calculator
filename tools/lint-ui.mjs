// 前端静态一致性检查：确认 app.js 引用的元素 id 都在 index.html 里存在
import { readFile } from 'node:fs/promises';
import { projectPath } from './paths.mjs';

const html = await readFile(projectPath('public', 'index.html'), 'utf8');
const js = await readFile(projectPath('public', 'app.js'), 'utf8');
const css = await readFile(projectPath('public', 'style.css'), 'utf8');

const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const jsIds = [...js.matchAll(/el\('([^']+)'\)/g)].map((m) => m[1]);

const missing = jsIds.filter((id) => !htmlIds.has(id));
console.log(`HTML 定义 id: ${htmlIds.size} 个`);
console.log(`app.js 引用 id: ${jsIds.length} 个`);

if (missing.length) {
  console.log('\n=== 引用了但 HTML 里没有 ===');
  for (const m of missing) console.log(`  ✗ ${m}`);
} else {
  console.log('✓ app.js 引用的元素 id 全部存在');
}

// 检查 app.js 里用到的 class 是否在 css 里定义（只查明显的、我们自己起的名字）
const usedClasses = new Set(
  [...js.matchAll(/className\s*=\s*[`'"]([^`'"]+)[`'"]/g)]
    .flatMap((m) => m[1].split(/\s+/))
    .concat([...js.matchAll(/classList\.(?:add|toggle)\('([^']+)'/g)].map((m) => m[1]))
    .filter(Boolean),
);
const cssClasses = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
const undef = [...usedClasses].filter((c) => !cssClasses.has(c));

if (undef.length) {
  console.log('\n=== 用了但 CSS 里没有定义的 class（可能没样式）===');
  for (const c of undef) console.log(`  · ${c}`);
} else {
  console.log('✓ 动态 class 全部有样式定义');
}

// 检查 html 里引用的静态资源是否存在
const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
console.log(`\nHTML 引用静态资源: ${assets.join(', ')}`);
for (const a of assets) {
  try {
    await readFile(projectPath('public', a.slice(1)));
    console.log(`  ✓ ${a}`);
  } catch {
    console.log(`  ✗ ${a} 不存在`);
  }
}
