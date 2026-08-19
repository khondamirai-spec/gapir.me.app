import { join } from 'node:path';
import { BrowserWindow, type Rectangle } from 'electron';
import { IPC, type DockGuides, type OverlayDock } from '@shared/types';

/**
 * The window that draws the pill's landing slots while it is being dragged.
 *
 * A leaf, like every other module beside state.ts: it knows nothing about dictations, docks
 * or the pill — overlay.ts drives it from inside the drag loop, and this only shows, paints
 * and hides. See src/renderer/dock-guides for what the slots look like and where the
 * numbers come from.
 *
 * It shares every focus-related option with the pill's own window and adds one of its own:
 * this one is click-through unconditionally, forever. The pill occasionally takes mouse
 * events so a click can land on it; this window covers an entire display, and a single
 * frame of it accepting a click would eat a click meant for whatever is underneath.
 *
 * Created lazily on the first drag and then reused. Building a full-screen transparent
 * window costs ~100ms, which is a visible stutter at the start of the very gesture it is
 * meant to make feel weightless — so the first drag pays it and no later one does.
 */

/** How long the fade-out is given before the window is actually hidden. Matches the
 *  `#guides` transition in the renderer; hiding sooner would cut the fade off. */
const FADE_OUT_MS = 160;

let win: BrowserWindow | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
/** Last payload sent, so a redundant highlight doesn't cross the bridge 120 times a second. */
let sent: DockGuides = { shown: false, active: null, y: 0 };

/** Whether a did-finish-load replay is already waiting — see showDockGuides. */
let replayQueued = false;
/** The work area the guides currently cover, so an unchanged one is not re-set every tick. */
let area: Rectangle | null = null;

function ensureWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;

  win = new BrowserWindow({
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
    type: process.platform === 'win32' ? 'toolbar' : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Unconditional, unlike the pill's: this window is the size of a display.
  win.setIgnoreMouseEvents(true, { forward: false });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/dock-guides/index.html`);
  } else {
    win.loadFile(join(__dirname, '../renderer/dock-guides/index.html'));
  }

  return win;
}

function send(next: DockGuides, force = false): void {
  if (!win || win.isDestroyed()) return;
  // `y` is compared whole-pixel like the rest: it tracks the cursor, so it genuinely changes
  // most ticks of a vertical drag and there is nothing to be saved by pretending otherwise —
  // but a purely horizontal drag still costs one message, not a hundred and twenty a second.
  if (!force && next.shown === sent.shown && next.active === sent.active && next.y === sent.y)
    return;
  sent = next;
  win.webContents.send(IPC.dockGuides, next);
}

/**
 * Put the guides up over one display's work area, with `active` as the slot the magnet
 * currently has and `y` the level the pill is being carried at, in pixels from the work
 * area's top — a side drop lands at that level, so the slot drawn for it has to follow.
 * Called on every tick of a drag that has travelled far enough to be a drag rather than a
 * shaky click — a click must not flash three outlines across the screen.
 *
 * Safe to call at the drag's own rate: the window is only re-bounded when the drag crosses
 * onto another display, and the payload only crosses the bridge when something moved.
 */
export function showDockGuides(workArea: Rectangle, active: OverlayDock | null, y: number): void {
  const guides = ensureWindow();
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  if (
    !area ||
    area.x !== workArea.x ||
    area.y !== workArea.y ||
    area.width !== workArea.width ||
    area.height !== workArea.height
  ) {
    area = { ...workArea };
    guides.setBounds(workArea);
  }
  if (!guides.isVisible()) guides.showInactive();
  // On the very first drag the page is still loading and anything sent now lands nowhere.
  // Replaying the latest state once it is there covers both the ordinary case and the drag
  // so short that it is already over by the time the page finishes loading.
  //
  // One listener, not one per call: this function runs at the drag's rate, ~120/s, and the
  // page takes long enough to load that the unguarded version stacked a dozen `once`
  // listeners and tripped Node's MaxListenersExceededWarning into main.log on first drag.
  if (guides.webContents.isLoading() && !replayQueued) {
    replayQueued = true;
    guides.webContents.once('did-finish-load', () => {
      replayQueued = false;
      send(sent, true);
    });
  }
  send({ shown: true, active, y: Math.round(y) });
}

/** Fade the slots out, then hide the window once the fade has had time to run. */
export function hideDockGuides(): void {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  send({ shown: false, active: null, y: sent.y });
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (win && !win.isDestroyed() && !sent.shown) win.hide();
  }, FADE_OUT_MS);
}

export function destroyDockGuides(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  area = null;
  sent = { shown: false, active: null, y: 0 };
  replayQueued = false;
}
