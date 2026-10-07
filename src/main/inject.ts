import { clipboard, nativeImage } from 'electron';
import { keyboard, Key } from '@nut-tree-fork/nut-js';

/**
 * Paste transcribed text into whatever field currently has focus.
 *
 * Clipboard + synthetic Ctrl+V (⌘V on a Mac) is the only approach that works reliably across every
 * target app. Typing the text character-by-character is far too slow for a paragraph and
 * breaks in editors with autocomplete; the Win32 SendInput unicode path has the same
 * problem. So: save the clipboard, borrow it, paste, hand it back.
 *
 * Two rules this module exists to enforce:
 *   1. NEVER focus a window of ours during this flow — the target app must keep its caret.
 *   2. Restore the clipboard on a timer, never synchronously, or the restore races the
 *      paste and the user gets their previous clipboard contents instead of the transcript.
 */

/**
 * The paste chord. ⌘V on a Mac — Ctrl+V there is a different command in most apps, and in a
 * terminal it is a literal control character typed into the shell.
 */
const PASTE_MODIFIER = process.platform === 'darwin' ? Key.LeftCmd : Key.LeftControl;

/** How long to let the target app consume the paste before restoring the clipboard. */
const RESTORE_DELAY_MS = 220;
/** Let physically-held modifier keys settle before we synthesise our own. */
const SETTLE_DELAY_MS = 40;

// nut-js inserts generous delays by default, which we don't want on a hot path.
keyboard.config.autoDelayMs = 0;

interface ClipboardSnapshot {
  text: string;
  html: string;
  rtf: string;
  image: Electron.NativeImage;
}

function snapshot(): ClipboardSnapshot {
  return {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    image: clipboard.readImage()
  };
}

function restore(snap: ClipboardSnapshot): void {
  const hasImage = !snap.image.isEmpty();
  // An entirely empty clipboard should be left empty, not filled with "".
  if (!snap.text && !snap.html && !snap.rtf && !hasImage) {
    clipboard.clear();
    return;
  }

  const data: Electron.Data = {};
  if (snap.text) data.text = snap.text;
  if (snap.html) data.html = snap.html;
  if (snap.rtf) data.rtf = snap.rtf;
  if (hasImage) data.image = snap.image;
  clipboard.write(data);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface InjectOptions {
  /**
   * Leave the transcript on the clipboard instead of restoring what was there.
   *
   * For when the paste may not have landed and we cannot tell: under Wayland a synthetic
   * keystroke reaches X11 apps only, so a dictation into a native Wayland window goes
   * nowhere — and restoring the old clipboard afterwards would take away the one way the user
   * still had to get their words, which is pressing Ctrl+V themselves.
   */
  keepOnClipboard?: boolean;
}

/**
 * Put `text` on the clipboard and nothing more — for when we know a synthetic paste would be
 * dropped (macOS without Accessibility). The user pastes it themselves.
 */
export function copyText(text: string): void {
  if (text) clipboard.writeText(text);
}

/**
 * Put `text` into the focused field. Resolves once the paste has been sent; the
 * clipboard restore completes shortly afterwards on its own.
 */
export async function injectText(text: string, options: InjectOptions = {}): Promise<void> {
  if (!text) return;

  const snap = snapshot();
  clipboard.writeText(text);

  // The user has just let go of the hotkey, but the OS may not have processed every keyup
  // yet. Synthesising Ctrl+V while it still believes the rest of the chord is held would
  // send the target app Ctrl+Shift+V, or Ctrl+Alt+V — a different command in most editors —
  // so let the physical keys settle. The delay is deliberately chord-agnostic: the chord is
  // a setting now, and there is no combination this wait does not cover. (Click-started
  // dictations have no keys down at all, and paste arrives a full transcription round-trip
  // after the release anyway; this guards the mock's instant path.)
  await sleep(SETTLE_DELAY_MS);

  try {
    await keyboard.pressKey(PASTE_MODIFIER, Key.V);
    await keyboard.releaseKey(PASTE_MODIFIER, Key.V);
  } catch (err) {
    // Hand the clipboard back immediately — the user can still paste manually,
    // so a failed keystroke shouldn't also cost them the transcript.
    restore(snap);
    throw new Error(
      `Could not send the paste keystroke: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!options.keepOnClipboard) setTimeout(() => restore(snap), RESTORE_DELAY_MS);
}

/** Exported for tests. */
export const _internals = { snapshot, restore, nativeImage };
