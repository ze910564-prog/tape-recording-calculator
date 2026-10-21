// 前端自检：无头 DOM 桩里真跑一遍渲染与交互。
//
// 存在的意义：界面上「列表空白」「按钮点了没反应」这类问题，打开浏览器控制台一看就知道，
// 但这个项目希望不打开浏览器也能查出来。所以这里手搓一个够用的 DOM 桩，
// 覆盖 createElement / append / addEventListener / onclick 等被用到的接口。
//
// 桩必须同时支持 addEventListener 和 onclick —— 踩过的坑：代码里混用了两种绑定方式，
// 而当时的桩只认前者，于是"按钮上留着重复处理器、点一次状态切换两次"
// 这个 bug 在测试里完全隐形，一路全绿。
//
// 用法: node tools/test-render.mjs [BASE]

const BASE = process.argv[2] ?? 'http://127.0.0.1:7788';

// ── 极简 DOM 桩 ─────────────────────────────────────────────────────────────
class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this._class = '';
    this._text = '';
    this.hidden = false;
    this.checked = false;
    this.value = '';
    this._listeners = {};
    // DocumentFragment 在 append 时会把子节点摊平到父节点里，
    // 不模拟这一点的话，一个片段会被当成"一个子节点"，渲染统计就全错了
    this.isFragment = tag === 'fragment';
  }
  get className() { return this._class; }
  set className(v) { this._class = String(v); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get innerHTML() { return this._html ?? ''; }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  append(...kids) {
    for (const k of kids) {
      if (k?.isFragment) this.children.push(...k.children);
      else this.children.push(k);
    }
  }
  remove() {}
  querySelectorAll() { return []; }
  querySelector() { return null; }
  addEventListener(type, fn) {
    (this._listeners[type] ??= []).push(fn);
  }
  /** 触发事件，两种绑定方式都要照顾到（见文件头的说明） */
  dispatch(type) {
    const ev = { target: this, preventDefault() {}, stopPropagation() {} };
    for (const fn of this._listeners[type] ?? []) fn(ev);
    const inline = this[`on${type}`];
    if (typeof inline === 'function') inline(ev);
  }
  classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
}

const ids = new Map();
const document = {
  getElementById: (id) => {
    if (!ids.has(id)) ids.set(id, new El('div'));
    return ids.get(id);
  },
  createElement: (tag) => new El(tag),
  createDocumentFragment: () => new El('fragment'),
  body: new El('body'),
  addEventListener() {},
};

import { readFile } from 'node:fs/promises';
import { projectPath } from './paths.mjs';

// 从 index.html 抓出所有 id，保证桩能提供
const html = await readFile(projectPath('public', 'index.html'), 'utf8');
const htmlIds = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
for (const id of htmlIds) document.getElementById(id);

const appSrc = await readFile(projectPath('public', 'app.js'), 'utf8');

// app.js 用 ESM 的 export 导出元素缓存，vm 里跑不了 —— 换成全局变量再喂进去；
// 同时去掉末尾的 init 自执行，改为手动触发，便于逐步观察
const patched = appSrc
  .replace(/^export const elements = \{\};$/m, 'const elements = {};')
  .replace(/\(async function init\(\)[\s\S]*?\}\)\(\);\s*$/, '')
  .concat('\n;globalThis.__hooks = { loadState, loadTracks, renderLibrary, renderSelected, renderVerdict, checkServerRestart, currentParams, state, elements };\n');

console.log(`模拟 DOM，注入 ${htmlIds.length} 个元素 id`);
console.log(`抓取远端数据: ${BASE}\n`);

const { default: vm } = await import('node:vm');

const sandbox = {
  document,
  window: {},
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: async (url, opts) => {
    const full = url.startsWith('http') ? url : BASE + url;
    return fetch(full, opts);
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms ?? 0),
  clearTimeout,
  console,
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  Blob: class { constructor() {} },
  confirm: () => false,
  prompt: () => null,
  structuredClone,
  __reloads: 0,
  location: {
    get href() { return BASE; },
    reload() { sandbox.__reloads++; },
  },
};

const ctx = vm.createContext(sandbox);
try {
  vm.runInContext(patched, ctx, { filename: 'app.js' });
  console.log('✓ app.js 解析并注册成功，没有语法/顶层错误');
} catch (e) {
  console.log('✗ app.js 顶层执行出错:', e.message);
  process.exit(1);
}

const hooks = sandbox.__hooks;

async function step(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    return true;
  } catch (e) {
    console.log(`✗ ${name} 抛出异常: ${e.message}`);
    console.log(e.stack?.split('\n').slice(1, 4).join('\n'));
    return false;
  }
}

let ok = true;
ok = (await step('loadState()', () => hooks.loadState())) && ok;
ok = (await step('loadTracks()', () => hooks.loadTracks())) && ok;

const tracks = hooks.state.allTracks;
console.log(`  → state.allTracks = ${tracks.length} 首`);
if (!tracks.length) {
  console.log('  ! 曲库是空的，后面的渲染检查没有意义');
  process.exit(1);
}

ok = (await step('renderLibrary()', async () => hooks.renderLibrary())) && ok;

const libList = document.getElementById('libList');
const rendered = libList.children.length;
console.log(`  → libList 里有 ${rendered} 个子节点`);
if (rendered < tracks.length) {
  console.log(`  ! 期望 ${tracks.length} 个曲目行，实际只有 ${rendered} 个 —— 渲染提前中断了`);
  ok = false;
}

ok = (await step('renderSelected()（空清单）', async () => hooks.renderSelected())) && ok;

hooks.state.selected = tracks.slice(0, 5).map((t) => t.id);
hooks.state.picked = [...hooks.state.selected];
ok = (await step('renderSelected()（5 首）', async () => hooks.renderSelected())) && ok;
const selList = document.getElementById('selList');
console.log(`  → selList 里有 ${selList.children.length} 个子节点`);

// ── 界面联动 ────────────────────────────────────────────────────────────────
//
// 「两面分配」和「自动排布」描述的是同一件事：这盘带按什么规则装。
// 两者互斥 —— 均衡按时长划分两面，自动排布按顺序划分。
// 约束关系全部固化成断言：前几轮的状态互相打架就出在这里。
//
// 界面上已经不再有「录音机类型」开关：它是个纯 UI 状态，从未参与计算，
// 却把状态空间从 2 种撑成 6 种。机器差异改用下拉框的文案标注。
console.log('\n界面联动检查');
const fillEl = hooks.elements.fill;
const autoEl = hooks.elements.autoBtn;

const linkCase = (label, fn) => {
  try {
    const r = fn();
    console.log(`${r.ok ? '✓' : '✗'} ${label}${r.detail ? `  ${r.detail}` : ''}`);
    if (!r.ok) ok = false;
  } catch (e) {
    console.log(`✗ ${label} 抛出异常: ${e.message}`);
    ok = false;
  }
};

const setFill = (v) => {
  fillEl.value = v;
  fillEl.dispatch('change');
};
/** 按钮文案写明状态，统一用它判断是否开启 */
const autoOn = () => autoEl.textContent.includes('已开启');

linkCase('默认塞满模式 → 按钮可点、初始为关', () => {
  setFill('pack');
  if (autoOn()) autoEl.dispatch('click');
  return { ok: !autoEl.disabled && !autoOn(), detail: `可点=${!autoEl.disabled} 文案="${autoEl.textContent}"` };
});

// 点一次只能切换一次。
// 踩过的坑：按钮上同时留着 onclick 和 addEventListener，两个处理器各切一次
// state.strategy，净效果是"闪一下就弹回去"。断言 state 而不只是文案 ——
// 两个处理器跑完后文案可能碰巧看起来正常。
linkCase('点一次只切换一次状态（不能闪回）', () => {
  setFill('pack');
  if (autoOn()) autoEl.dispatch('click');
  const before = hooks.state.strategy;
  autoEl.dispatch('click');
  const afterOne = hooks.state.strategy;
  const textOne = autoEl.textContent;
  autoEl.dispatch('click');
  const afterTwo = hooks.state.strategy;
  const clean = before === 'manual' && afterOne === 'auto' && afterTwo === 'manual' && textOne.includes('已开启');
  return { ok: clean, detail: `${before} → ${afterOne} → ${afterTwo}（一次点击文案="${textOne}"）` };
});

linkCase('开启自动排布 → 参数里 forceReorder=true', () => {
  setFill('pack');
  if (!autoOn()) autoEl.dispatch('click');
  const params = hooks.currentParams();
  return { ok: params.forceReorder === true, detail: `forceReorder=${params.forceReorder}` };
});

linkCase('关闭自动排布 → 参数里 forceReorder=false', () => {
  if (autoOn()) autoEl.dispatch('click');
  const params = hooks.currentParams();
  return { ok: params.forceReorder === false, detail: `forceReorder=${params.forceReorder}` };
});

linkCase('切到均衡 → 自动排布自动关闭并提示', () => {
  setFill('pack');
  if (!autoOn()) autoEl.dispatch('click');
  const wasOn = autoOn();
  setFill('balance');
  const nowOff = !autoOn();
  return { ok: wasOn && nowOff, detail: wasOn ? (nowOff ? '已关闭' : '✗ 没关') : '✗ 前置没建立' };
});

linkCase('均衡模式下点按钮 → 切到塞满并开启（不是没反应）', () => {
  setFill('balance');
  autoEl.dispatch('click');
  return { ok: fillEl.value === 'pack' && autoOn(), detail: `fill=${fillEl.value} 文案="${autoEl.textContent}"` };
});

linkCase('参数里带当前 fill', () => {
  setFill('balance');
  const params = hooks.currentParams();
  return { ok: params.fill === 'balance', detail: `fill=${params.fill}` };
});

linkCase('参数里不再有 machine（该维度已删除）', () => {
  const params = hooks.currentParams();
  return { ok: params.machine === undefined, detail: `machine=${params.machine}` };
});

// ── 服务重启检测 ────────────────────────────────────────────────────────────
//
// 改了 server.mjs / lib/ 之后不重启服务，会一直跑旧逻辑：
// 界面是新的、算出来的是旧的，各种「明明该 X 却显示 Y」都从这来。
// 这里验证前端能识别出"服务换了一茬"并自动刷新。
console.log('\n服务重启检测');
const check = hooks.checkServerRestart;

linkCase('第一次连接 → 只记录，不刷新', () => {
  hooks.state.serverStartedAt = null;
  const r1 = check(1000);
  return { ok: r1 === false && hooks.state.serverStartedAt === 1000, detail: `记录=${hooks.state.serverStartedAt}` };
});

linkCase('同一个服务继续用 → 不触发', () => {
  const before = sandbox.__reloads;
  const r = check(1000);
  return { ok: r === false && sandbox.__reloads === before, detail: 'reload 次数未增' };
});

linkCase('服务重启过 → 触发刷新', () => {
  const r = check(2000);
  return { ok: r === true, detail: `检测到新时间戳=${hooks.state.serverStartedAt}，已安排刷新` };
});

linkCase('缺 startedAt（旧版服务）→ 安全跳过', () => {
  const r = check(undefined);
  return { ok: r === false, detail: '不误报' };
});

console.log(ok ? '\n渲染自检通过' : '\n渲染自检发现问题');
process.exit(ok ? 0 : 1);
