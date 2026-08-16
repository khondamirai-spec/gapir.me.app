import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/**
 * Tee the console into a file under userData.
 *
 * A packaged Electron app has no console. Every diagnostic this codebase carefully writes —
 * the `[state]` line naming the model, the key origin, the round-trip time and the
 * transcript; the raw Gemini error bodies; ffmpeg's stderr — goes nowhere the moment the app
 * is installed rather than run from a terminal. That is the one situation where those lines
 * are worth anything: a stranger's machine, a failure you cannot reproduce, and a bug report
 * that says "it didn't type anything".
 *
 * The tray's "Loglar papkasi" item has always opened this folder. Until this module it opened
 * an empty one.
 *
 * Deliberately a tee rather than a replacement: `npm run dev` must keep printing to the
 * terminal exactly as before.
 *
 * Writes are synchronous. That is the right trade here — the volume is a handful of lines per
 * dictation, and a crash is precisely when the last line before it matters most, which is the
 * one an async buffered write loses.
 */

/** Rotated at this size, keeping one previous file. A few thousand dictations fit. */
const MAX_BYTES = 2 * 1024 * 1024;

type ConsoleMethod = 'log' | 'warn' | 'error';

let filePath = '';
/** Never let logging be the thing that breaks the app: one failure and we stop trying. */
let broken = false;

function stamp(): string {
  // Local time, not ISO/UTC: these logs are read next to a user saying "it broke just now".
  const now = new Date();
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
  );
}

/**
 * Render one console argument the way the terminal would.
 *
 * `JSON.stringify` alone is not enough: an Error stringifies to `{}`, and an error with no
 * stack in the log is a bug report that cost the user their time and told us nothing.
 */
function format(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function rotateIfNeeded(): void {
  try {
    if (statSync(filePath).size < MAX_BYTES) return;
    // One generation back. Two files of a bounded size is a log that can be attached to an
    // email; an unbounded one is a support problem of its own.
    renameSync(filePath, join(app.getPath('userData'), 'logs', 'main.old.log'));
  } catch {
    // No file yet (the common case), or a rename we are not allowed to do. Either way the
    // append below is still worth attempting.
  }
}

function write(level: ConsoleMethod, args: unknown[]): void {
  if (broken || !filePath) return;
  try {
    rotateIfNeeded();
    appendFileSync(filePath, `${stamp()} [${level}] ${args.map(format).join(' ')}\n`);
  } catch {
    // A full disk, a locked file, a userData directory that vanished. Logging is not worth
    // an exception thrown out of an arbitrary console.log somewhere in the app.
    broken = true;
  }
}

/**
 * Start logging to disk. Safe to call once, early — before anything that might need to
 * report a failure.
 */
export function initLogger(): void {
  try {
    const dir = join(app.getPath('userData'), 'logs');
    mkdirSync(dir, { recursive: true });
    filePath = join(dir, 'main.log');
  } catch (err) {
    // Console only, since that is all we have.
    console.warn('[logger] could not open the log file:', err instanceof Error ? err.message : err);
    return;
  }

  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      original(...args);
      write(level, args);
    };
  }

  console.log(
    `[logger] ${app.getName()} ${app.getVersion()} starting — ` +
      `${process.platform} ${process.arch}, electron ${process.versions.electron}`
  );
}

/** Where the log lives, so the tray can open the folder that actually contains it. */
export function logDirectory(): string {
  return join(app.getPath('userData'), 'logs');
}
