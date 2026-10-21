// 音频时长读取器 —— 纯文件头解析，不依赖外部进程
//
// 设计取舍：为什么不用 ffprobe？
//   1. 扫描几千个文件时，每个都 spawn 一个进程太慢（实测慢一个数量级）
//   2. 宿主环境不一定有 ffprobe（这台机器上 MarukoToolbox 只带了 ffmpeg.exe）
//   3. 无损格式的时长本来就可以从头部精确算出来，不需要解码
// 所以：优先纯解析；解析不了的格式（ogg 等）返回 ok:false，由上层决定是否走 ffprobe 兜底。
//
// 精度约定：返回的 seconds 是"音频流实际时长"，误差应当为 0（无损格式）或 <= 1 帧（有损格式）。

import { open } from 'node:fs/promises';

const HEAD_BYTES = 64 * 1024; // 常规头部读取窗口
const MP3_HEAD_BYTES = 8 * 1024 * 1024; // MP3 的 ID3v2 可能很大（实测有 130KB+ 的），窗口要够
const TAIL_BYTES = 256 * 1024; // 尾部读取窗口（ogg 需要）

/** 打开文件并读取头部若干字节 */
async function readHead(path, size = HEAD_BYTES) {
  const fh = await open(path, 'r');
  try {
    const { size: fileSize } = await fh.stat();
    const len = Math.min(size, fileSize);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return { buf, fileSize, fh };
  } catch (e) {
    await fh.close();
    throw e;
  }
}

/** 读取文件尾部若干字节 */
async function readTail(fh, fileSize, size = TAIL_BYTES) {
  const len = Math.min(size, fileSize);
  const buf = Buffer.alloc(len);
  await fh.read(buf, 0, len, fileSize - len);
  return { buf, offset: fileSize - len };
}

const fail = (reason) => ({ ok: false, seconds: null, reason });

// ── 各容器解析 ──────────────────────────────────────────────────────────────

/** FLAC: STREAMINFO 给出精确采样数与采样率 */
function parseFlac(buf) {
  if (buf.length < 42 || buf.toString('latin1', 0, 4) !== 'fLaC') return fail('not-flac');
  let off = 4;
  while (off + 4 <= buf.length) {
    const header = buf.readUInt8(off);
    const type = header & 0x7f;
    const last = (header & 0x80) !== 0;
    const len = buf.readUIntBE(off + 1, 3);
    if (type === 0) {
      // STREAMINFO: 20bit 采样率 + 3bit 声道 + 5bit 位深 + 36bit 总采样数
      const p = off + 4;
      if (p + 18 > buf.length) return fail('flac-truncated');
      const sampleRate = (buf[p + 10] << 12) | (buf[p + 11] << 4) | (buf[p + 12] >> 4);
      const channels = ((buf[p + 12] >> 1) & 0x07) + 1;
      const bitsPerSample = (((buf[p + 12] & 0x01) << 4) | (buf[p + 13] >> 4)) + 1;
      const totalSamples =
        (buf[p + 13] & 0x0f) * 2 ** 32 +
        buf.readUInt32BE(p + 14);
      if (!sampleRate) return fail('flac-no-samplerate');
      if (!totalSamples) return fail('flac-unknown-length'); // 流式编码的 flac 没写总长
      return {
        ok: true,
        seconds: totalSamples / sampleRate,
        codec: 'FLAC',
        sampleRate,
        channels,
        bitsPerSample,
        lossless: true,
      };
    }
    if (last) break;
    off += 4 + len;
  }
  return fail('flac-no-streaminfo');
}

/** DSF (DSD 存储格式, 小端): 'DSD ' 头 + 'fmt ' 块 + 'data' 块
 *
 * 实测字节布局（本机 2.8MHz DSD 文件）:
 *   0  'DSD ' | 4  chunk size u64le | 12 file size u64le | 20 metadata ptr u64le
 *   28 'fmt ' | 32 chunk size u64le(=52) | 40 version u32le(=1) | 44 format id u32le(=0 表示 DSD raw)
 *   48 channel type u32le | 52 channel num u32le | 56 sampling freq u32le(=2822400)
 *   60 bits per sample u32le | 64 sample count u64le | 72 block size u32le | 76 reserved u32le
 *   80 'data' | 84 chunk size u64le | 92 音频数据
 * 注意 fmt 数据区从 40 开始（chunk header 12 字节 + version 4 字节），不是 28+12。
 */
function parseDsf(buf) {
  if (buf.length < 92 || buf.toString('latin1', 0, 4) !== 'DSD ') return fail('not-dsf');
  const FMT = 28;
  if (buf.toString('latin1', FMT, FMT + 4) !== 'fmt ') return fail('dsf-no-fmt');
  const d = FMT + 12; // fmt 数据区起点
  const channels = buf.readUInt32LE(d + 12);
  const sampleRate = buf.readUInt32LE(d + 16); // DSD 位率，例如 2822400
  const bitsPerSample = buf.readUInt32LE(d + 20);
  const sampleCount = Number(buf.readBigUInt64LE(d + 24));
  if (!sampleRate) return fail('dsf-no-samplerate');
  if (!sampleCount) return fail('dsf-no-samplecount');
  return {
    ok: true,
    seconds: sampleCount / sampleRate,
    codec: 'DSD',
    sampleRate,
    channels,
    bitsPerSample,
    lossless: true,
  };
}

/** DFF (DSDIFF, 大端): FRM8 + FVER + PROP(SND: FS/CHNL/CMPR) + DSD 数据块
 *
 * 实测字节布局（本机 .dff 文件，已逐字节核对）:
 *   0  'FRM8' | 4 size u64be | 12 'DSD '            ← FRM8 的 size 与文件大小一致
 *   16 'FVER' | 20 size u64be(=4)  | 28 version
 *   32 'PROP' | 36 size u64be(=94) | 44 'SND '
 *   48 'FS  ' | 52 size u64be(=4)  | 60 sample rate u32be
 *   64 'CHNL' | 68 size u64be(=10) | 76 channels u16be + 声道 ID 字符串
 *   88 'CMPR' | 92 size u64be(=20) | 100 压缩类型字符串（'DSD ' / "not compressed"）
 *   144+ 'DSD ' | size u64be | 音频数据
 *
 * 两个坑：① 每个块头的 size 是 8 字节大端，不是 4 字节；② CMPR 载荷是文本而非位深数字，
 * DSD raw 恒为 1 bit/样本，照文本首字节当位深会算出 110bit 的荒谬结果。
 */
function parseDff(buf) {
  if (buf.length < 16 || buf.toString('latin1', 0, 4) !== 'FRM8') return fail('not-dff');
  if (buf.toString('latin1', 12, 16) !== 'DSD ') return fail('dff-not-dsd');

  const readSize = (o) => Number(buf.readBigUInt64BE(o));

  let sampleRate = 0;
  let channels = 0;
  let dataSize = 0;

  for (let off = 16; off + 12 <= buf.length; ) {
    const id = buf.toString('latin1', off, off + 4);
    if (!/^[\x20-\x7e]{4}$/.test(id)) break;
    const size = readSize(off + 4);
    const payload = off + 12;

    if (id === 'PROP') {
      const end = Math.min(payload + size, buf.length);
      for (let s = payload + 4; s + 12 <= end; ) {
        const sid = buf.toString('latin1', s, s + 4);
        const ssize = readSize(s + 4);
        const sp = s + 12;
        if (sid === 'FS  ') sampleRate = buf.readUInt32BE(sp);
        else if (sid === 'CHNL') channels = buf.readUInt16BE(sp);
        else if (sid === 'CMPR') {
          // 载荷为文本；'DSD ' 或 "not compressed" 都表示未压缩
          const kind = buf.toString('latin1', sp, Math.min(sp + 4, buf.length));
          if (kind !== 'DSD ') return fail('dff-compressed');
        }
        if (!Number.isFinite(ssize) || ssize < 0) break;
        s = sp + ssize + (ssize % 2); // DFF 子块按偶数边界对齐
      }
    } else if (id === 'DSD ') {
      dataSize = size;
      break;
    }

    if (!Number.isFinite(size) || size <= 0) break;
    off = payload + size + (size % 2);
  }

  if (!sampleRate || !channels) return fail('dff-missing-props');
  if (!dataSize) return fail('dff-no-data');
  // DSD raw: 1 bit/样本 => 8 样本打包进 1 字节
  return {
    ok: true,
    seconds: dataSize / (channels * sampleRate / 8),
    codec: 'DSD',
    sampleRate,
    channels,
    bitsPerSample: 1,
    lossless: true,
  };
}

/** WAV / WAVE: RIFF + fmt + data */
function parseWav(buf) {
  if (buf.length < 12) return fail('not-wav');
  if (buf.toString('latin1', 0, 4) !== 'RIFF') return fail('not-wav');
  if (buf.toString('latin1', 8, 12) !== 'WAVE') return fail('not-wav');
  let off = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let byteRate = 0;
  let dataSize = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      const p = off + 8;
      channels = buf.readUInt16LE(p + 2);
      sampleRate = buf.readUInt32LE(p + 4);
      byteRate = buf.readUInt32LE(p + 8);
      bitsPerSample = buf.readUInt16LE(p + 14);
    } else if (id === 'data') {
      dataSize = size;
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (!sampleRate || !dataSize) return fail('wav-incomplete');
  const rate = byteRate || (sampleRate * channels * bitsPerSample) / 8;
  if (!rate) return fail('wav-no-byterate');
  return {
    ok: true,
    seconds: dataSize / rate,
    codec: 'PCM',
    sampleRate,
    channels,
    bitsPerSample,
    lossless: true,
  };
}

/** AIFF / AIFC: FORM + COMM (80bit 扩展浮点采样率) */
function readFloat80(buf, off) {
  const exp = buf.readUInt16BE(off);
  const hi = buf.readUInt32BE(off + 2);
  const lo = buf.readUInt32BE(off + 6);
  if (exp === 0 && hi === 0 && lo === 0) return 0;
  const sign = exp & 0x8000 ? -1 : 1;
  const e = (exp & 0x7fff) - 16383;
  const mantissa = hi * 2 ** 32 + lo;
  return sign * mantissa * 2 ** (e - 63);
}

function parseAiff(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'FORM') return fail('not-aiff');
  let off = 12;
  let channels = 0;
  let frames = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32BE(off + 4);
    if (id === 'COMM') {
      const p = off + 8;
      channels = buf.readUInt16BE(p);
      frames = buf.readUInt32BE(p + 2);
      bitsPerSample = buf.readUInt16BE(p + 6);
      sampleRate = readFloat80(buf, p + 8);
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (!sampleRate || !frames) return fail('aiff-incomplete');
  return {
    ok: true,
    seconds: frames / sampleRate,
    codec: 'PCM',
    sampleRate: Math.round(sampleRate),
    channels,
    bitsPerSample,
    lossless: true,
  };
}

// MPEG 音频帧头解析（Layer I/II/III）
const MPEG_BITRATES = {
  // [version][layer] -> 位率表 (kbps)
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MPEG_SAMPLERATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };

function findFrameSync(buf, from) {
  for (let i = from; i + 4 <= buf.length; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      const h = decodeFrameHeader(buf, i);
      if (h) return h;
    }
  }
  return null;
}

function decodeFrameHeader(buf, i) {
  const b1 = buf[i + 1];
  const b2 = buf[i + 2];
  const versionBits = (b1 >> 3) & 0x03; // 0=2.5, 1=reserved, 2=2, 3=1
  if (versionBits === 1) return null;
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const layerBits = (b1 >> 1) & 0x03; // 0=reserved
  if (layerBits === 0) return null;
  const layer = 4 - layerBits; // 3=>1, 2=>2, 1=>3
  const bitrateIdx = (b2 >> 4) & 0x0f;
  if (bitrateIdx === 0 || bitrateIdx === 15) return null;
  const srIdx = (b2 >> 2) & 0x03;
  if (srIdx === 3) return null;
  const padding = (b2 >> 1) & 0x01;
  const vKey = version === 1 ? '1' : '2';
  if (layer === 2 && version === 2) return null; // 无此组合表项处理
  const table = MPEG_BITRATES[`${vKey}-${layer}`];
  const bitrate = table ? table[bitrateIdx] : null;
  if (!bitrate) return null;
  const sampleRate = MPEG_SAMPLERATES[version][srIdx];
  const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576;
  let frameLen = 0;
  if (layer === 1) frameLen = Math.floor((12 * bitrate * 1000) / sampleRate + padding) * 4;
  else frameLen = Math.floor((samplesPerFrame / 8) * bitrate * 1000 / sampleRate) + padding;
  return { version, layer, bitrate, sampleRate, padding, samplesPerFrame, frameLen, offset: i };
}

function parseMp3(buf, fileSize) {
  // 跳过 ID3v2
  let start = 0;
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    start = 10 + size;
  }
  const first = findFrameSync(buf, start);
  if (!first) return fail('mp3-no-frame');

  // Xing/Info 头提供精确帧数（VBR 文件必需）
  for (const tag of ['Xing', 'Info']) {
    // 注意 indexOf 的签名是 (value, byteOffset, encoding) —— 把编码放在第三位
    const idx = buf.indexOf(tag, first.offset + 4, 'latin1');
    if (idx !== -1 && idx < first.offset + 200) {
      const flags = buf.readUInt32BE(idx + 4);
      let p = idx + 8;
      if (flags & 0x01) {
        const frames = buf.readUInt32BE(p);
        p += 4;
        if (flags & 0x02) p += 4;
        return {
          ok: true,
          seconds: (frames * first.samplesPerFrame) / first.sampleRate,
          codec: 'MP3',
          sampleRate: first.sampleRate,
          channels: 2,
          bitrate: first.bitrate,
          vbr: buf[idx] === 0x58, // 'X'
          lossless: false,
        };
      }
    }
  }

  // 无 Xing：按 CBR 估算，用文件总长减去头部和 ID3v1 尾标
  const audioBytes = fileSize - start - 128;
  const bitrate = first.bitrate * 1000;
  if (bitrate > 0 && audioBytes > 0) {
    return {
      ok: true,
      seconds: (audioBytes * 8) / bitrate,
      codec: 'MP3',
      sampleRate: first.sampleRate,
      channels: 2,
      bitrate: first.bitrate,
      vbr: false,
      estimated: true,
      lossless: false,
    };
  }
  return fail('mp3-incomplete');
}

/** MP4/M4A: moov.mvhd 时长（timescale 归一化） */
function parseMp4(buf) {
  if (buf.length < 12 || buf.toString('latin1', 4, 8) !== 'ftyp') return fail('not-mp4');
  // 头部窗口内找 moov；moov 在文件尾的 faststart-less 文件需要靠 mvhd 不存在时失败
  let moovStart = -1;
  let moovSize = 0;
  let off = 0;
  while (off + 8 <= buf.length) {
    const size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (type === 'moov') {
      moovStart = off;
      moovSize = size;
      break;
    }
    if (size < 8) break;
    off += size;
  }
  if (moovStart === -1) return fail('mp4-moov-not-in-head');

  // 在 moov 范围内找 mvhd
  const end = Math.min(moovStart + moovSize, buf.length);
  for (let i = moovStart + 8; i + 8 <= end; i++) {
    if (buf.toString('latin1', i, i + 4) === 'mvhd') {
      const version = buf[i + 4];
      if (version === 0) {
        const timescale = buf.readUInt32BE(i + 16);
        const duration = buf.readUInt32BE(i + 20);
        if (timescale) {
          return {
            ok: true,
            seconds: duration / timescale,
            codec: 'AAC/MP4',
            sampleRate: null,
            channels: null,
            lossless: false,
          };
        }
      } else {
        const timescale = buf.readUInt32BE(i + 24);
        const duration = Number(buf.readBigUInt64BE(i + 28));
        if (timescale) {
          return {
            ok: true,
            seconds: duration / timescale,
            codec: 'AAC/MP4',
            sampleRate: null,
            channels: null,
            lossless: false,
          };
        }
      }
      return fail('mp4-bad-mvhd');
    }
  }
  return fail('mp4-no-mvhd');
}

/** Ogg: 从尾部最后一个 OggS 页读 granule position */
function parseOgg(headBuf, tailBuf, tailOffset) {
  if (headBuf.toString('latin1', 0, 4) !== 'OggS') return fail('not-ogg');
  // 反向找最后一个 'OggS'
  for (let i = tailBuf.length - 4; i >= 0; i--) {
    if (
      tailBuf[i] === 0x4f && tailBuf[i + 1] === 0x67 && tailBuf[i + 2] === 0x67 && tailBuf[i + 3] === 0x53
    ) {
      const granule = tailBuf.readBigUInt64LE(i + 6);
      const serial = tailBuf.readUInt32LE(i + 14);
      if (granule > 0n && granule < 2n ** 62n) {
        // 需要知道编码类型判断 granule 单位：Opus 用 48kHz，Vorbis 用采样率
        let sampleRate = 48000; // Opus 固定 48k
        let codec = 'Opus';
        // 在头部找 vorbis 标识
        const idx = headBuf.indexOf('vorbis', 0, 'latin1');
        if (idx !== -1) {
          codec = 'Vorbis';
          // 采样率在 identification header 偏移 12
          const oggStart = headBuf.indexOf('OggS', 0, 'latin1');
          if (oggStart !== -1 && oggStart + 28 + 16 < headBuf.length) {
            sampleRate = headBuf.readUInt32LE(oggStart + 28 + 12);
          }
        }
        return {
          ok: true,
          seconds: Number(granule) / sampleRate,
          codec,
          sampleRate,
          channels: null,
          lossless: codec === 'Vorbis' ? false : false,
          _serial: serial,
          _offset: tailOffset + i,
        };
      }
    }
  }
  return fail('ogg-no-page');
}

// ── 对外入口 ────────────────────────────────────────────────────────────────

const EXT_MAP = {
  flac: 'flac',
  dsf: 'dsf',
  dff: 'dff',
  wav: 'wav',
  wave: 'wav',
  aif: 'aiff',
  aiff: 'aiff',
  aifc: 'aiff',
  mp3: 'mp3',
  m4a: 'mp4',
  mp4: 'mp4',
  aac: 'aac',
  ogg: 'ogg',
  opus: 'ogg',
};

export const SUPPORTED_EXT = Object.keys(EXT_MAP);

/**
 * 读取单个音频文件的时长与基本信息
 * @param {string} path
 * @returns {Promise<{ok: boolean, seconds: number|null, reason?: string, codec?: string, sampleRate?: number|null, channels?: number|null, bitsPerSample?: number|null, bitrate?: number, lossless?: boolean, estimated?: boolean}>}
 */
export async function readDuration(path) {
  const ext = path.split('.').pop().toLowerCase();
  const kind = EXT_MAP[ext];
  if (!kind) return fail(`unsupported-ext:${ext}`);

  let fh;
  try {
    const wantHead = kind === 'mp3' ? MP3_HEAD_BYTES : HEAD_BYTES;
    const head = await readHead(path, wantHead);
    fh = head.fh;
    const { buf, fileSize } = head;

    switch (kind) {
      case 'flac':
        return parseFlac(buf);
      case 'dsf':
        return parseDsf(buf);
      case 'dff':
        return parseDff(buf);
      case 'wav':
        return parseWav(buf);
      case 'aiff':
        return parseAiff(buf);
      case 'mp3':
        return parseMp3(buf, fileSize);
      case 'mp4':
        return parseMp4(buf);
      case 'aac':
        return parseAdts(buf);
      case 'ogg': {
        const tail = await readTail(fh, fileSize);
        return parseOgg(buf, tail.buf, tail.offset);
      }
      default:
        return fail(`unhandled:${kind}`);
    }
  } catch (e) {
    return fail(`io-error:${e.code ?? e.message}`);
  } finally {
    if (fh) await fh.close();
  }
}

/** ADTS (裸 AAC): 累加帧数 × 1024 / 采样率 */
const ADTS_SAMPLERATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350, 0, 0, 0];
function parseAdts(buf) {
  // 寻找第一个同步字并读取采样率索引
  let totalFrames = 0;
  let sampleRate = 0;
  for (let i = 0; i + 7 <= buf.length; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xf6) === 0xf0) {
      const srIdx = (buf[i + 2] >> 2) & 0x0f;
      if (!sampleRate) sampleRate = ADTS_SAMPLERATES[srIdx];
      const frameLen = ((buf[i + 3] & 0x03) << 11) | (buf[i + 4] << 3) | ((buf[i + 5] >> 5) & 0x07);
      if (frameLen < 7) break;
      totalFrames++;
      i += frameLen - 1;
    }
  }
  if (!sampleRate || !totalFrames) return fail('adts-incomplete');
  return {
    ok: true,
    seconds: (totalFrames * 1024) / sampleRate,
    codec: 'AAC',
    sampleRate,
    channels: 2,
    lossless: false,
    estimated: true, // 头部窗口外的帧没统计到
  };
}

/** 格式化为 mm:ss 或 h:mm:ss */
export function fmtDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '--:--';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
