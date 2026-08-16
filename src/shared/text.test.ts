import { describe, expect, it } from 'vitest';
import { countWords, wordsPerMinute } from './text';

/*
 * Word counting is the one number this app shows in two places at once — the console log a
 * dictation writes, and the Statistika pane — so it is tested here, next to the single
 * implementation both of them import.
 */

describe('countWords', () => {
  it('counts plain words', () => {
    expect(countWords('salom dunyo')).toBe(2);
  });

  it('ignores surrounding and repeated whitespace', () => {
    expect(countWords('  salom   dunyo \n')).toBe(2);
  });

  it('is empty for a string with no letters', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ... !? ')).toBe(0);
  });

  it('does not split an Uzbek word at its apostrophe, in any of the five spellings', () => {
    for (const apostrophe of ["'", '’', '‘', 'ʻ', 'ʼ']) {
      expect(countWords(`to${apostrophe}rt so${apostrophe}z`)).toBe(2);
    }
  });

  it('counts non-Latin words, since speakers mix Russian in', () => {
    expect(countWords('salom привет hello')).toBe(3);
  });

  it('treats punctuation between words as a separator, not a word', () => {
    expect(countWords('salom, dunyo — bugun!')).toBe(3);
  });
});

describe('wordsPerMinute', () => {
  it('is measured over the audio, not the request', () => {
    // Four words in 30 seconds is eight a minute.
    expect(wordsPerMinute('bir ikki uch to‘rt', 30_000)).toBe(8);
  });

  it('is zero rather than Infinity when the duration is unknown', () => {
    expect(wordsPerMinute('salom', 0)).toBe(0);
    expect(wordsPerMinute('salom', -1)).toBe(0);
  });
});
