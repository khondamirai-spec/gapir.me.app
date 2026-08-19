import { EventEmitter } from 'node:events';
import { uIOhook, UiohookKey } from 'uiohook-napi';

/**
 * Global push-to-talk hotkey: hold Ctrl+Shift to record, release to transcribe.
 *
 * Electron's `globalShortcut` can't drive this. It only fires on press, never on release,
 * so there is no way to detect the "let go" that ends a dictation. We install a low-level
 * hook and track key state ourselves.
 *
 * The trigger used to be Ctrl+CapsLock, and this file used to *send* a CapsLock tap as well
 * as read one: CapsLock toggles on key down, uiohook can observe input but not suppress it,
 * so every dictation flipped the user's caps state and we un-flipped it with a synthetic
 * press afterwards. Ctrl+Shift has no such side effect, which is why none of that machinery
 * survives here — Shift is a pure modifier, and holding it toggles nothing.
 *
 * What Ctrl+Shift *is*, though, is the prefix of half the shortcuts in Windows —
 * Ctrl+Shift+V, Ctrl+Shift+T, Ctrl+Shift+Esc. Holding the combo down while reaching for the
 * third key looks exactly like the start of a dictation, so the moment ANY other key goes
 * down mid-gesture, the gesture is cancelled: the user is typing a shortcut, not speaking.
 * The sub-`minRecordingMs` guard in state.ts then discards whatever half-second of audio the
 * false start captured, so a shortcut never pastes anything.
 */

/** Modifier that must be held. */
const CTRL = new Set<number>([UiohookKey.Ctrl, UiohookKey.CtrlRight]);
/** The key that, together with the modifier, starts dictation. */
const TRIGGER = new Set<number>([UiohookKey.Shift, UiohookKey.ShiftRight]);

export interface HotkeyEvents {
  on(event: 'start', cb: () => void): this;
  on(event: 'stop', cb: () => void): this;
  on(event: 'cancel', cb: () => void): this;
}

class Hotkey extends EventEmitter implements HotkeyEvents {
  private ctrlDown = false;
  private triggerDown = false;
  /** True between emitting 'start' and 'stop' — guards against key auto-repeat. */
  private active = false;
  private started = false;

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

      if (CTRL.has(e.keycode)) this.ctrlDown = true;
      else if (TRIGGER.has(e.keycode)) this.triggerDown = true;
      else {
        // A third key while Ctrl+Shift is held means this is a keyboard shortcut, not a
        // dictation — Ctrl+Shift+V must paste-without-formatting, not paste a transcript.
        if (this.active) this.endGesture('cancel');
        return;
      }

      // Modifiers auto-repeat while held, so keydown fires many times for one physical
      // press; `active` makes this idempotent.
      if (this.ctrlDown && this.triggerDown && !this.active) {
        this.active = true;
        this.emit('start');
      }
    });

    uIOhook.on('keyup', (e) => {
      const isCtrl = CTRL.has(e.keycode);
      const isTrigger = TRIGGER.has(e.keycode);
      if (!isCtrl && !isTrigger) return;

      if (isCtrl) this.ctrlDown = false;
      if (isTrigger) this.triggerDown = false;

      // Releasing either half of the combo ends the dictation.
      if (this.active) this.endGesture('stop');
    });

    uIOhook.start();
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
   */
  resetModifierState(): void {
    this.ctrlDown = false;
    this.triggerDown = false;
    this.active = false;
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
