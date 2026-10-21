// 内嵌封面提取 —— FLAC PICTURE 块 / ID3v2 APIC 帧 / MP4 covr atom
//
// 策略：扫描阶段只探测"有没有封面、多大、什么类型"（便宜），真正的图片字节在 UI 请求时才提取并落盘缓存。
// 理由：541 首曲子如果每首都把封面塞进 JSON，缓存会膨胀到几十 MB，而且 90% 的封面用户根本不会看。

import { open } from 'node:fs/promises';

const MAX_COVER_BYTES = 8 * 1024 * 1024; // 超过这个大小的封面直接忽略（有些扫图能到 20MB）

/**
 * 探测封面元信息（不返回图片数据）
 *
 * `dataOffset` 的语义：**基于传入 buffer 起点的相对偏移**。
 * 调用方若传的是文件头窗口且窗口基址为 0，它就等于文件的绝对偏移；
 * 若传的是尾部窗口，必须加上该窗口的文件内基址才能得到绝对偏移。
 * 这个约定写在这里是因为踩过坑：尾部 ID3 的封面曾被当成绝对偏移去读，取回一堆垃圾字节。
 *
 * @param {Buffer} buf
 * @param {string} ext 小写扩展名
 * @param {{ baseOffset?: number }} [opts] baseOffset 只在内部转换时使用，函数本身不消费
 */
export function probeCoverInfo(buf, ext) {
  try {
    switch (ext) {
      case 'flac':
        return probeFlac(buf);
      case 'mp3':
        return probeId3(buf, 0);
      case 'dsf':
      case 'dff':
      case 'aiff':
      case 'aif':
      case 'aifc': {
        const fromHead = probeId3(buf, 0);
        if (fromHead) return fromHead;
        return probeId3At(buf); // 尾部 ID3
      }
      case 'm4a':
      case 'mp4':
        return probeMp4(buf);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * 把「相对于尾部窗口」的封面信息换算成「相对于文件」的绝对偏移。
 * @param {{dataOffset: number, bytes: number, mime: string, container: string}|null} info
 * @param {number} windowBase 该尾部窗口在文件中的起始偏移
 */
export function coverInfoToAbsolute(info, windowBase) {
  if (!info) return null;
  return { ...info, dataOffset: windowBase + info.dataOffset };
}

function probeFlac(buf) {
  if (buf.toString('latin1', 0, 4) !== 'fLaC') return null;
  let off = 4;
  while (off + 4 <= buf.length) {
    const header = buf.readUInt8(off);
    const type = header & 0x7f;
    const last = (header & 0x80) !== 0;
    const len = buf.readUIntBE(off + 1, 3);
    if (type === 6) {
      // PICTURE: type u32be | mimeLen u32be | mime | descLen u32be | desc | w h depth colors | dataLen u32be | data
      const p = off + 4;
      if (p + 8 > buf.length) return null;
      const mimeLen = buf.readUInt32BE(p + 4);
      const mime = buf.toString('latin1', p + 8, p + 8 + mimeLen);
      let q = p + 8 + mimeLen;
      const descLen = buf.readUInt32BE(q);
      q += 4 + descLen;
      q += 16; // width/height/depth/colors
      const dataLen = buf.readUInt32BE(q);
      const dataOffset = q + 4;
      if (dataLen <= 0 || dataLen > MAX_COVER_BYTES) return null;
      return { mime: normalizeMime(mime), bytes: dataLen, dataOffset, container: 'flac' };
    }
    if (last) break;
    off += 4 + len;
  }
  return null;
}

function probeId3(buf, at) {
  if (at + 10 > buf.length) return null;
  if (buf.toString('latin1', at, at + 3) !== 'ID3') return null;
  const major = buf[at + 3];
  const size =
    ((buf[at + 6] & 0x7f) << 21) | ((buf[at + 7] & 0x7f) << 14) | ((buf[at + 8] & 0x7f) << 7) | (buf[at + 9] & 0x7f);
  const end = Math.min(at + 10 + size, buf.length);
  let off = at + 10;
  const idLen = major === 2 ? 3 : 4;
  while (off + idLen + (major === 2 ? 3 : 6) <= end) {
    const id = buf.toString('latin1', off, off + idLen);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
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

    if (id === 'APIC' || id === 'PIC') {
      // APIC: encoding(1) | mime\0 | pictureType(1) | description\0 | data
      const p = off + headerLen;
      const enc = buf[p];
      let q = p + 1;
      let mime;
      if (id === 'PIC') {
        mime = buf.toString('latin1', q, q + 3); // 3 字符格式码
        q += 3;
      } else {
        const mimeEnd = buf.indexOf(0, q);
        if (mimeEnd === -1) return null;
        mime = buf.toString('latin1', q, mimeEnd);
        q = mimeEnd + 1;
      }
      q += 1; // picture type
      // 跳过描述（编码决定终止符宽度）
      if (enc === 1 || enc === 2) {
        while (q + 1 < buf.length && !(buf[q] === 0 && buf[q + 1] === 0)) q += 2;
        q += 2;
      } else {
        const descEnd = buf.indexOf(0, q);
        if (descEnd === -1) return null;
        q = descEnd + 1;
      }
      const dataLen = off + headerLen + frameSize - q;
      if (dataLen <= 0 || dataLen > MAX_COVER_BYTES) return null;
      return { mime: normalizeMime(mime), bytes: dataLen, dataOffset: q, container: 'id3' };
    }
    off += headerLen + frameSize;
  }
  return null;
}

/** 尾部 ID3（DSF/DFF 常见）：从后往前找真正的 'ID3' 标记 */
function probeId3At(buf) {
  for (let i = buf.length - 10; i >= 0; i--) {
    if (buf[i] !== 0x49 || buf[i + 1] !== 0x44 || buf[i + 2] !== 0x33) continue;
    // 只认版本号合法的标记：帧数据里也可能偶然出现 'ID3' 三个字节
    const major = buf[i + 3];
    if (major < 2 || major > 4 || buf[i + 4] === 0xff) continue;
    const r = probeId3(buf, i);
    if (r) return r;
  }
  return null;
}

function probeMp4(buf) {
  const covr = buf.indexOf('covr', 0, 'latin1');
  if (covr === -1) return null;
  const data = buf.indexOf('data', covr + 4, 'latin1');
  if (data === -1 || data > covr + 64) return null;
  // data atom: [size u32]['data'][type u32][locale u32][payload]
  const payloadStart = data + 12;
  const atomSize = buf.readUInt32BE(data - 4);
  const dataLen = atomSize - 8 - 8;
  if (dataLen <= 0 || dataLen > MAX_COVER_BYTES) return null;
  const typeCode = buf.readUInt32BE(data + 4);
  const mime = typeCode === 0x0d || typeCode === 0x0e ? 'image/jpeg' : typeCode === 0x0c ? 'image/gif' : 'image/png';
  return { mime, bytes: dataLen, dataOffset: payloadStart, container: 'mp4' };
}

function normalizeMime(m) {
  const s = (m ?? '').toLowerCase();
  if (s.includes('png')) return 'image/png';
  if (s.includes('gif')) return 'image/gif';
  if (s.includes('webp')) return 'image/webp';
  if (s.includes('bmp')) return 'image/bmp';
  return 'image/jpeg';
}

/**
 * 提取封面字节
 * @param {string} path
 * @param {{dataOffset: number, bytes: number}} info
 * @returns {Promise<Buffer|null>}
 */
export async function extractCover(path, info) {
  if (!info?.bytes) return null;
  let fh;
  try {
    fh = await open(path, 'r');
    const buf = Buffer.alloc(info.bytes);
    await fh.read(buf, 0, info.bytes, info.dataOffset);
    return buf;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close();
  }
}
