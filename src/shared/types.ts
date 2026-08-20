/** Shared between main and renderers. Keep this dependency-free. */

import { DEFAULT_HOTKEYS, type HotkeySettings } from './hotkeys';

/** Re-exported so a consumer of `Settings` doesn't need a second import for its one field. */
export type { Chord, HotkeySettings } from './hotkeys';

export type Language = 'uz' | 'ru' | 'en';

/**
 * The dictation lifecycle. Exactly one state is active at a time.
 *
 *   IDLE ──hotkey down──> RECORDING ──hotkey up──> TRANSCRIBING ──> INJECTING ──> DONE ──> IDLE
 *                             │                         │
 *                             └────── Esc / error ──────┴──────> ERROR ──(2.5s)──> IDLE
 *
 * IDLE does NOT mean "overlay hidden" — the pill stays on screen, collapsed to its logo.
 * DONE is a brief success flash so a dictation visibly finishes rather than just stopping.
 */
export type AppState = 'IDLE' | 'RECORDING' | 'TRANSCRIBING' | 'INJECTING' | 'DONE' | 'ERROR';

/**
 * Where the pill lives on screen: docked to the left edge, the bottom centre (the default),
 * or the right edge. There are exactly three docks rather than a free position — the pill
 * snaps to whichever the user drops it nearest, so it can never be lost half-off a screen
 * or stranded on a display that was unplugged.
 */
export type OverlayDock = 'left' | 'center' | 'right';

/**
 * What the dock guides draw while the pill is being carried: the three slots it can land
 * in, with `active` being the one the magnet is currently pulling it toward (null while it
 * is out in the open). `shown: false` is the exit — the guides fade before their window is
 * hidden, so a released pill does not leave three outlines blinking out behind it.
 */
export interface DockGuides {
  shown: boolean;
  active: OverlayDock | null;
  /**
   * Where down the work area the two side slots are drawn, in pixels from its top — the
   * level the pill is being carried at, because that is where a side drop now lands it.
   * The bottom slot ignores it; it has one place to be.
   */
  y: number;
}

export interface OverlayStatus {
  state: AppState;
  /** 0..1 RMS level, only meaningful while RECORDING. */
  level: number;
  /** Live partial transcript while RECORDING/TRANSCRIBING, if the provider sends them. */
  partial: string;
  /** Human-readable message, only set in ERROR. */
  message: string;
  /**
   * A thing the user can *do* about this state, drawn as a button on the pill instead of a
   * sentence.
   *
   * There is exactly one so far, and it earned the field: "you are signed out" used to be
   * an error message, which is a sentence telling somebody to go and find a window and a
   * button in it. It is not an error — it is the one step left before the app works — so
   * the pill offers the step. See the `.prompt` rules in the overlay's HTML.
   */
  prompt?: OverlayPrompt;
}

/** `sign-in` — the pill becomes a Google sign-in button. `''` — no offer, the default. */
export type OverlayPrompt = '' | 'sign-in' | 'signing-in';

export interface AudioDevice {
  /** Friendly name shown in settings, e.g. "Микрофон (DroidCam Audio)". */
  label: string;
  /**
   * ffmpeg dshow alternative name, e.g. "@device_cm_{...}\\wave_{...}".
   * Always ASCII — we pass THIS to ffmpeg, never `label`, because friendly names
   * contain non-ASCII characters that get mangled by the Windows console codepage.
   */
  id: string;
}

/**
 * How the transcript should read.
 *
 * Every field is a prompt rule, not post-processing: the model is the only thing in the
 * pipeline that knows which words were stumbles and which were meant. `verbatim` is the
 * honest default — a dictation tool that quietly rewrites what you said is a tool you
 * stop trusting — and the other two tones exist because dictating a message and dictating
 * a document want different things.
 */
export interface StyleSettings {
  /** verbatim: exactly as spoken · tidy: drop stumbles and repeats · formal: written register. */
  tone: 'verbatim' | 'tidy' | 'formal';
  /** Drop "uh", "mm", "eee" — on by default; nobody wants their breathing typed out. */
  removeFillers: boolean;
  /** Sentence case and punctuation. Off means a single unbroken lowercase run. */
  punctuation: boolean;
}

/**
 * What the user can change.
 *
 * Note what is *not* here: the API key and the model.
 *
 * Both used to be settings, and removing them is the product decision this file exists to
 * record. Everyone dictates on the key that ships with the app, on the model the app was
 * built against — so there is nothing for a user to configure, nothing for them to get
 * wrong, and no screen asking a person who wanted to talk into their computer to go and
 * register with Google first. The key lives in src/main/keys.ts and the model in
 * DEFAULT_GEMINI_MODEL below; both are ours to change in a release, not theirs to change in
 * a text box.
 */
export interface Settings {
  language: Language;
  /** AudioDevice.id, or '' to use the system default input. */
  deviceId: string;
  /**
   * Which keys start a dictation.
   *
   * A setting, now, and it was not before: the app watched Ctrl+Shift and that was that.
   * Two things forced the change. Ctrl+Shift is the prefix of half the shortcuts in
   * Windows, so people who live in one of those apps were cancelling dictations by
   * reflex — and a keyboard is personal enough that "the combination we chose" is not an
   * answer for a tool someone holds down a hundred times a day. See src/shared/hotkeys.ts
   * for the chord rules, which exist so a user cannot bind something that would break the
   * rest of their machine.
   */
  hotkeys: HotkeySettings;
  /**
   * Minimum recording length; anything shorter is treated as an accidental tap.
   * Deliberately has no control in Settings — the default is right for nearly everyone,
   * and the escape hatch is hand-editing settings.json (re-read on the next hotkey press).
   */
  minRecordingMs: number;
  launchAtLogin: boolean;
  /**
   * Keep the collapsed pill on screen while idle. Off means the overlay only appears
   * during a dictation — the escape hatch for exclusive-fullscreen games, which don't
   * always tolerate another always-on-top window.
   */
  showIdlePill: boolean;
  /** Append every successful transcript to the history log. */
  saveHistory: boolean;
  /**
   * Where the pill is docked. Set by dragging the pill itself, never by a Settings
   * control — a position is something you put somewhere, not something you name in a form.
   */
  overlayDock: OverlayDock;
  /**
   * How far down a side dock the pill sits, as a fraction of the work area's height — 0 is
   * the top edge, 1 the bottom, 0.5 the middle it used to be pinned to.
   *
   * A fraction rather than a pixel offset because a screen is not the size it was: a
   * resolution change, an external monitor, a taskbar that moved to the side all change the
   * work area, and 0.3 of it is still recognisably "a bit above the middle" where 320px may
   * be off the bottom of a laptop panel. Ignored by the bottom dock, which has only one
   * place to be, but kept across a visit to it so a round trip doesn't lose the level.
   */
  overlayDockY: number;
  /** Shown in the greeting. Purely cosmetic, and blank is a perfectly good value. */
  userName: string;
  style: StyleSettings;
  /** The notes pane. Persisted here so it survives a restart like everything else. */
  scratchpad: string;
  /**
   * Has the user been through the welcome flow?
   *
   * A flag of its own rather than "do they have a key", which is what this used to be:
   * the app ships with keys now, so key presence no longer distinguishes a first run from
   * a hundredth, and gating on it would show the welcome screen to nobody.
   *
   * It is only ever set at the *end* of the flow, and the flow's first step cannot be
   * passed while signed out. That is deliberate: the app cannot transcribe a word without
   * an account, so a setup that finished without one finished into a dead end.
   */
  onboarded: boolean;
}

/** Sections of the app window — the sidebar, and what the tray can open. */
export type AppSection =
  | 'dictation'
  | 'insights'
  | 'style'
  | 'scratchpad'
  | 'account'
  | 'settings'
  | 'help';

/**
 * Who is signed in.
 *
 * Note what is *not* here: any token. The Supabase session lives in the main process
 * (src/main/auth.ts) and is never sent to a renderer — the same rule that used to keep the
 * Gemini API key out of the renderer, applied to the credential that replaced it. A window
 * that draws hundreds of arbitrary transcripts has no business holding a bearer token.
 */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

/**
 * What the user's plan entitles them to, as of the last time we asked the server.
 *
 * **The unit is words per week, and it used to be dictations per day.** The fields were
 * renamed along with it rather than being left as `used`/`limit`, because a silently changed
 * unit is the kind of thing that survives a refactor and then draws "12 / 1000" under a
 * heading that says diktovka. Every consumer had to be visited; the compiler made sure it
 * was. See supabase/migrations/20260820101217_weekly_word_quota.sql for why words, and why a
 * week.
 */
export interface PlanSnapshot {
  plan: 'free' | 'pro';
  /** Words transcribed so far this week. */
  wordsUsed: number;
  /** Words allowed per week on this plan. */
  wordLimit: number;
  /**
   * When the weekly allowance resets — Monday 00:00 in Tashkent — as an ISO string.
   *
   * Sent by the server rather than worked out here, because the boundary is Postgres's to
   * define: a client that computed its own Monday would disagree with the one enforcing the
   * limit for anyone whose machine clock or timezone is off, and would do it silently.
   */
  resetsAt: string | null;
  /** When Pro runs out, as an ISO string. Null on free. */
  expiresAt: string | null;
  /** Monthly price of Pro in tiyin — read from the server so the UI can't quote a stale one. */
  priceTiyin: number;
}

/**
 * The whole of what the renderer knows about the account.
 *
 * `user: null` means signed out, which is also the state in which dictation refuses to run.
 * `plan: null` means signed in but we haven't heard back from the server yet — distinct from
 * "free", because showing someone `0 / 0` while a request is in flight reads as a bug.
 */
export interface AccountState {
  user: AuthUser | null;
  plan: PlanSnapshot | null;
  /** Set when the last sign-in or refresh failed, in Uzbek. */
  error: string;
}

/**
 * Default Gemini model.
 *
 * A Lite model rather than full Flash, and the reason is free-tier quota rather than
 * quality. Measured against a live key in August 2026, `gemini-3.6-flash` allows **20
 * requests per day** on the free tier — a dictation tool burns that before lunch, and the
 * 21st press of the hotkey fails with a quota error. The Lite models have room to spare and
 * were also the faster of the two (~1.0–1.4s against ~2.3s on a 5-second clip).
 *
 * There is no Settings box to override this any more — every install dictates on this model
 * — so the shipped default has to be one that still works on the hundredth dictation.
 * `GAPIR_ME_GEMINI_MODEL` overrides it for development; see src/main/config.ts.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';

export const DEFAULT_STYLE: StyleSettings = {
  tone: 'verbatim',
  removeFillers: true,
  punctuation: true
};

export const DEFAULT_SETTINGS: Settings = {
  language: 'uz',
  deviceId: '',
  hotkeys: DEFAULT_HOTKEYS,
  minRecordingMs: 300,
  launchAtLogin: false,
  showIdlePill: true,
  saveHistory: true,
  overlayDock: 'center',
  overlayDockY: 0.5,
  userName: '',
  style: DEFAULT_STYLE,
  scratchpad: '',
  onboarded: false
};

/** One dictation, as stored in the history log. */
export interface HistoryEntry {
  id: string;
  text: string;
  language: Language;
  /** Length of the captured audio, not of the transcription request. */
  durationMs: number;
  /** Unix epoch milliseconds. */
  createdAt: number;
}

/** What the updater knows, as surfaced in the Settings tab. */
export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'unsupported';
  /** The version being offered, once known. */
  version?: string;
  /** 0..100 while downloading. */
  percent?: number;
  message?: string;
}

/** IPC channel names, centralised so main and renderer can't drift apart. */
export const IPC = {
  /** main -> overlay renderer */
  overlayStatus: 'overlay:status',
  /**
   * main -> overlay renderer: is the cursor on the pill? The window is click-through and
   * receives no mouse events of its own, so main hit-tests the cursor and the renderer is
   * told the answer. See src/main/overlay.ts.
   */
  overlayHover: 'overlay:hover',
  /**
   * overlay renderer -> main: the pill was clicked. Toggles a hands-free dictation — start
   * when resting, stop-and-transcribe when recording — so the hotkey never has to be held.
   */
  overlayToggle: 'overlay:toggle',
  /**
   * overlay renderer -> main: the sign-in button on the pill was pressed. Opens the system
   * browser, exactly as the button in the app window does — the point of putting it on the
   * pill is that the pill is where the user already is when they find out they need it.
   */
  overlaySignIn: 'overlay:sign-in',
  /**
   * overlay renderer -> main: a drag of the pill began / ended. The renderer only reports
   * the button going down and up — main moves the window itself by polling the cursor,
   * because the renderer's screen coordinates and Electron's DIP coordinates disagree on
   * scaled displays. See beginDrag/endDrag in src/main/overlay.ts.
   */
  overlayDragStart: 'overlay:drag-start',
  overlayDragEnd: 'overlay:drag-end',
  /**
   * main -> overlay renderer: the push-to-talk chord, already formatted ("Ctrl + Shift").
   * The hover hint names the keys, and the keys are a setting now — a hint that still said
   * Ctrl+Shift to somebody who had changed it would be worse than no hint.
   */
  overlayHotkey: 'overlay:hotkey',
  /** main -> overlay renderer: which dock the pill sits in, so CSS can align the content.
   *  Also sent mid-drag with the dock the magnet is pulling toward, so the pill settles
   *  into the slot as it is carried rather than jumping into it on release. */
  overlayDock: 'overlay:dock',
  /** main -> dock-guides renderer: the three landing slots and which one is engaged. */
  dockGuides: 'dock:guides',
  /** app renderer -> main */
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  devicesList: 'devices:list',
  /** Which section the app window should open on — main -> app renderer. */
  appRoute: 'app:route',
  /** History log. */
  historyList: 'history:list',
  historyDelete: 'history:delete',
  historyClear: 'history:clear',
  historyCopy: 'history:copy',
  /** main -> app renderer, so an open window updates live as you dictate. */
  historyChanged: 'history:changed',
  /** Microphone test in the Settings tab. */
  micTestStart: 'mic:test-start',
  micTestStop: 'mic:test-stop',
  /** main -> app renderer, 0..1 RMS while the mic test runs. */
  micLevel: 'mic:level',
  /** main -> app renderer, when the test's ffmpeg dies (busy device, no permission). */
  micError: 'mic:error',
  /** ---- Shortcut test ----
   *  The welcome flow and the Sozlamalar pane both ask "do these keys light up?", and the
   *  answer has to come from the *global hook* rather than from a DOM keydown — the thing
   *  being tested is whether uiohook sees the keyboard at all, which a focused window's own
   *  key events would answer yes to even when it doesn't.
   *
   *  main only ever reports keys that belong to the chord being watched. A channel that
   *  streamed every keystroke to a renderer would be a keylogger with a nice reason. */
  hotkeyWatch: 'hotkey:watch',
  /** main -> app renderer: which of the watched chord's keys are down right now. */
  hotkeyKeys: 'hotkey:keys',
  /** Auto-update. */
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  /** main -> app renderer */
  updateStatus: 'update:status',
  /** Frameless window controls — the title bar is ours to draw, so it is ours to wire. */
  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close',
  /** main -> app renderer, so the maximise glyph matches the actual window. */
  windowState: 'window:state',
  /** ---- Account ----
   *  Sign-in happens in the system browser and comes back through the gapirme:// deep link,
   *  so `authSignIn` resolves as soon as the browser is opened — the *result* arrives later
   *  on `authChanged`. A renderer that awaits the invoke expecting a signed-in user will
   *  wait forever. */
  authGet: 'auth:get',
  authSignIn: 'auth:sign-in',
  authSignOut: 'auth:sign-out',
  authRefresh: 'auth:refresh',
  /** main -> app renderer, whenever the user or their plan changes. */
  authChanged: 'auth:changed',
  /** Opens the Payme checkout page in the system browser. */
  billingCheckout: 'billing:checkout',
  /** Misc. */
  appVersion: 'app:version',
  openExternal: 'app:open-external'
} as const;
