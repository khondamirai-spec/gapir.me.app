import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, renameSync, copyFileSync, statSync } from 'node:fs';
import { app } from 'electron';

/**
 * Where this app keeps everything, and how it stopped keeping it somewhere else.
 *
 * **Import this module first, before anything that reads a path.** Electron derives
 * `userData` from the app's name the first time it is asked, and `src/main/config.ts`
 * constructs its electron-store at import time — so the order of the imports at the top of
 * src/main/index.ts is load-bearing, not stylistic. Getting it wrong doesn't fail loudly:
 * it silently writes settings.json to the old folder again.
 *
 * ## Why there was an old folder
 *
 * This app began as a different program with a different name, and the name outlived it: the
 * npm package stayed `whisper-uz` long after the local model it referred to was gone, and
 * `app.getName()` falls back to `package.json#name`. So every build up to v0.2.4 wrote its
 * settings, history, session and logs to `%APPDATA%\whisper-uz` while calling itself
 * "gapir me" everywhere a user could see — one product, two identities, and the one on disk
 * was the name of a thing that no longer existed.
 *
 * Both halves are fixed now: the package is `gapir-me`, and `setName()` below pins the
 * folder rather than leaving it to be inferred. What remains is the one-way trip for
 * everyone who installed before that, which is what `migrate()` is.
 *
 * That trip is what makes this a rename rather than a reset. Without it everyone who updates
 * is silently signed out, loses their history and gets the welcome flow again, with their
 * real data sitting in a folder nothing will ever open.
 */

/** The one folder this app owns. Matches `productName` in electron-builder.yml. */
export const APP_FOLDER = 'gapir me';

/**
 * The folder every build up to v0.2.4 wrote to. Read once, renamed away, never written.
 *
 * **The last place the old name appears in this app, and it is here in order to erase it.**
 * Deleting the constant does not fail loudly — it just stops the migration, stranding the
 * history and the session of everyone who installed before the rename in a folder nothing
 * opens. When enough releases have passed that no unmigrated install is plausibly still out
 * there, this and `migrate()` can go together; until then, leave it.
 */
const LEGACY_FOLDER = 'whisper-uz';

/**
 * Files worth carrying across. Named rather than globbed, because the old folder also
 * accumulated Chromium's own caches (`Local Storage`, `Network`, `Session Storage`,
 * `SharedStorage-wal`) — disposable by design, several megabytes of it, and copying a cache
 * into a fresh profile is how you inherit a corrupt one.
 */
const MIGRATE_FILES = ['settings.json', 'history.json', 'auth.json'];
/** Directories carried across whole. Just the log, which is what a support conversation asks for. */
const MIGRATE_DIRS = ['logs'];

let migrationNote = '';

/**
 * Point `userData` at `%APPDATA%\gapir me`, moving the old folder's contents there once.
 *
 * Runs on import, at the bottom of this file, rather than being called from `bootstrap()` —
 * and that is the only shape that works. `import` statements are evaluated before any
 * statement in the importing module, so a call in main's body would run *after*
 * src/main/config.ts had already built its store against the old path. Being imported first
 * is the only way to be early enough.
 *
 * `setName` as well as `setPath` because the name is what everything else derives from —
 * crash dumps, the Windows jump list, `app.getPath('logs')` — and setting only the one path
 * would leave those pointing at the old identity.
 */
function initAppPaths(): void {
  app.setName(APP_FOLDER);

  const home = app.getPath('appData');
  // Under vitest `electron` is a stub with no roaming folder to speak of (see
  // test/electron-stub.ts). Creating "gapir me" in the repo root because a unit test
  // imported this module would be a surprising thing for a test run to leave behind.
  if (!home) return;

  const target = join(home, APP_FOLDER);
  const legacy = join(home, LEGACY_FOLDER);

  try {
    migrate(legacy, target);
  } catch (err) {
    // A failed migration must not stop the app from starting: the worst case is a user who
    // signs in again, which is recoverable, where a main process that throws here is not.
    migrationNote = `[paths] could not move ${LEGACY_FOLDER}: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Electron will create this itself, but only once something asks for the path — and the
  // migration above may have just put files in it. Make it exist either way.
  mkdirSync(target, { recursive: true });
  app.setPath('userData', target);
}

/**
 * Anything the logger should say once it exists.
 *
 * This module runs before `initLogger()` — it has to, since the logger writes into the very
 * path being decided here — so it cannot log. It leaves its one line for main to pick up.
 */
export function pathsNote(): string {
  return migrationNote;
}

function migrate(legacy: string, target: string): void {
  if (!existsSync(legacy) || legacy === target) return;

  // The clean case, and the common one: first launch after the update. A rename is atomic,
  // copies nothing, and cannot half-succeed.
  if (!existsSync(target)) {
    renameSync(legacy, target);
    migrationNote = `[paths] moved ${legacy} -> ${target}`;
    return;
  }

  // The target already exists — either Electron created it a moment ago (empty), or this is
  // a machine where both apps ran. Only fill in what isn't there; never overwrite a file the
  // new folder already has, because that one is by definition the newer of the two.
  let moved = 0;
  for (const name of MIGRATE_FILES) {
    const from = join(legacy, name);
    const to = join(target, name);
    if (!existsSync(from) || existsSync(to)) continue;
    copyFileSync(from, to);
    moved++;
  }
  for (const name of MIGRATE_DIRS) {
    const from = join(legacy, name);
    const to = join(target, name);
    if (!existsSync(from) || existsSync(to)) continue;
    copyDir(from, to);
    moved++;
  }
  if (!moved) return;

  migrationNote = `[paths] copied ${moved} item(s) from ${legacy} -> ${target}`;
  // Leave the old folder behind rather than deleting it. The rename branch above is what
  // normally runs and leaves nothing; reaching here means two folders already disagreed, and
  // deleting the one we just read from is not a risk worth taking to tidy up a rare case.
}

function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const src = join(from, entry);
    const dst = join(to, entry);
    if (statSync(src).isDirectory()) copyDir(src, dst);
    else copyFileSync(src, dst);
  }
}

/** Exported for tests — the migration is the half of this module worth pinning down. */
export const _internals = { migrate, copyDir, LEGACY_FOLDER, MIGRATE_FILES, MIGRATE_DIRS };

// The side effect this module exists for. See the note on initAppPaths.
initAppPaths();
