import { spawn } from 'node:child_process';
import Store from 'electron-store';
import { app } from 'electron';
import { sanitizeHotkeys, type HotkeySettings } from '@shared/hotkeys';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_SETTINGS,
  DEFAULT_STYLE,
  type OverlayDock,
  type Settings,
  type StyleSettings
} from '@shared/types';

/**
 * Persisted settings.
 *
 * Everything in here is plaintext, and that is now true without an asterisk: there is no
 * credential to protect. The app dictates through the Supabase proxy, whose key lives on the
 * server, so nothing a user types on the Settings screen is a secret — a device id, a name,
 * a scratchpad and three switches. The safeStorage/DPAPI machinery that used to guard the
 * user's own API key went with the field it guarded (the session it now guards lives in
 * src/main/auth.ts, not here).
 */

interface StoreShape {
  language: Settings['language'];
  deviceId: string;
  hotkeys: HotkeySettings;
  minRecordingMs: number;
  launchAtLogin: boolean;
  showIdlePill: boolean;
  saveHistory: boolean;
  overlayDock: OverlayDock;
  userName: string;
  style: StyleSettings;
  scratchpad: string;
  onboarded: boolean;
}

const store = new Store<StoreShape>({
  name: 'settings',
  defaults: { ...DEFAULT_SETTINGS }
});

/**
 * Drop settings that no version of this app will ever read again.
 *
 * Not tidiness. `apiKeyEnc` and `geminiKeyEnc` held encrypted API keys — one for a provider
 * this app no longer contacts, one for a field the Settings screen no longer has — and
 * leaving a credential on disk that nothing can use is the kind of thing that is nobody's
 * fault right up until it is. `conf` preserves unknown keys, so without this they would sit
 * in settings.json for the life of the install. The rest are dead weight from the vocabulary
 * and shortcut panes, removed in the same change.
 */
function dropLegacyKeys(): void {
  const dead = [
    'apiKeyEnc',
    'provider',
    'geminiKeyEnc',
    'geminiModel',
    'geminiRealtime',
    'dictionary',
    'snippets'
  ] as const;
  for (const key of dead) {
    if (store.has(key as never)) store.delete(key as never);
  }
}

dropLegacyKeys();

/**
 * The name Windows knew this app by before 2026-08-20.
 *
 * Electron names the "run at login" registry value after the **AppUserModelId**, not after
 * `app.getName()` — verifiable on any machine that had an old build: the value under
 * `HKCU\...\CurrentVersion\Run` was literally `uz.whisperuz.app`. So renaming the appId
 * (see electron-builder.yml) moves the name Electron looks under, and every entry written by
 * an older build becomes unreachable: `setLoginItemSettings({ openAtLogin: false })` deletes
 * the *new* name and leaves the old one behind forever.
 *
 * That is not a cosmetic leak. The stranded entry points at the executable path of whatever
 * install wrote it — on the machine this was found on, a `Programs\Whisper UZ\` directory
 * that no longer exists — so Windows tries to start a missing program at every login, and
 * turning the setting off in the app does nothing about it.
 */
const LEGACY_AUTOSTART_NAME = 'uz.whisperuz.app';

/**
 * Remove the autostart entry an older build left under the old AppUserModelId.
 *
 * Shelling out to `reg` because Electron exposes no registry API and
 * `setLoginItemSettings` can only address the current AUMID — which is precisely the thing
 * that changed. `reg` is present on every Windows install, exits non-zero when the value is
 * already gone (the common case, and not worth a line in the log), and can do nothing worse
 * than fail: the value name is a constant, never anything a user typed.
 *
 * Deliberately not awaited and never allowed to throw. A leftover registry value is worth
 * cleaning up; it is not worth a main process that fails to start.
 */
export function dropLegacyAutostart(): void {
  if (process.platform !== 'win32') return;
  try {
    const child = spawn(
      'reg',
      [
        'delete',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        '/v',
        LEGACY_AUTOSTART_NAME,
        '/f'
      ],
      { windowsHide: true, stdio: 'ignore' }
    );
    child.on('error', () => {
      /* `reg` missing is not a thing worth reporting, or recovering from. */
    });
    child.on('exit', (code) => {
      // 0 means a value was actually deleted, which happens exactly once per machine and is
      // worth saying — a login that stopped trying to launch a deleted executable is the kind
      // of thing someone will otherwise notice and wonder about.
      if (code === 0) console.log(`[config] removed the stale "${LEGACY_AUTOSTART_NAME}" autostart entry`);
    });
  } catch {
    /* see above */
  }
}

/**
 * Settings that were written by an older build, or hand-edited, can be missing fields or
 * hold the wrong type. Reading them back through a guard costs nothing and turns "the app
 * won't start after an update" into "that one setting went back to its default".
 */
function readStyle(): StyleSettings {
  const raw = store.get('style') as Partial<StyleSettings> | undefined;
  const tone = raw?.tone;
  return {
    tone: tone === 'tidy' || tone === 'formal' || tone === 'verbatim' ? tone : DEFAULT_STYLE.tone,
    removeFillers: typeof raw?.removeFillers === 'boolean' ? raw.removeFillers : DEFAULT_STYLE.removeFillers,
    punctuation: typeof raw?.punctuation === 'boolean' ? raw.punctuation : DEFAULT_STYLE.punctuation
  };
}

/** A fraction, clamped — a corrupt or hand-edited value must not park the pill off screen. */
function readDockY(): number {
  const raw = store.get('overlayDockY') as unknown;
  return typeof raw === 'number' && Number.isFinite(raw)
    ? Math.min(1, Math.max(0, raw))
    : DEFAULT_SETTINGS.overlayDockY;
}

function readDock(): OverlayDock {
  const raw = store.get('overlayDock') as unknown;
  return raw === 'left' || raw === 'right' || raw === 'center' ? raw : DEFAULT_SETTINGS.overlayDock;
}

export function getSettings(): Settings {
  return {
    language: store.get('language'),
    deviceId: store.get('deviceId'),
    hotkeys: sanitizeHotkeys(store.get('hotkeys')),
    minRecordingMs: store.get('minRecordingMs'),
    launchAtLogin: store.get('launchAtLogin'),
    showIdlePill: store.get('showIdlePill'),
    saveHistory: store.get('saveHistory'),
    overlayDock: readDock(),
    overlayDockY: readDockY(),
    userName: store.get('userName'),
    style: readStyle(),
    scratchpad: store.get('scratchpad'),
    onboarded: store.get('onboarded')
  };
}

export function setSettings(patch: Partial<Settings>): void {
  if (patch.language !== undefined) store.set('language', patch.language);
  if (patch.deviceId !== undefined) store.set('deviceId', patch.deviceId);
  // Sanitised on the way in as well as on the way out. A renderer is not a trusted source
  // of a chord — and a chord that reached the hook malformed would be one the user could
  // neither trigger nor see well enough to fix.
  if (patch.hotkeys !== undefined) store.set('hotkeys', sanitizeHotkeys(patch.hotkeys));
  if (patch.minRecordingMs !== undefined)
    store.set('minRecordingMs', Math.min(5_000, Math.max(0, Math.round(patch.minRecordingMs) || 0)));
  if (patch.showIdlePill !== undefined) store.set('showIdlePill', patch.showIdlePill);
  if (patch.saveHistory !== undefined) store.set('saveHistory', patch.saveHistory);
  if (patch.overlayDock !== undefined) store.set('overlayDock', patch.overlayDock);
  if (patch.overlayDockY !== undefined)
    store.set('overlayDockY', Math.min(1, Math.max(0, patch.overlayDockY)));
  if (patch.userName !== undefined) store.set('userName', patch.userName.trim().slice(0, 40));
  if (patch.style !== undefined) store.set('style', { ...readStyle(), ...patch.style });
  if (patch.scratchpad !== undefined) store.set('scratchpad', patch.scratchpad.slice(0, 200_000));
  if (patch.onboarded !== undefined) store.set('onboarded', patch.onboarded);
  if (patch.launchAtLogin !== undefined) {
    store.set('launchAtLogin', patch.launchAtLogin);
    app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin, args: ['--hidden'] });
  }
}

/**
 * The Gemini model every dictation runs on.
 *
 * Not a setting: see the note on `Settings` in src/shared/types.ts. The environment variable
 * is a development convenience — `npm run dev` loads .env into the child process, and a
 * packaged build on someone else's machine sees neither.
 */
export function geminiModel(): string {
  return process.env.GAPIR_ME_GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}

/**
 * Try Gemini's Live API socket before falling back to the batch endpoint.
 *
 * Off unless a developer asks for it. The Live API is built for conversation rather than
 * dictation and its model ids churn, so it is the experiment, not the path users get — see
 * src/main/stt/gemini-live.ts.
 */
export function geminiRealtimeEnabled(): boolean {
  return process.env.GAPIR_ME_GEMINI_REALTIME === '1';
}

/**
 * Where the key doing the transcribing comes from.
 *
 * `env`  — GEMINI_API_KEY/GOOGLE_API_KEY from a developer's .env.
 * `none` — no key in this process. On an installed copy that is the *normal* state: every
 *          dictation goes through the Supabase proxy, and the key lives on the server.
 *
 * There used to be a third origin, `pool` — keys shipped inside the installer, from before
 * the app had a backend. Phase 5 of docs/supabase-setup.md removed it.
 */
export type KeyOrigin = 'env' | 'none';

/**
 * The key in this process's own hands, if any.
 *
 * A developer convenience only: a packaged build has no environment to read, so on every
 * installed copy this is empty and the dictation is routed through the proxy instead
 * (src/main/state.ts). The branch exists so that working on the app doesn't spend real
 * users' quota. GOOGLE_API_KEY is accepted alongside GEMINI_API_KEY because Google's own
 * SDKs read both and people already have one or the other in their .env.
 */
export function resolveGeminiKey(): { key: string; origin: KeyOrigin } {
  const env = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  if (env) return { key: env, origin: 'env' };
  return { key: '', origin: 'none' };
}
