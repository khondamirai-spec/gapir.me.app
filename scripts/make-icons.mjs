/**
 * Generates resources/icon.png (app + installer) and resources/tray.png (tray glyph).
 *
 * Drawn procedurally rather than committed as binaries: no opaque blobs in the repo, and
 * the colours/shape can be tweaked by editing numbers instead of opening an image editor.
 *
 *   node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources');

// ---------- minimal PNG encoder ----------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

/** rgba: Uint8Array of size*size*4 */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10,11,12 = compression, filter, interlace — all 0

  // Each scanline is prefixed with a filter byte (0 = None).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, rowStart + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- geometry, in 0..1 normalised space ----------

/** Distance from point to a capsule (thick line segment) with round caps. */
function capsuleDist(px, py, x1, y1, x2, y2, r) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy) - r;
}

/** Distance to the lower half of a ring — the arc that cradles the mic. */
function arcDist(px, py, cx, cy, radius, thickness) {
  if (py < cy) return 1; // upper half: not part of the arc
  return Math.abs(Math.hypot(px - cx, py - cy) - radius) - thickness;
}

/** Signed distance to the microphone glyph. Negative = inside. */
function micDist(x, y) {
  const body = capsuleDist(x, y, 0.5, 0.3, 0.5, 0.48, 0.105);
  const arc = arcDist(x, y, 0.5, 0.48, 0.2, 0.028);
  const stem = capsuleDist(x, y, 0.5, 0.68, 0.5, 0.775, 0.026);
  const base = capsuleDist(x, y, 0.395, 0.79, 0.605, 0.79, 0.028);
  return Math.min(body, arc, stem, base);
}

/** Distance to a rounded square, used for the app icon's background tile. */
function roundedSquareDist(x, y, half, radius) {
  const dx = Math.abs(x - 0.5) - (half - radius);
  const dy = Math.abs(y - 0.5) - (half - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

// ---------- rendering ----------

const SS = 4; // supersampling factor for anti-aliasing

function render(size, { withBackground }) {
  const rgba = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const nx = (x + (sx + 0.5) / SS) / size;
          const ny = (y + (sy + 0.5) / SS) / size;

          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;

          if (withBackground && roundedSquareDist(nx, ny, 0.5, 0.22) < 0) {
            // Vertical indigo gradient.
            const t = ny;
            r = 109 + (124 - 109) * t;
            g = 92 + (107 - 92) * t;
            b = 207 + (222 - 207) * t;
            a = 255;
          }

          if (micDist(nx, ny) < 0) {
            // White glyph on the tile; on the tray it's the glyph alone.
            r = 255;
            g = 255;
            b = 255;
            a = 255;
          }

          rSum += r * a;
          gSum += g * a;
          bSum += b * a;
          aSum += a;
        }
      }

      const samples = SS * SS;
      const alpha = aSum / samples;
      const i = (y * size + x) * 4;
      // Un-premultiply so edges blend correctly against any background.
      rgba[i] = aSum ? Math.round(rSum / aSum) : 0;
      rgba[i + 1] = aSum ? Math.round(gSum / aSum) : 0;
      rgba[i + 2] = aSum ? Math.round(bSum / aSum) : 0;
      rgba[i + 3] = Math.round(alpha);
    }
  }

  return encodePng(rgba, size);
}

mkdirSync(OUT_DIR, { recursive: true });

writeFileSync(join(OUT_DIR, 'icon.png'), render(256, { withBackground: true }));
console.log('wrote resources/icon.png (256x256)');

// Tray icons are drawn small; the bare white glyph reads better than a shrunken tile.
writeFileSync(join(OUT_DIR, 'tray.png'), render(32, { withBackground: false }));
console.log('wrote resources/tray.png (32x32)');
