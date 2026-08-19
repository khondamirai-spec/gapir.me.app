import { join } from 'node:path';
import { BrowserWindow, screen, type Display, type Rectangle } from 'electron';
import { IPC, type AppState, type OverlayDock, type OverlayStatus } from '@shared/types';
import { destroyDockGuides, hideDockGuides, showDockGuides } from './dock-guides';

/**
 * The floating status pill — a permanent fixture, not a popup.
 *
 * It sits docked at the bottom centre of the screen for the whole session: a hairline bar
 * while idle, expanding into a waveform when you speak. That constant presence is the
 * point — the window can never take focus, and it is click-through everywhere except the
 * pill itself while the cursor is actually on it (see the hover notes below), so it never
 * gets between the user and their work.
 *
 * Every window option here is load-bearing for that one requirement: the overlay must
 * never take focus away from the app being dictated into. If it does, the caret moves, the
 * paste lands in the wrong place, and the whole app is useless. In particular:
 *
 *   focusable: false   — Windows won't activate the window on show, or on click
 *   showInactive()     — show() WILL steal focus; never use it here
 *   setIgnoreMouseEvents — clicks pass straight through to the app underneath, except
 *                          while the cursor is on the pill, when they toggle a dictation
 *
 * The window is click-through by default even though the pill reacts to hover: main works
 * out where the cursor is by itself rather than letting the window receive anything, and
 * only while the cursor is on the pill are mouse events switched on so a click can land.
 * See applyHoverWatch.
 *
 * The window is deliberately larger than the idle pill, and is never resized to fit one.
 * Growing the pill is done in CSS inside the renderer: resizing a transparent always-on-top
 * window on Windows flickers and lags a frame behind, whereas animating a div does not. The
 * empty area around the pill costs nothing because the whole window is click-through. The
 * one thing that does change its size is the dock, once, on a drop — see SIDE_HEIGHT.
 */

/** Window size — big enough for the fully expanded pill, not for the idle one. The height
 *  also has to hold the hover tooltip that floats above the pill (see the overlay's HTML);
 *  the pill itself stays anchored to the window's bottom edge, so the extra space is all
 *  above it and all click-through. */
const WIDTH = 360;
const HEIGHT = 150;
/**
 * The height a side-docked window gets instead — WIDTH, spelled out rather than reused,
 * because the two are equal by argument and not by definition.
 *
 * A side-docked pill is *rotated*: it runs along the edge, top to bottom. So every
 * measurement the horizontal layout spent on width, the rotated one spends on height — up to
 * the 300px capsule a live partial transcript widens it to. WIDTH is what covers all of it,
 * by construction.
 *
 * The width, meanwhile, stays WIDTH rather than shrinking to match, and two things need it:
 * `#pill.error` refuses to rotate (a sideways three-line sentence is not readable at any
 * size), so its 336px capsule still has to fit across a side-docked window, and the hover
 * hint doesn't rotate either — it sits horizontally beside the pill, reaching inward.
 */
const SIDE_HEIGHT = 360;
/**
 * Space left between the *window* and the bottom of the work area. Zero, deliberately: the
 * gap the user sees is PAD_BOTTOM, inside the renderer, because those pixels also have to
 * hold the pill's drop shadow. A window flush with the work area and a pill floating 24px
 * inside it draws a whole shadow; a window 14px up with the pill on its edge drew a shadow
 * sliced off in a hard horizontal line, which is what this constant used to cause.
 */
const BOTTOM_GAP = 0;
/**
 * Where the pill sits inside its window: off the bottom edge at the bottom dock, off the
 * docked edge at a side one — which are the same offset seen through the quarter turn the
 * CSS gives a side-docked pill. Both mirror the `#hit` rules in the overlay's HTML: main
 * hit-tests the pill and places the dock guides, so main has to know where in the window
 * the renderer put it. Change one and change the other; the CSS says so too.
 */
const PAD_BOTTOM = 24;
const PAD_SIDE = 16;
/**
 * The hovered group at a side dock, where it stops being the bottom dock's box turned on its
 * side: the pill is rotated but the hint beside it is not, so this reaches across the pill
 * (PAD_SIDE + 30 thick), the 12px gap and the ~152px tooltip, with slack at both ends. The
 * height only has to cover the taller of the pill's 64px length and the tooltip's 28.
 */
const SIDE_HOVER_WIDTH = 232;
const SIDE_HOVER_HEIGHT = 80;
/** How far a drag has to travel before it counts as a move rather than a shaky click. */
const DRAG_THRESHOLD_PX = 5;
/**
 * How often the window chases the cursor during a drag. 8ms rather than 16: the pill is
 * being carried by a hand, and every frame it spends behind the cursor is felt as weight.
 * The work per tick is one syscall and one setBounds.
 */
const DRAG_POLL_MS = 8;
/**
 * How close a dock has to be before it starts pulling the pill toward itself, in pixels of
 * window position. Generous on purpose — the magnet is meant to be discovered by accident.
 */
const SNAP_RADIUS = 200;
/**
 * The most the magnet may ever move the pill away from where the cursor is holding it.
 *
 * This is the whole difference between a hint and a hijack. The magnet used to move the
 * window a *fraction* of the remaining distance, which sounds gentle and is not: half of
 * "400px away from the slot" is 200px, so the pill tore out of the user's hand and flew at
 * the edge while they were still carrying it. Capping the assist in pixels means the pull
 * is felt as a slight lean toward the dock and never as the pill leaving the cursor — it
 * stays at the level it was carried to, and the *drop* is what puts it in the slot (see
 * endDrag, which glides it home).
 */
const MAX_ASSIST_PX = 28;
/**
 * How much the axis a dock does NOT define counts toward that distance. A side dock is
 * about reaching the *edge* — its height is our decision, not something a user should have
 * to aim for — so being 150px above or below the slot barely counts, while being 150px away
 * from the edge counts fully. The bottom dock is the same fact rotated.
 */
const FREE_AXIS_WEIGHT = 0.3;
/** The glide home after a drop, and the interval it is stepped at. */
const GLIDE_MS = 200;
const GLIDE_STEP_MS = 8;
/** How often the cursor is tested against the pill. Ticks only while the pill is clickable. */
const HOVER_POLL_MS = 120;
/**
 * How often the window's topmost status is re-asserted while it is on screen.
 *
 * `alwaysOnTop` is not a property Windows enforces forever: any other app that calls
 * SetWindowPos with HWND_TOPMOST after us slots in above, an explorer.exe restart rebuilds
 * the z-order from scratch, and some fullscreen transitions demote toolbar windows outright.
 * Electron keeps believing `isAlwaysOnTop()` is true the whole time, so the loss is
 * invisible from the API — the only reliable fix is to periodically re-claim the spot.
 * Cheap (two win32 calls that never activate the window), and it is what keeps the pill
 * from quietly living behind the browser after a week of uptime.
 */
const ON_TOP_REASSERT_MS = 4000;

let win: BrowserWindow | null = null;
/** Ticking only while a clickable pill is on screen; see applyHoverWatch. */
let hoverWatch: ReturnType<typeof setInterval> | null = null;
/** Ticking whenever the window is visible; see ON_TOP_REASSERT_MS. */
let onTopWatch: ReturnType<typeof setInterval> | null = null;
/** Whether the cursor is currently on the pill, as last told to the renderer. */
let hovered = false;
/** Mirrors the `showIdlePill` setting; decides whether IDLE keeps the window on screen. */
let idleVisible = true;
/** Last state pushed to the renderer, so visibility can be re-evaluated on a setting change. */
let lastState: AppState = 'IDLE';
/** Which dock the pill sits in. Mirrors the `overlayDock` setting; see setDock. */
let dock: OverlayDock = 'center';
/** How far down a side dock it sits, 0..1 of the work area. Mirrors `overlayDockY`. */
let dockY = 0.5;
/** Ticking only between beginDrag and endDrag; moves the window after the cursor. */
let dragWatch: ReturnType<typeof setInterval> | null = null;
/** Whether the current drag has actually moved — a shaky click must stay a click. */
let dragMoved = false;
/** The dock the drag is currently over, so the drop lands where the guides promised. */
let dragDock: OverlayDock | null = null;
/** Ticking only while the window is easing home after a drop; see glideTo. */
let glideWatch: ReturnType<typeof setInterval> | null = null;
/** The dock class the renderer was last told, so an unchanged one doesn't cross the bridge. */
let sentDockClass: OverlayDock | null = null;

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

/**
 * Where a given dock puts the window: bottom centre, or flush against the left/right edge
 * at the work area's vertical middle. The side docks keep the whole window on its display
 * rather than centring the *pill* on the edge — a window hanging half off one display is a
 * window drawing its tooltip on the neighbouring one. The renderer aligns and rotates the
 * pill toward the docked edge instead (see the dock classes in the overlay's CSS).
 *
 * The side docks are also the taller window: see SIDE_HEIGHT.
 *
 * `yFraction` is how far down the work area the *pill* belongs — the level it was dropped
 * at, persisted as `overlayDockY`. A side dock is an edge, not a point: pinning it to the
 * middle meant every drop up the edge slid back down to the centre of the screen, which
 * looks like the app rejecting where you put it. The window is centred on that level rather
 * than starting at it, because the pill sits at the middle of a side-docked window.
 */
export function dockBounds(workArea: Rectangle, at: OverlayDock, yFraction = 0.5): Rectangle {
  if (at === 'center') return bottomCenterBounds(workArea);

  const height = Math.min(SIDE_HEIGHT, workArea.height);
  const x =
    at === 'left' ? workArea.x : Math.max(workArea.x, workArea.x + workArea.width - WIDTH);
  const level = workArea.y + Math.min(1, Math.max(0, yFraction)) * workArea.height;
  const y = Math.min(
    Math.max(Math.round(level - height / 2), workArea.y),
    workArea.y + workArea.height - height
  );
  return { x, y, width: WIDTH, height };
}

/**
 * Which dock a window position belongs to: whichever third of the work area its middle
 * falls in. The pill lands where it was dropped, and nothing else about the drag can
 * override that — the magnet below pulls *toward* this answer, it does not choose it.
 */
export function dockForPosition(workArea: Rectangle, x: number): OverlayDock {
  const fraction = (x + WIDTH / 2 - workArea.x) / workArea.width;
  return fraction < 1 / 3 ? 'left' : fraction > 2 / 3 ? 'right' : 'center';
}

/**
 * The magnet: where a pill being carried at `pos` actually gets drawn, and how strongly.
 *
 * A dock is a fixed point, and a drag that has to hit a fixed point by hand is a drag that
 * misses. So as the pill nears its dock it is pulled the rest of the way — at full pull it
 * is sitting in the slot while the user is still holding it, which is the moment the drop
 * stops being a guess. The guides in src/renderer/dock-guides draw the slot it is heading
 * for, so the promise is visible before it is kept.
 *
 * Three details are what make it feel like a magnet rather than a snap:
 *
 * - **Smoothstep, not a circle.** Pull is zero at the edge of the radius and firms up as
 *   the pill closes in, so there is no frame where the window jumps because a threshold was
 *   crossed. It also means there is no hysteresis to get wrong: the pull is a pure function
 *   of where the pill is, so backing away un-pulls it exactly as smoothly.
 * - **The axis that defines the dock counts for most of it.** Distance along the free axis
 *   is discounted to FREE_AXIS_WEIGHT, so "take it to the left edge" is a complete gesture:
 *   the user never has to also find the exact vertical middle the slot happens to sit at.
 * - **The assist is capped in pixels, not in fractions.** MAX_ASSIST_PX is the whole reason
 *   this reads as a lean rather than a lunge; without it the pull scales with how far away
 *   the slot is, which is precisely backwards. The pill therefore never arrives at the slot
 *   under its own steam — it leans at it, the guides say where it will land, and endDrag
 *   glides it the rest of the way once the hand lets go.
 *
 * Pure, and exported for tests: this is the one piece of the drag whose feel is arithmetic.
 */
export function magnetTarget(
  workArea: Rectangle,
  pos: { x: number; y: number }
): { dock: OverlayDock; x: number; y: number; pull: number } {
  const at = dockForPosition(workArea, pos.x);
  const home = dockBounds(workArea, at);
  // A side dock has no height of its own to aim for any more — the pill lands at whatever
  // level it was carried to — so the target on that axis is simply where it already is, and
  // the magnet has nothing to say about it. The bottom dock is a point and still does.
  const target = { x: home.x, y: at === 'center' ? home.y : pos.y };
  const acrossWeight = at === 'center' ? FREE_AXIS_WEIGHT : 1;
  const alongWeight = at === 'center' ? 1 : FREE_AXIS_WEIGHT;
  const distance = Math.hypot(
    (target.x - pos.x) * acrossWeight,
    (target.y - pos.y) * alongWeight
  );
  const nearness = Math.max(0, 1 - distance / SNAP_RADIUS);
  const pull = nearness * nearness * (3 - 2 * nearness);
  return {
    dock: at,
    x: Math.round(pos.x + assist(target.x - pos.x, pull)),
    y: Math.round(pos.y + assist(target.y - pos.y, pull)),
    pull
  };
}

/** How far the magnet is allowed to shift one axis: `pull` of the way home, but never more
 *  than MAX_ASSIST_PX, and never past the slot itself. */
function assist(delta: number, pull: number): number {
  const wanted = delta * pull;
  return Math.sign(wanted) * Math.min(Math.abs(wanted), MAX_ASSIST_PX);
}

function positionOn(display: Display): void {
  stopGlide();
  win?.setBounds(dockBounds(display.workArea, dock, dockY));
}

/**
 * Move the window, restating its size every time.
 *
 * **Never use `setPosition` here.** On a display with fractional scaling — 125% is the
 * Windows default on most laptops — `setPosition` makes the window GROW, about a pixel per
 * call in each direction. Electron takes the position in DIPs, converts to physical pixels
 * and rounds; the size it keeps is re-derived from the rounded physical rect, so every call
 * feeds its own rounding error back in. One call is invisible. A drag makes ~120 of them a
 * second, and the window inflates from 360×150 to 600×600 in the few seconds it takes to
 * carry the pill across the screen.
 *
 * That is not a cosmetic problem, because the pill is anchored to the *bottom* of its
 * window: as the window grows downward the pill slides down and away from the cursor, which
 * is exactly the "the logo moves down, and it feels heavy" this drag was reported as. It
 * also ends with the pill somewhere below the screen once the window is taller than the
 * display, which reads as the pill vanishing on drop.
 *
 * `setBounds` with the size restated is immune: the DIP size is given explicitly every time,
 * so the same rounding produces the same physical size and nothing accumulates. `height` is
 * a parameter rather than the constant it used to be only because the side docks are taller
 * (see SIDE_HEIGHT); a caller passes the same value for every call of one gesture.
 */
function moveTo(x: number, y: number, height: number): void {
  win?.setBounds({ x, y, width: WIDTH, height });
}

/**
 * Ease the window to `target` instead of teleporting it there.
 *
 * Used for the drop: a pill that vanishes from under the cursor and reappears in its dock
 * reads as a glitch, and the same move over 200ms reads as the magnet finishing its job.
 * Stepped by an interval rather than by animation frames because a click-through,
 * unfocusable window is not guaranteed to be given rAF at all when it is not being drawn to.
 */
function glideTo(target: Rectangle): void {
  stopGlide();
  if (!win || win.isDestroyed()) return;
  const from = win.getBounds();
  if (from.x === target.x && from.y === target.y && from.height === target.height) return;
  const started = Date.now();
  glideWatch = setInterval(() => {
    if (!win || win.isDestroyed()) {
      stopGlide();
      return;
    }
    const t = Math.min(1, (Date.now() - started) / GLIDE_MS);
    // easeOutCubic: it leaves fast and arrives slowly, which is what "settling" looks like.
    const eased = 1 - Math.pow(1 - t, 3);
    // moveTo, not setPosition — the glide is another burst of moves, and setPosition inflates
    // the window on a scaled display. See moveTo. The height is eased along with the
    // position because a drop can change it: a side dock is the taller window, and the pill
    // rotating into it (a CSS transition of about the same length) is drawn against a box
    // that has to be growing underneath it, not one that snapped first.
    moveTo(
      Math.round(from.x + (target.x - from.x) * eased),
      Math.round(from.y + (target.y - from.y) * eased),
      Math.round(from.height + (target.height - from.height) * eased)
    );
    if (t >= 1) stopGlide();
  }, GLIDE_STEP_MS);
}

function stopGlide(): void {
  if (glideWatch) clearInterval(glideWatch);
  glideWatch = null;
}

/**
 * Tell the renderer which dock to align and rotate the pill to.
 *
 * Only ever sent from setDock, i.e. at startup and on a drop — never during a drag. The
 * renderer's transition then runs against the window's own glide (see glideTo), which is
 * what makes "it turned as it landed" one movement rather than two.
 */
function sendDockClass(next: OverlayDock): void {
  if (sentDockClass === next) return;
  sentDockClass = next;
  if (win && !win.isDestroyed()) win.webContents.send(IPC.overlayDock, next);
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
  // `on`, not `once`. A renderer can load more than once — Vite hot-reloads it whenever the
  // overlay's HTML or CSS is touched, and a crashed one is reloaded in the field — and a
  // page that loads without being re-told everything is a page drawing defaults: the resting
  // pill in the bottom dock, unhovered, whatever the app is actually doing. Every push below
  // is idempotent, so re-running it costs a few bytes over the bridge.
  win.webContents.on('did-finish-load', () => {
    updateOverlay({ state: lastState, level: 0, partial: '', message: '' });
    // Nothing has been told to *this* page, whatever a previous one was told.
    sentDockClass = null;
    sendDockClass(dock);
    if (win && !win.isDestroyed()) win.webContents.send(IPC.overlayHover, hovered);
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
    if (!win.isVisible()) {
      win.showInactive();
      assertOnTop();
    }
    if (!onTopWatch) onTopWatch = setInterval(assertOnTop, ON_TOP_REASSERT_MS);
  } else {
    if (win.isVisible()) win.hide();
    if (onTopWatch) {
      clearInterval(onTopWatch);
      onTopWatch = null;
    }
  }

  applyHoverWatch();
}

/**
 * Re-claim the topmost slot. Unconditional rather than gated on `isAlwaysOnTop()`, because
 * that getter reports the flag we set, not the z-order Windows actually has us in — the two
 * drift apart silently, which is the whole reason this exists. Neither call activates the
 * window, so the caret is safe.
 */
function assertOnTop(): void {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.moveTop();
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
 * while there is something for the cursor to do: the resting pill (which hover expands into
 * the hint, and a click starts a hands-free dictation), the recording pill (which a click
 * stops), and the brief DONE/ERROR flashes (which a click can interrupt to dictate again,
 * exactly as the hotkey can). During TRANSCRIBING and INJECTING there is nothing to click,
 * with `showIdlePill` off there is no window to point at, and in both the interval is
 * cleared rather than left ticking.
 *
 * The same hover fact drives `setIgnoreMouseEvents`: the window is click-through except
 * while the cursor is on the pill, so a click anywhere else still lands in the app
 * underneath, and a click on the pill lands on us. `focusable: false` keeps even that
 * click from activating the window, so the caret never moves.
 */
function applyHoverWatch(): void {
  const wanted =
    lastState !== 'TRANSCRIBING' &&
    lastState !== 'INJECTING' &&
    !!win &&
    !win.isDestroyed() &&
    win.isVisible();

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
 *
 * `width` and `height` below are the pill *as it is laid out*, which for a side dock is not
 * how it appears: the CSS rotates it a quarter turn so it runs along the edge, and the two
 * are swapped again at the bottom of this function. Everything about a rotated pill grows
 * away from the edge — the tooltip that floated above it now floats inward — so the box is
 * built from the edge in.
 */
function hitRect(bounds: Rectangle): Rectangle {
  let width: number;
  let height: number;
  // Hovering only *shows* anything in the states that have nothing better to say, which is
  // the same `:not(.active):not(.error):not(.done)` chain the CSS wears. Hovering a
  // recording pill leaves a recording pill, and its box below must not become the hint's.
  let showsHint = false;
  if (lastState === 'RECORDING') {
    // The expanded 90×32 capsule, with a little margin — the click that stops a hands-free
    // dictation should not demand pixel accuracy.
    width = 110;
    height = 40;
  } else if (lastState === 'DONE') {
    // The 44×32 tick capsule.
    width = 64;
    height = 40;
  } else if (lastState === 'ERROR') {
    // The 336×62 error pill.
    width = 344;
    height = 70;
  } else if (hovered) {
    // The expanded idle group: the logo capsule and the one-line tooltip floating above it.
    // The tooltip has to be inside this box, or moving the cursor up to read it would count
    // as leaving and collapse the very thing being read. (It used to be 320 wide, for a
    // help button that no longer exists beside the pill.)
    showsHint = true;
    width = 260;
    height = 100;
  } else {
    width = 64;
    height = 30;
  }
  if (dock === 'center') {
    // Centred horizontally; the pill's bottom edge is PAD_BOTTOM up from the window's own
    // bottom, and every hit box grows upward from there because so does the pill.
    return {
      x: Math.round(bounds.x + (bounds.width - width) / 2),
      y: bounds.y + bounds.height - PAD_BOTTOM - height,
      width,
      height
    };
  }

  // An error is the one state that does not rotate — a sideways three-line sentence is not
  // readable — so it sits square in the middle of its window, and so does its hit box.
  if (lastState === 'ERROR') {
    return {
      x: Math.round(bounds.x + (bounds.width - width) / 2),
      y: Math.round(bounds.y + (bounds.height - height) / 2),
      width,
      height
    };
  }

  // Every side-docked box runs from just outside the docked edge inward, with a little slack
  // on the edge side because the pill is against a screen edge and a cursor that overshoots
  // it should not lose the pill.
  const outside = PAD_SIDE - 8;

  // The hovered group is the one shape that is not simply the laid-out pill turned on its
  // side, because the hint beside it is NOT rotated: the pill runs 64px down the edge while
  // the tooltip reaches some 210px in from it, horizontally. So it is wide and short where
  // the rotated boxes are narrow and tall. It still has to contain the tooltip — a cursor
  // moving onto the hint it just summoned must not read as leaving.
  if (showsHint) {
    return {
      x: dock === 'left' ? bounds.x + outside : bounds.x + bounds.width - outside - SIDE_HOVER_WIDTH,
      y: Math.round(bounds.y + (bounds.height - SIDE_HOVER_HEIGHT) / 2),
      width: SIDE_HOVER_WIDTH,
      height: SIDE_HOVER_HEIGHT
    };
  }

  // Rotated: the laid-out height becomes the on-screen width and vice versa.
  const reach = height + 16;
  return {
    x: dock === 'left' ? bounds.x + outside : bounds.x + bounds.width - outside - reach,
    y: Math.round(bounds.y + (bounds.height - width) / 2),
    width: reach,
    height: width
  };
}

function pollHover(): void {
  if (!win || win.isDestroyed()) return;
  // Mid-drag the cursor is the thing moving the window, and clamping at a screen edge can
  // put it briefly outside the hit box. Un-hovering then would turn mouse events off and
  // eat the mouseup that ends the drag, so hover is pinned until endDrag.
  if (dragWatch) return;
  const { x, y } = screen.getCursorScreenPoint();
  const r = hitRect(win.getBounds());
  setHovered(x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
}

function setHovered(next: boolean): void {
  if (hovered === next) return;
  hovered = next;
  if (win && !win.isDestroyed()) {
    // On the pill: take mouse events, so the click reaches the renderer instead of the app
    // underneath. Off it: click-through again, immediately — a swallowed click next to the
    // pill would be a phantom dead spot in whatever the user is working on.
    win.setIgnoreMouseEvents(!next, { forward: false });
    win.webContents.send(IPC.overlayHover, next);
  }
}

function stopHoverWatch(): void {
  if (hoverWatch) clearInterval(hoverWatch);
  hoverWatch = null;
  hovered = false;
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(true, { forward: false });
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
  // Re-claim topmost at the moment it matters most: some other window may have out-topped
  // us since the interval last ticked, and the user is about to stare at this exact spot.
  assertOnTop();
}

/** Backs the `showIdlePill` setting — takes effect immediately, without a restart. */
export function setIdleVisible(visible: boolean): void {
  idleVisible = visible;
  applyVisibility();
}

/**
 * Put the pill in a dock: snap the window there and tell the renderer, whose CSS aligns and
 * rotates the pill toward the docked edge. Called at startup with the persisted setting,
 * and from endDrag with wherever the user just dropped it.
 *
 * `y` is the level a side dock sits at, as a fraction of the work area. Omitting it keeps
 * the level already in force, which is what makes a trip through the bottom dock and back
 * return the pill to the height it was left at rather than to the middle.
 */
export function setDock(next: OverlayDock, options: { glide?: boolean; y?: number } = {}): void {
  dock = next;
  if (options.y !== undefined) dockY = Math.min(1, Math.max(0, options.y));
  if (!win || win.isDestroyed()) return;
  // The display the window is on right now, not the one the cursor is on: a drop is
  // finished where the window is, and at startup the two are the same anyway.
  const target = dockBounds(screen.getDisplayMatching(win.getBounds()).workArea, dock, dockY);
  if (options.glide) glideTo(target);
  else {
    stopGlide();
    win.setBounds(target);
  }
  sentDockClass = null;
  sendDockClass(dock);
}

/**
 * The pill is being held. The renderer only reports the mousedown — the window is moved
 * from here, off the same `getCursorScreenPoint` the hover poll uses, because renderer
 * screen coordinates and Electron's DIP coordinates disagree on scaled displays.
 *
 * The window chases the cursor by the drag's total delta, so the cursor keeps its grip
 * point on the pill; clamping to the work area is the one place the two can drift apart,
 * which is why pollHover is pinned during a drag (see above).
 */
export function beginDrag(): void {
  if (!win || win.isDestroyed() || dragWatch) return;
  stopGlide();
  dragMoved = false;
  dragDock = null;
  const startCursor = screen.getCursorScreenPoint();
  const startBounds = win.getBounds();
  // The window keeps the size — and the renderer keeps the dock class — it was picked up
  // with, for the whole gesture. A pill that re-anchored inside its own window mid-drag
  // (which is what this used to do once the magnet took hold) moved out from under the
  // cursor that was carrying it, and now that a side dock also *rotates* the pill it would
  // spin in the user's hand as well. The guides say where it will land; the drop is what
  // puts it there.
  const height = startBounds.height;
  dragWatch = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const cur = screen.getCursorScreenPoint();
    const dx = cur.x - startCursor.x;
    const dy = cur.y - startCursor.y;
    // Below the threshold this is still a click; moving the window under a clicking cursor
    // would turn every slightly shaky click into a one-pixel drag.
    if (!dragMoved && Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
    // Clamp to the display the cursor is on, so a drag can cross displays but the pill
    // can never be parked half off every screen.
    const wa = screen.getDisplayNearestPoint(cur).workArea;
    const free = {
      x: Math.min(Math.max(startBounds.x + dx, wa.x), wa.x + wa.width - WIDTH),
      y: Math.min(Math.max(startBounds.y + dy, wa.y), wa.y + wa.height - height)
    };
    const pulled = magnetTarget(wa, free);
    dragDock = pulled.dock;

    // The slots appear on the first real movement rather than on the press, so a click never
    // flashes three outlines across the screen. Called every tick from then on — it is cheap
    // when nothing changed, and it is what lets the guides follow a drag onto another
    // display along with the pill.
    dragMoved = true;
    showDockGuides(wa, pulled.dock, pillLevel(pulled.y, height) - wa.y);

    moveTo(pulled.x, pulled.y, height);
  }, DRAG_POLL_MS);
}

/**
 * The pill's own centre line, in screen coordinates, for a window at `y` of `height`.
 *
 * Not the window's middle: where the pill sits inside its window depends on the dock it is
 * currently wearing. A bottom-docked pill hangs from the window's lower edge (PAD_BOTTOM up,
 * half a hover capsule further); a side-docked one is centred. Both matter here, because a
 * drag keeps the pose it was picked up in and the level the *user* sees is the pill's.
 */
function pillLevel(y: number, height: number): number {
  return dock === 'center' ? y + height - PAD_BOTTOM - 15 : y + height / 2;
}

/**
 * The pill was released. It docks where the guides said it would — whichever third of the
 * work area it was dropped in, at the level it was dropped at — gliding the last of the way
 * rather than teleporting, and returns both so the caller (index.ts) can persist them.
 * Returns null when the "drag" never moved, i.e. it was a click.
 */
export function endDrag(): { dock: OverlayDock; y: number } | null {
  if (!dragWatch) return null;
  clearInterval(dragWatch);
  dragWatch = null;
  hideDockGuides();
  if (!dragMoved || !win || win.isDestroyed()) return null;

  // The level is read off the pill's own position under the cursor, before setDock is told
  // anything — pillLevel() answers for the pose the drag was carried in, and setDock is
  // about to change it.
  const bounds = win.getBounds();
  const wa = screen.getDisplayMatching(bounds).workArea;
  const y = (pillLevel(bounds.y, bounds.height) - wa.y) / wa.height;

  // dragDock rather than a fresh measurement of the window: the magnet may have pulled the
  // window into a neighbouring third, and the dock the guides promised is the one the user
  // was shown. Those two agreeing is the whole point of highlighting a slot.
  const next = dragDock ?? dock;
  // A drop on the bottom dock has no level to record, and must not overwrite the one the
  // side docks are holding: crossing the middle of the screen on the way to the other edge
  // would otherwise reset the height the pill had been living at.
  setDock(next, { glide: true, y: next === 'center' ? undefined : y });
  return { dock: next, y: dockY };
}

export function updateOverlay(status: OverlayStatus): void {
  if (!win || win.isDestroyed()) return;
  lastState = status.state;
  applyVisibility();
  win.webContents.send(IPC.overlayStatus, status);
}

export function destroyOverlay(): void {
  if (dragWatch) {
    clearInterval(dragWatch);
    dragWatch = null;
  }
  stopGlide();
  destroyDockGuides();
  stopHoverWatch();
  if (onTopWatch) {
    clearInterval(onTopWatch);
    onTopWatch = null;
  }
  if (win && !win.isDestroyed()) {
    // `closable: false` means close() is a no-op; destroy() is the way out.
    win.destroy();
  }
  win = null;
}

/** Exported for tests. */
export const _internals = {
  WIDTH,
  HEIGHT,
  SIDE_HEIGHT,
  BOTTOM_GAP,
  HOVER_POLL_MS,
  PAD_BOTTOM,
  PAD_SIDE,
  SNAP_RADIUS,
  MAX_ASSIST_PX
};
