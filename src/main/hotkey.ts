import { EventEmitter } from 'node:events';
import { uIOhook, UiohookKey } from 'uiohook-napi';
import { DEFAULT_HOTKEYS, type Chord, type HotkeySettings } from '@shared/hotkeys';

/**
 * The global dictation shortcuts: hold one chord to talk, press another to toggle.
 *
 * Electron's `globalShortcut` can't drive this. It only fires on press, never on release,
 * so there is no way to detect the "let go" that ends a dictation. We install a low-level
 * hook and track key state ourselves.
 *
 * The chords are settings now (see `Settings.hotkeys`), and this file is written around
 * that: nothing below names Ctrl or Shift, it matches whatever the user chose. The default
 * is still Ctrl+Shift, and the trigger before that was Ctrl+CapsLock — this file used to
 * *send* a CapsLock tap as well as read one, because CapsLock toggles on key down and
 * uiohook can observe input but not suppress it, so every dictation flipped the user's caps
 * state and we un-flipped it afterwards. None of that machinery survives: a chord of pure
 * modifiers toggles nothing, which is why `chordProblem` in src/shared/hotkeys.ts pushes
 * people toward one.
 *
 * What a modifier chord *is*, though, is the prefix of half the shortcuts in Windows —
 * Ctrl+Shift+V, Ctrl+Shift+T, Ctrl+Shift+Esc. Holding the combo down while reaching for the
 * third key looks exactly like the start of a dictation, so the moment any key outside the
 * gesture goes down, the gesture is cancelled: the user is typing a shortcut, not speaking.
 * The sub-`minRecordingMs` guard in state.ts then discards whatever half-second of audio the
 * false start captured, so a shortcut never pastes anything.
 */

/**
 * Canonical key name -> the keycodes that produce it.
 *
 * Left and right modifiers are the same key as far as a shortcut is concerned; nobody who
 * chose Ctrl+Shift meant the left-hand pair specifically. Keys we refuse to bind are absent
 * rather than mapped, so an unknown name simply never matches.
 */
const KEYCODES = new Map<string, number[]>([
  ['Ctrl', [UiohookKey.Ctrl, UiohookKey.CtrlRight]],
  ['Shift', [UiohookKey.Shift, UiohookKey.ShiftRight]],
  ['Alt', [UiohookKey.Alt, UiohookKey.AltRight]],
  ['Win', [UiohookKey.Meta, UiohookKey.MetaRight]],
  ['Space', [UiohookKey.Space]],
  ['CapsLock', [UiohookKey.CapsLock]],
  ['Backquote', [UiohookKey.Backquote]],
  ['Minus', [UiohookKey.Minus]],
  ['Equal', [UiohookKey.Equal]],
  ['BracketLeft', [UiohookKey.BracketLeft]],
  ['BracketRight', [UiohookKey.BracketRight]],
  ['Backslash', [UiohookKey.Backslash]],
  ['Semicolon', [UiohookKey.Semicolon]],
  ['Quote', [UiohookKey.Quote]],
  ['Comma', [UiohookKey.Comma]],
  ['Period', [UiohookKey.Period]],
  ['Slash', [UiohookKey.Slash]]
]);

for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
  KEYCODES.set(letter, [UiohookKey[letter as 'A']]);
}
for (let digit = 0; digit <= 9; digit++) {
  KEYCODES.set(String(digit), [UiohookKey[String(digit) as '0']]);
}
for (let n = 1; n <= 24; n++) {
  const code = UiohookKey[`F${n}` as 'F1'];
  if (typeof code === 'number') KEYCODES.set(`F${n}`, [code]);
}

/** keycode -> canonical name, built once from the map above. */
const NAMES = new Map<number, string>();
for (const [name, codes] of KEYCODES) {
  for (const code of codes) NAMES.set(code, name);
}

/** The canonical name of a physical key, or '' for one no chord can contain. */
export function keyNameFromKeycode(keycode: number): string {
  return NAMES.get(keycode) ?? '';
}

export interface HotkeyEvents {
  on(event: 'start', cb: () => void): this;
  on(event: 'stop', cb: () => void): this;
  on(event: 'cancel', cb: () => void): this;
  on(event: 'toggle', cb: () => void): this;
  /** Which keys of the currently watched chord are down. See `watch()`. */
  on(event: 'keys', cb: (keys: string[]) => void): this;
}

class Hotkey extends EventEmitter implements HotkeyEvents {
  private chords: HotkeySettings = DEFAULT_HOTKEYS;
  /** Canonical names currently held, restricted to keys that appear in some chord. */
  private held = new Set<string>();
  /** True between emitting 'start' and 'stop' — guards against key auto-repeat. */
  private active = false;
  private started = false;
  /**
   * The hands-free chord has to be *completed* to fire, and must not fire again while it is
   * still held down — a chord of modifiers auto-repeats for as long as a finger is on it.
   */
  private handsFreeLatched = false;
  /** The chord whose key state is being reported to a renderer, if any. See `watch()`. */
  private watched: Chord = [];

  /**
   * Replace the chords. Safe at any time: settings can change mid-session, and a chord that
   * is swapped out while it is held would otherwise leave `held` describing a keyboard that
   * no longer exists.
   */
  setChords(chords: HotkeySettings): void {
    this.chords = chords;
    this.resetModifierState();
    // Unlike a mid-dictation reset, this really is a fresh start: the latch below describes
    // a chord that may no longer exist.
    this.handsFreeLatched = false;
  }

  /**
   * Report which of `chord`'s keys are down, to whoever asked.
   *
   * This exists for the "press the keys — do they light up?" step in the welcome flow, and
   * the restriction to one chord is the whole design: a channel that forwarded every
   * keystroke to a renderer would be a keylogger, and it would be one for the entire
   * session rather than for the ten seconds a user is looking at the test. Pass an empty
   * chord to stop.
   */
  watch(chord: Chord): void {
    this.watched = chord;
    this.emitKeys();
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    uIOhook.on('keydown', (e) => {
      // Esc aborts the dictation without pasting anything — and that has to keep working
      // after the keys are released, while the transcript is still in flight. `active`
      // tracks the physical gesture, not the dictation, so it goes false the instant the
      // user lets go; testing it here (as this once did) made Esc silently do nothing for
      // the whole TRANSCRIBING state, which is precisely when someone realises they
      // misspoke. The state machine ignores a cancel it has no use for.
      if (e.keycode === UiohookKey.Escape) {
        if (this.active) this.endGesture('cancel');
        else this.emit('cancel');
        return;
      }

      const name = keyNameFromKeycode(e.keycode);
      const known = name !== '' && this.inSomeChord(name);
      if (!known) {
        // A key outside every chord, pressed mid-gesture, means this is a keyboard shortcut
        // rather than a dictation — Ctrl+Shift+V must paste-without-formatting, not paste a
        // transcript.
        if (this.active) this.endGesture('cancel');
        return;
      }

      this.held.add(name);
      this.emitKeys();

      // Hands-free first: it is the longer chord when the two overlap (Ctrl+Shift and
      // Ctrl+Shift+Space), and the key that completes it would otherwise read as the third
      // key that cancels a push-to-talk gesture.
      if (this.isHeld(this.chords.handsFree)) {
        if (!this.handsFreeLatched) {
          this.handsFreeLatched = true;
          // If a push-to-talk gesture was already running, the extra key ends it rather than
          // layering a second dictation on top — the state machine only has one.
          if (this.active) this.endGesture('cancel');
          this.emit('toggle');
        }
        return;
      }

      if (this.active) {
        // Still inside the gesture: a key that belongs to *another* chord is not part of
        // this one, so it cancels for the same reason any other stray key does.
        if (!this.chords.pushToTalk.includes(name)) this.endGesture('cancel');
        return;
      }

      // The hands-free chord is still down, and one chord can be the *prefix* of the other:
      // Ctrl+Shift is part of Ctrl+Shift+Space. Every key auto-repeats while held, so a
      // moment after the toggle fires, the repeats re-satisfy the shorter chord and would
      // start a push-to-talk gesture inside the hands-free dictation the user just began.
      // The latch is released by the keyup, which is the honest signal that the hand moved.
      if (this.handsFreeLatched) return;

      // Modifiers auto-repeat while held, so keydown fires many times for one physical
      // press; `active` makes this idempotent.
      if (this.isHeld(this.chords.pushToTalk)) {
        this.active = true;
        this.emit('start');
      }
    });

    uIOhook.on('keyup', (e) => {
      const name = keyNameFromKeycode(e.keycode);
      if (!name) return;

      // Releasing any part of the hands-free chord arms it for the next press — and this is
      // tested *before* the "did we think it was down" guard below, deliberately. A
      // dictation started by that chord ends in `reset()`, which calls
      // `resetModifierState()` and empties our copy of the keyboard while the user's fingers
      // are still on the keys. Gating the re-arm on that copy would leave the latch stuck
      // closed, and the hands-free hotkey would work exactly once per session.
      if (this.chords.handsFree.includes(name)) this.handsFreeLatched = false;

      if (!this.held.delete(name)) return;
      this.emitKeys();

      // Releasing any part of the push-to-talk chord ends the dictation.
      if (this.active && this.chords.pushToTalk.includes(name)) this.endGesture('stop');
    });

    uIOhook.start();
  }

  /** Is every key of `chord` down? An empty chord is off, never "trivially satisfied". */
  private isHeld(chord: Chord): boolean {
    return chord.length > 0 && chord.every((key) => this.held.has(key));
  }

  private inSomeChord(name: string): boolean {
    return this.chords.pushToTalk.includes(name) || this.chords.handsFree.includes(name);
  }

  private emitKeys(): void {
    if (!this.watched.length) return;
    this.emit(
      'keys',
      this.watched.filter((key) => this.held.has(key))
    );
  }

  /** End the current gesture. */
  private endGesture(event: 'stop' | 'cancel'): void {
    this.active = false;
    this.emit(event);
  }

  /**
   * Clear cached key state.
   *
   * Anything that steals input mid-gesture — alt-tab, a UAC prompt, the lock screen —
   * can swallow a keyup and leave us believing a key is still held. Called on every
   * return to IDLE so a missed keyup can't wedge the hotkey permanently.
   *
   * `handsFreeLatched` is deliberately NOT cleared here. It records that a chord is still
   * physically down, and this method runs *while it still is* — the dictation it started
   * ends at the state machine's convenience, not the hand's. Clearing it would re-arm the
   * chord under fingers that never moved, and the next auto-repeat would toggle the
   * dictation straight back off. Only a keyup clears it; only `setChords` overrides that.
   */
  resetModifierState(): void {
    this.held.clear();
    this.active = false;
    this.emitKeys();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    try {
      uIOhook.stop();
    } catch {
      // Hook already torn down during shutdown — nothing to do.
    }
  }
}

export const hotkey = new Hotkey();

/** Exported for tests — the chord table is the part worth pinning down. */
export const _internals = { KEYCODES, NAMES };
