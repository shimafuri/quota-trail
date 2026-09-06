#!/usr/bin/env node
// assets/icon.png（32x32）, assets/icon-16.png, assets/icon.ico を生成する。
// 依存なしの純 Node（zlib で PNG を作り、ICO は PNG を包む Vista 形式）。
// 図案: Claude テラコッタ #D97757 の円 + 右上 1/4 を ChatGPT グリーン #10A37F。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'assets');

const TERRACOTTA = [0xd9, 0x77, 0x57];
const GREEN = [0x10, 0xa3, 0x7f];

// --- CRC32 ------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * RGBA バッファ（size*size*4）→ PNG Buffer
 * @param {number} size
 * @param {Buffer} rgba
 */
function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * アイコンの RGBA を作る（4x4 スーパーサンプリング）。
 * @param {number} size
 */
function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4, 0);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - Math.max(1, size / 32);
  const SS = 4;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hitR = 0;
      let hitG = 0;
      let total = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          total += 1;
          const dx = px - cx;
          const dy = py - cy;
          if (dx * dx + dy * dy <= r * r) {
            if (dx >= 0 && dy <= 0) hitG += 1; // 右上の 1/4
            else hitR += 1;
          }
        }
      }
      const cov = (hitR + hitG) / total;
      if (cov === 0) continue;
      const gRatio = hitG / (hitR + hitG);
      const color = [
        Math.round(TERRACOTTA[0] * (1 - gRatio) + GREEN[0] * gRatio),
        Math.round(TERRACOTTA[1] * (1 - gRatio) + GREEN[1] * gRatio),
        Math.round(TERRACOTTA[2] * (1 - gRatio) + GREEN[2] * gRatio),
      ];
      const o = (y * size + x) * 4;
      buf[o] = color[0];
      buf[o + 1] = color[1];
      buf[o + 2] = color[2];
      buf[o + 3] = Math.round(cov * 255);
    }
  }
  return buf;
}

/**
 * PNG を包んだ ICO（Vista 形式）を作る。
 * @param {{size:number, png:Buffer}[]} images
 */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;       // width
    e[1] = size >= 256 ? 0 : size;       // height
    e[2] = 0;                            // color count
    e[3] = 0;                            // reserved
    e.writeUInt16LE(1, 4);               // planes
    e.writeUInt16LE(32, 6);              // bit count
    e.writeUInt32LE(png.length, 8);      // bytes in res
    e.writeUInt32LE(offset, 12);         // image offset
    entries.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

fs.mkdirSync(outDir, { recursive: true });

const sizes = [16, 32, 48, 256];
const pngs = sizes.map((size) => ({ size, png: encodePng(size, drawIcon(size)) }));

const png32 = pngs.find((p) => p.size === 32).png;
const png16 = pngs.find((p) => p.size === 16).png;
fs.writeFileSync(path.join(outDir, 'icon.png'), png32);
fs.writeFileSync(path.join(outDir, 'icon-16.png'), png16);
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(pngs));

process.stdout.write(`assets/icon.png (32x32, ${png32.length} B)\n`);
process.stdout.write(`assets/icon-16.png (16x16, ${png16.length} B)\n`);
process.stdout.write(`assets/icon.ico (${sizes.join('/')}, ${fs.statSync(path.join(outDir, 'icon.ico')).size} B)\n`);
