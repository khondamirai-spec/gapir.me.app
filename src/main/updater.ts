import { app } from 'electron';
import type { UpdateStatus } from '@shared/types';

/**
 * Auto-update against GitHub Releases.
 *
 * The build is unsigned, which matters here: electron-updater normally checks that the
 * downloaded installer carries the same publisher signature as the running app, and with no
 * certificate that check can only fail. `verifyUpdateCodeSignature: false` in
 * electron-builder.yml turns it off; integrity still rests on the SHA-512 recorded in
 * latest.yml, which is served over TLS from the release the app is already trusting.
 *
 * electron-updater is loaded lazily and defensively — it is a no-op in dev (there is no
 * app-update.yml to read) and it must never be the reason the app fails to boot.
 */

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let status: UpdateStatus = { state: 'idle' };
let listener: ((status: UpdateStatus) => void) | null = null;
let interval: NodeJS.Timeout | null = null;
let downloaded = false;

export function onUpdateStatus(cb: (status: UpdateStatus) => void): void {
  listener = cb;
  cb(status);
}

export function getUpdateStatus(): UpdateStatus {
  return status;
}

function set(next: UpdateStatus): void {
  status = next;
  listener?.(next);
}

/** `null` in dev, or if electron-updater can't load — every caller treats that as "off". */
async function autoUpdater(): Promise<typeof import('electron-updater').autoUpdater | null> {
  if (!app.isPackaged) return null;
  try {
    const { autoUpdater } = await import('electron-updater');
    return autoUpdater;
  } catch (err) {
    console.warn('[updater] unavailable:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function initUpdater(): Promise<void> {
  const updater = await autoUpdater();
  if (!updater) {
    set({ state: 'unsupported', message: app.isPackaged ? 'Yangilash mavjud emas' : 'Dev rejimi' });
    return;
  }

  // Downloading is fine unattended; installing is not — it restarts the app, which would
  // yank the window out from under whatever the user is dictating into.
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  updater.on('checking-for-update', () => set({ state: 'checking' }));
  updater.on('update-not-available', () => set({ state: 'idle' }));
  updater.on('update-available', (info) => set({ state: 'available', version: info.version }));
  updater.on('download-progress', (p) =>
    set({ state: 'downloading', percent: Math.round(p.percent), version: status.version })
  );
  updater.on('update-downloaded', (info) => {
    downloaded = true;
    set({ state: 'ready', version: info.version });
  });
  updater.on('error', (err) => set({ state: 'error', message: err.message }));

  void checkForUpdates();
  interval = setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS);
}

export async function checkForUpdates(): Promise<void> {
  const updater = await autoUpdater();
  if (!updater) return;
  try {
    await updater.checkForUpdates();
  } catch (err) {
    set({ state: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

/** Restart into the new version. Only meaningful once `state` is 'ready'. */
export async function installUpdate(): Promise<void> {
  const updater = await autoUpdater();
  if (!updater || !downloaded) return;
  updater.quitAndInstall();
}

export function stopUpdater(): void {
  if (interval) clearInterval(interval);
  interval = null;
}
