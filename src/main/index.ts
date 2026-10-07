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
  dialog,
  type MenuItemConstructorOptions
} from 'electron';
import {
  IPC,
  PAID_PLANS,
  type AppSection,
  type PaidPlan,
  type PermissionsState,
  type Settings
} from '@shared/types';
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
import { applyLaunchAtLogin, dropLegacyAutostart, getSettings, setSettings } from './config';
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
import {
  accessibilityGranted,
  isWayland,
  microphoneStatus,
  openPrivacySettings,
  requestMicrophone,
  stopPermissionWatch,
  whenAccessibilityGranted
} from './permissions';
import { installAppImageEntry } from './linux-desktop';
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
/** Set at the end of bootstrap. Until then there is no window to open and no session store. */
let ready = false;
/** A sign-in callback that arrived before we were ready — macOS can deliver it that early. */
let pendingDeepLink: string | null = null;

const IS_MAC = process.platform === 'darwin';

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

// macOS delivers deep links as an event instead of argv — and when the link is what launched
// the app, before `ready`, so before there is a window to open or a session to write. Those
// are parked and replayed at the end of bootstrap; dropping one would drop a consent the
// user has just given. Registered at the top level, not in bootstrap, for the same reason.
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (!ready) {
    pendingDeepLink = url;
    return;
  }
  void completeSignIn(url).then((handled) => {
    if (handled) openApp('account');
  });
});

// Double-clicking the app in Finder or Launchpad while it is already running. A menu bar
// app with no window open would otherwise appear to do nothing at all.
app.on('activate', () => {
  if (ready) openApp('dictation');
});

// Keep the app alive with no windows open — it's a tray app. Merely registering a
// listener suppresses Electron's default quit-on-last-window-closed behaviour.
app.on('window-all-closed', () => {});

/**
 * The app window's icon in the Dock, shown only while that window is open.
 *
 * The app is a menu bar app (`LSUIElement` in electron-builder.yml), so at rest it has no
 * Dock icon and no Cmd-Tab entry — like the tray app it is on Windows. But a window with no
 * Dock icon cannot be Cmd-Tabbed back to once it is behind something, which makes the app
 * window feel lost; so the icon comes and goes with it.
 */
function setDockVisible(visible: boolean): void {
  if (!IS_MAC || !app.dock) return;
  if (visible) void app.dock.show();
  else app.dock.hide();
}

function iconPath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, name)
    : join(__dirname, '../../resources', name);
}

function openApp(section: AppSection): void {
  if (appWin && !appWin.isDestroyed()) {
    if (appWin.isMinimized()) appWin.restore();
    setDockVisible(true);
    appWin.show();
    appWin.focus();
    if (IS_MAC) app.focus({ steal: true });
    appWin.webContents.send(IPC.appRoute, section);
    return;
  }

  setDockVisible(true);
  appWin = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 880,
    minHeight: 560,
    title: 'gapir me',
    // The title bar is drawn in the renderer, so the frame has to go. Everything that a
    // frame used to do — drag, minimise, maximise, close — is wired over IPC below, and
    // the drag region is the `-webkit-app-region: drag` header in the app's HTML.
    //
    // Except on a Mac, where the window keeps the system's own traffic lights: a Mac user
    // looks top-left for them, and a set of Windows-style buttons on the right reads as a
    // ported app. `hidden` keeps the lights over our header; the renderer hides its own
    // buttons and leaves room for these (see `.platform-darwin` in the app's HTML).
    ...(IS_MAC
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 16, y: 15 } }
      : { frame: false }),
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

  // A window opened from a menu bar app does not come to the front on its own.
  if (IS_MAC) app.focus({ steal: true });

  appWin.on('closed', () => {
    appWin = null;
    setDockVisible(false);
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

function trayTooltip(): string {
  return `gapir me — ${formatChord(getSettings().hotkeys.pushToTalk)} bosib gapiring`;
}

function buildTray(): void {
  // The macOS menu bar wants a template image (black + alpha, recoloured by the system for
  // light and dark bars); the white mark is for the Windows taskbar and Linux panels, which
  // are dark by default. `trayTemplate@2x.png` beside it is picked up for Retina by name.
  const image = nativeImage.createFromPath(iconPath(IS_MAC ? 'trayTemplate.png' : 'tray.png'));
  if (IS_MAC) image.setTemplateImage(true);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip(trayTooltip());

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

  // On macOS a click opens the menu, as every menu bar item does; these are the Windows
  // taskbar's gestures (and Linux AppIndicator sends neither).
  if (!IS_MAC) {
    tray.on('click', () => openApp('dictation'));
    tray.on('double-click', () => openApp('dictation'));
  }
}

/**
 * The macOS menu bar's menu, which exists for the keyboard rather than to be browsed.
 *
 * Without an Edit menu, ⌘C, ⌘V, ⌘X, ⌘A and ⌘Z do nothing in a Mac app — they are menu
 * shortcuts there, not text-field behaviour — so the search box, the notes pane and the
 * name field would refuse paste. ⌘W and ⌘Q come from the same place. Windows and Linux
 * keep Electron's default, which a frameless window never shows anyway.
 */
function buildAppMenu(): void {
  if (!IS_MAC) return;
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'gapir me',
      submenu: [
        { role: 'about', label: 'gapir me haqida' },
        { type: 'separator' },
        { label: 'Sozlamalar…', accelerator: 'Cmd+,', click: () => openApp('settings') },
        { type: 'separator' },
        { role: 'hide', label: 'gapir me’ni yashirish' },
        { role: 'hideOthers', label: 'Boshqalarni yashirish' },
        { type: 'separator' },
        { role: 'quit', label: 'Chiqish' }
      ]
    },
    {
      label: 'Tahrirlash',
      submenu: [
        { role: 'undo', label: 'Bekor qilish' },
        { role: 'redo', label: 'Qaytarish' },
        { type: 'separator' },
        { role: 'cut', label: 'Kesish' },
        { role: 'copy', label: 'Nusxalash' },
        { role: 'paste', label: 'Qo‘yish' },
        { role: 'selectAll', label: 'Hammasini belgilash' }
      ]
    },
    {
      label: 'Oyna',
      submenu: [
        { role: 'minimize', label: 'Kichraytirish' },
        { role: 'close', label: 'Yopish' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** What the OS is currently allowing — see src/main/permissions.ts. */
function permissionsState(): PermissionsState {
  return {
    platform: IS_MAC ? 'darwin' : process.platform === 'linux' ? 'linux' : 'win32',
    microphone: microphoneStatus(),
    accessibility: accessibilityGranted(),
    hotkeyActive: hotkey.isRunning(),
    wayland: isWayland()
  };
}

function publishPermissions(): void {
  toAppWindow(IPC.permissionsChanged, permissionsState());
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
      if (patch.hotkeys !== undefined) tray?.setToolTip(trayTooltip());
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

  ipcMain.handle(IPC.micTestStart, async (_e, deviceId: string) => {
    // On a Mac the meter is usually where the microphone question is first asked — the
    // welcome flow's Mikrofon step. Asking here, before ffmpeg opens the device, is what
    // makes it a prompt rather than a meter that silently never moves.
    if (!(await requestMicrophone())) {
      const message = 'Mikrofonga ruxsat yo‘q — Tizim sozlamalari → Maxfiylik → Mikrofon';
      toAppWindow(IPC.micError, message);
      publishPermissions();
      return;
    }
    publishPermissions();
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

  // ---- OS permissions ----
  //
  // Asking is two different gestures depending on history, and only macOS knows which: the
  // first time, a system prompt; after a refusal, never again — only System Settings can
  // change the answer, so that is what we open. Either way the renderer gets the state back,
  // and an Accessibility grant made later in System Settings arrives on permissionsChanged
  // when the poll sees it.
  ipcMain.handle(IPC.permissionsGet, () => permissionsState());
  ipcMain.handle(IPC.permissionsRequest, async (_e, kind: unknown) => {
    if (kind === 'microphone') {
      const status = microphoneStatus();
      if (status === 'not-determined') await requestMicrophone();
      else if (status !== 'granted') openPrivacySettings('microphone');
    } else if (kind === 'accessibility') {
      // `true` shows the system sheet, which itself offers to open System Settings — and
      // after the first time it is silent, so open the pane ourselves as well.
      if (!accessibilityGranted(true)) {
        openPrivacySettings('accessibility');
        whenAccessibilityGranted(publishPermissions);
      }
    }
    return permissionsState();
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

  // The renderer names a *plan* and nothing else: the user is identified by the token main
  // already holds, and the price is looked up by the server. A renderer that could name
  // either would be a renderer that could name someone else's account or a cheaper price.
  // Anything that is not a paid plan we sell is refused here rather than forwarded.
  ipcMain.handle(IPC.billingCheckout, (_e, plan: unknown) =>
    (PAID_PLANS as readonly unknown[]).includes(plan)
      ? openCheckout(plan as PaidPlan)
      : 'Bunday tarif yo‘q'
  );

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
  // programs. A Windows concept; elsewhere the id comes from the bundle or .desktop file.
  if (process.platform === 'win32') app.setAppUserModelId('me.gapir.app');
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

  // A menu bar app: no Dock icon until the app window opens. The packaged build is already an
  // agent app via LSUIElement and starts without one; this covers `npm run dev`, where the
  // Electron binary's own Info.plist is in charge.
  setDockVisible(false);
  buildAppMenu();

  // An AppImage has to register itself with the desktop (menu entry + the gapirme:// sign-in
  // handler) — nothing installed it. A no-op for the .deb and everywhere else.
  installAppImageEntry(iconPath('icon.png'));
  // ...and Electron's login items do not exist on Linux, so the autostart entry is ours to
  // keep pointing at wherever the app now is.
  if (process.platform === 'linux' && getSettings().launchAtLogin) applyLaunchAtLogin(true);

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
    // On a Mac the hook may only come up minutes from now, when Accessibility is granted —
    // tell an open window when it does, so its "permission needed" card can go away.
    dictation.init(publishPermissions);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[hotkey] hook failed to start:', detail);
    dialog.showErrorBox(
      'gapir me',
      process.platform === 'linux'
        ? `Klaviatura tugmalarini kuzatib bo‘lmadi (X11 kerak):\n\n${detail}\n\n` +
            'Belgini bosib diktovka qilish baribir ishlaydi.'
        : `Klaviatura hooki ishga tushmadi:\n\n${detail}`
    );
  }

  ready = true;
  if (pendingDeepLink) {
    const url = pendingDeepLink;
    pendingDeepLink = null;
    void completeSignIn(url).then((handled) => {
      if (handled) openApp('account');
    });
    return;
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
  stopPermissionWatch();
  stopMicTest();
  dictation.shutdown();
  destroyOverlay();
  tray?.destroy();
});
