import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AccountState,
  type AudioDevice,
  type DockGuides,
  type HistoryEntry,
  type OverlayDock,
  type OverlayStatus,
  type PlanSnapshot,
  type Settings,
  type UpdateStatus
} from '../shared/types';

/**
 * The only bridge between main and the renderers. Context isolation is on and node
 * integration is off, so this surface is deliberately tiny — the renderers just draw.
 *
 * Every `on*` subscriber returns its own unsubscribe function; the app window swaps
 * sections without reloading, so a listener that couldn't be detached would accumulate.
 */

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, value: T): void => cb(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const api = {
  /** Overlay: subscribe to dictation status. Returns an unsubscribe function. */
  onStatus(cb: (status: OverlayStatus) => void): () => void {
    return subscribe(IPC.overlayStatus, cb);
  },

  /**
   * Overlay: whether the cursor is on the pill. Main decides this — the overlay window is
   * click-through and never sees a mouse event. See the hover notes in src/main/overlay.ts.
   */
  onOverlayHover(cb: (hovered: boolean) => void): () => void {
    return subscribe(IPC.overlayHover, cb);
  },

  /**
   * Overlay: the pill was clicked — toggle a hands-free dictation. Main decides what that
   * means from the state machine; the pill just reports the click.
   */
  toggleDictation(): Promise<void> {
    return ipcRenderer.invoke(IPC.overlayToggle);
  },

  /**
   * Overlay: the pill is being held / was released. The renderer reports only the gesture —
   * main moves the window itself by polling the cursor, and snaps it to the nearest dock on
   * release. See beginDrag/endDrag in src/main/overlay.ts.
   */
  overlayDragStart(): Promise<void> {
    return ipcRenderer.invoke(IPC.overlayDragStart);
  },

  overlayDragEnd(): Promise<void> {
    return ipcRenderer.invoke(IPC.overlayDragEnd);
  },

  /** Overlay: which dock the pill sits in, so the CSS can align content toward that edge. */
  onOverlayDock(cb: (dock: OverlayDock) => void): () => void {
    return subscribe(IPC.overlayDock, cb);
  },

  /** Dock guides: the landing slots drawn while the pill is carried, and which one has it. */
  onDockGuides(cb: (guides: DockGuides) => void): () => void {
    return subscribe(IPC.dockGuides, cb);
  },

  getSettings(): Promise<Settings> {
    return ipcRenderer.invoke(IPC.settingsGet);
  },

  setSettings(patch: Partial<Settings>): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke(IPC.settingsSet, patch);
  },

  listDevices(): Promise<AudioDevice[]> {
    return ipcRenderer.invoke(IPC.devicesList);
  },

  /** Which section to show — sent when the tray opens the window on a specific one. */
  onRoute(cb: (section: string) => void): () => void {
    return subscribe(IPC.appRoute, cb);
  },

  /** ---- History ---- */
  listHistory(): Promise<{ entries: HistoryEntry[]; filePath: string }> {
    return ipcRenderer.invoke(IPC.historyList);
  },

  deleteHistory(id: string): Promise<void> {
    return ipcRenderer.invoke(IPC.historyDelete, id);
  },

  clearHistory(): Promise<void> {
    return ipcRenderer.invoke(IPC.historyClear);
  },

  /** Copy through main, so copying can never disturb the caret the paste path relies on. */
  copyText(text: string): Promise<void> {
    return ipcRenderer.invoke(IPC.historyCopy, text);
  },

  onHistoryChanged(cb: () => void): () => void {
    return subscribe(IPC.historyChanged, cb);
  },

  /** ---- Microphone test ---- */
  startMicTest(deviceId: string): Promise<void> {
    return ipcRenderer.invoke(IPC.micTestStart, deviceId);
  },

  stopMicTest(): Promise<void> {
    return ipcRenderer.invoke(IPC.micTestStop);
  },

  onMicLevel(cb: (level: number) => void): () => void {
    return subscribe(IPC.micLevel, cb);
  },

  onMicError(cb: (message: string) => void): () => void {
    return subscribe(IPC.micError, cb);
  },

  /** ---- Updates ---- */
  checkForUpdates(): Promise<void> {
    return ipcRenderer.invoke(IPC.updateCheck);
  },

  installUpdate(): Promise<void> {
    return ipcRenderer.invoke(IPC.updateInstall);
  },

  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void {
    return subscribe(IPC.updateStatus, cb);
  },

  /** ---- Frameless window controls ---- */
  minimizeWindow(): Promise<void> {
    return ipcRenderer.invoke(IPC.windowMinimize);
  },

  /** Resolves with whether the window ended up maximised. */
  toggleMaximizeWindow(): Promise<boolean> {
    return ipcRenderer.invoke(IPC.windowMaximize);
  },

  closeWindow(): Promise<void> {
    return ipcRenderer.invoke(IPC.windowClose);
  },

  /** Fires for maximise changes we didn't initiate — Win+Up, Aero Snap, a header drag. */
  onWindowState(cb: (maximized: boolean) => void): () => void {
    return subscribe(IPC.windowState, cb);
  },

  /** ---- Account ---- */
  getAccount(): Promise<AccountState> {
    return ipcRenderer.invoke(IPC.authGet);
  },

  /**
   * Start Google sign-in.
   *
   * Resolves once the system browser has been opened — **not** when the user is signed in.
   * The consent happens in a browser we do not control and comes back through a deep link, so
   * the signed-in state arrives on `onAccountChanged`. Awaiting this and then reading the
   * account will read the signed-out one.
   */
  signIn(): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke(IPC.authSignIn);
  },

  signOut(): Promise<void> {
    return ipcRenderer.invoke(IPC.authSignOut);
  },

  /** Re-read the plan and today's usage from the server. */
  refreshPlan(): Promise<PlanSnapshot | null> {
    return ipcRenderer.invoke(IPC.authRefresh);
  },

  /** Opens the Payme checkout in the system browser. Resolves with '' or an Uzbek error. */
  startCheckout(): Promise<string> {
    return ipcRenderer.invoke(IPC.billingCheckout);
  },

  onAccountChanged(cb: (state: AccountState) => void): () => void {
    return subscribe(IPC.authChanged, cb);
  },

  /** ---- Misc ---- */
  getVersion(): Promise<string> {
    return ipcRenderer.invoke(IPC.appVersion);
  },

  /** Opens in the system browser. Main validates the URL before handing it to the shell. */
  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke(IPC.openExternal, url);
  }
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
