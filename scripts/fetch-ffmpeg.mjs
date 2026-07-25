/**
 * Downloads the ffmpeg.exe that gets bundled into the installer.
 *
 *   node scripts/fetch-ffmpeg.mjs [--force]
 *
 * A downloaded app cannot tell its users to `winget install ffmpeg` first, so the binary has
 * to be in the box. It is not committed to the repo — a 100 MB binary in git history is a
 * permanent tax on every clone — so this runs in `predist` and in CI instead.
 *
 * Two deliberate choices:
 *
 * LGPL, not GPL. BtbN publishes both. ffmpeg is invoked here as a separate process and never
 * linked, but the LGPL build removes any argument about what that implies for redistributing
 * this app. Its licence is copied out next to the binary and ships with it.
 *
 * A pinned release with a digest checked in, not "latest". Verifying a hash you fetched from
 * the same place as the file proves nothing, so the digest lives here in the repo where a
 * change to it shows up in review. To bump the version, update URL and SHA256 together: run
 * with --force, and the script prints the digest it got when it doesn't match.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCES = join(ROOT, 'resources');

/** Pinned build — update `url` and `sha256` together. */
const BUILD = {
  label: 'ffmpeg n8.1.2 win64-lgpl (BtbN autobuild-2026-07-24)',
  url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-07-24-13-32/ffmpeg-n8.1.2-31-g8c9502e9b0-win64-lgpl-8.1.zip',
  sha256: '972c57498dff104fff2d53b8b0cb3641f45b8ff1e7cc1b00257c9e34435fe853'
};

const TARGET = join(RESOURCES, 'ffmpeg.exe');
const ZIP = join(RESOURCES, '.ffmpeg-download.zip');
const EXTRACT_DIR = join(RESOURCES, '.ffmpeg-extract');

/** Depth-first search by filename — the archive's top folder is version-stamped. */
function findFile(dir, name) {
  for (const item of readdirSync(dir)) {
    const path = join(dir, item);
    if (statSync(path).isDirectory()) {
      const hit = findFile(path, name);
      if (hit) return hit;
    } else if (item.toLowerCase() === name.toLowerCase()) {
      return path;
    }
  }
  return null;
}

function fail(message) {
  console.error(`[ffmpeg] ${message}`);
  rmSync(ZIP, { force: true });
  rmSync(EXTRACT_DIR, { recursive: true, force: true });
  process.exit(1);
}

if (existsSync(TARGET) && !process.argv.includes('--force')) {
  console.log('[ffmpeg] resources/ffmpeg.exe already present — pass --force to re-fetch');
  process.exit(0);
}

mkdirSync(RESOURCES, { recursive: true });

console.log(`[ffmpeg] downloading ${BUILD.label}`);
const res = await fetch(BUILD.url, { redirect: 'follow' });
if (!res.ok || !res.body) fail(`download failed: HTTP ${res.status}`);
await pipeline(res.body, createWriteStream(ZIP));

const digest = createHash('sha256').update(readFileSync(ZIP)).digest('hex');
if (digest !== BUILD.sha256) {
  fail(
    `digest mismatch — refusing to bundle this file.\n` +
      `         expected ${BUILD.sha256}\n` +
      `         got      ${digest}`
  );
}

console.log('[ffmpeg] digest verified, extracting');
rmSync(EXTRACT_DIR, { recursive: true, force: true });
mkdirSync(EXTRACT_DIR, { recursive: true });

// Expand-Archive rather than a zip dependency: it ships with Windows, and this script only
// ever runs on Windows (or a windows-latest runner) because its output is a .exe.
execFileSync(
  'powershell',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath '${ZIP}' -DestinationPath '${EXTRACT_DIR}' -Force`
  ],
  { stdio: 'inherit' }
);

const exe = findFile(EXTRACT_DIR, 'ffmpeg.exe');
if (!exe) fail('ffmpeg.exe not found inside the archive');
writeFileSync(TARGET, readFileSync(exe));

// The LGPL asks that the licence travel with the binary; electron-builder ships this file
// next to ffmpeg.exe in the installer.
const licence = findFile(EXTRACT_DIR, 'LICENSE.txt') ?? findFile(EXTRACT_DIR, 'LICENSE');
if (licence) writeFileSync(join(RESOURCES, 'ffmpeg-LICENSE.txt'), readFileSync(licence));
else console.warn('[ffmpeg] no LICENSE file in the archive — check the build before shipping');

rmSync(ZIP, { force: true });
rmSync(EXTRACT_DIR, { recursive: true, force: true });

const mb = (statSync(TARGET).size / 1024 / 1024).toFixed(1);
console.log(`[ffmpeg] wrote resources/ffmpeg.exe (${mb} MB)`);
