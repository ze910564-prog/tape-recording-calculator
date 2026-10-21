// 磁带录制计算器 —— 本地 HTTP 服务
//
// 只做三件事：暴露库数据、接收判定请求、按需返回封面字节。
// 判定逻辑全在 lib/plan.mjs，这里不重复实现任何规则。

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanAll, loadCache } from './lib/library.mjs';
import { planRecording, computeCapacity } from './lib/plan.mjs';
import { extractCover } from './lib/covers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');
const CACHE_DIR = join(HERE, '.cache');
const LIBRARY_CACHE = join(CACHE_DIR, 'library.json');
const CONFIG_PATH = join(CACHE_DIR, 'config.json');
const COVER_CACHE = join(CACHE_DIR, 'covers');

/**
 * 端口优先级：命令行 --port > 环境变量 PORT > 上次用过的端口 > 7788
 * 记住上次的端口是为了让 stop.mjs 之类的工具能找到我们。
 */
function resolvePort() {
  const argIdx = process.argv.indexOf('--port');
  if (argIdx !== -1 && process.argv[argIdx + 1]) return Number(process.argv[argIdx + 1]);
  if (process.env.PORT) return Number(process.env.PORT);
  return null;
}

const HOST = '127.0.0.1';

/** 封面磁盘缓存的格式版本；偏移语义变化时 +1 即可让旧缓存失效 */
const COVER_CACHE_VERSION = 2;

/** 粗判一段字节是不是图片（防止把错误偏移读到的垃圾当成封面发给浏览器） */
function looksLikeImage(buf) {
  if (buf.length < 4) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // GIF
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return true;
  return false;
}

const DEFAULT_CONFIG = {
  libraries: [], // 首次启动没有曲库，用界面左上角的“＋”添加
  activeLibrary: 0,
  port: null, // 实际使用的端口由启动时决定，写回配置供 stop.mjs 等使用
  token: null, // 关闭接口的口令，启动时写回配置
  tape: { minutes: 120, offset: 'nominal', mode: 'value', percentMap: { '+1m': 2, '+30s': 1, nominal: 0, '-30s': -1, '-1m': -2 } },
  gapSeconds: 3,
  leadSeconds: 0,
  /** 两面的分配方式：'pack' 塞满 A 面 / 'balance' 两面均衡 */
  fill: 'pack',
};

async function loadConfig() {
  try {
    const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
    return {
      ...DEFAULT_CONFIG,
      ...cfg,
      tape: { ...DEFAULT_CONFIG.tape, ...(cfg.tape ?? {}) },
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

async function saveConfig(cfg) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

// ── 内存中的曲库状态（扫描结果 + 进度） ──────────────────────────────────────
let library = { tracks: [], scannedAt: 0, scanning: false, progress: null, stats: null };
const coverInflight = new Map(); // id -> Promise<Buffer|null>

async function scanLibraries(roots, { force = false } = {}) {
  if (library.scanning) return;
  library.scanning = true;
  library.progress = { phase: 'start', done: 0, total: 0 };
  try {
    const { tracks, perRoot } = await scanAll(roots, LIBRARY_CACHE, {
      force,
      onProgress: (info) => {
        library.progress = info;
      },
    });
    library.tracks = tracks;
    library.stats = perRoot;
    library.scannedAt = Date.now();
  } catch (e) {
    library.progress = { phase: 'error', message: String(e?.message ?? e) };
  } finally {
    library.scanning = false;
  }
}

/** 启动时先用缓存把曲库灌进来，让界面秒开；随后后台做增量扫描 */
async function warmStart(roots) {
  try {
    const cache = await loadCache(LIBRARY_CACHE);
    const tracks = [];
    for (const root of roots) {
      const bucket = cache.roots?.[root];
      if (!bucket) continue;
      for (const [rel, e] of Object.entries(bucket.entries)) {
        tracks.push({
          id: `${root}|${rel}`,
          root,
          rel,
          name: rel.split(/[\\/]/).pop(),
          dir: rel.includes('\\') ? rel.slice(0, rel.lastIndexOf('\\')) : '',
          ...e,
        });
      }
    }
    if (tracks.length) {
      library.tracks = tracks;
      library.scannedAt = Number(cache.roots?.[roots[0]]?.scannedAt ?? 0);
    }
  } catch {
    /* 冷启动无所谓 */
  }
}

// ── HTTP 工具 ───────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/** 只保留送到前端的字段，避免把缓存里的 mtime/size 之类泄漏出去 */
function publicTrack(t) {
  return {
    id: t.id,
    name: t.name,
    title: t.title,
    artist: t.artist,
    album: t.album,
    track: t.track,
    seconds: t.seconds,
    ok: t.ok,
    reason: t.reason,
    codec: t.codec,
    sampleRate: t.sampleRate,
    bitsPerSample: t.bitsPerSample,
    lossless: t.lossless,
    hasCover: Boolean(t.cover?.bytes),
    dir: t.dir,
  };
}

/**
 * 按请求参数算出装带方案。判定与导出共用这一段，避免两处各写一遍规则。
 * @param {object} body { ids, minutes, offset, mode, gapSeconds, leadSeconds, forceReorder }
 */
async function buildPlanFor(body) {
  const cfg = await loadConfig();
  const tracks = (body.ids ?? [])
    .map((id) => library.tracks.find((t) => t.id === id))
    .filter(Boolean)
    .map((t) => ({
      id: t.id,
      // 没有标签的曲目退回文件名，但要剥掉扩展名 —— 清单上写 "3C.flac" 不好看
      title: t.title ?? t.name.replace(/\.[^.]+$/, ''),
      artist: t.artist,
      album: t.album,
      seconds: t.seconds,
    }));

  if (!tracks.length) return { ok: false, error: 'no-tracks', message: '还没有选歌' };

  const result = planRecording({
    tracks,
    minutes: Number(body.minutes ?? cfg.tape.minutes),
    offset: body.offset ?? cfg.tape.offset,
    mode: body.mode ?? cfg.tape.mode,
    percentMap: cfg.tape.percentMap,
    gapSeconds: Number(body.gapSeconds ?? cfg.gapSeconds),
    leadSeconds: Number(body.leadSeconds ?? cfg.leadSeconds),
    fill: body.fill ?? cfg.fill ?? 'pack',
    forceReorder: Boolean(body.forceReorder),
  });
  if (!result.ok) return result;

  // 导出清单里要写明留白参数，这里带回实际生效的值
  result.gapSeconds = Number(body.gapSeconds ?? cfg.gapSeconds);

  // 补上文件名和目录，导出时要写进清单
  const absById = new Map();
  for (const t of library.tracks) {
    if (body.ids.includes(t.id)) absById.set(t.id, { name: t.name, dir: t.dir, root: t.root, rel: t.rel });
  }
  const hydrate = (side) => ({
    ...side,
    placed: side.placed.map((p) => ({
      ...p,
      artist: p.artist ?? null,
      album: p.album ?? null,
      name: absById.get(p.id)?.name ?? null,
      dir: absById.get(p.id)?.dir ?? null,
      absPath: absById.has(p.id) ? join(absById.get(p.id).root, absById.get(p.id).rel) : null,
    })),
  });
  result.assignment = { ...result.assignment, a: hydrate(result.assignment.a), b: hydrate(result.assignment.b) };
  return result;
}

/** 纯文本清单：按面向磁带标签的排版写 */
function exportText(result, lib) {
  const { capacity, totals, assignment } = result;
  const fmt = (s) => {
    const t = Math.round(s ?? 0);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const sec = t % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  };

  const lines = [];
  lines.push('磁带录制清单');
  lines.push('='.repeat(46));
  lines.push(`生成时间   ${new Date().toLocaleString('zh-CN')}`);
  lines.push(`容量算法   ${capacity.formula}`);
  lines.push(`单面容量   ${fmt(capacity.perSideSeconds)}`);
  lines.push(`歌间留白   ${result.gapSeconds ?? 0} 秒`);
  if (totals.leadSeconds) lines.push(`起始引导   ${Math.round(totals.leadSeconds)} 秒`);
  lines.push(`总占用     ${fmt(totals.requiredSeconds)}  /  可用 ${fmt(totals.totalAvailable)}`);
  lines.push(`实际剩余   ${fmt(totals.remainingSeconds)}`);
  lines.push(`装法       ${assignment.reordered ? '自动排布（已重新划分两面）' : '按选定的顺序'}`);
  lines.push('');

  for (const [label, side] of [['A 面', assignment.a], ['B 面', assignment.b]]) {
    if (!side.placed.length) continue;
    lines.push(`${label}   ${side.placed.length} 首   用 ${fmt(side.usedSeconds)}   余 ${fmt(side.remainingSeconds)}`);
    lines.push('-'.repeat(46));
    side.placed.forEach((it, i) => {
      const idx = String(i + 1).padStart(2, ' ');
      const title = it.title || it.name || '';
      const artist = it.artist ? ` — ${it.artist}` : '';
      lines.push(`${idx}. ${title}${artist}`);
      lines.push(`    时长 ${fmt(it.seconds).padStart(6)}    起始 ${fmt(it.startAt)}`);
    });
    lines.push('');
  }

  const skipped = [...assignment.a.skipped, ...assignment.b.skipped];
  if (skipped.length) {
    lines.push('未能装入');
    lines.push('-'.repeat(46));
    for (const t of skipped) lines.push(`  · ${t.title || t.name} (${fmt(t.seconds)})`);
    lines.push('');
  }
  return lines.join('\r\n');
}

/** CSV：一行一首，带面和序号，方便在 Excel 里再排版 */
function exportCsv(result, lib) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['面', '序号', '标题', '艺人', '专辑', '时长', '起始', '文件名', '路径'].join(',')];
  for (const [label, side] of [['A', result.assignment.a], ['B', result.assignment.b]]) {
    side.placed.forEach((it, i) => {
      rows.push(
        [
          label,
          i + 1,
          esc(it.title),
          esc(it.artist),
          esc(it.album),
          Math.round(it.seconds),
          Math.round(it.startAt),
          esc(it.name),
          esc(it.absPath),
        ].join(','),
      );
    });
  }
  return rows.join('\r\n');
}

// ── 路由 ────────────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = decodeURIComponent(url.pathname);

  try {
    // 静态资源
    if (!path.startsWith('/api/')) {
      const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
      const file = resolve(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      try {
        let data = await readFile(file);
        // index.html 里的资源引用带上启动版本号。
        // 否则浏览器可能拿缓存里的旧 app.js：界面看着是新版，跑的却是老逻辑，
        // 排查起来极其费劲（"我明明刷新了"就是这么来的）。
        if (file.endsWith('index.html')) {
          data = Buffer.from(
            data.toString('utf8').replace(/(src|href)="(\/[^"?]+\.(?:js|css))"/g, `$1="$2?v=${STARTED_AT}"`),
            'utf8',
          );
        }
        res.writeHead(200, {
          'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
        });
        res.end(data);
      } catch {
        res.writeHead(404).end('not found');
      }
      return;
    }

    // ── API ──────────────────────────────────────────────────────────────────
    if (path === '/api/state' && req.method === 'GET') {
      const cfg = await loadConfig();
      const tracks = library.tracks.filter((t) => t.ok);
      sendJson(res, 200, {
        config: cfg,
        startedAt: STARTED_AT,
        library: {
          count: tracks.length,
          totalSeconds: tracks.reduce((a, t) => a + t.seconds, 0),
          scannedAt: library.scannedAt,
          scanning: library.scanning,
          progress: library.progress,
          stats: library.stats,
        },
        capacity: computeCapacity({ ...cfg.tape }),
      });
      return;
    }

    if (path === '/api/tracks' && req.method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      let list = library.tracks.filter((t) => t.ok);
      if (q) {
        list = list.filter((t) =>
          [t.title, t.artist, t.album, t.name, t.dir].some((v) => v && String(v).toLowerCase().includes(q)),
        );
      }
      // 目录聚合，供左侧按文件夹浏览
      const dirs = [...new Set(list.map((t) => t.dir))].sort();
      sendJson(res, 200, { tracks: list.map(publicTrack), dirs, total: list.length });
      return;
    }

    if (path === '/api/scan' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = await loadConfig();
      if (Array.isArray(body.libraries) && body.libraries.length) cfg.libraries = body.libraries;
      await saveConfig(cfg);
      scanLibraries(cfg.libraries, { force: Boolean(body.force) }); // 故意不 await：进度靠轮询
      sendJson(res, 200, { started: true });
      return;
    }

    if (path === '/api/progress' && req.method === 'GET') {
      sendJson(res, 200, {
        scanning: library.scanning,
        progress: library.progress,
        count: library.tracks.filter((t) => t.ok).length,
        scannedAt: library.scannedAt,
        startedAt: STARTED_AT,
      });
      return;
    }

    if (path === '/api/plan' && req.method === 'POST') {
      const body = await readBody(req);
      // 判定逻辑和「导出」共用同一条路径，避免两处各写一遍规则
      sendJson(res, 200, await buildPlanFor(body));
      return;
    }

    if (path === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = await loadConfig();
      const next = {
        ...cfg,
        ...body,
        tape: { ...cfg.tape, ...(body.tape ?? {}) },
      };
      await saveConfig(next);
      sendJson(res, 200, { config: next, capacity: computeCapacity({ ...next.tape }) });
      return;
    }

    // 关闭接口：给 tools/stop.mjs 用。
    // 要求带口令，避免浏览器里的任意页面（或别的本机程序）随手把服务关掉；
    // 口令每次启动重新生成并写进 .cache/config.json，只有本机能读到。
    if (path === '/api/shutdown' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.token && body.token === SHUTDOWN_TOKEN) {
        sendJson(res, 200, { stopping: true });
        console.log('收到停止请求，正在关闭…');
        setTimeout(() => process.exit(0), 50);
      } else {
        sendJson(res, 403, { error: 'bad token' });
      }
      return;
    }

    // 导出：生成 A/B 面清单。给写磁带标签（J-card）用，
    // 所以文本和 CSV 都写「A 面 / B 面 + 累计时间」，而不是单纯的文件列表。
    if (path === '/api/export' && req.method === 'POST') {
      const body = await readBody(req);
      const format = String(body.format ?? 'txt').toLowerCase();
      const result = await buildPlanFor(body); // 注意 await：漏了会拿到 Promise，!result.ok 直接命中
      if (!result.ok) {
        sendJson(res, 400, result);
        return;
      }

      if (format === 'm3u') {
        // m3u 由前端自己拼（它已经拿到全部曲目信息），这里只回数据
        sendJson(res, 200, result);
        return;
      }

      const stamp = new Date().toISOString().slice(0, 10);
      const minutesLabel = result.capacity.nominalSeconds / 60;
      const filename = `磁带清单-${minutesLabel}分-${stamp}.${format === 'csv' ? 'csv' : 'txt'}`;
      const content = format === 'csv' ? exportCsv(result, library) : exportText(result, library);
      const buf = Buffer.from('\uFEFF' + content, 'utf8'); // BOM 让 Excel 正确识别中文
      res.writeHead(200, {
        'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Content-Length': buf.length,
      });
      res.end(buf);
      return;
    }

    // 封面：/api/cover?id=<trackId>  —— 懒提取 + 落盘缓存
    if (path === '/api/cover' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      const track = library.tracks.find((t) => t.id === id);
      if (!track?.cover?.bytes) {
        res.writeHead(404).end('no cover');
        return;
      }
      let buf = coverInflight.get(id);
      if (!buf) {
        buf = (async () => {
          // 先看磁盘缓存。
          // 文件名带版本前缀：封面偏移的语义（相对窗口 vs 绝对文件偏移）改过一次，
          // 旧缓存里存的是垃圾数据，靠版本号自然失效，不必让用户手动清目录。
          const cacheFile = join(COVER_CACHE, `v${COVER_CACHE_VERSION}-${Buffer.from(id).toString('base64url')}.bin`);
          try {
            const cached = await readFile(cacheFile);
            if (cached.length > 4 && looksLikeImage(cached)) return cached;
          } catch {
            /* 未缓存 */
          }
          const abs = join(track.root, track.rel);
          const data = await extractCover(abs, track.cover);
          if (data) {
            await mkdir(COVER_CACHE, { recursive: true }).catch(() => {});
            await writeFile(cacheFile, data).catch(() => {});
          }
          return data;
        })().finally(() => coverInflight.delete(id));
        coverInflight.set(id, buf);
      }
      const data = await buf;
      if (!data) {
        res.writeHead(404).end('no cover');
        return;
      }
      res.writeHead(200, {
        'Content-Type': track.cover.mime ?? 'image/jpeg',
        'Content-Length': data.length,
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(data);
      return;
    }

    res.writeHead(404).end('not found');
  } catch (e) {
    sendJson(res, 500, { error: String(e?.message ?? e) });
  }
});

const cfg = await loadConfig();
await warmStart(cfg.libraries);

// 端口优先级：命令行 --port > 环境变量 PORT > 上次用过的端口 > 7788
// 记住上次的端口是为了让 tools/stop.mjs 这类工具能找到我们。
const PORT = resolvePort() ?? cfg.port ?? 7788;

/**
 * 本次启动的时间戳。
 *
 * 用途：前端每次刷新都会加载新的 app.js，但服务是个常驻进程 ——
 * 改了 server.mjs / lib/ 之后不重启，它一直跑的是旧逻辑。
 * 这时界面看着是新的、算出来的是旧的，各种「明明该 X 却显示 Y」的怪现象都从这来。
 * 前端拿这个值比对，不一致就明确提示"服务没重启"，省得靠猜。
 */
const STARTED_AT = Date.now();

// 每次启动换一次口令；stop.mjs 从 config.json 里读它
const SHUTDOWN_TOKEN = cfg.token ?? randomBytes(16).toString('hex');

/** 监听失败时给出人话提示，而不是扔一个 EADDRINUSE 栈 */
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用。`);
    console.error(`换一个端口试试：  node server.mjs --port ${PORT + 1}`);
    console.error(`或者先停掉旧服务：node tools/stop.mjs\n`);
    process.exit(1);
  }
  console.error('服务启动失败:', e.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`磁带录制计算器  →  http://${HOST}:${PORT}`);
  console.log(`曲库: ${cfg.libraries.join('  |  ')}`);
  console.log(`缓存: ${LIBRARY_CACHE}`);
  if (library.tracks.length) {
    console.log(`已从缓存载入 ${library.tracks.filter((t) => t.ok).length} 首（后台会做增量扫描）`);
  }

  // 记下实际端口和关闭口令，stop.mjs 靠它们找到并停掉我们
  if (cfg.port !== PORT || cfg.token !== SHUTDOWN_TOKEN) {
    saveConfig({ ...cfg, port: PORT, token: SHUTDOWN_TOKEN }).catch(() => {});
  }

  // 传 --open 才自动开浏览器：启动脚本自己会开，所以它不加这个参数
  if (process.argv.includes('--open')) openBrowser(`http://${HOST}:${PORT}`);
});

/** 用系统默认浏览器打开地址（失败就算了，不是关键路径） */
async function openBrowser(url) {
  try {
    const { spawn } = await import('node:child_process');
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* 打不开就让用户手动点 */
  }
}

// 启动后自动做一次增量扫描（有缓存时很快）
scanLibraries(cfg.libraries, { force: false });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
