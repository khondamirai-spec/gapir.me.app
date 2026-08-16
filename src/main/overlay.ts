import { join } from 'node:path';
import { BrowserWindow, screen, type Display, type Rectangle } from 'electron';
import { IPC, type AppState, type OverlayStatus } from '@shared/types';

/**
 * The floating status pill — a permanent fixture, not a popup.
 *
 * It sits docked at the bottom centre of the screen for the whole session: a hairline bar
 * while idle, expanding into a waveform when you speak. That constant presence is the
 * point — there is no button to press and nothing to click, so the window is entirely
 * click-through and can never take focus.
 *
 * Every window option here is load-bearing for that one requirement: the overlay must
 * never take focus away from the app being dictated into. If it does, the caret moves, the
 * paste lands in the wrong place, and the whole app is useless. In particular:
 *
 *   focusable: false   — Windows won't activate the window on show
 *   showInactive()     — show() WILL steal focus; never use it here
 *   setIgnoreMouseEvents — clicks pass straight through to the app underneath
 *
 * The window stays fully click-through even though the pill reacts to hover: main works out
 * where the cursor is by itself rather than letting the window receive anything. See
 * applyHoverWatch.
 *
 * The window is a FIXED size, deliberately larger than the idle pill, and never resized.
 * Growing the pill is done in CSS inside the renderer: resizing a transparent always-on-top
 * window on Windows flickers and lags a frame behind, whereas animating a div does not. The
 * empty area around the pill costs nothing because the whole window is click-through.
 */

/** Window size — big enough for the fully expanded pill, not for the idle one. */
const WIDTH = 360;
const HEIGHT = 80;
/** Space left between the pill and the bottom of the work area (above the taskbar). */
const BOTTOM_GAP = 14;
/** How often the cursor is tested against the pill. Ticks only while a resting pill is up. */
const HOVER_POLL_MS = 120;

let win: BrowserWindow | null = null;
/** Ticking only while a resting pill is on screen; see applyHoverWatch. */
let hoverWatch: ReturnType<typeof setInterval> | null = null;
/** Whether the cursor is currently on the pill, as last told to the renderer. */
let hovered = false;
/** Mirrors the `showIdlePill` setting; decides whether IDLE keeps the window on screen. */
let idleVisible = true;
/** Last state pushed to the renderer, so visibility can be re-evaluated on a setting change. */
let lastState: AppState = 'IDLE';

/**
 * Where the window goes on a given display's work area.
 *
 * Pure and exported so the clamping can be unit-tested without a screen: work areas can
 * have negative origins (a display left of the primary), can be narrower than the pill on
 * heavily scaled setups, and the taskbar can be on any edge.
 */
export function bottomCenterBounds(workArea: Rectangle): Rectangle {
  const x = Math.round(workArea.x + (workArea.width - WIDTH) / 2);
  const y = Math.round(workArea.y + workArea.height - HEIGHT - BOTTOM_GAP);

  return {
    // Clamp so a work area smaller than the window still leaves the pill on screen.
    x: Math.max(workArea.x, x),
    y: Math.max(workArea.y, y),
    width: WIDTH,
    height: HEIGHT
  };
}

function positionOn(display: Display): void {
  win?.setBounds(bottomCenterBounds(display.workArea));
}

/** The display the user is working on, which is where the pill belongs. */
function activeDisplay(): Display {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

export function createOverlay(): BrowserWindow {
  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    // Keep it off Alt-Tab and out of screen captures of other apps.
    type: process.platform === 'win32' ? 'toolbar' : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // 'screen-saver' floats above fullscreen apps and most other always-on-top windows.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: false });

  positionOn(screen.getPrimaryDisplay());

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/overlay/index.html`);
  } else {
    win.loadFile(join(__dirname, '../renderer/overlay/index.html'));
  }

  // The renderer starts collapsed on its own, but push the real state anyway so the two
  // can't disagree from the first frame — e.g. after a crash-restart mid-dictation.
  win.webContents.once('did-finish-load', () => {
    updateOverlay({ state: lastState, level: 0, partial: '', message: '' });
  });

  // A resolution change, a docked laptop or an unplugged monitor all move the bottom edge.
  const reposition = (): void => positionOn(activeDisplay());
  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);

  applyVisibility();

  return win;
}

/**
 * Show the window if the current state warrants it, hide it if not.
 *
 * The policy lives here rather than in the state machine so there is exactly one place
 * that decides whether the pill is on screen: anything other than IDLE is always visible,
 * and IDLE is visible only when the user wants the resting bar.
 */
function applyVisibility(): void {
  if (!win || win.isDestroyed()) return;

  const shouldShow = lastState !== 'IDLE' || idleVisible;
  if (shouldShow) {
    // showInactive, NOT show — show() activates the window and steals the caret.
    if (!win.isVisible()) win.showInactive();
  } else if (win.isVisible()) {
    win.hide();
  }

  applyHoverWatch();
}

/**
 * Hover, on a window that cannot be told about the mouse.
 *
 * The obvious implementation is `setIgnoreMouseEvents(true, { forward: true })` plus
 * mouseenter/mouseleave in the renderer, and it was the first thing tried here. On Windows
 * that forwarding is driven by a low-level mouse hook inside Electron, and on this app it
 * delivers nothing: with the window transparent and unfocusable, the renderer sees no moves
 * at all and the pill never reacts. Rather than ship a feature resting on a hook that may
 * or may not fire, main does the hit-testing itself — `getCursorScreenPoint` is the same
 * fact, from a source that is not conditional on anything.
 *
 * So this is a poll, which is the honest cost of the feature. It is bounded by only running
 * while a resting pill is actually on screen: during a dictation the pill ignores hover, and
 * with `showIdlePill` off there is no window to point at, and in both cases the interval is
 * cleared rather than left ticking.
 */
function applyHoverWatch(): void {
  const wanted = lastState === 'IDLE' && !!win && !win.isDestroyed() && win.isVisible();

  if (wanted && !hoverWatch) {
    hoverWatch = setInterval(pollHover, HOVER_POLL_MS);
  } else if (!wanted && hoverWatch) {
    clearInterval(hoverWatch);
    hoverWatch = null;
    // Leaving it hovered would strand the expanded pill the next time IDLE comes back.
    setHovered(false);
  }
}

/**
 * The pill's hover target, in screen coordinates.
 *
 * These mirror `#hit` in the overlay's CSS, which is the one duplication this design costs:
 * main decides whether the cursor is on the pill, so main has to know how big the pill is.
 * The hovered box is deliberately larger than the collapsed one — it has to cover the
 * expanded pill, or the cursor would sit on the hint it just summoned, be judged outside,
 * and collapse it, forever.
 */
function hitRect(bounds: Rectangle): Rectangle {
  const width = hovered ? 224 : 64;
  const height = hovered ? 38 : 30;
  return {
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: bounds.y + bounds.height - height,
    width,
    height
  };
}

function pollHover(): void {
  if (!win || win.isDestroyed()) return;
  const { x, y } = screen.getCursorScreenPoint();
  const r = hitRect(win.getBounds());
  setHovered(x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
}

function setHovered(next: boolean): void {
  if (hovered === next) return;
  hovered = next;
  if (win && !win.isDestroyed()) win.webContents.send(IPC.overlayHover, next);
}

function stopHoverWatch(): void {
  if (hoverWatch) clearInterval(hoverWatch);
  hoverWatch = null;
  hovered = false;
}

/**
 * Called as a dictation starts: make sure the pill is up, on the display the user is
 * actually looking at. Repositioning here rather than continuously is deliberate — this is
 * the only moment the pill's location matters, and `getCursorScreenPoint` is a syscall.
 */
export function ensureVisible(): void {
  if (!win || win.isDestroyed()) return;
  positionOn(activeDisplay());
  applyVisibility();
}

/** Backs the `showIdlePill` setting — takes effect immediately, without a restart. */
export function setIdleVisible(visible: boolean): void {
  idleVisible = visible;
  applyVisibility();
}

export function updateOverlay(status: OverlayStatus): void {
  if (!win || win.isDestroyed()) return;
  lastState = status.state;
  applyVisibility();
  win.webContents.send(IPC.overlayStatus, status);
}

export function destroyOverlay(): void {
  stopHoverWatch();
  if (win && !win.isDestroyed()) {
    // `closable: false` means close() is a no-op; destroy() is the way out.
    win.destroy();
  }
  win = null;
}

/** Exported for tests. */
export const _internals = { WIDTH, HEIGHT, BOTTOM_GAP, HOVER_POLL_MS };
