// 音乐库扫描与缓存
//
// 缓存策略：以 (相对路径 + mtimeMs + size) 作为失效判据。
// 只有新增或改动过的文件才会重新解析时长和标签，其余直接命中缓存 —— 这是切磁带参数时"零重扫"的基础。
//
// 缓存结构（JSON）:
// {
//   version: 1,
//   roots: { "<rootPath>": { scannedAt, entries: { "<relPath>": Entry } } }
// }
// Entry: { mtimeMs, size, seconds, ok, reason, codec, sampleRate, channels, bitsPerSample, lossless, estimated,
//          title, artist, album, track }

import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, relative, extname, dirname } from 'node:path';
import { readDuration } from './duration.mjs';
import { readTagsAndCover } from './tags.mjs';

const CACHE_VERSION = 1;
const SKIP_DIRS = new Set([
  '$RECYCLE.BIN',
  'System Volume Information',
  '.git',
  'node_modules',
  '.cache',
  '__pycache__',
]);

/** 支持的音频扩展名（与 duration.mjs 保持一致） */
export const AUDIO_EXT = new Set(['flac', 'dsf', 'dff', 'wav', 'wave', 'aif', 'aiff', 'aifc', 'mp3', 'm4a', 'mp4', 'aac', 'ogg', 'opus']);

/**
 * 递归列出目录下的音频文件（返回绝对路径）
 * @param {string} root
 * @param {{ onProgress?: (found: number) => void }} [opts]
 */
export async function listAudioFiles(root, opts = {}) {
  const out = [];
  const stack = [root];
  const started = Date.now();
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(p);
      } else if (e.isFile()) {
        const ext = extname(e.name).slice(1).toLowerCase();
        if (AUDIO_EXT.has(ext)) {
          out.push(p);
          if (out.length % 200 === 0) opts.onProgress?.(out.length);
        }
      }
    }
    // 防止病态深层目录把栈撑爆
    if (Date.now() - started > 120_000) break;
  }
  return out;
}

export async function loadCache(cachePath) {
  try {
    const raw = await readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.version !== CACHE_VERSION) return emptyCache();
    return parsed;
  } catch {
    return emptyCache();
  }
}

function emptyCache() {
  return { version: CACHE_VERSION, roots: {} };
}

export async function saveCache(cachePath, cache) {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(cache), 'utf8');
}

/**
 * 扫描一个根目录，返回曲目列表（带缓存与增量）
 * @param {string} root 绝对路径
 * @param {object} cache 由 loadCache 得到的缓存对象（会被就地更新）
 * @param {{ force?: boolean, onProgress?: (info: {phase: string, done: number, total: number, name?: string}) => void, concurrency?: number }} [opts]
 * @returns {Promise<{tracks: object[], stats: {total: number, cached: number, parsed: number, failed: number, ms: number}}>}
 */
export async function scanRoot(root, cache, opts = {}) {
  const { force = false, onProgress, concurrency = 8 } = opts;
  const t0 = Date.now();

  const files = await listAudioFiles(root, { onProgress: (n) => onProgress?.({ phase: 'walk', done: n, total: 0 }) });
  const rootKey = root;
  if (!cache.roots[rootKey]) cache.roots[rootKey] = { scannedAt: 0, entries: {} };
  const entries = cache.roots[rootKey].entries;

  // 先把文件系统状态看一遍，决定哪些需要重新解析
  const stale = [];
  const fresh = new Map(); // relPath -> entry
  for (const abs of files) {
    let st;
    try {
      st = await stat(abs);
    } catch {
      continue;
    }
    const rel = relative(root, abs);
    const hit = entries[rel];
    if (!force && hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      fresh.set(rel, hit);
    } else {
      stale.push({ abs, rel, st });
    }
  }

  let failed = 0;
  let done = 0;
  const total = stale.length;

  // 并发解析（文件头读取是 IO 密集，几个并发足够）
  const queue = [...stale];
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, async () => {
    while (queue.length) {
      const job = queue.shift();
      if (!job) break;
      const { abs, rel, st } = job;
      const ext = extname(abs).slice(1).toLowerCase();
      const [dur, meta] = await Promise.all([readDuration(abs), readTagsAndCover(abs, ext)]);
      const { tags, cover } = meta;
      if (!dur.ok) failed++;
      const entry = {
        mtimeMs: st.mtimeMs,
        size: st.size,
        seconds: dur.ok ? dur.seconds : null,
        ok: dur.ok,
        reason: dur.reason ?? null,
        codec: dur.codec ?? null,
        sampleRate: dur.sampleRate ?? null,
        channels: dur.channels ?? null,
        bitsPerSample: dur.bitsPerSample ?? null,
        lossless: dur.lossless ?? null,
        estimated: dur.estimated ?? false,
        title: tags.title ?? null,
        artist: tags.artist ?? null,
        album: tags.album ?? null,
        track: tags.track ?? null,
        cover: cover ?? null, // { mime, bytes, dataOffset } —— 只记位置，图片字节按需提取
      };
      entries[rel] = entry;
      fresh.set(rel, entry);
      done++;
      onProgress?.({ phase: 'parse', done, total, name: rel });
    }
  });
  await Promise.all(workers);

  // 清掉已经不存在的文件
  const present = new Set(fresh.keys());
  for (const rel of Object.keys(entries)) {
    if (!present.has(rel)) delete entries[rel];
  }
  cache.roots[rootKey].scannedAt = Date.now();

  const tracks = [...fresh.entries()].map(([rel, e]) => ({
    id: `${rootKey}|${rel}`,
    root: rootKey,
    rel,
    name: rel.split(/[\\/]/).pop(),
    dir: rel.includes('\\') ? rel.slice(0, rel.lastIndexOf('\\')) : '',
    ...e,
  }));

  return {
    tracks,
    stats: {
      total: files.length,
      cached: files.length - stale.length,
      parsed: stale.length,
      failed,
      ms: Date.now() - t0,
    },
  };
}

/**
 * 扫描多个根目录并合并
 * @param {string[]} roots
 * @param {string} cachePath
 */
export async function scanAll(roots, cachePath, opts = {}) {
  const cache = await loadCache(cachePath);
  const all = [];
  const perRoot = {};
  for (const root of roots) {
    const { tracks, stats } = await scanRoot(root, cache, opts);
    all.push(...tracks);
    perRoot[root] = stats;
  }
  await saveCache(cachePath, cache);
  return { tracks: all, perRoot };
}
