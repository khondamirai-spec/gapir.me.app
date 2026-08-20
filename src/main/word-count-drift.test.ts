import { describe, expect, it } from 'vitest';
import { countWords as clientCount, WORD_CHARS as clientChars } from '@shared/text';
import {
  countWords as serverCount,
  WORD_CHARS as serverChars
} from '../../supabase/functions/_shared/text';

/**
 * The two copies of the word counter must not drift.
 *
 * A word stopped being a display detail when the quota became words per week: the Edge
 * Function's copy decides what a dictation *costs*, and the app's copy decides what the
 * Hisob pane says is left. A rule changed in one file and not the other does not produce a
 * wrong number somewhere harmless — it produces a pane reading "940 / 1000 so'z" next to a
 * server that has already refused the next dictation, which is the worst kind of bug this
 * app can have because the user is looking at evidence that we are wrong.
 *
 * Same arrangement, and same justification, as prompt-drift.test.ts: the copy is deliberate
 * (two runtimes, and bridging them costs more machinery than it saves) and this test is what
 * makes it honest. It is also the only thing typechecking that file, since `supabase/` is
 * outside tsconfig's `include`.
 *
 * The cases below are chosen to be the ones a re-implementation gets wrong, not the ones it
 * gets right: five apostrophes that all turn up in real Uzbek text, scripts outside ASCII,
 * digits, and the punctuation that separates words rather than joining them.
 */

const CASES: string[] = [
  '',
  '   ',
  'salom',
  'salom dunyo',
  '  bir   ikki  uch  ',
  // All five apostrophes, which is the whole reason WORD_CHARS exists. Each of these is one
  // word, and a counter that knows only the ASCII one says two for four of them.
  "to'rt",
  'to’rt',
  'to‘rt',
  'toʻrt',
  'toʼrt',
  "o'zbekiston respublikasi",
  // A hyphen joins; a dash between spaces does not.
  'ora-sira',
  'bir - ikki',
  // Cyrillic, and a mixed sentence — \w would miscount both.
  'Привет мир',
  'Salom, привет, hello',
  // Digits count as word characters: "2026 yil" is two words, the way a person reads it.
  '2026 yil',
  '3.14 va 1,5',
  // Punctuation that ends a sentence rather than joining one.
  'Salom! Qalaysiz? Yaxshi.',
  'nuqta.vergul,ikki:nuqta',
  // Newlines and tabs, which is what a multi-sentence dictation actually looks like.
  'birinchi qator\nikkinchi qator',
  '\tbir\t\tikki\n',
  // The sentinel for a silent clip never reaches a counter, but an empty transcript does.
  '\n\n',
  // Emoji and symbols are not letters and must not become words of their own.
  'salom 👋 dunyo',
  '— salom —',
  '(qavs) [kvadrat] {figurali}',
  // A long, ordinary paragraph: the case the quota is actually made of.
  'Bugun ertalab ishga bordim va yangi loyiha haqida gaplashdik. ' +
    'Hammasi yaxshi o‘tdi, ertaga davom ettiramiz.'
];

describe('word-count parity between the app and the edge function', () => {
  it('uses the same word characters', () => {
    expect(serverChars).toBe(clientChars);
  });

  it('counts every case identically', () => {
    for (const text of CASES) {
      expect(serverCount(text), `word-count drift for ${JSON.stringify(text)}`).toBe(
        clientCount(text)
      );
    }
    expect(CASES.length).toBeGreaterThan(20);
  });

  /**
   * Not parity, but the property the quota rests on: a dictation cannot cost a negative
   * amount, and it cannot cost nothing when words were actually returned. A counter that
   * returned 0 for a real transcript would make the free tier unlimited.
   */
  it('charges nothing for silence and something for speech', () => {
    expect(serverCount('')).toBe(0);
    expect(serverCount('   \n\t ')).toBe(0);
    expect(serverCount('bitta')).toBe(1);
    expect(serverCount('bir ikki uch to‘rt besh')).toBe(5);
  });
});
