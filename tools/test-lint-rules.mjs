// lint 规则的回归测试。
//
// 规则的价值全在误报控制上，所以每条规则都拿「真问题」和「正常写法」两边对照。
// 这里复刻 lint.mjs 的判定逻辑（改规则时两边要同步）。
//
// 被这两条规则抓到的真实 bug：
//   1. 无限递归 —— 批量替换把函数自己的定义体也换了，`f(t) = f(t)`，整个页面渲染栈溢出
//   2. 重复绑定 —— 按钮上同时留着 onclick 和 addEventListener，各切换一次状态，
//      净效果是"闪一下就弹回去"，看起来像按钮坏了

// ── 规则 1：函数无条件立即调用自己（无限递归） ──────────────────────────────

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

function extractBodies(src) {
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
  return bodies;
}

function detectSelfRecursion(src) {
  const flagged = [];
  for (const [name, body] of extractBodies(src)) {
    if (depthZeroSelfCall(body, name)) flagged.push(name);
  }
  return flagged;
}

// ── 规则 2：同一元素同时用 addEventListener 和 onclick ──────────────────────

function detectDuplicateBindings(src) {
  const problems = [];
  const boundByListener = new Set(
    [...src.matchAll(/(\w+(?:\.\w+)*)\.addEventListener\(\s*['"](\w+)['"]/g)].map((m) => `${m[1]}#${m[2]}`),
  );
  for (const m of src.matchAll(/(\w+(?:\.\w+)*)\.on(\w+)\s*=/g)) {
    const key = `${m[1]}#${m[2].toLowerCase()}`;
    if (boundByListener.has(key)) problems.push(key);
  }
  return problems;
}

// ── 用例 ────────────────────────────────────────────────────────────────────
const recursionCases = [
  { name: '[递归] 真 bug：替换时连自己定义体也换了', code: `const trackTitle = (t) => trackTitle(t).replace(/x/, '');`, expect: ['trackTitle'] },
  { name: '[递归] 真 bug：命名函数立即自调用', code: `function render(x) { render(x); }`, expect: ['render'] },
  { name: '[递归] 正常：目录遍历', code: `function walk(dir) {\n  for (const e of list(dir)) {\n    if (e.isDir()) walk(e.path);\n  }\n}`, expect: [] },
  { name: '[递归] 正常：事件回调里重渲染', code: `function renderDirs(dirs) {\n  for (const d of dirs) {\n    d.onclick = () => {\n      renderDirs(dirs);\n    };\n  }\n}`, expect: [] },
  { name: '[递归] 正常：有终止条件的递归', code: `function parse(node) {\n  if (node.child) {\n    return parse(node.child);\n  }\n  return node;\n}`, expect: [] },
  { name: '[递归] 正常：箭头函数简写且不自调用', code: `const fmt = (s) => String(s).padStart(2, '0');`, expect: [] },
];

const bindingCases = [
  { name: '[绑定] 真 bug：同一按钮两种方式都绑 click', code: `btn.addEventListener('click', () => toggle());\nbtn.onclick = () => other();`, expect: ['btn#click'] },
  { name: '[绑定] 真 bug：输入框两种方式都绑 change', code: `input.addEventListener('change', () => save());\ninput.onchange = () => save2();`, expect: ['input#change'] },
  { name: '[绑定] 正常：只用 addEventListener', code: `btn.addEventListener('click', () => toggle());\nbtn.addEventListener('change', () => save());`, expect: [] },
  { name: '[绑定] 正常：只用 onclick', code: `btn.onclick = () => toggle();\nother.onclick = () => other2();`, expect: [] },
  { name: '[绑定] 正常：不同元素各用一种方式', code: `btn.addEventListener('click', () => a());\nother.onclick = () => b();`, expect: [] },
  { name: '[绑定] 正常：同一元素不同事件', code: `input.addEventListener('click', () => a());\ninput.onchange = () => b();`, expect: [] },
];

let pass = 0;
let fail = 0;
for (const c of [
  ...recursionCases.map((c) => ({ ...c, detect: detectSelfRecursion })),
  ...bindingCases.map((c) => ({ ...c, detect: detectDuplicateBindings })),
]) {
  const got = c.detect(c.code);
  const okRow = JSON.stringify(got) === JSON.stringify(c.expect);
  if (okRow) pass++;
  else fail++;
  console.log(`${okRow ? '✓' : '✗'} ${c.name}`);
  if (!okRow) console.log(`    期望 ${JSON.stringify(c.expect)}，实际 ${JSON.stringify(got)}`);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
