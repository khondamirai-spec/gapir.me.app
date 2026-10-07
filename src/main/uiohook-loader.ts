/**
 * The native keyboard hook, loaded so that failing to load it costs the hotkey and not the app.
 *
 * `uiohook-napi` dlopens its binary the moment it is imported, and on Linux that binary links
 * libXt — which Electron itself does not need, so a machine can run the app and still lack
 * it. A static import would turn that into a main process that dies before it has a window to
 * say why. Required here instead; src/main/hotkey.ts rethrows `loadError` from `start()`,
 * where index.ts shows it, and the pill still dictates by click without any hook at all.
 *
 * A module of its own so tests can replace it: vitest's `vi.mock` intercepts imports, not a
 * bare `require`.
 *
 * One more thing about this library that is not obvious from its API: on macOS without the
 * Accessibility permission, `uIOhook.start()` does not reliably throw — it can take the whole
 * process down. Never call it there without checking `accessibilityGranted()` first, which is
 * what `startHook` in src/main/state.ts is for.
 */
type UiohookModule = typeof import('uiohook-napi');

let native: UiohookModule | null = null;
let loadError = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  native = require('uiohook-napi') as UiohookModule;
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err);
  console.error('[hotkey] could not load uiohook-napi:', loadError);
}

export const uIOhook: UiohookModule['uIOhook'] | null = native?.uIOhook ?? null;
export const UiohookKey = (native?.UiohookKey ?? {}) as UiohookModule['UiohookKey'];
export { loadError };
