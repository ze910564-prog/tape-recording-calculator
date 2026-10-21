// 代码质量静态检查：语法、未使用的导入、遗留的临时写法
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { projectRoot, projectPath } from './paths.mjs';

const ROOT = projectRoot();
const SCAN_DIRS = ['lib', 'public', 'tools'];
const SKIP = new Set(['node_modules', '.cache', '.git']);

const files = [];
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else if (/\.(mjs|js)$/.test(e.name)) files.push(p);
  }
}
for (const d of SCAN_DIRS) {
  try {
    await walk(join(ROOT, d));
  } catch {
    /* 目录不存在就算了 */
  }
}
files.push(join(ROOT, 'server.mjs'));

const problems = [];
const notes = [];

for (const f of files) {
  const rel = relative(ROOT, f);
  // 检查器自身和它的规则测试里就包含这些反面样本，跳过以免自报
  if (rel.endsWith('lint.mjs') || rel.endsWith('test-lint-rules.mjs')) continue;
  const src = await readFile(f, 'utf8');

  // 1. 语法检查
  try {
    new (await import('node:vm')).SourceTextModule(src, { identifier: rel });
  } catch (e) {
    if (e.name === 'SyntaxError') problems.push(`${rel}: 语法错误 — ${e.message}`);
  }

  // 2. 未使用的 import
  const importRe = /^import\s+(?:{([^}]+)}|(\w+)|\*\s+as\s+(\w+))\s+from\s+['"]([^'"]+)['"]/gm;
  for (const m of src.matchAll(importRe)) {
    const names = (m[1] ?? m[2] ?? m[3] ?? '')
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/).pop())
      .filter(Boolean);
    const body = src.slice(m.index + m[0].length);
    for (const n of names) {
      // 在后续代码里是否出现过（粗略但够用）
      const used = new RegExp(`\\b${n.replace(/[$]/g, '\\$')}\\b`).test(body);
      if (!used) problems.push(`${rel}: 导入了但未使用 — ${n} (来自 ${m[4]})`);
    }
  }

  // 3. 遗留的调试写法
  if (/\bconsole\.log\(/.test(src) && !rel.startsWith('tools') && rel !== 'server.mjs') {
    notes.push(`${rel}: 生产代码里有 console.log`);
  }
  if (/\bTODO\b|\bFIXME\b|\bXXX\b/.test(src)) {
    notes.push(`${rel}: 含 TODO/FIXME 标记`);
  }
  if (/\bdebugger\b/.test(src)) problems.push(`${rel}: 残留 debugger 语句`);

  // 4. 中文目录路径的坑：new URL(...).pathname
  if (/new URL\([^)]*\)\.pathname/.test(src)) {
    problems.push(`${rel}: 用了 new URL().pathname —— 中文路径会被 URL 编码，改用 projectPath()`);
  }

  // 5. Buffer.indexOf 的编码参数位置（踩过的坑）
  for (const m of src.matchAll(/\.indexOf\(([^)]*)\)/g)) {
    const args = m[1].split(',').map((s) => s.trim());
    if (args.length >= 3 && /^\d+$/.test(args[1]) && /^['"]/.test(args[1])) {
      problems.push(`${rel}: indexOf 的参数顺序可疑 — ${m[0]}`);
    }
  }

  // 6. 把 async 调用的返回值当普通对象用（漏 await 的典型症状）
  //
  // 这条规则是被真实 bug 逼出来的：server.mjs 里 await buildPlanFor(body) 少写了一个 await，
  // result 拿到的是 Promise，紧接着的 !result.ok 立刻命中，
  // 接口稳定返回 400 和一个空的 {}——不报错、不崩服务，但结果永远不对。
  //
  // 判定方式刻意保守：只看「赋值后马上对该变量做属性访问 / 真值判断」这一种形态。
  // 事件处理器里的 fire-and-forget（onclick = () => runPlan()）是正常写法，不在这里报。
  const asyncNames = new Set();
  for (const m of src.matchAll(/async\s+function\s+(\w+)/g)) asyncNames.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*async\s*\(/g)) asyncNames.add(m[1]);

  // asyncNames 为空时不能再拼正则：模式会退化成空分组，把 `foo = (x) =>` 这类也匹配上
  const declRe = asyncNames.size
    ? new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*(?:await\\s+)?(${[...asyncNames].join('|')})\\s*\\(`, 'g')
    : null;
  for (const m of declRe ? src.matchAll(declRe) : []) {
    const [, varName, fnName] = m;
    // 已经 await 过的就没问题
    if (/=\s*await\s/.test(m[0])) continue;

    // 往后看这个变量第一次被怎么用：属性访问 / 真值取反 / if 判断，都说明被当成了对象
    const rest = src.slice(m.index + m[0].length);
    const use = new RegExp(
      `(?<![\\w.])${varName}\\s*(?:\\?\\.|\\.\\w+)|!\\s*${varName}\\b|if\\s*\\(\\s*${varName}\\b`,
    ).exec(rest);
    if (!use) continue;
    // 紧跟着 then/catch/finally 是正常写法
    if (/then\b|catch\b|finally\b/.test(use[0])) continue;

    const lineNo = src.slice(0, m.index).split('\n').length;
    problems.push(`${rel}:${lineNo}: ${varName} = ${fnName}() 少了 await，后面却直接当对象用`);
  }

  // 7. 函数体里直接调用自己（无限递归）
  //
  // 这条也是被真实 bug 逼出来的：给 trackTitle 加"剥掉扩展名"时，
  // 用脚本批量把 `t.title || t.name` 替换成 `trackTitle(t)`，
  // 结果连函数自己的定义体也被换掉了，变成 `const trackTitle = (t) => trackTitle(t).replace(...)`。
  // 整个页面渲染直接栈溢出、列表全空白，但语法检查完全看不出来。
  const bodies = new Map();
  for (const m of src.matchAll(/(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{/g)) {
    const body = readBraces(src, src.indexOf('{', m.index));
    if (body) bodies.set(m[1], body);
  }
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g)) {
    const body = readBraces(src, src.indexOf('{', m.index));
    if (body) bodies.set(m[1], body);
  }
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*([^\n;]+)/g)) {
    if (!bodies.has(m[1])) bodies.set(m[1], m[2]);
  }
  for (const [name, body] of bodies) {
    // 只看顶层（花括号嵌套深度为 0）的自调用。
    // 目录遍历 `walk(dir) { ... walk(sub) ... }` 和事件回调 `row.onclick = () => renderDirs(d)`
    // 都是合法递归，它们在更深的层级；而 `(t) => trackTitle(t).replace(...)`
    // 这种立即自调用必然栈溢出，且恰好落在顶层。
    if (depthZeroSelfCall(body, name)) {
      const lineNo = src.slice(0, src.indexOf(body)).split('\n').length;
      problems.push(`${rel}:${lineNo}: ${name} 无条件立即调用自己 —— 必然无限递归`);
    }
  }

  // 8. 同一个元素同时用 addEventListener 和 onclick 绑事件
  //
  // 这两种方式不会互相覆盖，点一次两个处理器都跑。
  // 踩过的坑：自动排布按钮上留着旧的 onclick，和新写的 addEventListener 各切换一次
  // state.strategy，净效果是"闪一下就弹回去"，看起来像按钮坏了。
  const boundByListener = new Set(
    [...src.matchAll(/(\w+(?:\.\w+)*)\.addEventListener\(\s*['"](\w+)['"]/g)].map((m) => `${m[1]}#${m[2]}`),
  );
  for (const m of src.matchAll(/(\w+(?:\.\w+)*)\.on(\w+)\s*=/g)) {
    const key = `${m[1]}#${m[2].toLowerCase()}`;
    // 同一元素同一事件，两种方式都用了 -> 重复
    if (boundByListener.has(key)) {
      const lineNo = src.slice(0, m.index).split('\n').length;
      problems.push(
        `${rel}:${lineNo}: ${m[1]} 的 ${m[2].toLowerCase()} 事件既用 addEventListener 又用 on${m[2]} —— 会重复触发`,
      );
    }
  }
}

/** body 的顶层是否出现了对 name 的调用 */
function depthZeroSelfCall(body, name) {
  const selfRe = new RegExp(`(?<![\\w.])${name}\\s*\\(`, 'g');
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0) {
      selfRe.lastIndex = i;
      const m = selfRe.exec(body);
      if (m && m.index === i) return true;
    }
  }
  return false;
}

/** 从 `{` 的下一层往右配对，返回花括号内的文本 */
function readBraces(src, openIdx) {
  if (openIdx < 0) return null;
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return null;
}

console.log(`检查了 ${files.length} 个文件\n`);
if (problems.length) {
  console.log('=== 问题 ===');
  for (const p of problems) console.log(`  ✗ ${p}`);
} else {
  console.log('=== 问题 === 无');
}
if (notes.length) {
  console.log('\n=== 提示 ===');
  for (const n of notes) console.log(`  · ${n}`);
}
console.log(`\n合计: ${problems.length} 个问题, ${notes.length} 条提示`);
