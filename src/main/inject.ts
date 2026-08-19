import { clipboard, nativeImage } from 'electron';
import { keyboard, Key } from '@nut-tree-fork/nut-js';

/**
 * Paste transcribed text into whatever field currently has focus.
 *
 * Clipboard + synthetic Ctrl+V is the only approach that works reliably across every
 * target app. Typing the text character-by-character is far too slow for a paragraph and
 * breaks in editors with autocomplete; the Win32 SendInput unicode path has the same
 * problem. So: save the clipboard, borrow it, paste, hand it back.
 *
 * Two rules this module exists to enforce:
 *   1. NEVER focus a window of ours during this flow — the target app must keep its caret.
 *   2. Restore the clipboard on a timer, never synchronously, or the restore races the
 *      paste and the user gets their previous clipboard contents instead of the transcript.
 */

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

/**
 * Put `text` into the focused field. Resolves once the paste has been sent; the
 * clipboard restore completes shortly afterwards on its own.
 */
export async function injectText(text: string): Promise<void> {
  if (!text) return;

  const snap = snapshot();
  clipboard.writeText(text);

  // The user has just let go of the hotkey, but the OS may not have processed both keyups
  // yet. Synthesising Ctrl+V while it still believes Shift is held would send the target
  // app Ctrl+Shift+V — a different command in most editors — so let the physical keys
  // settle. (Click-started dictations have no keys down at all, and paste arrives a full
  // transcription round-trip after the release anyway; this guards the mock's instant path.)
  await sleep(SETTLE_DELAY_MS);

  try {
    await keyboard.pressKey(Key.LeftControl, Key.V);
    await keyboard.releaseKey(Key.LeftControl, Key.V);
  } catch (err) {
    // Hand the clipboard back immediately — the user can still paste manually,
    // so a failed keystroke shouldn't also cost them the transcript.
    restore(snap);
    throw new Error(
      `Could not send the paste keystroke: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  setTimeout(() => restore(snap), RESTORE_DELAY_MS);
}

/** Exported for tests. */
export const _internals = { snapshot, restore, nativeImage };
