/**
 * Generates every copy of the brand mark the app needs, from the one piece of artwork.
 *
 *   node scripts/make-icons.mjs
 *
 * Writes:
 *
 *   resources/icon.png            256x256  the mark on a cream tile — window, taskbar, installer
 *   resources/tray.png             32x32   the mark in white — the tray, on a dark taskbar
 *   src/renderer/assets/logo.png    720w   trimmed, ink on transparent — both renderers
 *   docs/logo.png                   720w   the same file for the download page
 *
 * **Every one of them is the real artwork, rescaled.** `resources/logo.png` (a copy of
 * LOGO.png) is the source of truth and nothing here redraws it.
 *
 * That is worth stating because an earlier version of this script did redraw it: it traced
 * the two lip curves by hand as bezier paths, dropped the waveform between them, and the
 * renderers inlined *those* paths as SVG. The reasoning was legibility — the artwork is
 * 290x149 of hairline strokes, and at tray size the waveform does close up into a smear. The
 * reasoning was also wrong. A brand mark that has been redrawn is a different mark, and a
 * user looking at the sidebar was not looking at their logo. Legibility is a question about
 * *size*, and the answer is to draw the mark bigger, not to draw a different mark: the
 * sidebar and the pill were widened to give it room.
 *
 * The trimmed renderer copy exists because the artwork is a 500x500 canvas with the mark
 * floating in the middle of it — dropped into a 44px box unchanged, the padding is most of
 * what you get. Trimming to the mark's own bounding box means a CSS width means what it says.
 * It is emitted at 720px wide so it stays crisp on a 200% display.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'resources');
const RENDERER_DIR = join(ROOT, 'src', 'renderer', 'assets');
const DOCS_DIR = join(ROOT, 'docs');
const SOURCE = join(OUT_DIR, 'logo.png');

/** The tile behind the mark on the app icon, sampled from the artwork's background. */
const CREAM = [255, 239, 223]; // #ffefdf

// ---------- minimal PNG codec ----------

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

/** rgba: Uint8Array of width*height*4. Non-square because the mark is about 2:1. */
function encodePng(rgba, width, height = width) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10,11,12 = compression, filter, interlace — all 0

  // Each scanline is prefixed with a filter byte (0 = None).
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, rowStart + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * Decodes the one PNG shape we need to read: 8-bit RGBA, non-interlaced. Anything else
 * throws rather than silently producing garbage — logo.png is the only input this ever sees,
 * and if someone re-exports it in another shape a loud failure is what they want.
 */
function decodePng(buf) {
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];

  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.slice(offset + 4, offset + 8).toString('ascii');
    if (type === 'IHDR') {
      width = buf.readUInt32BE(offset + 8);
      height = buf.readUInt32BE(offset + 12);
      const depth = buf[offset + 16];
      const colour = buf[offset + 17];
      const interlace = buf[offset + 20];
      if (depth !== 8 || colour !== 6 || interlace !== 0) {
        throw new Error(
          `${SOURCE}: need 8-bit RGBA, non-interlaced (got depth ${depth}, colour type ${colour}, interlace ${interlace})`
        );
      }
    }
    // Encoders are free to split the pixel data across any number of IDAT chunks.
    if (type === 'IDAT') idat.push(buf.slice(offset + 8, offset + 8 + len));
    offset += 12 + len;
    if (type === 'IEND') break;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const px = Buffer.alloc(width * height * bpp);
  let p = 0;

  // Undo the per-scanline filters (PNG spec §9). Each byte is predicted from its left (a),
  // upper (b) and upper-left (c) neighbours in the already-reconstructed image.
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const row = y * stride;
    const prev = row - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[p++];
      const a = i >= bpp ? px[row + i - bpp] : 0;
      const b = y > 0 ? px[prev + i] : 0;
      const c = i >= bpp && y > 0 ? px[prev + i - bpp] : 0;
      let v;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      px[row + i] = v & 0xff;
    }
  }

  return { px, width, height };
}

// ---------- geometry ----------

/** Distance to a rounded square, used for the icon's background tile. */
function roundedSquareDist(x, y, half, radius) {
  const dx = Math.abs(x - 0.5) - (half - radius);
  const dy = Math.abs(y - 0.5) - (half - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

// ---------- rendering ----------

/** The artwork's own bounding box inside its padded canvas, and the decoded pixels. */
function loadMark() {
  const src = decodePng(readFileSync(SOURCE));

  let minX = src.width;
  let minY = src.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (src.px[(y * src.width + x) * 4 + 3] > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  return { src, minX, minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Resample the mark into a `dstW` x `dstH` buffer, drawn `scale`d and centred, over
 * whatever `rgba` already holds.
 *
 * Box-filtered, and averaged in premultiplied space: the strokes are surrounded by a
 * transparent halo, and averaging that halo naively drags the colour towards black — which
 * on a 32px tray icon is the difference between a burgundy mark and a dirty grey one.
 * `tint`, when given, replaces the artwork's colour and keeps only its shape; that is how
 * the tray gets a white mark without a second source file.
 */
function drawMark(rgba, dstW, dstH, { mark, scale, tint }) {
  const { src, minX, minY, width, height } = mark;
  const inv = 1 / scale;
  const ox = (dstW - width * scale) / 2;
  const oy = (dstH - height * scale) / 2;

  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const sx0 = minX + (x - ox) * inv;
      const sy0 = minY + (y - oy) * inv;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      let n = 0;
      const ix0 = Math.max(0, Math.floor(sx0));
      const ix1 = Math.min(src.width - 1, Math.ceil(sx0 + inv) - 1);
      const iy0 = Math.max(0, Math.floor(sy0));
      const iy1 = Math.min(src.height - 1, Math.ceil(sy0 + inv) - 1);
      for (let sy = iy0; sy <= iy1; sy++) {
        for (let sx = ix0; sx <= ix1; sx++) {
          const i = (sy * src.width + sx) * 4;
          const al = src.px[i + 3];
          sr += src.px[i] * al;
          sg += src.px[i + 1] * al;
          sb += src.px[i + 2] * al;
          sa += al;
          n++;
        }
      }
      if (n === 0 || sa === 0) continue;

      const alpha = sa / n / 255;
      const [mr, mg, mb] = tint ?? [sr / sa, sg / sa, sb / sa];

      const i = (y * dstW + x) * 4;
      const dr = rgba[i];
      const dg = rgba[i + 1];
      const db = rgba[i + 2];
      const da = rgba[i + 3];
      rgba[i] = Math.round(mr * alpha + dr * (1 - alpha));
      rgba[i + 1] = Math.round(mg * alpha + dg * (1 - alpha));
      rgba[i + 2] = Math.round(mb * alpha + db * (1 - alpha));
      rgba[i + 3] = Math.round(Math.min(255, (sa / n) + da * (1 - alpha)));
    }
  }
}

/** A square icon: the mark spanning `fill` of the width, over an optional rounded tile. */
function squareIcon(size, { fill, tile, tint }) {
  const mark = loadMark();
  const rgba = new Uint8Array(size * size * 4);

  if (tile) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = roundedSquareDist((x + 0.5) / size, (y + 0.5) / size, 0.5, 0.22);
        const cov = Math.max(0, Math.min(1, 0.5 - d * size)); // ~1px of anti-aliasing
        if (cov <= 0) continue;
        const i = (y * size + x) * 4;
        [rgba[i], rgba[i + 1], rgba[i + 2]] = tile;
        rgba[i + 3] = Math.round(255 * cov);
      }
    }
  }

  drawMark(rgba, size, size, { mark, scale: (size * fill) / mark.width, tint });
  return encodePng(rgba, size, size);
}

/** The mark alone, trimmed to its own edges — what the renderers put in an <img>. */
function trimmedMark(width) {
  const mark = loadMark();
  const scale = width / mark.width;
  const height = Math.round(mark.height * scale);
  const rgba = new Uint8Array(width * height * 4);
  drawMark(rgba, width, height, { mark, scale });
  return encodePng(rgba, width, height);
}

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(RENDERER_DIR, { recursive: true });
mkdirSync(DOCS_DIR, { recursive: true });

writeFileSync(join(OUT_DIR, 'icon.png'), squareIcon(256, { fill: 0.82, tile: CREAM }));
console.log('wrote resources/icon.png (256x256)');

// White rather than brand burgundy: the tray sits on the taskbar, which is dark by default,
// and #590222 on near-black is invisible. `fill: 0.94` because a tray icon has no tile to sit
// on and every pixel of the 32 is worth having.
writeFileSync(join(OUT_DIR, 'tray.png'), squareIcon(32, { fill: 0.94, tint: [255, 255, 255] }));
console.log('wrote resources/tray.png (32x32)');

// 720px wide so the sidebar's 44px copy stays sharp at 200% display scaling.
const trimmed = trimmedMark(720);
writeFileSync(join(RENDERER_DIR, 'logo.png'), trimmed);
console.log('wrote src/renderer/assets/logo.png (720w, trimmed)');
writeFileSync(join(DOCS_DIR, 'logo.png'), trimmed);
console.log('wrote docs/logo.png (720w, trimmed)');
