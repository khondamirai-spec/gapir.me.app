/**
 * What a dictation shortcut is, spelled the same way in every process.
 *
 * Three places need to agree about a chord and they cannot see each other's key events:
 * the renderer records one from DOM `KeyboardEvent.code`, main matches it against
 * uiohook-napi keycodes, and settings.json stores it between runs. So the chord itself is
 * a list of *canonical names* — 'Ctrl', 'Shift', 'Win', 'Space', 'A' — and each side owns
 * exactly one translation: this file turns DOM codes into names (both renderers can call
 * it), src/main/hotkey.ts turns names into keycodes.
 *
 * Keep this file dependency-free: it is imported by main and by two renderers.
 */

/** The four keys that may be *held*. Order is the order a chord is displayed in. */
export const MODIFIERS = ['Ctrl', 'Shift', 'Alt', 'Win'] as const;
export type Modifier = (typeof MODIFIERS)[number];

/**
 * A chord: modifiers, optionally finished by one ordinary key.
 *
 * Stored in the order the user must read it, not the order they pressed it — 'Shift+Ctrl'
 * and 'Ctrl+Shift' are the same shortcut, and a settings file that remembers which way
 * round someone's fingers landed would make two identical chords compare unequal.
 */
export type Chord = string[];

export interface HotkeySettings {
  /**
   * Hold to talk: the dictation runs for exactly as long as the keys are down.
   * Modifiers-only is the shape that works best here — a chord ending in a letter types
   * that letter into whatever has focus every time you dictate.
   */
  pushToTalk: Chord;
  /**
   * Press once to start, press again to stop. Empty means off — and off is the default,
   * because the overlay pill is already a click-to-start-and-stop control that costs no
   * key combination at all.
   */
  handsFree: Chord;
}

export const DEFAULT_HOTKEYS: HotkeySettings = {
  pushToTalk: ['Ctrl', 'Shift'],
  handsFree: []
};

/** Longest chord we accept. Four is already more than a hand wants to hold. */
export const MAX_CHORD_KEYS = 4;

/**
 * Keys that may never be part of a chord.
 *
 * Escape cancels a dictation in flight and must keep meaning that; the rest are keys whose
 * ordinary job is destructive or navigational enough that holding them for a second — which
 * is what a dictation *is* — would do something the user did not ask for.
 */
const RESERVED = new Set(['Escape', 'Enter', 'Tab', 'Backspace', 'Delete']);

/**
 * DOM `KeyboardEvent.code` → canonical name, or '' for a key we refuse to bind.
 *
 * `code` rather than `key`, deliberately: `key` is the *character produced*, which changes
 * with the keyboard layout and with which modifiers are already held — on a Russian layout
 * `key` for the physical A key is 'ф', and with Shift down it is 'Ф'. `code` is the physical
 * key, which is what a global hook can actually match later.
 */
export function keyNameFromCode(code: string): string {
  if (code === 'ControlLeft' || code === 'ControlRight') return 'Ctrl';
  if (code === 'ShiftLeft' || code === 'ShiftRight') return 'Shift';
  if (code === 'AltLeft' || code === 'AltRight') return 'Alt';
  if (code === 'MetaLeft' || code === 'MetaRight' || code === 'OSLeft' || code === 'OSRight')
    return 'Win';
  if (RESERVED.has(code)) return '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (code === 'Space' || code === 'CapsLock') return code;
  if (
    code === 'Backquote' ||
    code === 'Minus' ||
    code === 'Equal' ||
    code === 'BracketLeft' ||
    code === 'BracketRight' ||
    code === 'Backslash' ||
    code === 'Semicolon' ||
    code === 'Quote' ||
    code === 'Comma' ||
    code === 'Period' ||
    code === 'Slash'
  )
    return code;
  return '';
}

export function isModifier(name: string): boolean {
  return (MODIFIERS as readonly string[]).includes(name);
}

/**
 * Every name a chord may contain.
 *
 * A closed list, and it does real work beyond validation: `capsHtml` in the app window
 * writes key names into markup, and settings.json is a plain file anyone can hand-edit. An
 * allowlist is what makes "a chord read back from disk" safe to put in an innerHTML, and it
 * is why `sanitizeChord` filters against this rather than merely counting modifiers.
 */
export const BINDABLE_KEYS: readonly string[] = [
  ...MODIFIERS,
  'Space',
  'CapsLock',
  'Backquote',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Semicolon',
  'Quote',
  'Comma',
  'Period',
  'Slash',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  ...'0123456789'.split(''),
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`)
];

export function isBindable(name: string): boolean {
  return BINDABLE_KEYS.includes(name);
}

/** Modifiers first and always in the same order, then the ordinary key. See `Chord`. */
export function sortChord(keys: Iterable<string>): Chord {
  const unique = [...new Set(keys)];
  const mods = MODIFIERS.filter((m) => unique.includes(m)) as string[];
  const rest = unique.filter((k) => !isModifier(k)).sort();
  return [...mods, ...rest];
}

export function chordEquals(a: Chord, b: Chord): boolean {
  if (a.length !== b.length) return false;
  return a.every((key, i) => key === b[i]);
}

/**
 * Is this something we are willing to listen for globally?
 *
 * A chord this app watches is a chord it watches in *every* application, and it cannot
 * suppress the keys on the way past — so the rules are about not stealing something that
 * already means something. One key alone would fire while someone typed; more than one
 * ordinary key cannot be pressed as a chord reliably; and with no modifier at all the
 * shortcut would trigger inside every text box on the machine.
 */
export function chordProblem(chord: Chord): string {
  if (chord.length === 0) return 'Tugma tanlanmagan';
  if (chord.length > MAX_CHORD_KEYS) return `Ko‘pi bilan ${MAX_CHORD_KEYS} ta tugma`;
  const plain = chord.filter((key) => !isModifier(key));
  if (plain.length > 1) return 'Faqat bitta oddiy tugma bo‘lishi mumkin';
  if (chord.length - plain.length === 0) return 'Kamida bitta boshqaruv tugmasi kerak (Ctrl, Shift, Alt, Win)';
  if (chord.length < 2) return 'Kamida ikkita tugma kerak';
  return '';
}

/**
 * The extra rule for push-to-talk: it is *held*, so an ordinary key in it is typed —
 * repeatedly, into whatever the user is dictating into. Allowed, because someone may have
 * a keyboard where it is the only comfortable option, but they are told first.
 */
export function pushToTalkWarning(chord: Chord): string {
  return chord.some((key) => !isModifier(key))
    ? 'Bu tugma bosib turilganda yozilib qolishi mumkin — faqat Ctrl/Shift/Alt/Win tavsiya etiladi'
    : '';
}

/** How a key is written on a cap. Only 'Win' differs from its canonical name. */
export function keyLabel(name: string): string {
  if (name === 'Win') return 'Win';
  if (name === 'Space') return 'Space';
  if (name === 'CapsLock') return 'Caps';
  if (name === 'Backquote') return '`';
  if (name === 'Minus') return '-';
  if (name === 'Equal') return '=';
  if (name === 'BracketLeft') return '[';
  if (name === 'BracketRight') return ']';
  if (name === 'Backslash') return '\\';
  if (name === 'Semicolon') return ';';
  if (name === 'Quote') return "'";
  if (name === 'Comma') return ',';
  if (name === 'Period') return '.';
  if (name === 'Slash') return '/';
  return name;
}

export function formatChord(chord: Chord): string {
  return chord.map(keyLabel).join(' + ');
}

/** Read a chord back out of settings, dropping anything a hand-edit or an older build left. */
export function sanitizeChord(raw: unknown, fallback: Chord): Chord {
  if (!Array.isArray(raw)) return [...fallback];
  const keys = raw
    .filter((key): key is string => typeof key === 'string')
    // 'Meta' is what an older build (and every DOM event) calls the Windows key.
    .map((key) => (key === 'Meta' ? 'Win' : key))
    .filter(isBindable);
  const chord = sortChord(keys);
  if (chord.length === 0) return [];
  return chordProblem(chord) ? [...fallback] : chord;
}

export function sanitizeHotkeys(raw: unknown): HotkeySettings {
  const value = (raw ?? {}) as Partial<Record<keyof HotkeySettings, unknown>>;
  const pushToTalk = sanitizeChord(value.pushToTalk, DEFAULT_HOTKEYS.pushToTalk);
  return {
    // Push-to-talk is the one shortcut the app cannot work without: an empty one would
    // leave a user with no way to dictate and no obvious way back.
    pushToTalk: pushToTalk.length ? pushToTalk : [...DEFAULT_HOTKEYS.pushToTalk],
    handsFree: sanitizeChord(value.handsFree, DEFAULT_HOTKEYS.handsFree)
  };
}
