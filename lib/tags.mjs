// 音频标签读取 —— FLAC Vorbis Comment / ID3v2 (MP3、DSF、AIFF)
//
// 只读我们 UI 需要的少数几个字段，不做完整标签库。
// 所有函数都容错：读不出来就返回空对象，绝不因为标签损坏而让扫描失败。

import { open } from 'node:fs/promises';
import { probeCoverInfo, coverInfoToAbsolute } from './covers.mjs';

const EMPTY = { title: null, artist: null, album: null, track: null };

/** ID3v2 文本帧解析（兼容 v2.2/2.3/2.4，UTF-8/UTF-16/Latin1） */
function parseId3v2(buf) {
  const out = { ...EMPTY };
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return out;
  const major = buf[3];
  // synchsafe 长度：每字节 7 位有效
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  const tagEnd = 10 + size;
  if (tagEnd > buf.length) return out; // 标签超出已读窗口，宁可返回空也不猜
  const end = Math.min(tagEnd, buf.length);
  let off = 10;

  // v2.2 用 3 字节帧 ID，v2.3+ 用 4 字节
  const idLen = major === 2 ? 3 : 4;
  const idMap = {
    TIT2: 'title', TT2: 'title',
    TPE1: 'artist', TP1: 'artist',
    TALB: 'album', TAL: 'album',
    TRCK: 'track', TRK: 'track',
  };

  while (off + idLen + (major === 2 ? 3 : 6) <= end) {
    const id = buf.toString('latin1', off, off + idLen);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break; // 遇到填充或垃圾就停
    let frameSize;
    let headerLen;
    if (major === 2) {
      frameSize = (buf[off + 3] << 16) | (buf[off + 4] << 8) | buf[off + 5];
      headerLen = 6;
    } else if (major === 4) {
      frameSize =
        ((buf[off + 4] & 0x7f) << 21) | ((buf[off + 5] & 0x7f) << 14) | ((buf[off + 6] & 0x7f) << 7) | (buf[off + 7] & 0x7f);
      headerLen = 10;
    } else {
      frameSize = buf.readUInt32BE(off + 4);
      headerLen = 10;
    }
    if (frameSize <= 0 || off + headerLen + frameSize > end) break;

    const key = idMap[id];
    if (key) {
      const p = off + headerLen;
      const enc = buf[p];
      const raw = buf.subarray(p + 1, p + frameSize);
      out[key] = decodeText(raw, enc);
    }
    off += headerLen + frameSize;
  }

  // 去掉 Windows 资源管理器写进去的 \0 结尾
  for (const k of Object.keys(out)) {
    if (typeof out[k] === 'string') out[k] = out[k].replace(/\0+$/, '').trim() || null;
  }
  return out;
}

function decodeText(raw, encoding) {
  try {
    switch (encoding) {
      case 0: // ISO-8859-1
        return raw.toString('latin1');
      case 1: // UTF-16 with BOM
        return raw.toString('utf16le').replace(/^\ufeff/, '');
      case 2: // UTF-16BE without BOM
        return swap16(raw).toString('utf16le');
      case 3: // UTF-8
        return raw.toString('utf8');
      default:
        return raw.toString('utf8');
    }
  } catch {
    return null;
  }
}

function swap16(buf) {
  const c = Buffer.from(buf);
  for (let i = 0; i + 1 < c.length; i += 2) {
    const t = c[i];
    c[i] = c[i + 1];
    c[i + 1] = t;
  }
  return c;
}

/** FLAC: 遍历元数据块找 VORBIS_COMMENT(4) */
function parseFlacTags(buf) {
  const out = { ...EMPTY, artist: null };
  if (buf.toString('latin1', 0, 4) !== 'fLaC') return out;
  let off = 4;
  const artists = [];
  while (off + 4 <= buf.length) {
    const header = buf.readUInt8(off);
    const type = header & 0x7f;
    const last = (header & 0x80) !== 0;
    const len = buf.readUIntBE(off + 1, 3);
    if (type === 4) {
      const p = off + 4;
      const end = Math.min(p + len, buf.length);
      let q = p;
      const vendorLen = buf.readUInt32LE(q);
      q += 4 + vendorLen;
      if (q + 4 > end) break;
      const count = buf.readUInt32LE(q);
      q += 4;
      for (let i = 0; i < count && q + 4 <= end; i++) {
        const klen = buf.readUInt32LE(q);
        q += 4;
        if (q + klen > end) break;
        const kv = buf.toString('utf8', q, q + klen);
        q += klen;
        const eq = kv.indexOf('=');
        if (eq === -1) continue;
        const k = kv.slice(0, eq).toUpperCase();
        const v = kv.slice(eq + 1).trim();
        if (!v) continue;
        if (k === 'TITLE' && !out.title) out.title = v;
        else if (k === 'ARTIST' || k === 'ALBUMARTIST') artists.push(v);
        else if (k === 'ALBUM' && !out.album) out.album = v;
        else if (k === 'TRACKNUMBER' && !out.track) out.track = v;
      }
    }
    if (last) break;
    off += 4 + len;
  }
  if (artists.length) out.artist = artists.join(' / ');
  return out;
}

/** M4A/MP4: 从 ilst 里取 ©nam / ©ART / ©alb / trkn */
function parseMp4Tags(buf) {
  const out = { ...EMPTY };
  const wanted = { '\xa9nam': 'title', '\xa9ART': 'artist', '\xa9alb': 'album', trkn: 'track' };
  for (const key of Object.keys(wanted)) {
    const idx = buf.indexOf(key, 0, 'latin1');
    if (idx === -1) continue;
    // 结构: [size u32][key][size u32]['data'][type u32][locale u32][payload]
    const dataIdx = buf.indexOf('data', idx + 4, 'latin1');
    if (dataIdx === -1 || dataIdx > idx + 64) continue;
    const payloadStart = dataIdx + 12;
    if (payloadStart >= buf.length) continue;
    const size = buf.readUInt32BE(idx);
    const payloadEnd = Math.min(idx + size, buf.length);
    if (key === 'trkn') {
      if (payloadStart + 4 <= payloadEnd) out.track = String(buf.readUInt16BE(payloadStart + 2));
    } else {
      const v = buf.toString('utf8', payloadStart, payloadEnd).replace(/\0+$/, '').trim();
      if (v) out[wanted[key]] = v;
    }
  }
  return out;
}

/**
 * 读取音频文件的标签与内嵌封面元信息（一次 IO 同时拿到两样，避免扫描时每文件读两遍）
 * @param {string} path
 * @param {string} ext 小写扩展名（不含点）
 * @returns {Promise<{tags: {title, artist, album, track}, cover: {mime, bytes, dataOffset, container}|null}>}
 */
export async function readTagsAndCover(path, ext) {
  let fh;
  try {
    fh = await open(path, 'r');
    const { size: fileSize } = await fh.stat();
    // 实测本机 MP3 的 ID3v2 可达 130KB+，窗口按文件大小自适应（并发下不至于一次性吃满内存）
    const window = Math.max(256 * 1024, Math.min(fileSize, 8 * 1024 * 1024));
    const buf = Buffer.alloc(window);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead);

    let tags = { ...EMPTY };
    switch (ext) {
      case 'flac':
        tags = parseFlacTags(head);
        break;
      case 'mp3':
        tags = parseId3v2(head);
        break;
      case 'dsf':
      case 'dff':
      case 'aiff':
      case 'aif':
      case 'aifc': {
        // 这些容器的 ID3 可能在文件头，也可能挂在 metadata 指针处（DSF 常见在文件尾）
        const headTags = parseId3v2(head);
        if (headTags.title || headTags.artist || headTags.album) tags = headTags;
        else tags = (await readTrailingId3(fh, fileSize)) ?? headTags;
        break;
      }
      case 'm4a':
      case 'mp4':
        tags = parseMp4Tags(head);
        break;
      default:
        break;
    }

    // 封面探测复用同一份已读入的缓冲。
    // 头部窗口的基址是 0，所以相对偏移直接就是绝对偏移；
    // 尾部 ID3 必须换算，否则提取时会去文件的错误位置读（曾经读到一堆垃圾字节）。
    let cover = probeCoverInfo(head, ext);
    if (!cover && ['dsf', 'dff', 'aiff', 'aif', 'aifc'].includes(ext)) {
      const tail = await readTailWindow(fh, fileSize, window);
      if (tail) {
        cover = coverInfoToAbsolute(probeCoverInfo(tail, ext), fileSize - tail.length);
      }
    }

    return { tags, cover };
  } catch {
    return { tags: { ...EMPTY }, cover: null };
  } finally {
    if (fh) await fh.close();
  }
}

/** 读取文件尾部窗口（用于尾部 ID3/封面） */
async function readTailWindow(fh, fileSize, maxLen) {
  const len = Math.min(fileSize, maxLen);
  if (len <= 0) return null;
  const buf = Buffer.alloc(len);
  await fh.read(buf, 0, len, fileSize - len);
  return buf;
}

/** 尝试读取文件尾部的 ID3v2（DSF 的元数据块常放在末尾） */
async function readTrailingId3(fh, fileSize) {
  const tailLen = Math.min(fileSize, 2 * 1024 * 1024);
  const buf = Buffer.alloc(tailLen);
  await fh.read(buf, 0, tailLen, fileSize - tailLen);
  // 尾部 ID3 之前通常还有一个 8 字节的指针，所以从后往前找 'ID3' 标记
  for (let i = buf.length - 10; i >= 0; i--) {
    if (buf[i] === 0x49 && buf[i + 1] === 0x44 && buf[i + 2] === 0x33) {
      const major = buf[i + 3];
      if (major > 4) continue;
      const size =
        ((buf[i + 6] & 0x7f) << 21) | ((buf[i + 7] & 0x7f) << 14) | ((buf[i + 8] & 0x7f) << 7) | (buf[i + 9] & 0x7f);
      if (i + 10 + size > buf.length) continue;
      const tags = parseId3v2(buf.subarray(i));
      if (tags.title || tags.artist || tags.album) return tags;
    }
  }
  return null;
}
