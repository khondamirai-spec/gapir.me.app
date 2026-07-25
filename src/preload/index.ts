import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AudioDevice,
  type HistoryEntry,
  type Language,
  type OverlayStatus,
  type Settings,
  type UpdateStatus
} from '../shared/types';

/**
 * The only bridge between main and the renderers. Context isolation is on and node
 * integration is off, so this surface is deliberately tiny — the renderers just draw.
 *
 * Every `on*` subscriber returns its own unsubscribe function; the app window swaps tabs
 * without reloading, so a listener that couldn't be detached would accumulate.
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

  /** Settings: the apiKey field comes back masked, never as the real key. */
  getSettings(): Promise<Settings> {
    return ipcRenderer.invoke(IPC.settingsGet);
  },

  setSettings(patch: Partial<Settings>): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke(IPC.settingsSet, patch);
  },

  listDevices(): Promise<AudioDevice[]> {
    return ipcRenderer.invoke(IPC.devicesList);
  },

  /**
   * Check a key against Aisha. Pass the key being typed; pass nothing to test the one
   * already saved.
   */
  testKey(
    apiKey?: string,
    language?: Language
  ): Promise<{ status: 'ok' | 'invalid' | 'unknown'; message: string }> {
    return ipcRenderer.invoke(IPC.testKey, apiKey, language);
  },

  /** Which tab to show — sent when the tray opens the window on a specific one. */
  onRoute(cb: (tab: string) => void): () => void {
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
