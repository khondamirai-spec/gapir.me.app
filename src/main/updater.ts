import { execFile } from 'node:child_process';
import { app, shell } from 'electron';
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

/** Where a release can always be downloaded by hand. */
const DOWNLOAD_PAGE = 'https://www.gapir.me/download';

/**
 * Whether this copy can update itself in place.
 *
 * Everywhere but macOS, yes. On a Mac electron-updater hands the install to Squirrel.Mac,
 * which will only swap in a new version signed by the same Apple Developer ID as the running
 * one — an ad-hoc-signed build (what we ship until there is a certificate) fails that check
 * after downloading the whole update, with an error no user can act on. So on a Mac we read
 * our own signature: a Developer ID build updates itself like everywhere else, and an ad-hoc
 * one is told a version exists and pointed at the download page. Buying the certificate
 * turns auto-update on with no code change.
 */
let selfUpdate: Promise<boolean> | null = null;
function canSelfUpdate(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(true);
  selfUpdate ??= new Promise((resolve) => {
    const bundle = process.execPath.replace(/\.app\/Contents\/MacOS\/.*$/, '.app');
    execFile('codesign', ['-dv', '--verbose=2', bundle], (_err, _stdout, stderr) => {
      const signed = /Authority=Developer ID Application/.test(stderr ?? '');
      console.log(`[updater] macOS signature: ${signed ? 'Developer ID' : 'ad-hoc'} — ${signed ? 'self-update' : 'manual download'}`);
      resolve(signed);
    });
  });
  return selfUpdate;
}

let status: UpdateStatus = { state: 'idle' };
let listener: ((status: UpdateStatus) => void) | null = null;
let interval: NodeJS.Timeout | null = null;
let downloaded = false;

export function onUpdateStatus(cb: (status: UpdateStatus) => void): void {
  listener = cb;
  cb(status);
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
  const inPlace = await canSelfUpdate();
  updater.autoDownload = inPlace;
  updater.autoInstallOnAppQuit = inPlace;

  updater.on('checking-for-update', () => set({ state: 'checking' }));
  updater.on('update-not-available', () => set({ state: 'idle' }));
  updater.on('update-available', (info) =>
    set({ state: 'available', version: info.version, manual: !inPlace })
  );
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
  if (status.manual) {
    void shell.openExternal(DOWNLOAD_PAGE);
    return;
  }
  const updater = await autoUpdater();
  if (!updater || !downloaded) return;
  updater.quitAndInstall();
}

export function stopUpdater(): void {
  if (interval) clearInterval(interval);
  interval = null;
}
