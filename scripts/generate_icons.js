// ============================================================
// PWA用アイコン生成スクリプト
//
//   外部ライブラリなし（Node組み込みの zlib のみ）で、
//   紺色の背景 + 白い吹き出し型の仮アイコンPNGを生成する。
//   本番のアイコンに差し替えるときは、icons/ の PNG を上書きするか、
//   drawIcon() の図形を書き換えて再実行する。
//   maskable対応のため、図柄は中央80%のセーフゾーンに収める。
//
//   実行方法: node scripts/generate_icons.js
//   出力先  : icons/icon-192.png, icons/icon-512.png
// ============================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// 背景色（紺色）と吹き出しの色（白）
const BG_COLOR = [0x1e, 0x3a, 0x8a];
const MARK_COLOR = [0xff, 0xff, 0xff];

/**
 * PNGチャンク（長さ + タイプ + データ + CRC32）を組み立てる
 */
function buildChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  // zlib.crc32 は符号付きになりうるため >>> 0 で符号なしに揃える
  crc.writeUInt32BE(zlib.crc32(crcInput) >>> 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/**
 * RGBAピクセル配列からPNGバイナリを組み立てる
 */
function encodePng(size, pixels) {
  // IHDR: 幅・高さ・ビット深度8・カラータイプ6(RGBA)
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // ビット深度
  ihdr[9] = 6; // RGBA
  // ihdr[10..12] = 圧縮方式・フィルタ方式・インターレース（すべて0）

  // 各行の先頭にフィルタタイプ0（None）を付けてdeflate圧縮
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // フィルタ: None
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    buildChunk('IHDR', ihdr),
    buildChunk('IDAT', idat),
    buildChunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * 指定サイズのアイコンピクセルを描画する。
 * 背景は全面塗り（maskable対応）、中央に角丸の吹き出しと、左下のしっぽ。
 * 図柄は中央80%のセーフゾーンに収める。
 */
function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);

  // 吹き出し本体（角丸の長方形）
  const left = size * 0.24;
  const right = size * 0.76;
  const top = size * 0.28;
  const bottom = size * 0.64;
  const radius = size * 0.08;
  // しっぽ（左下に伸びる三角形）
  const tail = [[size * 0.34, bottom - 1], [size * 0.48, bottom - 1], [size * 0.30, size * 0.76]];

  const insideRoundRect = (x, y) => {
    if (x < left || x > right || y < top || y > bottom) { return false; }
    const cx = Math.min(Math.max(x, left + radius), right - radius);
    const cy = Math.min(Math.max(y, top + radius), bottom - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };
  const insideTriangle = (x, y) => {
    const [a, b, c] = tail;
    const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
    const d1 = sign([x, y], a, b);
    const d2 = sign([x, y], b, c);
    const d3 = sign([x, y], c, a);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const color = insideRoundRect(x, y) || insideTriangle(x, y) ? MARK_COLOR : BG_COLOR;
      const offset = (y * size + x) * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = 255; // 不透明
    }
  }
  return pixels;
}

// ---- メイン処理 ----------------------------------------------

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [192, 512]) {
  const png = encodePng(size, drawIcon(size));
  const outPath = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`生成完了: ${outPath} (${png.length} bytes)`);
}
