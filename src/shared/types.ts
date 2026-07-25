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

export interface Settings {
  apiKey: string;
  language: Language;
  /** AudioDevice.id, or '' to use the system default input. */
  deviceId: string;
  /** Minimum recording length; anything shorter is treated as an accidental tap. */
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
}

export const DEFAULT_SETTINGS: Omit<Settings, 'apiKey'> = {
  language: 'uz',
  deviceId: '',
  minRecordingMs: 300,
  launchAtLogin: false,
  showIdlePill: true,
  saveHistory: true
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
  /** app renderer -> main */
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  devicesList: 'devices:list',
  testKey: 'settings:test-key',
  /** Which tab the app window should open on — main -> app renderer. */
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
  /** Misc. */
  appVersion: 'app:version',
  openExternal: 'app:open-external'
} as const;
