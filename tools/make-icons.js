'use strict';
/* 生成扩展图标（PNG，纯 Node 实现，无第三方依赖）。
 * 设计：蓝色渐变圆角方块 + 四条彩色圆角横条（形似格式化后的数据行）。 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
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

function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function sdfInside(px, py, x0, y0, x1, y1, rad) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const hw = (x1 - x0) / 2, hh = (y1 - y0) / 2;
  const qx = Math.abs(px - cx) - (hw - rad);
  const qy = Math.abs(py - cy) - (hh - rad);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  const dist = Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - rad;
  return dist <= 0;
}

function drawIcon(size) {
  const S = 4;
  const W = size * S;
  const buf = new Float64Array(W * W * 4); // RGB + alpha(0..255)

  const paint = (x0, y0, x1, y1, rad, colorFn) => {
    const xa = Math.max(0, Math.floor(x0 * S)), xb = Math.min(W - 1, Math.ceil(x1 * S));
    const ya = Math.max(0, Math.floor(y0 * S)), yb = Math.min(W - 1, Math.ceil(y1 * S));
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const px = (x + 0.5) / S, py = (y + 0.5) / S;
        if (!sdfInside(px, py, x0, y0, x1, y1, rad)) continue;
        const c = colorFn(px, py);
        const i = (y * W + x) * 4;
        buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255;
      }
    }
  };

  // 背景：垂直渐变圆角方块
  const c0 = [37, 99, 235];   // #2563eb
  const c1 = [30, 64, 175];   // #1e40af
  paint(0, 0, size, size, size * 0.22, (px, py) => {
    const t = Math.min(1, Math.max(0, py / size));
    return [
      c0[0] + (c1[0] - c0[0]) * t,
      c0[1] + (c1[1] - c0[1]) * t,
      c0[2] + (c1[2] - c0[2]) * t,
    ];
  });

  // 四条彩色圆角横条
  const bars = [
    { w: 0.52, c: [255, 255, 255] },
    { w: 0.40, c: [253, 230, 138] },
    { w: 0.46, c: [134, 239, 172] },
    { w: 0.34, c: [147, 197, 253] },
  ];
  const x0 = size * 0.24;
  const bh = size * 0.095;
  const gap = size * 0.048;
  let y = size * 0.21;
  for (const b of bars) {
    paint(x0, y, x0 + size * b.w, y + bh, bh / 2, () => b.c);
    y += bh + gap;
  }

  // 超采样降采样
  const out = Buffer.alloc(size * size * 4);
  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const i = ((oy * S + sy) * W + ox * S + sx) * 4;
          const al = buf[i + 3] / 255;
          r += buf[i] * al;
          g += buf[i + 1] * al;
          b += buf[i + 2] * al;
          a += al;
        }
      }
      const o = (oy * size + ox) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / (S * S)) * 255);
    }
  }
  return encodePNG(size, size, out);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, 'icon' + size + '.png');
  fs.writeFileSync(file, drawIcon(size));
  console.log('wrote', file);
}
