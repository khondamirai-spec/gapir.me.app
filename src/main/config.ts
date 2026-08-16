import Store from 'electron-store';
import { app } from 'electron';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_SETTINGS,
  DEFAULT_STYLE,
  type Settings,
  type StyleSettings
} from '@shared/types';
import { pickBundledKey } from './keys';

/**
 * Persisted settings.
 *
 * Everything in here is plaintext, and that is now true without an asterisk: there is no
 * credential to protect. The app dictates on the keys it ships with (src/main/keys.ts), so
 * nothing a user types on the Settings screen is a secret — a device id, a name, a
 * scratchpad and three switches. The safeStorage/DPAPI machinery that used to guard the
 * user's own API key went with the field it guarded.
 */

interface StoreShape {
  language: Settings['language'];
  deviceId: string;
  minRecordingMs: number;
  launchAtLogin: boolean;
  showIdlePill: boolean;
  saveHistory: boolean;
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

export function getSettings(): Settings {
  return {
    language: store.get('language'),
    deviceId: store.get('deviceId'),
    minRecordingMs: store.get('minRecordingMs'),
    launchAtLogin: store.get('launchAtLogin'),
    showIdlePill: store.get('showIdlePill'),
    saveHistory: store.get('saveHistory'),
    userName: store.get('userName'),
    style: readStyle(),
    scratchpad: store.get('scratchpad'),
    onboarded: store.get('onboarded')
  };
}

export function setSettings(patch: Partial<Settings>): void {
  if (patch.language !== undefined) store.set('language', patch.language);
  if (patch.deviceId !== undefined) store.set('deviceId', patch.deviceId);
  if (patch.minRecordingMs !== undefined)
    store.set('minRecordingMs', Math.min(5_000, Math.max(0, Math.round(patch.minRecordingMs) || 0)));
  if (patch.showIdlePill !== undefined) store.set('showIdlePill', patch.showIdlePill);
  if (patch.saveHistory !== undefined) store.set('saveHistory', patch.saveHistory);
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
  return process.env.WHISPER_UZ_GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}

/**
 * Try Gemini's Live API socket before falling back to the batch endpoint.
 *
 * Off unless a developer asks for it. The Live API is built for conversation rather than
 * dictation and its model ids churn, so it is the experiment, not the path users get — see
 * src/main/stt/gemini-live.ts.
 */
export function geminiRealtimeEnabled(): boolean {
  return process.env.WHISPER_UZ_GEMINI_REALTIME === '1';
}

/**
 * Where the key doing the transcribing comes from.
 *
 * `pool` — one of the keys shipped with the app, the case every installed copy is in.
 * `env`  — GEMINI_API_KEY/GOOGLE_API_KEY from a developer's .env.
 * `none` — neither, the only state in which dictation cannot work at all.
 *
 * The distinction is not cosmetic: only a pool key may be rotated when it comes back spent
 * (src/main/state.ts). Rotating away from a developer's own key would hide the one fact they
 * need about their own account.
 */
export type KeyOrigin = 'pool' | 'env' | 'none';

/**
 * The key that will actually do the transcribing.
 *
 * A developer's own key first, then the pool the app ships with. The order looks backwards
 * for a product where everyone shares one key, and it isn't: a packaged build has no
 * environment to read, so on every installed copy the first branch is empty and the pool is
 * the answer. The branch exists so that working on the app doesn't spend the keys real users
 * are dictating on. GOOGLE_API_KEY is accepted alongside GEMINI_API_KEY because Google's own
 * SDKs read both and people already have one or the other in their .env.
 */
export function resolveGeminiKey(): { key: string; origin: KeyOrigin } {
  const env = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  if (env) return { key: env, origin: 'env' };

  const bundled = pickBundledKey();
  if (bundled) return { key: bundled, origin: 'pool' };

  return { key: '', origin: 'none' };
}
