import { EventEmitter } from 'node:events';
import { uIOhook, UiohookKey } from 'uiohook-napi';
import { keyboard, Key } from '@nut-tree-fork/nut-js';

/**
 * Global push-to-talk hotkey: hold Ctrl+CapsLock to record, release to transcribe.
 *
 * Electron's `globalShortcut` can't drive this. It only fires on press, never on release,
 * so there is no way to detect the "let go" that ends a dictation. We install a low-level
 * hook and track key state ourselves.
 *
 * ── Why this file sends keystrokes as well as reading them ──────────────────────────
 * uiohook-napi observes input; it cannot suppress it. CapsLock toggles on key DOWN, so
 * the OS flips caps state the instant a dictation starts and there is no way to stop it.
 * Left alone, every dictation would leave the user typing in CAPS until they noticed and
 * fixed it by hand.
 *
 * So once the gesture ends we tap CapsLock once to undo the toggle the user's own press
 * caused. Two consequences worth knowing:
 *
 *   1. Our synthetic tap is visible to our own hook — injected input goes through the
 *      same low-level chain as real input. Without `restoringCaps` guarding it, that tap
 *      would look like a fresh trigger press and, with Ctrl still held, immediately start
 *      another recording. Hence the guard.
 *   2. The correction is a toggle, not a "set". It assumes exactly one toggle happened
 *      during the gesture, which holds because CapsLock does not auto-repeat.
 *
 * Set RESTORE_CAPS_LOCK to false to drop the correction and accept the flipped state.
 */

const RESTORE_CAPS_LOCK = true;
/** Long enough for the injected tap to drain out of the hook before we listen again. */
const RESTORE_GUARD_MS = 80;

/** Modifier that must be held. */
const CTRL = new Set<number>([UiohookKey.Ctrl, UiohookKey.CtrlRight]);
/** The key that, together with the modifier, starts dictation. */
const TRIGGER = new Set<number>([UiohookKey.CapsLock]);

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
  /** True while our own corrective CapsLock tap is in flight; see the note above. */
  private restoringCaps = false;

  start(): void {
    if (this.started) return;
    this.started = true;

    uIOhook.on('keydown', (e) => {
      // Esc aborts an in-flight recording without pasting anything.
      if (e.keycode === UiohookKey.Escape && this.active) {
        this.endGesture('cancel');
        return;
      }

      if (CTRL.has(e.keycode)) this.ctrlDown = true;
      else if (TRIGGER.has(e.keycode)) {
        // Ignore the CapsLock tap we injected ourselves.
        if (this.restoringCaps) return;
        this.triggerDown = true;
      } else return;

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
      if (isTrigger && this.restoringCaps) return;

      if (isCtrl) this.ctrlDown = false;
      if (isTrigger) this.triggerDown = false;

      // Releasing either half of the combo ends the dictation.
      if (this.active) this.endGesture('stop');
    });

    uIOhook.start();
  }

  /** End the current gesture and undo CapsLock's toggle. */
  private endGesture(event: 'stop' | 'cancel'): void {
    this.active = false;
    this.emit(event);
    void this.restoreCapsLock();
  }

  /**
   * Tap CapsLock once to cancel out the toggle caused by the user's own press.
   * Failures are logged, not thrown — a stuck caps state must never break dictation.
   */
  private async restoreCapsLock(): Promise<void> {
    if (!RESTORE_CAPS_LOCK) return;

    this.restoringCaps = true;
    try {
      await keyboard.pressKey(Key.CapsLock);
      await keyboard.releaseKey(Key.CapsLock);
    } catch (err) {
      console.warn('[hotkey] could not restore CapsLock state:', err);
    } finally {
      setTimeout(() => {
        this.restoringCaps = false;
      }, RESTORE_GUARD_MS);
    }
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
