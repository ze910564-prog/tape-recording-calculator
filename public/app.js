// 磁带录制计算器 —— 前端逻辑
//
// 状态模型：
//   allTracks  当前曲库（服务端已过滤掉解析失败的）
//   selected   已选曲目的 id 数组 —— 数组顺序就是录制顺序
//   planResult 服务端返回的判定结果（唯一真相来源，前端不自己算容量）
//
// 选择状态落 localStorage，刷新或关掉浏览器都不丢。

const LS_KEY = 'tape-calc:state:v1';

const el = (id) => {
  const node = document.getElementById(id);
  elements[id] = node;
  return node;
};
/**
 * 界面元素缓存。导出它是为了让 tools/test-render.mjs 能在无头环境里
 * 拿到真实的元素对象来触发事件（否则联动逻辑只能靠肉眼检查）。
 */
export const elements = {};
const els = {
  libInfo: el('libInfo'),
  minutes: el('minutes'),
  offsetSeg: el('offsetSeg'),
  mode: el('mode'),
  fill: el('fill'),
  gap: el('gap'),
  lead: el('lead'),
  autoBtn: el('autoBtn'),
  search: el('search'),
  libSelect: el('libSelect'),
  addLibBtn: el('addLibBtn'),
  rescanBtn: el('rescanBtn'),
  scanBar: el('scanBar'),
  scanFill: el('scanFill'),
  scanText: el('scanText'),
  libCount: el('libCount'),
  onlyAlbum: el('onlyAlbum'),
  dirList: el('dirList'),
  libList: el('libList'),
  selCount: el('selCount'),
  selList: el('selList'),
  clearBtn: el('clearBtn'),
  verdictBody: el('verdictBody'),
  toast: el('toast'),
};

const state = {
  allTracks: [],
  selected: [],
  /**
   * 用户最初点选出来的顺序，只增删不改序。
   * 用来判断「软件把哪几首挪了位置」——selected 会被软件的排布结果覆盖，
   * 拿它当基准的话，采纳之后高亮就自己消失了。
   */
  picked: [],
  planResult: null,
  config: null,
  activeDir: null,
  scanning: false,
  timer: null,
  /** 'manual' 只按你排的顺序；'auto' 允许软件重新划分 A/B 面 */
  strategy: 'manual',
  /** 第一次连上时服务端的启动时间，用来发现"服务没重启" */
  serverStartedAt: null,
};

// ── 工具 ────────────────────────────────────────────────────────────────────
/** 显示标题：有标签用标签，没有就退回文件名（剥掉扩展名，清单上更好看） */
const trackTitle = (t) => (t.title || t.name || '').replace(/\.[^.]+$/, '');

const fmt = (sec) => {
  if (sec == null || !Number.isFinite(sec)) return '--:--';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
};

const fmtLong = (sec) => {
  if (sec == null || !Number.isFinite(sec)) return '--';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}小时${m}分${r}秒` : `${m}分${r}秒`;
};

let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 2600);
}

function saveLocal() {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        selected: state.selected,
        picked: state.picked,
        minutes: els.minutes.value,
        offset: currentOffset(),
        mode: els.mode.value,
        fill: els.fill.value,
        gap: els.gap.value,
        lead: els.lead.value,
        search: els.search.value,
      }),
    );
  } catch {
    /* 隐私模式下写不进去，无所谓 */
  }
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const currentOffset = () => els.offsetSeg.querySelector('button.on')?.dataset.offset ?? 'nominal';

// ── 数据加载 ────────────────────────────────────────────────────────────────
/**
 * 服务端重启检测。
 *
 * 前端每次刷新都会重新下载 app.js，但服务是常驻进程 —— 改了 server.mjs / lib/
 * 之后不重启，它一直跑旧逻辑。那时界面是新的、算出来的是旧的，
 * 各种「明明该 X 却显示 Y」都由此而来。这里发现不一致就自动刷新，省得靠猜。
 */
function checkServerRestart(startedAt) {
  if (startedAt == null) return false;
  if (state.serverStartedAt == null) {
    state.serverStartedAt = startedAt;
    return false;
  }
  if (state.serverStartedAt !== startedAt) {
    state.serverStartedAt = startedAt;
    toast('检测到服务已重启，正在刷新界面…');
    setTimeout(() => location.reload(), 1200);
    return true;
  }
  return false;
}

async function loadState() {
  const r = await fetch('/api/state');
  const data = await r.json();
  state.config = data.config;
  if (checkServerRestart(data.startedAt)) return;

  // 曲库路径下拉
  els.libSelect.innerHTML = '';
  data.config.libraries.forEach((lib, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = lib;
    els.libSelect.append(o);
  });
  els.libSelect.value = String(data.config.activeLibrary ?? 0);

  const lib = data.library;
  els.libInfo.textContent = lib.count
    ? `${lib.count} 首 · 合计 ${fmtLong(lib.totalSeconds)} · ${new Date(lib.scannedAt).toLocaleString('zh-CN')}`
    : '曲库为空，点右上角 ↻ 扫描';

  // 服务端配置回填到界面（本地状态优先）
  const local = loadLocal();
  els.minutes.value = local?.minutes ?? data.config.tape.minutes;
  els.mode.value = local?.mode ?? data.config.tape.mode;
  els.fill.value = local?.fill ?? data.config.fill ?? 'pack';
  els.gap.value = local?.gap ?? data.config.gapSeconds;
  els.lead.value = local?.lead ?? data.config.leadSeconds;
  setOffset(local?.offset ?? data.config.tape.offset);
  updateModeUI();

  if (lib.scanning) startProgressPolling();
}

function setOffset(offset) {
  els.offsetSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.offset === offset));
}

async function loadTracks() {
  const q = els.search.value.trim();
  const url = q ? `/api/tracks?q=${encodeURIComponent(q)}` : '/api/tracks';
  const r = await fetch(url);
  const data = await r.json();
  state.allTracks = data.tracks;
  els.libCount.textContent = `${data.total} 首`;
  renderDirs(data.dirs);
  renderLibrary();
}

function startProgressPolling() {
  if (state.scanning) return;
  state.scanning = true;
  els.scanBar.hidden = false;
  const tick = async () => {
    try {
      const p = await (await fetch('/api/progress')).json();
      checkServerRestart(p.startedAt);
      const pr = p.progress ?? {};
      if (pr.phase === 'walk') {
        els.scanText.textContent = `遍历目录… 已找到 ${pr.done}`;
        els.scanFill.style.width = '8%';
      } else if (pr.phase === 'parse') {
        const pct = pr.total ? Math.round((pr.done / pr.total) * 100) : 0;
        els.scanFill.style.width = `${pct}%`;
        els.scanText.textContent = `解析 ${pr.done}/${pr.total} ${pct}%`;
      } else if (pr.phase === 'error') {
        els.scanText.textContent = `扫描出错: ${pr.message}`;
      } else {
        els.scanText.textContent = '开始扫描…';
      }

      if (!p.scanning) {
        state.scanning = false;
        els.scanFill.style.width = '100%';
        setTimeout(() => (els.scanBar.hidden = true), 800);
        await loadState();
        await loadTracks();
        schedulePlan();
        return;
      }
    } catch {
      state.scanning = false;
      return;
    }
    setTimeout(tick, 600);
  };
  tick();
}

// ── 渲染 ────────────────────────────────────────────────────────────────────
function coverUrl(id) {
  return `/api/cover?id=${encodeURIComponent(id)}`;
}

function coverEl(cls, track) {
  const d = document.createElement('div');
  d.className = cls;
  if (track.hasCover) {
    d.style.backgroundImage = `url("${coverUrl(track.id)}")`;
  } else {
    d.textContent = '♪';
  }
  return d;
}

function renderDirs(dirs) {
  els.dirList.innerHTML = '';
  if (!els.onlyAlbum.checked) {
    els.dirList.hidden = true;
    state.activeDir = null;
    return;
  }
  els.dirList.hidden = false;
  for (const dir of dirs) {
    const d = document.createElement('div');
    d.textContent = dir || '(根目录)';
    d.className = state.activeDir === dir ? 'on' : '';
    d.onclick = () => {
      state.activeDir = state.activeDir === dir ? null : dir;
      renderDirs(dirs);
      renderLibrary();
    };
    els.dirList.append(d);
  }
}

function renderLibrary() {
  const sel = new Set(state.selected);
  const list = state.activeDir == null ? state.allTracks : state.allTracks.filter((t) => t.dir === state.activeDir);
  els.libList.innerHTML = '';

  if (!list.length) {
    els.libList.innerHTML = '<p class="muted" style="padding:12px">没有匹配的曲目。</p>';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const t of list) {
    const row = document.createElement('div');
    row.className = `track${sel.has(t.id) ? ' on' : ''}`;
    row.append(coverEl('cover', t));

    const meta = document.createElement('div');
    meta.className = 'meta';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = trackTitle(t);
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = [t.artist, t.album, t.bitsPerSample ? `${t.bitsPerSample}bit` : null, t.sampleRate ? `${(t.sampleRate / 1000).toFixed(1)}k` : null]
      .filter(Boolean)
      .join(' · ') || t.dir;
    meta.append(title, sub);

    const dur = document.createElement('div');
    dur.className = 'dur';
    dur.textContent = fmt(t.seconds);

    row.append(meta, dur);
    row.onclick = () => toggleTrack(t.id);
    frag.append(row);
  }
  els.libList.append(frag);
}

function renderSelected() {
  const p = state.planResult;
  const byId = new Map(state.allTracks.map((t) => [t.id, t]));

  // 开了自动排布或均衡时，列表按服务端排好的顺序显示，而不是用户点选的顺序，
  // 否则中间看到的和右侧清单里的对不上，等于白排。
  const reordered = Boolean(p?.ok && p.assignment?.reordered);
  const order = displayOrder();

  // 高亮的依据是「自动模式有没有生效」，不是 reordered。
  // 用户拖动微调之后服务端的顺序可能恰好等于他的顺序（reordered 变 false），
  // 但软件仍然在按均衡/自动排布装带，不该突然不标了。
  const autoApplied = Boolean(p?.ok && p.assignment?.autoApplied);
  const movedIds = new Set();
  if (autoApplied) {
    order.forEach((id, i) => {
      if (state.picked[i] !== id) movedIds.add(id);
    });
  }

  els.selCount.textContent = `${state.selected.length} 首`;
  els.selList.innerHTML = '';

  if (!state.selected.length) {
    els.selList.innerHTML = '<p class="muted" style="padding:12px">从左边点选曲目，这里会按录制顺序排列。</p>';
    return;
  }

  const aCount = p?.ok ? (p.assignment?.a?.placed?.length ?? 0) : 0;
  const frag = document.createDocumentFragment();

  order.forEach((id, i) => {
    const t = byId.get(id);
    if (!t) return;

    if (i === 0) frag.append(sideDivider('A 面'));
    if (i === aCount && aCount > 0 && aCount < order.length) frag.append(sideDivider('B 面'));

    const row = document.createElement('div');
    row.className = `sel-item${movedIds.has(id) ? ' moved' : ''}`;
    row.draggable = true;
    row.dataset.idx = String(i);

    const idx = document.createElement('div');
    idx.className = 'idx';
    idx.textContent = String(i + 1);

    const cover = coverEl('cover', t);

    const meta = document.createElement('div');
    meta.style.minWidth = '0';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = trackTitle(t);
    const sub = document.createElement('div');
    sub.className = 'sub';
    const originIdx = state.picked.indexOf(id);
    sub.textContent =
      reordered && movedIds.has(id) && originIdx >= 0 ? `原第 ${originIdx + 1} 位` : t.artist || t.dir;
    meta.append(title, sub);

    const dur = document.createElement('div');
    dur.className = 'dur';
    dur.textContent = fmt(t.seconds);

    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.textContent = '×';
    rm.title = '移除';
    rm.onclick = (e) => {
      e.stopPropagation();
      toggleTrack(id);
    };

    row.append(idx, cover, meta, dur, rm);

    // 拖动：自动排布/均衡之后仍然允许微调，但限定在同一面内。
    // 跨面搬运会把两面时长差拉开，等于把刚算好的均衡作废 —— 那种调整应该去改参数重算，
    // 而不是靠拖拽一点点挪。所以跨面直接拒绝并说明原因。
    row.addEventListener('dragstart', (e) => {
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      const sameSide = inSameSide(i, aCount, order.length);
      row.classList.toggle('over', sameSide);
      row.classList.toggle('over-cross', !sameSide);
    });
    row.addEventListener('dragleave', () => row.classList.remove('over', 'over-cross'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('over', 'over-cross');
      const from = Number(e.dataTransfer.getData('text/plain'));
      const to = Number(row.dataset.idx);
      if (!Number.isInteger(from) || from === to) return;
      if (!inSameSide(from, aCount, order.length) || !inSameSide(to, aCount, order.length)) {
        toast('跨面搬歌会破坏两面分配 —— 请改分配方式或选歌，不要直接拖到另一面');
        return;
      }
      moveItem(from, to);
    });

    frag.append(row);
  });

  els.selList.append(frag);
}

/** 拖动落点是否和起点在同一面（A 面是 0..aCount-1，B 面是 aCount..total-1） */
function inSameSide(a, b, aCount) {
  if (aCount <= 0) return true; // 还没有分面信息，随便拖
  return a < aCount === b < aCount;
}

function sideDivider(label) {
  const d = document.createElement('div');
  d.className = 'side-divider';
  d.textContent = label;
  return d;
}

/**
 * 当前清单的显示顺序。
 *   自动排布/均衡 -> 服务端算出来的顺序（用户看到的、拖动的都是这个）
 *   手动         -> 用户自己排的 selected
 */
function displayOrder() {
  const p = state.planResult;
  if (p?.ok && p.assignment?.reordered) {
    return [...(p.assignment.a.placed ?? []), ...(p.assignment.b.placed ?? [])].map((x) => x.id);
  }
  return state.selected;
}

function moveItem(from, to) {
  // 用户是在「看到的顺序」上拖动的，所以以它为准来移动。
  // 自动模式下这份顺序来自服务端，得先采纳成基准，否则用户微调完一重算就被覆盖回去。
  const list = displayOrder();
  if (from < 0 || to < 0 || from >= list.length || to >= list.length) return;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
  state.selected = list;

  // 作废上一次的判定结果：它描述的是拖动之前的顺序。
  // 留着的话，下一次规划返回之前界面会"显示旧顺序、内部已是新顺序"，看着像没反应。
  state.planResult = null;

  saveLocal();
  renderLibrary();
  renderSelected();
  schedulePlan();
}

function toggleTrack(id) {
  const i = state.selected.indexOf(id);
  if (i >= 0) {
    state.selected.splice(i, 1);
    const j = state.picked.indexOf(id);
    if (j >= 0) state.picked.splice(j, 1);
  } else {
    state.selected.push(id);
    state.picked.push(id); // picked 只记录点选，拖动调整不会改它
  }
  saveLocal();
  renderLibrary();
  renderSelected();
  schedulePlan();
}

// ── 判定 ────────────────────────────────────────────────────────────────────
function schedulePlan() {
  clearTimeout(state.timer);
  state.timer = setTimeout(runPlan, 160);
}

async function runPlan() {
  if (!state.selected.length) {
    state.planResult = null;
    els.verdictBody.innerHTML = '<p class="muted">左侧选歌后这里会实时显示结果。</p>';
    renderSelected();
    return;
  }

  const body = currentParams();

  try {
    const r = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    state.planResult = await r.json();
  } catch (e) {
    els.verdictBody.innerHTML = `<p class="muted">判定失败: ${e.message}</p>`;
    return;
  }
  renderVerdict();
  renderSelected();
}

function renderVerdict() {
  const p = state.planResult;
  if (!p || !p.ok) {
    els.verdictBody.innerHTML = `<p class="muted">${p?.message ?? '—'}</p>`;
    return;
  }

  const t = p.totals;
  const a = p.assignment.a;
  const b = p.assignment.b;
  const label = { fits: '录得下', reorder: '需要重排', overflow: '录不下' }[p.verdict];

  const parts = [];
  parts.push(`<div><span class="badge ${p.verdict}">${label}</span></div>`);

  // 剩余量按实际装进去的算：装不下的情况下用「总可用量 - 总需求」会得到负数，没意义
  const remaining = t.remainingSeconds ?? 0;
  const filled = t.totalAvailable > 0 ? (t.usedSeconds / t.totalAvailable) * 100 : 0;
  const cls = p.verdict === 'overflow' ? 'bad' : remaining < 60 ? 'warn' : '';

  parts.push(`
    <div class="gauge">
      <div class="lbl"><span>已装 ${fmtLong(t.usedSeconds)}</span><span>空余 <b>${fmtLong(remaining)}</b></span></div>
      <div class="bar"><div class="fill ${cls}" style="width:${Math.min(100, filled).toFixed(1)}%"></div></div>
      <div class="lbl" style="margin-top:4px">
        <span>磁带总容量 ${fmtLong(t.totalAvailable)}</span>
        <span>${p.assignment.balanceApplied ? '两面均衡' : p.assignment.autoApplied ? '自动排布' : '按你的顺序'}</span>
      </div>
    </div>`);

  parts.push(`
    <dl class="kv">
      <dt>容量算法</dt><dd>${p.capacity.formula}</dd>
      <dt>单面容量</dt><dd>${fmtLong(p.capacity.perSideSeconds)}</dd>
      <dt>歌曲总长</dt><dd>${fmtLong(t.sumSeconds)}</dd>
      <dt>歌间留白</dt><dd>${fmtLong(t.gapsNeeded)}</dd>
      ${t.leadSeconds ? `<dt>起始引导</dt><dd>${fmtLong(t.leadSeconds)}</dd>` : ''}
      ${
        // 「超出」只在真的装不下时才显示。
        // 它是「整个清单需求 − 总容量」，和上面的「空余」（只算已装进去的）口径不同，
        // 两个一起显示会出现"还有空余却超出"的自相矛盾。
        p.verdict === 'overflow'
          ? `<dt>超出</dt><dd style="color:var(--bad)">${fmtLong(t.overflowSeconds)}</dd>`
          : ''
      }
    </dl>`);

  // 未装入的曲目要单独点出来。
  // 「空余」只反映已装进去那部分的余量，不说清楚的话，用户会以为空余就等于这些歌也装下了。
  const missing = t.notPlacedCount ?? 0;
  if (missing > 0) {
    parts.push(
      `<div class="diag ${p.verdict === 'overflow' ? 'capacity' : 'warn'}"><div>还有 <b>${missing}</b> 首没排进去（上面的空余只是已装入部分的余量${p.verdict === 'reorder' ? '；总量是够的，重新划分两面就能装下' : ''}）。</div></div>`,
    );
  }

  const sideBlock = (name, side) => `
    <h3 class="side-title">${name} · ${side.placed.length} 首 · 用 ${fmtLong(side.usedSeconds)} · 余 ${fmtLong(side.remainingSeconds)}</h3>
    <div class="side-list">
      ${side.placed
        .map(
          (it) => `<div class="it">
            <span class="t">${escapeHtml(it.title ?? '')}</span>
            <span class="at">${fmt(it.startAt)}</span>
            <span class="d">${fmt(it.seconds)}</span>
          </div>`,
        )
        .join('')}
      ${side.placed.length ? '' : '<div class="muted">（空）</div>'}
    </div>`;

  parts.push(sideBlock('A 面', a));
  if (b.placed.length || b.skipped.length) parts.push(sideBlock('B 面', b));

  // 两面的落地差异提示。只讲这盘带录出来是什么样，不再按"机型"分叉 ——
  // 机型差异已经写在下拉框的文案里（哪档适合哪种机器）。
  const aSide = p.assignment.a;
  const bSide = p.assignment.b;
  const sideDiff = Math.abs(aSide.usedSeconds - bSide.usedSeconds);
  if (p.assignment.balanceApplied) {
    parts.push(
      `<div class="diag ok"><div><b>两面已均衡</b>（相差 ${fmtLong(sideDiff)}）—— 手动反面机听完 B 面翻过来，磁带正好回到起点，不用倒带。</div></div>`,
    );
  } else if (bSide.placed.length) {
    parts.push(
      `<div class="diag"><div>两面相差 ${fmtLong(sideDiff)}。手动反面机听完 B 面想回到起点要倒带 —— 换成「两面均衡」可以免掉这一步；自动反面机则由机器自己换向，不用管。</div></div>`,
    );
  }

  // 服务端的补充说明（例如：请求了均衡但总量超出，只能退回塞满）
  for (const note of p.notes ?? []) {
    parts.push(`<div class="diag warn"><div>${escapeHtml(note.message)}</div></div>`);
  }

  if (p.diagnosis) {
    const d = p.diagnosis;
    // 候选为空有两种情况：一首都删不掉就能装下（不需要建议），或者删一首远远不够
    const noSugHint =
      d.kind === 'capacity' && !d.suggestions.length
        ? '<div class="muted" style="margin-top:6px">删任何单独一首都不够 —— 需要按上面的数量继续减。</div>'
        : '';
    const sug = d.suggestions.length
      ? `<div class="muted" style="margin-top:6px">最小代价的候选（不是自动替你删）：</div>
         <ul>${d.suggestions
           .map(
             (s) =>
               `<li class="sug"><span>删《${escapeHtml(s.track.title)}》(${fmt(s.track.seconds)})</span><span class="muted">删后余 ${fmtLong(s.margin)}</span></li>`,
           )
           .join('')}</ul>`
      : '';
    parts.push(`
      <div class="diag ${d.kind}">
        <div>${escapeHtml(d.message)}</div>
        ${sug}
        ${noSugHint}
      </div>`);
  }

  // 提示已经由服务端的 diagnosis.message 给出（它知道用户开没开自动排布），
  // 这里不再重复一遍，否则同一件事会说两次。
  // 提示跟着「自动模式有没有生效」走，而不是 reordered ——
  // 用户拖动微调后顺序可能恰好一致，但自动装带这件事仍然是生效的
  if (p.assignment.autoApplied) {
    const moved = countMoved(p);
    const how = p.assignment.balanceApplied ? '两面均衡' : '自动排布';
    parts.push(
      `<div class="diag"><div>这份装法由<b>${how}</b>给出${moved ? ` —— 有 <b>${moved}</b> 首不在你最初的选歌顺序上（序号标黄）` : ''}。同一面内可以继续拖动微调。</div></div>`,
    );
  }

  // 导出：写磁带标签用
  parts.push(`
    <div class="export">
      <div class="muted" style="margin-bottom:6px">导出清单（写标签用）</div>
      <div class="row">
        <button class="btn ghost" data-export="txt">文本清单</button>
        <button class="btn ghost" data-export="csv">CSV 表格</button>
        <button class="btn ghost" data-export="m3u">M3U 播放列表</button>
      </div>
    </div>`);

  els.verdictBody.innerHTML = parts.join('');

  for (const btn of els.verdictBody.querySelectorAll('[data-export]')) {
    btn.onclick = () => exportPlan(btn.dataset.export, btn);
  }
}

/** 数一数自动排布把多少首挪了位置 */
function countMoved(p) {
  const order = [...(p.assignment.a.placed ?? []), ...(p.assignment.b.placed ?? [])].map((x) => x.id);
  let n = 0;
  order.forEach((id, i) => {
    if (state.selected[i] !== id) n++;
  });
  return n;
}

/** 当前界面上的全部参数，导出和判定共用同一份，避免两边算出不同结果 */
function currentParams() {
  return {
    ids: state.selected,
    minutes: Number(els.minutes.value),
    offset: currentOffset(),
    mode: els.mode.value,
    gapSeconds: Number(els.gap.value),
    leadSeconds: Number(els.lead.value),
    fill: els.fill.value,
    forceReorder: state.strategy === 'auto',
  };
}

/**
 * 更新「自动排布」按钮的显示。
 *
 * 这里不再有"机器类型"这个开关 —— 它曾经是个纯 UI 状态，却把状态空间
 * 从「塞满/均衡」2 种撑成 6 种，前几轮的状态互相打架全出在那多出来的一维上。
 * 机器差异改用下拉框的文案标注（哪个档适合哪种机型），比用一个开关去"管理"它更直接。
 *
 * 现在的规则只有一条：
 *   均衡模式下点按钮 → 切到「塞满」并开启自动排布（并说明原因）
 *   塞满模式下点按钮 → 在"按你排的顺序"和"软件重新划分"之间切换
 */
function updateModeUI() {
  els.autoBtn.classList.toggle('on', state.strategy === 'auto');
  els.autoBtn.textContent = state.strategy === 'auto' ? '自动排布：已开启' : '自动排布：关';
  els.autoBtn.title =
    state.strategy === 'auto'
      ? '当前：软件重新划分 A/B 面。点一下回到你自己排的顺序'
      : '当前：按你排的顺序装。点一下让软件重新划分 A/B 面（选歌不变，只是想装得更满）';
}

// ── 导出 ────────────────────────────────────────────────────────────────────
async function exportPlan(format, btn) {
  if (!state.selected.length) {
    toast('还没有选歌');
    return;
  }
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '生成中…';

  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...currentParams(), format }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    if (format === 'm3u') {
      // M3U 由前端根据服务端返回的结构生成
      const plan = await res.json();
      download(plan.filename, buildM3u(plan), 'audio/x-mpegurl');
    } else {
      const blob = await res.blob();
      const name = filenameFromHeader(res.headers.get('content-disposition')) ?? `磁带清单.${format}`;
      download(name, blob, blob.type);
    }
    toast('已导出：' + format.toUpperCase());
  } catch (e) {
    toast('导出失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function filenameFromHeader(header) {
  if (!header) return null;
  const m = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/** #EXTINF 带标题，方便播放器里直接看；路径用绝对路径，双击 m3u 也能放 */
function buildM3u(plan) {
  const lines = ['#EXTM3U'];
  const seen = new Set();
  for (const side of [plan.assignment.a, plan.assignment.b]) {
    for (const it of side.placed) {
      const path = it.absPath ?? it.id;
      if (seen.has(path)) continue;
      seen.add(path);
      const artist = it.artist ? `${it.artist} - ` : '';
      lines.push(`#EXTINF:${Math.round(it.seconds)},${artist}${it.title || it.name || ''}`);
      lines.push(path);
    }
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function download(filename, data, mime = 'text/plain;charset=utf-8') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ── 事件绑定 ────────────────────────────────────────────────────────────────
els.offsetSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  setOffset(btn.dataset.offset);
  saveLocal();
  schedulePlan();
});

// 这些控件只改参数，不改变"按什么规则装"，所以统一处理；
// 两面分配（fill）有额外联动，单独绑在下面
for (const input of [els.minutes, els.mode, els.gap, els.lead]) {
  input.addEventListener('input', () => {
    saveLocal();
    schedulePlan();
  });
  input.addEventListener('change', () => {
    saveLocal();
    schedulePlan();
  });
}

// 两面的分配方式。均衡和自动排布是两种互斥的排法，切到均衡时把自动排布关掉并说明原因。
els.fill.addEventListener('change', () => {
  if (els.fill.value === 'balance' && state.strategy === 'auto') {
    state.strategy = 'manual';
    toast('自动排布已关闭 —— 「两面均衡」本身就按时长划分两面');
  }
  updateModeUI();
  saveLocal();
  schedulePlan();
});

els.autoBtn.addEventListener('click', () => {
  if (els.fill.value === 'balance') {
    // 均衡会按时长自己划分两面，跟自动排布是两种互斥的排法。
    // 不默默退出，而是换到能用自动排布的状态并说清楚发生了什么。
    els.fill.value = 'pack';
    state.strategy = 'auto';
    updateModeUI();
    saveLocal();
    toast('「两面均衡」改为「塞满 A 面」，并开启自动排布（顺序将由软件重排）');
    runPlan();
    return;
  }

  state.strategy = state.strategy === 'auto' ? 'manual' : 'auto';
  updateModeUI();
  saveLocal();
  toast(state.strategy === 'auto' ? '自动排布：软件会重新划分 A/B 面（选歌不变）' : '已回到你排的顺序');
  runPlan();
});

let searchTimer = null;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    saveLocal();
    loadTracks();
  }, 250);
});

els.onlyAlbum.addEventListener('change', () => loadTracks());

els.clearBtn.onclick = () => {
  if (!state.selected.length) return;
  state.selected = [];
  state.picked = [];
  saveLocal();
  renderLibrary();
  renderSelected();
  schedulePlan();
};

els.rescanBtn.onclick = async () => {
  const force = confirm('重新扫描曲库？\n\n确定 = 强制重新读取所有文件（慢，几十秒）\n取消 = 只做增量更新（只读新增/改动的文件）');
  await fetch('/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force }),
  });
  toast(force ? '已开始全量重扫…' : '已开始增量扫描…');
  startProgressPolling();
};

els.libSelect.onchange = async () => {
  const idx = Number(els.libSelect.value);
  // 切换激活的曲库，并把当前曲库列表完整保留（而不是覆盖成只剩这一个）
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeLibrary: idx }),
  });
  toast(`已切换到 ${state.config.libraries[idx]}，正在扫描…`);
  await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  startProgressPolling();
};

els.addLibBtn.onclick = async () => {
  const p = prompt('要添加的曲库目录（绝对路径）：', '');
  if (!p?.trim()) return;
  const libs = [...state.config.libraries, p.trim()];
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ libraries: libs, activeLibrary: libs.length - 1 }),
  });
  toast('已添加曲库，开始扫描…');
  await loadState();
  await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  startProgressPolling();
};

// ── 启动 ────────────────────────────────────────────────────────────────────
(async function init() {
  const local = loadLocal();
  await loadState();
  if (local?.selected?.length) {
    state.selected = local.selected;
    // picked 记的是"点选顺序"：没存过就退化成当前顺序（旧版本的存档也没有这个字段）
    state.picked = local.picked?.length === local.selected.length ? local.picked : [...local.selected];
  }
  if (local?.search) els.search.value = local.search;

  await loadTracks();
  renderSelected();
  if (state.selected.length) runPlan();
})();
