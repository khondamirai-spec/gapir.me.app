import { shell, systemPreferences } from 'electron';
import type { MicPermission } from '@shared/types';

/**
 * What the operating system has to allow before this app can do its job.
 *
 * On Windows the answer is "nothing": a desktop app may open a microphone, hook the keyboard
 * and synthesise Ctrl+V without asking anyone. macOS asks the user for two of those, and
 * each one fails in a way that looks like a bug rather than a missing permission:
 *
 *   Microphone     Without it AVFoundation neither errors nor delivers. ffmpeg opens, waits
 *                  for a consent that never comes, and the pill shows a recording that is
 *                  recording nothing. So we ask *before* spawning it, from the app itself,
 *                  which is also what makes the prompt say "gapir me" — ffmpeg is a child
 *                  process, and TCC attributes it to us.
 *
 *   Accessibility  Covers both halves of the keyboard: uiohook's event tap (without it
 *                  uIOhook.start() throws UIOHOOK_ERROR_AXAPI_DISABLED — and pops the system
 *                  prompt again on every attempt) and nut-js's synthetic ⌘V (without it the
 *                  keystroke is silently dropped, and the transcript never lands).
 *
 * Linux asks for neither, but has its own version of the second problem: under Wayland a
 * client can neither watch global keys nor type into another client's window. We run under
 * XWayland, so both work against X11 apps and do nothing against native Wayland ones — the
 * honest response is to know which session we are in and say so, see `isWayland`.
 *
 * A leaf, like the rest of src/main: it knows nothing about hotkeys, audio or windows.
 * state.ts decides what a missing permission means for a dictation.
 */

const IS_MAC = process.platform === 'darwin';

/** Where System Settings keeps each switch. Both deep links have been stable since 10.14. */
const PRIVACY_PANES = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
} as const;

/** How often to look again while waiting for the user to flip the Accessibility switch. */
const ACCESSIBILITY_POLL_MS = 1500;

export function microphoneStatus(): MicPermission {
  if (!IS_MAC) return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('microphone') as MicPermission;
  } catch {
    return 'unknown';
  }
}

/**
 * Ask for the microphone, showing the system prompt if the user has not been asked yet.
 * Resolves true once it is granted. After a "Don't Allow" macOS never shows the prompt
 * again — only System Settings can change the answer, which is what `openPrivacySettings`
 * is for.
 */
export async function requestMicrophone(): Promise<boolean> {
  if (!IS_MAC) return true;
  if (microphoneStatus() === 'granted') return true;
  try {
    return await systemPreferences.askForMediaAccess('microphone');
  } catch (err) {
    console.warn('[permissions] microphone request failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Whether we may watch the keyboard and type into other apps.
 *
 * `prompt` shows the system's "would like to control this computer" sheet when the answer is
 * no. Only ever pass it in answer to a click: the sheet is modal and macOS will happily show
 * it again on every call, so a poll that prompted would bury the screen in them.
 */
export function accessibilityGranted(prompt = false): boolean {
  if (!IS_MAC) return true;
  try {
    return systemPreferences.isTrustedAccessibilityClient(prompt);
  } catch {
    return false;
  }
}

let accessibilityWaiters: (() => void)[] = [];
let accessibilityPoll: ReturnType<typeof setInterval> | null = null;

/**
 * Run `cb` once Accessibility is granted — immediately, if it already is.
 *
 * A poll, because macOS sends no notification when the switch is flipped. It runs only while
 * someone is waiting, and the grant takes effect without a restart: AXIsProcessTrusted
 * answers the new value straight away, and an event tap created after that works.
 */
export function whenAccessibilityGranted(cb: () => void): void {
  if (accessibilityGranted()) {
    cb();
    return;
  }
  accessibilityWaiters.push(cb);
  if (accessibilityPoll) return;
  accessibilityPoll = setInterval(() => {
    if (!accessibilityGranted()) return;
    if (accessibilityPoll) clearInterval(accessibilityPoll);
    accessibilityPoll = null;
    const waiters = accessibilityWaiters;
    accessibilityWaiters = [];
    console.log('[permissions] Accessibility granted');
    for (const waiter of waiters) waiter();
  }, ACCESSIBILITY_POLL_MS);
}

export function stopPermissionWatch(): void {
  if (accessibilityPoll) clearInterval(accessibilityPoll);
  accessibilityPoll = null;
  accessibilityWaiters = [];
}

/** Open the System Settings pane where the user can grant `kind`. macOS only. */
export function openPrivacySettings(kind: keyof typeof PRIVACY_PANES): void {
  if (!IS_MAC) return;
  void shell.openExternal(PRIVACY_PANES[kind]);
}

/**
 * A Wayland session, where the global hotkey and the synthetic paste only reach X11 apps.
 *
 * Read from the session rather than from Electron: Electron 33 runs under XWayland unless told
 * otherwise, so from inside the process everything looks like X11 — which is precisely why
 * the hook starts without complaint and then never sees a key typed into a native Wayland
 * window.
 */
export function isWayland(): boolean {
  if (process.platform !== 'linux') return false;
  return process.env.XDG_SESSION_TYPE === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY);
}
