/** Minimal stand-in for the electron module so unit tests can run under plain Node. */
export const app = {
  isPackaged: false,
  getPath: () => '',
  setPath: () => {},
  setName: () => {},
  setLoginItemSettings: () => {}
};

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s: string) => Buffer.from(s),
  decryptString: (b: Buffer) => b.toString()
};

export const clipboard = {
  readText: () => '',
  readHTML: () => '',
  readRTF: () => '',
  readImage: () => ({ isEmpty: () => true }),
  writeText: () => {},
  write: () => {},
  clear: () => {}
};

export const nativeImage = { createEmpty: () => ({ isEmpty: () => true }) };

/**
 * Only present so `import { BrowserWindow, screen } from 'electron'` resolves. The helpers
 * under test are pure — anything that actually touches a window or a display is exercised
 * by running the app, not here.
 */
export class BrowserWindow {}

export const screen = {
  getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
  getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  on: () => {}
};
