// FIRST, and it has to be. This import decides where `userData` is *as a side effect of
// being imported*, and several modules below build a store or a log file out of that path
// while they are being imported too. ES modules evaluate in import order, so moving this
// line down is not a formatting change — it silently sends everything back to the old
// folder. See src/main/app-paths.ts.
import { pathsNote } from './app-paths';
import { join, resolve } from 'node:path';
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
import { IPC, type AppSection, type Settings } from '@shared/types';
import {
  beginDrag,
  createOverlay,
  destroyOverlay,
  endDrag,
  setDock,
  setHotkeyHint,
  setIdleVisible
} from './overlay';
import { hotkey } from './hotkey';
import { formatChord } from '@shared/hotkeys';
import { dictation } from './state';
import { dropLegacyAutostart, getSettings, setSettings } from './config';
import { refreshDevices } from './audio';
import {
  clearHistory,
  historyFilePath,
  listHistory,
  onHistoryChanged,
  removeHistory
} from './history';
import { startMicTest, stopMicTest } from './mic-test';
import { initLogger, logDirectory } from './logger';
import {
  accountState,
  completeSignIn,
  initAuth,
  onAccountChanged,
  refreshPlan,
  signIn,
  signOut
} from './auth';
import { openCheckout } from './billing';
import { AUTH_PROTOCOL } from './supabase-config';
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

/**
 * The sign-in callback arrives here, and only here.
 *
 * On Windows a `gapirme://` link launches a *second* copy of the app with the URL as an argv
 * entry. That copy loses the single-instance lock and quits — so if the URL were not forwarded
 * and read here, every sign-in would silently do nothing. The lock and the deep link are one
 * mechanism, which is worth knowing before touching either.
 *
 * Scanned rather than indexed because the position of the URL in argv is not ours to predict:
 * Electron adds its own arguments, and a packaged build's argv differs from a dev run's.
 */
function handleDeepLink(argv: string[]): boolean {
  const url = argv.find((arg) => arg.startsWith(`${AUTH_PROTOCOL}://`));
  if (!url) return false;
  void completeSignIn(url).then((handled) => {
    // Bring the window forward so the user sees they are signed in, rather than being left
    // looking at the browser tab that sent them here.
    if (handled) openApp('account');
  });
  return true;
}

app.on('second-instance', (_event, argv) => {
  if (handleDeepLink(argv)) return;
  openApp('dictation');
});

// macOS delivers deep links as an event instead of argv. Harmless on Windows, and it means
// the auth flow is already correct on the day the four platform files get their branches.
app.on('open-url', (event, url) => {
  event.preventDefault();
  void completeSignIn(url).then((handled) => {
    if (handled) openApp('account');
  });
});

// Keep the app alive with no windows open — it's a tray app. Merely registering a
// listener suppresses Electron's default quit-on-last-window-closed behaviour.
app.on('window-all-closed', () => {});

function iconPath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, name)
    : join(__dirname, '../../resources', name);
}

function openApp(section: AppSection): void {
  if (appWin && !appWin.isDestroyed()) {
    if (appWin.isMinimized()) appWin.restore();
    appWin.show();
    appWin.focus();
    appWin.webContents.send(IPC.appRoute, section);
    return;
  }

  appWin = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 880,
    minHeight: 560,
    title: 'gapir me',
    // The title bar is drawn in the renderer, so the frame has to go. Everything that a
    // frame used to do — drag, minimise, maximise, close — is wired over IPC below, and
    // the drag region is the `-webkit-app-region: drag` header in the app's HTML.
    frame: false,
    // Matches --paper in the app's stylesheet, so a slow first paint isn't a flash of
    // black. Change one and change the other.
    backgroundColor: '#ffeee0',
    autoHideMenuBar: true,
    icon: iconPath('icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // The section is in the hash so it survives the initial load; later switches come over IPC.
  if (process.env.ELECTRON_RENDERER_URL) {
    void appWin.loadURL(`${process.env.ELECTRON_RENDERER_URL}/app/index.html#${section}`);
  } else {
    void appWin.loadFile(join(__dirname, '../renderer/app/index.html'), { hash: section });
  }

  // Without a frame the maximise glyph is ours to keep truthful, and the window can be
  // maximised by ways we never hear about otherwise (Win+Up, a double-click on the header,
  // Aero Snap).
  const sendWindowState = (): void => toAppWindow(IPC.windowState, appWin?.isMaximized() ?? false);
  appWin.on('maximize', sendWindowState);
  appWin.on('unmaximize', sendWindowState);

  appWin.on('closed', () => {
    appWin = null;
    // Nothing is listening for levels any more, and the test holds the microphone open.
    stopMicTest();
    // Likewise the shortcut test: the window that asked for key reports is gone, and a
    // watch nobody reads is a watch nobody remembers to turn off.
    hotkey.watch([]);
  });
}

/** The pill's hover hint names the user's own chord; keep the two in step. */
function publishHotkeyHint(): void {
  setHotkeyHint(formatChord(getSettings().hotkeys.pushToTalk));
}

/** Send to the app window if it's open; a closed window re-reads everything on open. */
function toAppWindow(channel: string, payload?: unknown): void {
  if (appWin && !appWin.isDestroyed()) appWin.webContents.send(channel, payload);
}

function buildTray(): void {
  const image = nativeImage.createFromPath(iconPath('tray.png'));
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip(`gapir me — ${formatChord(getSettings().hotkeys.pushToTalk)} bosib gapiring`);

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `gapir me ${app.getVersion()}`, enabled: false },
      { type: 'separator' },
      { label: 'Diktovka…', click: () => openApp('dictation') },
      { label: 'Statistika…', click: () => openApp('insights') },
      { label: 'Hisob…', click: () => openApp('account') },
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
        click: () => void shell.openPath(logDirectory())
      },
      { type: 'separator' },
      { label: 'Chiqish', click: () => app.quit() }
    ])
  );

  tray.on('click', () => openApp('dictation'));
  tray.on('double-click', () => openApp('dictation'));
}

function registerIpc(): void {
  // A click on the pill toggles a hands-free dictation; the state machine decides what the
  // click means, the pill only reports it.
  ipcMain.handle(IPC.overlayToggle, () => dictation.toggle());

  // The Google button on the pill. Same call as the app window's, and the same contract:
  // it resolves when the browser opens, not when the user is signed in.
  ipcMain.handle(IPC.overlaySignIn, async () => {
    const result = await signIn();
    if (result.ok) dictation.noteSigningIn();
  });

  // Dragging the pill to a new dock. The renderer reports only the button going down and
  // up; the window is moved and snapped in overlay.ts, and the chosen dock is persisted
  // here so the pill comes back where it was left.
  ipcMain.handle(IPC.overlayDragStart, () => beginDrag());
  ipcMain.handle(IPC.overlayDragEnd, () => {
    const dropped = endDrag();
    if (dropped) setSettings({ overlayDock: dropped.dock, overlayDockY: dropped.y });
  });

  // Nothing is filtered on the way out any more: the settings hold no credential, because
  // the key the app dictates on is the app's rather than the user's. See src/main/config.ts.
  ipcMain.handle(IPC.settingsGet, (): Settings => getSettings());

  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<Settings>) => {
    try {
      setSettings(patch);
      // Applied here rather than inside config.ts so that module stays free of UI concerns.
      if (patch.showIdlePill !== undefined) setIdleVisible(patch.showIdlePill);
      // A chord is stored *and* installed: the hook keeps its own copy, and the pill's hint
      // names the keys. Read back through getSettings rather than trusting `patch`, which
      // may hold a chord setSettings sanitised on the way in.
      if (patch.hotkeys !== undefined) {
        dictation.applyHotkeys();
        publishHotkeyHint();
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Opening the app is also the natural moment to notice newly plugged-in microphones.
  ipcMain.handle(IPC.devicesList, () => refreshDevices());

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

  // "Press the keys — do they light up?", answered by the global hook rather than by the
  // window's own key events, because whether the hook sees the keyboard at all is exactly
  // what the welcome flow is asking. main reports only the chord it was handed.
  ipcMain.handle(IPC.hotkeyWatch, (_e, chord: unknown) => {
    hotkey.watch(Array.isArray(chord) ? chord.filter((k): k is string => typeof k === 'string') : []);
  });

  ipcMain.handle(IPC.updateCheck, () => checkForUpdates());
  ipcMain.handle(IPC.updateInstall, () => installUpdate());
  ipcMain.handle(IPC.appVersion, () => app.getVersion());

  // Window controls. `BrowserWindow.fromWebContents` rather than the module-level `appWin`
  // so a control can only ever act on the window it was clicked in.
  ipcMain.handle(IPC.windowMinimize, (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
  ipcMain.handle(IPC.windowMaximize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle(IPC.windowClose, (event) => BrowserWindow.fromWebContents(event.sender)?.close());

  // ---- Account ----
  //
  // Note what crosses this boundary: a name, an email and two numbers (no avatar URL —
  // auth.ts drops it, the window's CSP couldn't load it anyway). The
  // access token stays in main. That is the same rule the old `settingsGet` handler used to
  // enforce for the Gemini key, applied to the credential that replaced it — a window that
  // renders hundreds of arbitrary transcripts has no business holding a bearer token.
  ipcMain.handle(IPC.authGet, () => accountState());

  // Resolves as soon as the browser opens, NOT when the user is signed in. The result comes
  // back through the deep link and arrives on IPC.authChanged; see the note in the IPC map.
  ipcMain.handle(IPC.authSignIn, () => signIn());

  ipcMain.handle(IPC.authSignOut, async () => {
    await signOut();
  });

  ipcMain.handle(IPC.authRefresh, () => refreshPlan());

  // No arguments, deliberately: the user is identified by the token main already holds, and
  // the price is the server's to decide. A renderer that could name either would be a
  // renderer that could name someone else's account or a cheaper price.
  ipcMain.handle(IPC.billingCheckout, () => openCheckout());

  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    // Never hand an arbitrary string to the shell — a file: or ms-msdt: URL from a
    // compromised renderer would execute rather than browse.
    if (!/^https:\/\//i.test(url)) return;
    void shell.openExternal(url);
  });
}

/**
 * Claim the `gapirme://` scheme so the browser can hand the sign-in back to us.
 *
 * The dev-mode form is not optional cosmetics: under `npm run dev` the running binary is
 * `electron.exe`, which would register *itself* as the handler for every project on the
 * machine. Passing the entry script pins the registration to this app, and is the only way
 * the sign-in flow can be tested without packaging first.
 */
function registerProtocol(): void {
  const ok = app.isPackaged
    ? app.setAsDefaultProtocolClient(AUTH_PROTOCOL)
    : app.setAsDefaultProtocolClient(AUTH_PROTOCOL, process.execPath, [
        resolve(process.argv[1] ?? '')
      ]);
  if (!ok) console.warn(`[auth] could not register the ${AUTH_PROTOCOL}:// handler`);
}

function bootstrap(): void {
  // Must match `appId` in electron-builder.yml exactly — that is the id the installer
  // stamps on the shortcuts, and Windows groups taskbar buttons and routes notifications by
  // it. Two spellings means the running app and its own shortcut look like different
  // programs.
  app.setAppUserModelId('me.gapir.app');
  // ...and clean up after the id this one replaced. Must come after the line above, and is
  // its direct consequence: Electron keys the run-at-login registry value on the AUMID, so
  // changing the AUMID orphans whatever an older build wrote. See dropLegacyAutostart.
  dropLegacyAutostart();

  // First, so that everything below reports its failures somewhere a user can find them.
  initLogger();

  // app-paths.ts runs before the logger exists — it decides where the log file goes — so it
  // leaves its one line here. Silent when there was nothing to move, which is every launch
  // after the first.
  const note = pathsNote();
  if (note) console.log(note);

  registerProtocol();
  registerIpc();
  createOverlay();
  publishHotkeyHint();
  setIdleVisible(getSettings().showIdlePill);
  setDock(getSettings().overlayDock, { y: getSettings().overlayDockY });
  buildTray();

  // Keep an open window in step with dictations happening in other apps.
  hotkey.on('keys', (keys) => toAppWindow(IPC.hotkeyKeys, keys));
  onHistoryChanged(() => toAppWindow(IPC.historyChanged));
  onUpdateStatus((status) => toAppWindow(IPC.updateStatus, status));
  onAccountChanged((state) => {
    toAppWindow(IPC.authChanged, state);
    // The pill may still be offering the sign-in that just succeeded. Told rather than
    // watched for, so state.ts keeps its one-way dependency on auth.ts.
    if (state.user) dictation.clearSignInPrompt();
  });
  void initUpdater();

  // Restoring the session is what decides whether the very next hotkey press can dictate, so
  // it starts here rather than when the window first opens — most launches never open one.
  void initAuth();

  // Populate the device cache up front — enumeration shells out to ffmpeg and is far too
  // slow to run on the hotkey path.
  void refreshDevices().then((devices) => {
    console.log(`[audio] ${devices.length} input device(s):`, devices.map((d) => d.label));
  });

  try {
    dictation.init();
  } catch (err) {
    dialog.showErrorBox(
      'gapir me',
      `Klaviatura hooki ishga tushmadi:\n\n${err instanceof Error ? err.message : String(err)}`
    );
  }

  // A cold start *through* the protocol: the app wasn't running when the browser finished the
  // sign-in, so the callback is in our own argv rather than a second instance's. Rare — it
  // needs the app to have been closed mid-sign-in — but the alternative is a consent the user
  // gave being silently dropped.
  if (handleDeepLink(process.argv)) return;

  // Launched by the login item — stay quiet in the tray. Otherwise a first run opens on the
  // welcome flow, which is where someone learns the hotkey exists at all.
  if (!process.argv.includes('--hidden') && !getSettings().onboarded) {
    openApp('dictation');
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
