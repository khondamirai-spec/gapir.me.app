import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

/*
 * resources/gemini-keys.json is hidden from these tests on purpose.
 *
 * That file holds the real keys the app ships with, and on a maintainer's machine it is
 * populated — which made the pool below "three test keys plus whatever this developer
 * happens to have", so `nextBundledKey` wrapped somewhere the assertions didn't expect and
 * the whole suite went red on a clean checkout of working code. A unit test for the cooldown
 * bookkeeping must not depend on a gitignored file, so the pool here is exactly what
 * WHISPER_UZ_BUNDLED_KEYS says it is.
 */
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: () => false
}));

import {
  bundledKeys,
  parseKeyList,
  msUntilQuotaReset,
  markKeyExhausted,
  nextBundledKey,
  pickBundledKey,
  _internals
} from './keys';

/**
 * The pool of keys that ships with the app. Only the pure parts are tested here — reading
 * resources/gemini-keys.json needs a packaged app, and the cooldown bookkeeping is the part
 * that decides whether a spent key costs the user their dictation.
 */

describe('parseKeyList', () => {
  it('splits on commas', () => {
    expect(parseKeyList('AIza-one,AIza-two')).toEqual(['AIza-one', 'AIza-two']);
  });

  it('splits on whitespace and newlines too', () => {
    // A key list pasted out of a spreadsheet arrives with either; a stray newline turning
    // the whole list into one unusable "key" would only show up as a 400 mid-dictation.
    expect(parseKeyList('AIza-one\nAIza-two  AIza-three')).toEqual([
      'AIza-one',
      'AIza-two',
      'AIza-three'
    ]);
  });

  it('is empty for an empty string', () => {
    expect(parseKeyList('')).toEqual([]);
    expect(parseKeyList('   ,  ,  ')).toEqual([]);
  });
});

describe('looksLikeKey', () => {
  const { looksLikeKey } = _internals;

  it('accepts a real-looking key whatever its format', () => {
    // Not an AIza check on purpose: Google's key format is theirs to change, and rejecting
    // a real key would be a far worse failure than accepting a fake one.
    expect(looksLikeKey('AIzaSyD-KeyMaterialGoesHere1234567890abc')).toBe(true);
    expect(looksLikeKey('some-future-format-abcdefghijklmnop')).toBe(true);
  });

  it('accepts a key that merely happens to contain a placeholder word', () => {
    // Keys are random, so across enough of them one eventually contains "example" or "xxxx"
    // by luck. Matching those as substrings would silently drop a working key — the worse
    // of the two failures, and the bug the first version of this rule actually had.
    expect(looksLikeKey('AIzaSyD-ExampleKeyMaterial1234567890')).toBe(true);
    expect(looksLikeKey('AIzaSyDxxxxKeyMaterial1234567890')).toBe(true);
  });

  it('trims a key that arrived with a trailing space', () => {
    expect(looksLikeKey('  AIzaSyD-KeyMaterial1234567890  ')).toBe(true);
  });

  it('rejects the placeholders a hand-edited file collects', () => {
    // A placeholder announces itself at the front; that is what the rule keys on.
    expect(looksLikeKey('PASTE_YOUR_KEY_HERE')).toBe(false);
    expect(looksLikeKey('<your key>')).toBe(false);
    expect(looksLikeKey('your-key-here')).toBe(false);
    expect(looksLikeKey('EXAMPLE_KEY_1234567890')).toBe(false);
    expect(looksLikeKey('xxxxxxxxxxxxxxxx')).toBe(false);
  });

  it('rejects anything with whitespace inside it or too short to be a credential', () => {
    expect(looksLikeKey('AIzaSyD KeyMaterial')).toBe(false);
    expect(looksLikeKey('')).toBe(false);
    expect(looksLikeKey('   ')).toBe(false);
    expect(looksLikeKey('abc')).toBe(false);
    expect(looksLikeKey(42)).toBe(false);
    expect(looksLikeKey(null)).toBe(false);
  });
});

describe('msUntilQuotaReset', () => {
  /*
   * Every instant here is written in UTC on purpose. Google resets requests-per-day at
   * midnight America/Los_Angeles, so the answer depends on the wall clock in California and
   * on nothing about the machine running the test — which is the whole point of the
   * function, and a test built from `new Date(2026, 7, 15, ...)` would instead assert
   * whatever the runner's own timezone happens to be.
   */
  it('counts to the next midnight in Los Angeles, not the local one', () => {
    // 01:30 PDT on 15 Aug — 22.5 hours short of the next reset.
    expect(msUntilQuotaReset(new Date('2026-08-15T08:30:00Z'))).toBe(81_000_000);
  });

  it('is about to roll over one minute before the reset', () => {
    // 23:59 PDT on 14 Aug.
    expect(msUntilQuotaReset(new Date('2026-08-15T06:59:00Z'))).toBe(60_000);
  });

  it('follows Pacific daylight saving rather than a fixed offset', () => {
    // 01:00 PST on 15 Jan: winter puts Los Angeles on UTC-8, an hour further from UTC than
    // the August cases above. A hardcoded offset would be an hour wrong here.
    expect(msUntilQuotaReset(new Date('2026-01-15T09:00:00Z'))).toBe(82_800_000);
  });

  it('gives a full day exactly at the reset', () => {
    expect(msUntilQuotaReset(new Date('2026-08-15T07:00:00Z'))).toBe(86_400_000);
  });
});

describe('key cooldowns', () => {
  // The pool is read once and memoised, so it is populated before anything asks for it.
  beforeAll(() => {
    process.env.WHISPER_UZ_BUNDLED_KEYS = 'key-a,key-b,key-c';
    expect(bundledKeys()).toEqual(['key-a', 'key-b', 'key-c']);
  });

  afterAll(() => {
    delete process.env.WHISPER_UZ_BUNDLED_KEYS;
  });

  beforeEach(() => _internals.coolingUntil.clear());

  it('benches a spent key until tomorrow', () => {
    markKeyExhausted('key-a', 'daily');
    expect(_internals.isHealthy('key-a')).toBe(false);
    expect(_internals.isHealthy('key-b')).toBe(true);
  });

  it('lets a benched key back once its cooldown has passed', () => {
    _internals.coolingUntil.set('key-a', Date.now() - 1);
    expect(_internals.isHealthy('key-a')).toBe(true);
  });

  it('skips a spent key when picking one to dictate with', () => {
    markKeyExhausted('key-a', 'daily');
    expect(pickBundledKey()).toBe('key-b');
  });

  it('never hands back the key that just failed', () => {
    expect(nextBundledKey('key-a')).toBe('key-b');
    markKeyExhausted('key-b', 'daily');
    expect(nextBundledKey('key-a')).toBe('key-c');
  });

  it('returns nothing when every other key is also spent', () => {
    markKeyExhausted('key-b', 'daily');
    markKeyExhausted('key-c', 'daily');
    expect(nextBundledKey('key-a')).toBe('');
  });

  it('still hands back a key when the whole pool is cooling down', () => {
    // Our cooldowns are a guess; Google's allowances are the authority. Refusing to try
    // would replace a real quota message with one we invented.
    for (const key of ['key-a', 'key-b', 'key-c']) markKeyExhausted(key, 'daily');
    expect(pickBundledKey()).toBe('key-a');
  });

  it('reaches for the soonest-expiring key when the whole pool is cooling down', () => {
    // A key benched for 90 seconds by a burst limit is a far better bet than one benched
    // until tomorrow by a daily cap, and pool order alone would keep picking the latter.
    markKeyExhausted('key-a', 'daily');
    markKeyExhausted('key-b', 'burst');
    markKeyExhausted('key-c', 'daily');
    expect(pickBundledKey()).toBe('key-b');
  });

  it('prefers a healthy key over a cooling one that expires sooner', () => {
    // The soonest-expiry rule is the tiebreak for a spent pool, not a competitor to being
    // available now.
    markKeyExhausted('key-a', 'burst');
    expect(pickBundledKey()).toBe('key-b');
  });
});
