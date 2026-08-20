import { describe, it, expect } from 'vitest';
import {
  chordEquals,
  chordProblem,
  DEFAULT_HOTKEYS,
  formatChord,
  isBindable,
  keyNameFromCode,
  pushToTalkWarning,
  sanitizeChord,
  sanitizeHotkeys,
  sortChord
} from './hotkeys';

/**
 * The chord vocabulary is the contract between three processes that never see each other's
 * key events — a renderer recording from DOM codes, main matching uiohook keycodes, and a
 * settings file in between. These tests are about that contract holding, and about the two
 * things a malformed chord could cost: a shortcut that fires while somebody types, and a
 * settings file that reaches an innerHTML.
 */

describe('keyNameFromCode', () => {
  it('folds left and right modifiers into one name', () => {
    expect(keyNameFromCode('ControlLeft')).toBe('Ctrl');
    expect(keyNameFromCode('ControlRight')).toBe('Ctrl');
    expect(keyNameFromCode('ShiftRight')).toBe('Shift');
    expect(keyNameFromCode('AltLeft')).toBe('Alt');
  });

  it('calls the Windows key Win, whichever name the platform gives it', () => {
    expect(keyNameFromCode('MetaLeft')).toBe('Win');
    expect(keyNameFromCode('OSRight')).toBe('Win');
  });

  it('reads the physical key, not the character it produces', () => {
    // `code` is why a Russian layout still binds the same physical key.
    expect(keyNameFromCode('KeyA')).toBe('A');
    expect(keyNameFromCode('Digit7')).toBe('7');
    expect(keyNameFromCode('F9')).toBe('F9');
  });

  it('refuses the keys whose ordinary job must survive', () => {
    for (const code of ['Escape', 'Enter', 'Tab', 'Backspace', 'Delete']) {
      expect(keyNameFromCode(code)).toBe('');
    }
  });

  it('returns empty for anything it does not know', () => {
    expect(keyNameFromCode('MediaPlayPause')).toBe('');
    expect(keyNameFromCode('')).toBe('');
  });
});

describe('sortChord', () => {
  it('puts modifiers first, in one fixed order, whatever order they were pressed', () => {
    expect(sortChord(['Shift', 'Ctrl'])).toEqual(['Ctrl', 'Shift']);
    expect(sortChord(['Space', 'Win', 'Ctrl'])).toEqual(['Ctrl', 'Win', 'Space']);
  });

  it('drops duplicates, so a repeated keydown cannot lengthen a chord', () => {
    expect(sortChord(['Ctrl', 'Ctrl', 'Shift'])).toEqual(['Ctrl', 'Shift']);
  });

  it('makes two orders of the same chord compare equal', () => {
    expect(chordEquals(sortChord(['Shift', 'Ctrl']), sortChord(['Ctrl', 'Shift']))).toBe(true);
  });
});

describe('chordProblem', () => {
  it('accepts the shapes a global shortcut can safely have', () => {
    expect(chordProblem(['Ctrl', 'Shift'])).toBe('');
    expect(chordProblem(['Ctrl', 'Win', 'Space'])).toBe('');
  });

  it('rejects a chord with no modifier — it would fire inside every text box', () => {
    expect(chordProblem(['A'])).not.toBe('');
    expect(chordProblem(['Space'])).not.toBe('');
  });

  it('rejects a lone modifier: one key held is not a chord', () => {
    expect(chordProblem(['Ctrl'])).not.toBe('');
  });

  it('rejects more than one ordinary key, which cannot be pressed as a chord', () => {
    expect(chordProblem(['Ctrl', 'A', 'B'])).not.toBe('');
  });

  it('rejects an empty chord and one longer than a hand', () => {
    expect(chordProblem([])).not.toBe('');
    expect(chordProblem(['Ctrl', 'Shift', 'Alt', 'Win', 'Space'])).not.toBe('');
  });
});

describe('pushToTalkWarning', () => {
  it('says nothing about a chord of pure modifiers', () => {
    expect(pushToTalkWarning(['Ctrl', 'Shift'])).toBe('');
  });

  it('warns when a held chord would type its own key', () => {
    expect(pushToTalkWarning(['Ctrl', 'Space'])).not.toBe('');
  });
});

describe('sanitizeChord', () => {
  it('keeps a good chord as it is', () => {
    expect(sanitizeChord(['Ctrl', 'Shift'], ['Alt'])).toEqual(['Ctrl', 'Shift']);
  });

  it('reorders on the way in, so a hand-edited file still compares equal', () => {
    expect(sanitizeChord(['Shift', 'Ctrl'], [])).toEqual(['Ctrl', 'Shift']);
  });

  it('translates the name an older build used for the Windows key', () => {
    expect(sanitizeChord(['Ctrl', 'Meta'], [])).toEqual(['Ctrl', 'Win']);
  });

  it('drops names outside the table — this is what keeps capsHtml safe', () => {
    expect(isBindable('<img src=x onerror=alert(1)>')).toBe(false);
    expect(sanitizeChord(['Ctrl', 'Shift', '<img src=x onerror=alert(1)>'], [])).toEqual([
      'Ctrl',
      'Shift'
    ]);
  });

  it('falls back when what is left is not a usable chord', () => {
    expect(sanitizeChord(['A'], ['Ctrl', 'Shift'])).toEqual(['Ctrl', 'Shift']);
    expect(sanitizeChord('Ctrl+Shift', ['Ctrl', 'Shift'])).toEqual(['Ctrl', 'Shift']);
  });

  it('keeps an empty chord empty — that is how hands-free is turned off', () => {
    expect(sanitizeChord([], ['Ctrl', 'Shift'])).toEqual([]);
  });
});

describe('sanitizeHotkeys', () => {
  it('never leaves push-to-talk empty, which would leave no way to dictate', () => {
    expect(sanitizeHotkeys({ pushToTalk: [], handsFree: [] }).pushToTalk).toEqual(
      DEFAULT_HOTKEYS.pushToTalk
    );
    expect(sanitizeHotkeys(undefined).pushToTalk).toEqual(DEFAULT_HOTKEYS.pushToTalk);
  });

  it('does leave hands-free empty, because off is a real answer', () => {
    expect(sanitizeHotkeys({ pushToTalk: ['Ctrl', 'Alt'], handsFree: [] }).handsFree).toEqual([]);
  });
});

describe('formatChord', () => {
  it('writes the keys the way they are written on a keyboard', () => {
    expect(formatChord(['Ctrl', 'Shift'])).toBe('Ctrl + Shift');
    expect(formatChord(['Ctrl', 'Win', 'Space'])).toBe('Ctrl + Win + Space');
    expect(formatChord(['Ctrl', 'Comma'])).toBe('Ctrl + ,');
  });
});
