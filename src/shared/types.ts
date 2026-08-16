/** Shared between main and renderers. Keep this dependency-free. */

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

export interface OverlayStatus {
  state: AppState;
  /** 0..1 RMS level, only meaningful while RECORDING. */
  level: number;
  /** Live partial transcript while RECORDING/TRANSCRIBING, if the provider sends them. */
  partial: string;
  /** Human-readable message, only set in ERROR. */
  message: string;
}

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

/** What the user's plan entitles them to, as of the last time we asked the server. */
export interface PlanSnapshot {
  plan: 'free' | 'pro';
  /** Dictations used today. */
  used: number;
  /** Dictations allowed today on this plan. */
  limit: number;
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
 * `WHISPER_UZ_GEMINI_MODEL` overrides it for development; see src/main/config.ts.
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
  minRecordingMs: 300,
  launchAtLogin: false,
  showIdlePill: true,
  saveHistory: true,
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
