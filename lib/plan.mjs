// 磁带录制方案判定核心
//
// 职责边界（按需求约定）：手动选歌，软件只做判定、分配、诊断 —— 绝不自动改用户的选择。
//
// 三个产出：
//   capacity    容量基准怎么算出来的（标称 + 档位，数值或百分比模式）
//   verdict     录得下 / 卡边缘 / 录不下
//   assignment  逐面分装（保持用户选定的顺序，A 面先装）
//   diagnosis   录不下时：差多少秒、是容量问题还是分配问题、最少删几首、删哪几首代价最小

const DECI = 10; // 内部以 0.1 秒为单位做整数 DP，够精确又不至于状态爆炸

/**
 * 计算单面容量（秒）
 * @param {{minutes: number, offset: string, mode: 'value'|'percent', percentMap: object}} opts
 */
export function computeCapacity(opts) {
  const { minutes, offset = 'nominal', mode = 'value', percentMap } = opts;
  const nominalSeconds = minutes * 60;
  const OFFSET_SECONDS = { '+1m': 60, '+30s': 30, nominal: 0, '-30s': -30, '-1m': -60 };
  const DEFAULT_PERCENT = { '+1m': 2, '+30s': 1, nominal: 0, '-30s': -1, '-1m': -2 };
  const map = { ...DEFAULT_PERCENT, ...(percentMap ?? {}) };

  let totalSeconds;
  let formula;
  if (mode === 'percent') {
    const pct = Number(map[offset] ?? 0);
    totalSeconds = nominalSeconds * (1 + pct / 100);
    formula = `${minutes}分 × (1 ${pct >= 0 ? '+' : '-'} ${Math.abs(pct)}%) = ${(totalSeconds / 60).toFixed(2)} 分`;
  } else {
    const delta = OFFSET_SECONDS[offset] ?? 0;
    totalSeconds = nominalSeconds + delta;
    const sign = delta === 0 ? '±0' : delta > 0 ? `+${delta}s` : `${delta}s`;
    formula = `${minutes}分 ${sign} = ${(totalSeconds / 60).toFixed(2)} 分`;
  }

  return {
    nominalSeconds,
    totalSeconds,
    /** 单面容量：磁带左右对称，两面等长 */
    perSideSeconds: totalSeconds / 2,
    formula,
    offset,
    mode,
  };
}

/**
 * 把一串曲目装进单面。
 *
 * 时间模型：第 i 首的起点 = lead + i × gap。
 *   引导段（lead）只在 A 面开头算一次；gap 是歌与歌之间的间隔，最后一首之后不追加
 *   —— 否则末尾那点空白会被当成必须留出的空洞，白白挤掉一首歌。
 */
function planSide(items, gapSeconds, capacitySeconds, leadSeconds = 0) {
  const placed = [];
  const skipped = [];
  let cursor = leadSeconds;
  for (const item of items) {
    if (cursor + item.seconds <= capacitySeconds + 1e-6) {
      placed.push({ ...item, startAt: cursor, endAt: cursor + item.seconds, gapBefore: placed.length === 0 ? leadSeconds : gapSeconds });
      cursor += item.seconds + gapSeconds; // 为下一首预留间隔
    } else {
      skipped.push(item);
    }
  }
  const usedSeconds = placed.length === 0 ? 0 : cursor - gapSeconds; // 末尾没有 gap
  return { placed, skipped, usedSeconds, freeAt: cursor, remainingSeconds: capacitySeconds - usedSeconds };
}

/**
 * 顺序不变的前提下找折点：前 k 首给 A 面，其余给 B 面。
 *
 * 目标由 targetA 决定，而 targetA 取决于用户选的填充方式（fill）：
 *   - pack：A 面塞满最省带，但手动反面机翻面后要倒带一大段
 *   - balance：两面尽量各占一半。这样手动反面机听完 B 面翻过来，磁带正好回到起点，不用倒带
 *
 * 无论哪种目标，都要保证剩下的能进 B 面；进不去就退，把 A 面让出空间。
 */
function splitTracks(tracks, gapSeconds, perSide, leadSeconds, targetA = perSide) {
  // 占用函数：第 i 首结束于 lead + i×gap + 累计时长
  const endOf = (k) => {
    let sum = leadSeconds;
    for (let i = 0; i < k; i++) sum += tracks[i].seconds + (i > 0 ? gapSeconds : 0);
    return sum;
  };
  const bTotalFrom = (k) => {
    let sum = 0;
    for (let j = k; j < tracks.length; j++) sum += tracks[j].seconds + (j > k ? gapSeconds : 0);
    return sum;
  };

  // 单首就超过单面容量的，任何方案都录不进去
  const impossible = tracks.filter((t) => t.seconds > perSide - leadSeconds);
  const feasible = tracks.filter((t) => !impossible.includes(t));

  // 先按目标找「最接近 targetA 且不超出」的 k，再逐步回退直到剩下的能进 B 面
  let bestK = 0;
  for (let k = feasible.length; k >= 1; k--) {
    if (endOf(k) <= targetA + 1e-6) {
      bestK = k;
      break;
    }
  }
  let fits = false;
  for (let k = bestK; k >= 1; k--) {
    if (bTotalFrom(k) <= perSide + 1e-6) {
      bestK = k;
      fits = true;
      break;
    }
  }

  let a;
  let b;
  if (fits) {
    a = planSide(feasible.slice(0, bestK), gapSeconds, perSide, leadSeconds);
    b = planSide(feasible.slice(bestK), gapSeconds, perSide, 0);
  } else {
    // 装不下时的"尽力而为"呈现：A 面贪心填满，剩下的继续往 B 面填，
    // 让用户看清"实际能录进去哪些"，而不是给一个空 A 面。
    a = planSide(feasible, gapSeconds, perSide, leadSeconds);
    b = planSide(a.skipped, gapSeconds, perSide, 0);
  }
  return { a, b, impossible, fits };
}

/**
 * 两面均衡：在「一首不丢」的前提下，让两面的音乐时长尽量相等。
 *
 * 为什么要相等：A 面正向走到带尾是一面，翻过来 B 面从带尾往回走，B 面放完磁头正好回到带头
 * —— 也就是 A 面的开头。所以只要两面音乐时长相等，翻面之后紧接着就是 A 面第一首，
 * 完全不用倒带。这正是「手动反面机型」那种听法的核心诉求。
 *
 * 约束只有一条：每面各自的音乐时长不超过单面容量。两面是两条独立音轨，
 * 总容量是两者的和；「均衡」是分摊，不是砍容量 —— 这点和直觉相反，但很关键。
 *
 * 算法：以「总量的一半」为目标二分 A 面预算。
 *   预算太小时剩下的塞不进 B 面，就调大；直到找到最小的可行预算，
 *   此时 A 面尽量少占、B 面尽量多装，两面最接近。
 *
 * @returns {{a: object, b: object, fits: boolean, targetA: number, longest: number}}
 */
function balanceSplit(items, gapSeconds, perSide, leadSeconds) {
  const gapTotal = Math.max(0, items.length - 1) * gapSeconds;
  const total = items.reduce((sum, t) => sum + t.seconds, 0) + gapTotal;
  const idealA = Math.min(total / 2 + leadSeconds / 2, perSide);
  const longest = items.reduce((m, t) => Math.max(m, t.seconds), 0);

  const tryWith = (budgetForA) => {
    const chosenA = bestSubset(items, budgetForA, gapSeconds, leadSeconds);
    const aItems = items.filter((_, i) => chosenA.has(i));
    const bItems = items.filter((_, i) => !chosenA.has(i));
    const a = planSide(aItems, gapSeconds, perSide, leadSeconds);
    const b = planSide(bItems, gapSeconds, perSide, 0);
    return { a, b, fits: a.skipped.length === 0 && b.skipped.length === 0 };
  };

  let best = tryWith(idealA);

  // 理想值不行时，二分找最小的可行预算。
  // 上界取「理想值 + 最长曲目」：DP 返回的子集和与目标最多差一首曲子的长度，
  // 用最长曲目当余量比直接取满单面容量更精确。
  if (!best.fits) {
    let lo = idealA;
    let hi = Math.min(idealA + longest, perSide);
    if (tryWith(hi).fits) {
      for (let i = 0; i < 14 && hi - lo > 1; i++) {
        const mid = (lo + hi) / 2;
        const attempt = tryWith(mid);
        if (attempt.fits) {
          hi = mid;
          best = attempt;
        } else {
          lo = mid;
        }
      }
    } else {
      // 连「理想值 + 最长曲目」都塞不下，说明总量确实超出整盘。
      // 这时均衡让位给装载量：各自按单面容量取最大子集，先尽可能多录。
      // 只挑"最接近目标"的子集会导致总装入量反而比塞满模式少，那没有道理。
      const chosenA = bestSubset(items, perSide, gapSeconds, leadSeconds);
      const restB = items.filter((_, i) => !chosenA.has(i));
      const a = planSide(items.filter((_, i) => chosenA.has(i)), gapSeconds, perSide, leadSeconds);
      const b = planSide(restB, gapSeconds, perSide, 0);
      best = { a, b, fits: a.skipped.length === 0 && b.skipped.length === 0 };
    }
  }
  return { ...best, targetA: idealA, longest };
}

/**
 * 用 DP 求「装进给定容量、总时长最大」的子集（0.1 秒粒度）。
 *
 * 已知保守性：DP 只是子集和，不区分曲目先后，所以无法精确表达「只有 k-1 个间隔」这一事实
 * —— 这里按「每首选中的曲子都预留 gap」计算，结果是略微保守（宁可少装也不越界）。
 * 越界在磁带上不可恢复（歌会被截断），所以偏向保守是正确的取舍。
 *
 * @param {Array<{seconds: number}>} items
 * @param {number} capacitySeconds 单面容量
 * @param {number} gapSeconds 歌间留白
 * @param {number} leadSeconds A 面起始引导段
 */
function bestSubset(items, capacitySeconds, gapSeconds = 0, leadSeconds = 0) {
  const budget = capacitySeconds - leadSeconds;
  const cap = Math.floor(budget * DECI);
  if (cap <= 0 || items.length === 0) return new Set();

  const gapUnits = Math.ceil(gapSeconds * DECI);
  const reachable = new Uint8Array(cap + 1);
  const parent = new Int32Array(cap + 1).fill(-1);
  reachable[0] = 1;

  for (let i = 0; i < items.length; i++) {
    const w = Math.floor(items[i].seconds * DECI) + gapUnits;
    if (w <= 0 || w > cap) continue;
    for (let s = cap - w; s >= 0; s--) {
      if (reachable[s] && !reachable[s + w]) {
        reachable[s + w] = 1;
        parent[s + w] = i;
      }
    }
  }

  let best = -1;
  for (let s = cap; s >= 0; s--) {
    if (reachable[s]) {
      best = s;
      break;
    }
  }
  if (best < 0) return new Set();

  const chosen = new Set();
  let s = best;
  let guard = 0;
  while (s > 0 && parent[s] >= 0 && guard++ < items.length + 1) {
    const i = parent[s];
    if (chosen.has(i)) break; // 防御：异常时不死循环
    chosen.add(i);
    s -= Math.floor(items[i].seconds * DECI) + gapUnits;
  }
  return chosen;
}

/**
 * 主判定函数
 * @param {object} input
 * @param {Array<{id: string, title?: string, seconds: number}>} input.tracks 用户选定的曲目（顺序即录制顺序）
 * @param {number} input.minutes 磁带标称分钟数
 * @param {string} input.offset '+1m' | '+30s' | 'nominal' | '-30s' | '-1m'
 * @param {string} input.mode 'value' | 'percent'
 * @param {number} input.gapSeconds 歌间留白
 * @param {number} input.leadSeconds 起始引导段（A 面开头留白）
 * @param {string} input.strategy 'manual' | 'auto'  手动顺序 / 自动排布
 * @param {string} input.fill 'pack' | 'balance'  塞满 A 面 / 两面时长均衡
 * @param {boolean} input.forceReorder  true = 不看顺序折点，直接让软件重新划分两面
 *
 * 注意这里没有"录音机类型"参数。它曾经存在过，但从未参与任何计算 ——
 * 它只影响两件事：要不要用均衡、以及界面上按钮灰不灰。那是个纯 UI 状态，
 * 却把状态空间从「塞满/均衡」2 种撑成 6 种，状态互相打架全出在那多出来的一维上。
 * 机器差异改用界面上选项的文案标注（哪档适合哪种机型），更直接也更难出错。
 */
export function planRecording(input) {
  const {
    tracks,
    minutes,
    offset,
    mode,
    percentMap,
    gapSeconds = 3,
    leadSeconds = 0,
    fill = 'pack',
    forceReorder = false,
  } = input;

  if (!tracks?.length) {
    return { ok: false, error: 'no-tracks', message: '还没有选歌' };
  }

  const capacity = computeCapacity({ minutes, offset, mode, percentMap });
  const perSide = capacity.perSideSeconds;

  // 总时长校验：所有歌 + 所有歌间留白 + 引导段
  const gapsNeeded = Math.max(0, tracks.length - 1) * gapSeconds;
  const sumSeconds = tracks.reduce((a, t) => a + t.seconds, 0);
  const requiredSeconds = sumSeconds + gapsNeeded + leadSeconds;
  const totalAvailable = perSide * 2;

  /**
   * 两面的填充目标。
   *   自动反面机：机器自己换向，歌曲就是一条连续序列，A 面塞满 = 最省带
   *   手动反面 + pack：同上，但翻面后要倒带一大段
   *   手动反面 + balance：两面音乐时长尽量相等 —— 翻面后磁头正好回到 A 面开头，不用倒带
   *
   * balance 不受总量限制：两面是两条独立音轨，每条各有一面容量，
   * 「均衡」只是把选歌分摊到两面，并不会缩减可录总量。
   */
  const balanced = fill === 'balance';
  const halfSide = perSide / 2;
  const targetA = balanced ? halfSide + leadSeconds / 2 : perSide;

  const base = {
    capacity,
    totals: {
      sumSeconds,
      gapsNeeded,
      leadSeconds,
      requiredSeconds,
      totalAvailable,
      /**
       * 只在真正装不下时才是正数。
       *
       * 注意别拿它当通用指标：它是「整个清单的需求 − 总容量」，包含了没装进去的曲目；
       * 而 remainingSeconds 是「已装入部分在两面的剩余」——两者口径不同，
       * 同时显示会得出"明明还有剩余却显示超出"这种自相矛盾的界面。
       * 所以除非 verdict 是 overflow，前端不该展示这个值。
       */
      overflowSeconds: Math.max(0, requiredSeconds - totalAvailable),
      /** 两面的实际剩余（按当前装法算，未装下的曲目不参与） */
      remainingSeconds: 0, // 由下面填
    },
  };

  // ① 保持顺序，搜折点（最贴近"我手动排的顺序"这个意图）
  const split = splitTracks(tracks, gapSeconds, perSide, leadSeconds, targetA);

  // ② 均衡模式走独立的搜索；它和"重新划分两面"是两回事：
  //    后者追求不丢歌，前者追求两面时长接近。
  let dpPlan = null;
  let balancePlan = null;
  if (balanced) {
    balancePlan = balanceSplit(tracks.filter((t) => t.seconds <= perSide), gapSeconds, perSide, leadSeconds);
  } else if (!split.fits || forceReorder) {
    const usable = tracks.filter((t) => t.seconds <= perSide);
    const chosenA = bestSubset(usable, perSide, gapSeconds, leadSeconds);
    const restB = usable.filter((_, i) => !chosenA.has(i));
    const autoA = planSide(usable.filter((_, i) => chosenA.has(i)), gapSeconds, perSide, leadSeconds);
    const autoB = planSide(restB, gapSeconds, perSide, 0);
    dpPlan = { a: autoA, b: autoB, fits: autoA.skipped.length === 0 && autoB.skipped.length === 0 };
  }

  // 呈现哪套装法（用哪个 plan 由 forceReorder 决定，与 reordered 无关）：
  //   均衡模式     -> 用均衡搜索的结果（顺序切分做不到均衡）
  //   开了自动排布 -> 用重新划分的结果
  //   其余         -> 用保持顺序的折点结果（哪怕提示"装不下"），
  //                   否则显示的曲目顺序会和用户实际排的顺序对不上
  const useDp = Boolean(forceReorder && dpPlan);
  const activePlan = balancePlan ?? (useDp ? dpPlan : split);

  // reordered =「这份装法的顺序与用户点选的顺序不同」。
  // 直接比较两者的 id 序列最可靠：自动排布、均衡都会打乱顺序，而用户自己拖动调整过
  // 顺序之后，服务端算出来的结果可能恰好就等于他的顺序，那时就不该再标"已重排"。
  const plannedIds = [...activePlan.a.placed, ...activePlan.b.placed].map((p) => p.id);
  const reordered =
    plannedIds.length === tracks.length && plannedIds.some((id, i) => id !== tracks[i].id);

  // ── 判定 ──────────────────────────────────────────────────────────────────
  //
  // 判定必须和「实际采用的那套装法」对齐。
  // 均衡模式用的是 activePlan（均衡搜索的结果），如果还拿 split（A 面塞满的顺序切分）去判，
  // 就会得出"分不进两面"，凭空报出「需要重排」—— 而均衡模式下 A 面本来就是故意不塞满的，
  // 顺序切分分不下是必然结果，不能当成错误。
  const totalFits = requiredSeconds <= totalAvailable + 1e-6;
  const activeFits = activePlan.a.skipped.length === 0 && activePlan.b.skipped.length === 0;

  let verdict;
  if (activeFits && activePlan === balancePlan) {
    // 均衡成功：按均衡结果算，不必再看顺序切分
    verdict = 'fits';
  } else if (forceReorder) {
    // 用户主动要求重排：以重排结果为准
    verdict = dpPlan?.fits ? 'fits' : totalFits ? 'reorder' : 'overflow';
  } else if (split.fits && split.impossible.length === 0) {
    verdict = 'fits';
  } else if (totalFits) {
    verdict = 'reorder'; // 总量够，只是当前顺序分不进两面
  } else {
    verdict = 'overflow';
  }

  // 按 id 去重 —— 顺序结果和重排结果来自不同对象，靠对象相等去不掉重复
  const unusableMap = new Map();
  for (const t of [...split.impossible, ...activePlan.a.skipped, ...activePlan.b.skipped]) {
    unusableMap.set(t.id ?? `${t.title}@${t.seconds}`, t);
  }
  const unusable = [...unusableMap.values()];

  // ── 诊断：录不下时给数字，绝不自动改用户的选择 ──────────────────────────────
  //
  // 注意数字的算法：已装入的以 placed 为准，「还差多少」= 没装进去的那些歌的时长。
  // 不能拿「总需求 - 总可用」当成超出量 —— 装不下时它会和实际未装入的量对不上，
  // 也不能数 skipped 的个数 —— 同一首歌可能同时出现在两面的 skipped 里被数两次。
  const placedIds = new Set([...activePlan.a.placed, ...activePlan.b.placed].map((p) => p.id));
  const notPlaced = tracks.filter((t) => !placedIds.has(t.id));
  const notPlacedSeconds = notPlaced.reduce((sum, t) => sum + t.seconds, 0);

  let diagnosis = null;
  if (verdict !== 'fits') {
    // 最少删几首：从最长的开始去掉（近似，但方向明确），直到剩下的能装进去
    const worst = [...tracks].sort((x, y) => y.seconds - x.seconds);
    const mustRemove = [];
    let freed = 0;
    for (const t of worst) {
      if (freed >= notPlacedSeconds) break;
      freed += t.seconds;
      mustRemove.push(t);
    }

    // 更常用的建议：删哪一首「刚好够」，代价最小
    const suggestions = tracks
      .map((t) => {
        const after = requiredSeconds - t.seconds - gapSeconds;
        return { track: t, afterSeconds: after, fits: after <= totalAvailable, margin: totalAvailable - after };
      })
      .filter((s) => s.fits)
      .sort((x, y) => x.margin - y.margin)
      .slice(0, 5);

    diagnosis = {
      kind: verdict === 'overflow' ? 'capacity' : 'assignment',
      overflowSeconds: notPlacedSeconds,
      notPlaced,
      notPlacedSeconds,
      mustRemoveCount: mustRemove.length,
      mustRemove,
      suggestions,
      unusable,
      // 提示要跟"到底能不能救"对齐，判据是 dpPlan.fits（重新划分装不装得下），
      // 不是 reordered（顺序有没有变）。
      // 这两件事没有关系：顺序切分遇到装不下的曲子会跳过它继续往后装，顺序因此被打乱
      // （reordered 变 true），但那并不代表"没救了"——重新划分往往就能装下。
      // 之前这里用 reordered 判断，于是明明救得了却告诉用户"自动排布也救不了"。
      needsReorder: verdict === 'reorder' && !dpPlan?.fits,
      message:
        verdict === 'overflow'
          ? `这盘装不下全部：有 ${notPlaced.length} 首（共 ${(notPlacedSeconds / 60).toFixed(1)} 分）没能装入，最少要少录 ${mustRemove.length} 首`
          : verdict === 'reorder'
            ? dpPlan?.fits
              ? '总时长够，只是当前这个排法分不进两面 —— 按「自动排布」让软件重新划分即可，一首都不用删'
              : `总时长够，但有 ${unusable.length} 首因为单曲太长（超过单面容量）无论怎么排都放不进`
            : `有 ${unusable.length} 首因为单曲太长（超过单面容量）无论怎么排都放不进`,
    };
  }

  // ── 补充说明：不影响判定，但用户需要知道为什么某个选项没生效 ────────────────
  const notes = [];
  if (balancePlan && !balancePlan.fits) {
    notes.push({
      kind: 'balance-partial',
      message:
        `即便按两面均衡来摊，仍有 ${(balancePlan.a.skipped.length + balancePlan.b.skipped.length)} 首装不进去 ` +
        `（单曲超过单面容量，或总时长超出整盘）。可以先按现在这个划分录，剩下的下盘再说。`,
    });
  }

  // 剩余量按「实际装进两面的时长」算，而不是拿总可用量减去总需求 ——
  // 后者在装不下的情况下会给出负数，对用户没有意义。
  base.totals.remainingSeconds = activePlan.a.remainingSeconds + activePlan.b.remainingSeconds;
  base.totals.usedSeconds = activePlan.a.usedSeconds + activePlan.b.usedSeconds;

  // 没排进去的曲目数：必须由这里给出，不能靠前端拿「选了 N 首 − 装进 M 首」去猜，
  // 那样一旦两边对不上就会算出 0，把"还有歌没排进去"这个提示吃掉。
  const placedIdSet = new Set([...activePlan.a.placed, ...activePlan.b.placed].map((p) => p.id));
  base.totals.notPlacedCount = tracks.filter((t) => !placedIdSet.has(t.id)).length;

  return {
    ok: true,
    verdict,
    ...base,
    assignment: {
      a: activePlan.a,
      b: activePlan.b,
      /** true = 这份装法是软件重新划分过的，与你的手动顺序不同 */
      reordered,
      strategy: reordered ? 'auto' : 'manual',
      /** 实际生效的分配方式 */
      fill: balanced ? 'balance' : 'pack',
      /** 请求了均衡但没生效时为 false，前端据此提示 */
      balanceApplied: balanced,
      /**
       * 这份装法是不是「软件排出来的」（均衡或自动排布真的用上了）。
       *
       * 和 reordered 是两件事，别混：
       *   autoApplied —— 前端据此决定要不要高亮"被软件挪过的曲子"
       *   reordered   —— 前端据此决定要不要标注"原第几位"
       * 用户手动拖动微调之后，服务端算出的顺序可能恰好等于他的顺序（reordered 变 false），
       * 但自动模式仍然在生效，高亮不该跟着消失。
       */
      autoApplied: Boolean(balancePlan || useDp),
    },
    notes,
    diagnosis,
    /**
     * 内部决策快照，给 tools/ 下的排查脚本用。
     * 「明明装得下却报需要重排」这类问题光看输入输出判断不了，得知道当时选了哪条分支。
     */
    _debug: {
      usedPlan: balancePlan ? 'balance' : useDp ? 'dp' : 'split',
      splitFits: split.fits,
      splitImpossible: split.impossible.length,
      dpPlanFits: dpPlan ? dpPlan.fits : null,
      dpSkipped: dpPlan ? dpPlan.a.skipped.length + dpPlan.b.skipped.length : null,
      balanceFits: balancePlan ? balancePlan.fits : null,
      totalFits,
      forceReorder,
      activeFits,
      verdict,
    },
  };
}
