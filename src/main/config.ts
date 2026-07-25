import Store from 'electron-store';
import { app, safeStorage } from 'electron';
import { DEFAULT_SETTINGS, type Settings } from '@shared/types';

/**
 * Persisted settings.
 *
 * The API key is encrypted at rest with Electron's safeStorage (DPAPI on Windows), so it
 * isn't sitting in plaintext in %APPDATA%. If the OS keyring is unavailable we refuse to
 * write the key rather than silently downgrading to plaintext — the caller surfaces that.
 */

interface StoreShape {
  /** base64 of the safeStorage-encrypted key. */
  apiKeyEnc: string;
  language: Settings['language'];
  deviceId: string;
  minRecordingMs: number;
  launchAtLogin: boolean;
  showIdlePill: boolean;
  saveHistory: boolean;
}

const store = new Store<StoreShape>({
  name: 'settings',
  defaults: {
    apiKeyEnc: '',
    ...DEFAULT_SETTINGS
  }
});

export function getApiKey(): string {
  const enc = store.get('apiKeyEnc');
  if (!enc) return '';
  if (!safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    // Key was encrypted under a different OS user/profile — treat as unset.
    return '';
  }
}

export function setApiKey(key: string): void {
  if (!key) {
    store.set('apiKeyEnc', '');
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS encryption is unavailable, refusing to store the API key in plaintext');
  }
  store.set('apiKeyEnc', safeStorage.encryptString(key).toString('base64'));
}

export function getSettings(): Settings {
  return {
    apiKey: getApiKey(),
    language: store.get('language'),
    deviceId: store.get('deviceId'),
    minRecordingMs: store.get('minRecordingMs'),
    launchAtLogin: store.get('launchAtLogin'),
    showIdlePill: store.get('showIdlePill'),
    saveHistory: store.get('saveHistory')
  };
}

export function setSettings(patch: Partial<Settings>): void {
  if (patch.apiKey !== undefined) setApiKey(patch.apiKey);
  if (patch.language !== undefined) store.set('language', patch.language);
  if (patch.deviceId !== undefined) store.set('deviceId', patch.deviceId);
  if (patch.minRecordingMs !== undefined) store.set('minRecordingMs', patch.minRecordingMs);
  if (patch.showIdlePill !== undefined) store.set('showIdlePill', patch.showIdlePill);
  if (patch.saveHistory !== undefined) store.set('saveHistory', patch.saveHistory);
  if (patch.launchAtLogin !== undefined) {
    store.set('launchAtLogin', patch.launchAtLogin);
    app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin, args: ['--hidden'] });
  }
}

/**
 * Dev convenience: fall back to AISHA_API_KEY from the environment when nothing has been
 * saved yet, so `npm run dev` works without clicking through Settings first.
 */
export function resolveApiKey(): string {
  return getApiKey() || process.env.AISHA_API_KEY || '';
}
