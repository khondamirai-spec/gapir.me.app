import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { app } from 'electron';

/**
 * The pre-Supabase pool of Gemini keys — kept alive only for builds made before a backend
 * was configured, and scheduled for deletion (Phase 5 of docs/supabase-setup.md).
 *
 * Before there was a server, the app shipped with keys of its own so it worked out of the
 * box. Today `resolveRoute()` in state.ts reaches for this pool only when `isConfigured()`
 * is false; a developer's own key in `.env` (GEMINI_API_KEY) always wins over the pool.
 * There is no user-facing key setting any more — nothing new should reach for this module.
 *
 * **A key shipped inside an installer is a key anyone can extract**, and nothing here
 * pretends otherwise. That is a deliberate trade, and it is why the pool is a *list*: keys
 * are cheap, quota is not, and the file below is meant to be filled with keys that are
 * expected to be spent and rotated rather than protected.
 *
 * Two sources, both read at startup **on the machine the app is running on**:
 *
 *   resources/gemini-keys.json   shipped in the installer, editable without a rebuild
 *   WHISPER_UZ_BUNDLED_KEYS      comma-separated, a development convenience
 *
 * That distinction is worth stating because getting it wrong ships a dead installer: the
 * environment variable is read at runtime, and a packaged build on someone else's machine
 * has no environment to inherit it from. Keys reach a release only by being in the JSON file
 * when electron-builder runs, which in CI is what scripts/write-keys.mjs is for.
 *
 * Free-tier keys have a daily request cap, so a pool is only useful if a spent key steps
 * aside for the next one — that is what the cooldown bookkeeping at the bottom is for.
 */

/** Empty in the repo on purpose — a committed key is a leaked key. */
const KEYS_FILE = 'gemini-keys.json';

interface KeysFile {
  gemini?: unknown;
}

function keysFilePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, KEYS_FILE)
    : join(__dirname, '../../resources', KEYS_FILE);
}

/**
 * Is this array entry actually a key, or is it the instructions someone pasted around one?
 *
 * This file is edited by hand — that is the point of shipping it as a file rather than baking
 * it into the bundle — so it collects the things hand-editing produces: a placeholder left
 * behind, a key with a trailing space off the end of a paste, a whole line copied out of a
 * web page. Every one of those used to become a pool "key", and a fake key is worse than a
 * missing one: it is tried at hotkey-press time, fails with a 400 naming nothing useful, and
 * costs the user a round trip per dictation until somebody notices.
 *
 * Deliberately not a check that the key looks like `AIza…`. Google's key format is theirs to
 * change and rejecting a real key would be a far worse failure than accepting a fake one —
 * so this only rules out what cannot be a key under any format.
 */
function looksLikeKey(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const key = raw.trim();
  if (!key) return false;
  // No credential contains whitespace or angle brackets, and none is three characters long.
  if (/[\s<>]/.test(key) || key.length < 8) return false;
  // Placeholder vocabulary, anchored to the START of the value rather than searched for
  // anywhere inside it. The difference is load-bearing and this rule was wrong the first
  // time: a key is random text, so given enough of them one eventually contains "example" or
  // "xxxx" by luck, and a substring match would silently drop a working key — much the worse
  // failure of the two, since the fake it is guarding against costs only one logged round
  // trip. A placeholder announces itself at the front ("PASTE_YOUR_KEY_HERE"); a real key
  // never begins with a word.
  return !/^[^a-z0-9]*(paste|your[_ -]?key|placeholder|example|todo|replace|enter|xxx)/i.test(key);
}

function readKeysFile(): string[] {
  const path = keysFilePath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as KeysFile;
    if (!Array.isArray(parsed.gemini)) return [];

    const keys = parsed.gemini.filter(looksLikeKey).map((key) => key.trim());

    // Say so rather than silently shrinking the pool: "I pasted four keys and it still says
    // the limit is reached" is otherwise unanswerable. The count only — never the value.
    const skipped = parsed.gemini.length - keys.length;
    if (skipped > 0) {
      console.warn(
        `[keys] ignored ${skipped} entr${skipped === 1 ? 'y' : 'ies'} in ${KEYS_FILE} that ` +
          `did not look like a key (placeholder text, or whitespace inside it)`
      );
    }

    return keys;
  } catch (err) {
    console.warn(`[keys] ${KEYS_FILE} is not readable JSON:`, err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Split on commas and whitespace: a key pasted out of a spreadsheet arrives with either,
 * and a stray newline turning the whole list into one unusable "key" is a silent failure
 * that only shows up as a 400 at hotkey-press time.
 */
export function parseKeyList(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((key) => key.trim())
    .filter(Boolean);
}

let cached: string[] | null = null;

/** Every bundled key, deduplicated, in the order they should be tried. */
export function bundledKeys(): string[] {
  if (cached) return cached;
  const merged = [...readKeysFile(), ...parseKeyList(process.env.WHISPER_UZ_BUNDLED_KEYS ?? '')];
  cached = [...new Set(merged)];
  if (cached.length > 0) console.log(`[keys] ${cached.length} bundled key(s) available`);
  return cached;
}

/**
 * When each spent key becomes worth trying again, as epoch ms.
 *
 * In memory rather than on disk: a restart is a fine moment to find out whether Google has
 * reset an allowance, and persisting this would mean a machine whose clock was wrong once
 * keeps a working key benched.
 */
const coolingUntil = new Map<string, number>();

/** A burst limit clears in seconds; this is deliberately longer than Google's retryDelay. */
const BURST_COOLDOWN_MS = 90_000;

/**
 * Milliseconds until a free-tier daily allowance resets.
 *
 * Google resets requests-per-day at **midnight America/Los_Angeles**, which is documented and
 * is not the same moment as midnight here. This used to bench a spent key until local
 * midnight, and in Tashkent (UTC+5) that is roughly twelve hours out: a key exhausted in the
 * afternoon came back on duty at 00:00 local while Google's counter did not roll over until
 * noon the next day, so the pool kept reaching for keys that were still spent.
 *
 * The result is deliberately wrong by up to an hour on the two DST changeover days a year:
 * this counts down to a wall-clock time in Los Angeles rather than a fixed number of hours,
 * which is the right shape, and the residual error is far inside the tolerance of a cooldown
 * that pickBundledKey() is allowed to ignore anyway.
 */
export function msUntilQuotaReset(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(now);

  const field = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // `hour12: false` yields 24 rather than 0 for midnight in some ICU versions.
  const hour = field('hour') % 24;
  const elapsedMs =
    ((hour * 60 + field('minute')) * 60 + field('second')) * 1000 + now.getMilliseconds();

  return 24 * 60 * 60 * 1000 - elapsedMs;
}

/**
 * Bench a key that just failed on quota.
 *
 * `daily` is the free tier's per-day cap, which no amount of waiting inside one dictation
 * will fix — the key is done until tomorrow and the next one in the pool should take over.
 */
export function markKeyExhausted(key: string, kind: 'daily' | 'burst' = 'daily'): void {
  if (!key) return;
  const until = Date.now() + (kind === 'daily' ? msUntilQuotaReset() : BURST_COOLDOWN_MS);
  coolingUntil.set(key, until);
  console.warn(`[keys] benched a bundled key (${kind}) for ${Math.round((until - Date.now()) / 1000)}s`);
}

function isHealthy(key: string): boolean {
  const until = coolingUntil.get(key);
  return !until || until <= Date.now();
}

/**
 * The bundled key to use now, or '' when the pool is empty.
 *
 * When every key is cooling down we still hand one back rather than refusing outright: the
 * cooldowns are our own guess, Google's allowances are the real authority, and letting the
 * request go through means the user sees the actual quota message instead of ours.
 *
 * Which one, in that case, is not arbitrary. The key whose cooldown expires soonest is the
 * one most likely to have been given its allowance back already — a burst limit benched 90
 * seconds ago is a far better bet than a key benched until tomorrow, and reaching for the
 * first key in the list regardless would keep picking the latter. Ties keep pool order, so a
 * pool benched all at once still starts from the top.
 */
export function pickBundledKey(): string {
  const keys = bundledKeys();
  if (keys.length === 0) return '';

  const healthy = keys.find(isHealthy);
  if (healthy) return healthy;

  let best = keys[0];
  let bestUntil = coolingUntil.get(best) ?? 0;
  for (const key of keys) {
    const until = coolingUntil.get(key) ?? 0;
    if (until < bestUntil) {
      best = key;
      bestUntil = until;
    }
  }
  return best;
}

/** The next healthy key that isn't the one that just failed, or '' if there is no other. */
export function nextBundledKey(failed: string): string {
  const keys = bundledKeys();
  const start = keys.indexOf(failed);
  for (let i = 1; i <= keys.length; i++) {
    const candidate = keys[(start + i) % keys.length];
    if (candidate !== failed && isHealthy(candidate)) return candidate;
  }
  return '';
}

/** Exported for tests. */
export const _internals = { coolingUntil, BURST_COOLDOWN_MS, isHealthy, looksLikeKey };
