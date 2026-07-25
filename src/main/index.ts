import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  clipboard,
  ipcMain,
  nativeImage,
  shell,
  dialog
} from 'electron';
import { IPC, type Language, type Settings } from '@shared/types';
import { createOverlay, destroyOverlay, setIdleVisible } from './overlay';
import { dictation } from './state';
import { getSettings, resolveApiKey, setSettings } from './config';
import { refreshDevices } from './audio';
import {
  clearHistory,
  historyFilePath,
  listHistory,
  onHistoryChanged,
  removeHistory
} from './history';
import { startMicTest, stopMicTest } from './mic-test';
import { verifyApiKey } from './stt/verify-key';
import {
  checkForUpdates,
  initUpdater,
  installUpdate,
  onUpdateStatus,
  stopUpdater
} from './updater';

/**
 * App bootstrap: single instance, tray, the app window, IPC.
 * There is no main window in the usual sense — this app lives in the tray and the overlay,
 * and the window is somewhere you visit to read your history or change a setting.
 */

export type AppTab = 'history' | 'settings';

let tray: Tray | null = null;
let appWin: BrowserWindow | null = null;

/**
 * A second instance would install a second keyboard hook and double every dictation, so it
 * hands its arguments to the running copy and leaves.
 *
 * The flag matters: `app.quit()` is a request, not a return, so without gating the whole
 * bootstrap on it the loser instance goes on to reach `whenReady` and call
 * `uIOhook.start()` while it is already tearing down — and uiohook-napi answers that by
 * aborting the process with a native fatal error rather than throwing.
 */
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
}

app.on('second-instance', () => openApp('history'));

// Keep the app alive with no windows open — it's a tray app. Merely registering a
// listener suppresses Electron's default quit-on-last-window-closed behaviour.
app.on('window-all-closed', () => {});

function iconPath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, name)
    : join(__dirname, '../../resources', name);
}

function openApp(tab: AppTab): void {
  if (appWin && !appWin.isDestroyed()) {
    appWin.show();
    appWin.focus();
    appWin.webContents.send(IPC.appRoute, tab);
    return;
  }

  appWin = new BrowserWindow({
    width: 720,
    // Tall enough that the three welcome steps fit without scrolling — that flow is the
    // first thing a new user sees, and a hidden step 3 is a step nobody does.
    height: 660,
    minWidth: 560,
    minHeight: 420,
    title: 'Whisper UZ',
    backgroundColor: '#17171b',
    autoHideMenuBar: true,
    icon: iconPath('icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // The tab is in the hash so it survives the initial load; later switches come over IPC.
  if (process.env.ELECTRON_RENDERER_URL) {
    void appWin.loadURL(`${process.env.ELECTRON_RENDERER_URL}/app/index.html#${tab}`);
  } else {
    void appWin.loadFile(join(__dirname, '../renderer/app/index.html'), { hash: tab });
  }

  appWin.on('closed', () => {
    appWin = null;
    // Nothing is listening for levels any more, and the test holds the microphone open.
    stopMicTest();
  });
}

/** Send to the app window if it's open; a closed window re-reads everything on open. */
function toAppWindow(channel: string, payload?: unknown): void {
  if (appWin && !appWin.isDestroyed()) appWin.webContents.send(channel, payload);
}

function buildTray(): void {
  const image = nativeImage.createFromPath(iconPath('tray.png'));
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('Whisper UZ — Ctrl+Caps Lock bosib gapiring');

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Whisper UZ ${app.getVersion()}`, enabled: false },
      { type: 'separator' },
      { label: 'Tarix…', click: () => openApp('history') },
      { label: 'Sozlamalar…', click: () => openApp('settings') },
      {
        label: 'Yangilanishlarni tekshirish',
        click: () => {
          void checkForUpdates();
          openApp('settings');
        }
      },
      { type: 'separator' },
      {
        label: 'Loglar papkasi',
        click: () => void shell.openPath(app.getPath('userData'))
      },
      { type: 'separator' },
      { label: 'Chiqish', click: () => app.quit() }
    ])
  );

  tray.on('click', () => openApp('history'));
  tray.on('double-click', () => openApp('history'));
}

function registerIpc(): void {
  ipcMain.handle(IPC.settingsGet, () => {
    const s = getSettings();
    // Never ship the raw key to a renderer; a presence flag is all the UI needs.
    return { ...s, apiKey: s.apiKey ? '••••••••' : '' };
  });

  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<Settings>) => {
    // The masked placeholder means "unchanged" — don't overwrite the real key with dots.
    if (patch.apiKey === '••••••••') delete patch.apiKey;
    try {
      setSettings(patch);
      // Applied here rather than inside config.ts so that module stays free of UI concerns.
      if (patch.showIdlePill !== undefined) setIdleVisible(patch.showIdlePill);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Opening the app is also the natural moment to notice newly plugged-in microphones.
  ipcMain.handle(IPC.devicesList, () => refreshDevices());

  ipcMain.handle(IPC.testKey, (_e, apiKey?: string, language?: Language) => {
    // An empty or masked field means "test the key you already have".
    const key = apiKey && apiKey !== '••••••••' ? apiKey : resolveApiKey();
    return verifyApiKey(key, language ?? getSettings().language);
  });

  ipcMain.handle(IPC.historyList, () => ({
    entries: listHistory(),
    filePath: historyFilePath()
  }));

  ipcMain.handle(IPC.historyDelete, (_e, id: string) => removeHistory(id));
  ipcMain.handle(IPC.historyClear, () => clearHistory());

  ipcMain.handle(IPC.historyCopy, (_e, text: string) => {
    // Deliberately Electron's clipboard from main rather than the renderer's: this keeps
    // every clipboard write in the process that also runs the paste path in inject.ts,
    // so there is one place to look when the clipboard misbehaves.
    clipboard.writeText(text);
  });

  ipcMain.handle(IPC.micTestStart, (_e, deviceId: string) => {
    startMicTest(deviceId, {
      onLevel: (level) => toAppWindow(IPC.micLevel, level),
      onError: (message) => {
        console.warn('[mic-test]', message);
        toAppWindow(IPC.micError, message);
      }
    });
  });

  ipcMain.handle(IPC.micTestStop, () => stopMicTest());

  ipcMain.handle(IPC.updateCheck, () => checkForUpdates());
  ipcMain.handle(IPC.updateInstall, () => installUpdate());
  ipcMain.handle(IPC.appVersion, () => app.getVersion());

  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    // Never hand an arbitrary string to the shell — a file: or ms-msdt: URL from a
    // compromised renderer would execute rather than browse.
    if (!/^https:\/\//i.test(url)) return;
    void shell.openExternal(url);
  });
}

function bootstrap(): void {
  app.setAppUserModelId('uz.whisperuz.app');

  registerIpc();
  createOverlay();
  setIdleVisible(getSettings().showIdlePill);
  buildTray();

  // Keep an open window in step with dictations happening in other apps.
  onHistoryChanged(() => toAppWindow(IPC.historyChanged));
  onUpdateStatus((status) => toAppWindow(IPC.updateStatus, status));
  void initUpdater();

  // Populate the device cache up front — enumeration shells out to ffmpeg and is far too
  // slow to run on the hotkey path.
  void refreshDevices().then((devices) => {
    console.log(`[audio] ${devices.length} input device(s):`, devices.map((d) => d.label));
  });

  try {
    dictation.init();
  } catch (err) {
    dialog.showErrorBox(
      'Whisper UZ',
      `Klaviatura hooki ishga tushmadi:\n\n${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Launched by the login item — stay quiet in the tray. Otherwise a first run with no key
  // opens straight onto the welcome flow, which is the only way anyone gets started.
  if (!process.argv.includes('--hidden') && !getSettings().apiKey) {
    openApp('settings');
  }
}

if (isPrimaryInstance) {
  app.whenReady().then(bootstrap);
}

app.on('before-quit', () => {
  stopUpdater();
  stopMicTest();
  dictation.shutdown();
  destroyOverlay();
  tray?.destroy();
});
