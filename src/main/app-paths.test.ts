import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _internals } from './app-paths';

/**
 * The migration is the whole reason this module is more than two lines: it is what turns
 * "the folder is called gapir me now" into a rename rather than a reset. Everyone who
 * updates has a session, a history and a settings file in the old folder, and the failure
 * mode of getting this wrong is silent — the app starts, works, and looks brand new.
 */

const { migrate } = _internals;

let root = '';
let legacy = '';
let target = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gapir-paths-'));
  legacy = join(root, 'whisper-uz');
  target = join(root, 'gapir me');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedLegacy(): void {
  mkdirSync(join(legacy, 'logs'), { recursive: true });
  writeFileSync(join(legacy, 'settings.json'), '{"language":"ru"}');
  writeFileSync(join(legacy, 'history.json'), '{"entries":[]}');
  writeFileSync(join(legacy, 'auth.json'), 'ciphertext');
  writeFileSync(join(legacy, 'logs', 'main.log'), 'hello');
  // Chromium's own leftovers, which must not be carried into a fresh profile.
  mkdirSync(join(legacy, 'Local Storage'), { recursive: true });
  writeFileSync(join(legacy, 'Local Storage', 'leveldb.ldb'), 'cache');
}

describe('migrate', () => {
  it('renames the whole folder when the new one does not exist yet', () => {
    seedLegacy();

    migrate(legacy, target);

    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(target, 'settings.json'), 'utf8')).toBe('{"language":"ru"}');
    expect(readFileSync(join(target, 'auth.json'), 'utf8')).toBe('ciphertext');
    // A rename carries everything, caches included — nothing is copied, so nothing is chosen.
    expect(existsSync(join(target, 'Local Storage'))).toBe(true);
  });

  it('copies only the files worth having when the new folder already exists', () => {
    seedLegacy();
    mkdirSync(target, { recursive: true });

    migrate(legacy, target);

    expect(existsSync(join(target, 'settings.json'))).toBe(true);
    expect(existsSync(join(target, 'history.json'))).toBe(true);
    expect(existsSync(join(target, 'auth.json'))).toBe(true);
    expect(readFileSync(join(target, 'logs', 'main.log'), 'utf8')).toBe('hello');
    // The cache is disposable by design, and inheriting a corrupt one is a real failure.
    expect(existsSync(join(target, 'Local Storage'))).toBe(false);
    // The source is left alone in this branch: two folders already disagreed, and deleting
    // the one just read from is not worth the tidiness.
    expect(existsSync(legacy)).toBe(true);
  });

  it('never overwrites a file the new folder already has', () => {
    seedLegacy();
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'settings.json'), '{"language":"en"}');

    migrate(legacy, target);

    expect(readFileSync(join(target, 'settings.json'), 'utf8')).toBe('{"language":"en"}');
  });

  it('does nothing at all when there is no old folder', () => {
    migrate(legacy, target);
    expect(existsSync(target)).toBe(false);
  });

  it('does nothing when both names resolve to the same folder', () => {
    seedLegacy();
    migrate(legacy, legacy);
    expect(existsSync(join(legacy, 'settings.json'))).toBe(true);
  });
});
