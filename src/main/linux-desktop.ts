import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The two things a Linux desktop learns about an app from `.desktop` files, and which
 * Electron does not write for us.
 *
 * **The app entry, for AppImage only.** The .deb installs `/usr/share/applications/gapir-me.desktop`
 * (electron-builder writes it, including `MimeType=x-scheme-handler/gapirme` from `protocols:`
 * in electron-builder.yml). An AppImage installs nothing — it is one file in ~/Downloads — so
 * without this there is no menu entry and, worse, nothing registered for `gapirme://`: the
 * browser finishes the Google sign-in and has nowhere to send it. That is the same silent
 * failure the `protocols:` comment in electron-builder.yml describes for Windows, and it gets
 * the same fix — register the handler ourselves, on every launch, pointing at wherever the
 * AppImage currently is.
 *
 * **The autostart entry.** `app.setLoginItemSettings` is a no-op on Linux; the freedesktop
 * way is a .desktop file in ~/.config/autostart.
 *
 * The file name matches `desktopName` in package.json — Electron hands that name to
 * `xdg-mime` when it registers the protocol, and the .deb's own entry has the same name, so
 * the two installs share one identity instead of fighting over the scheme.
 */

const DESKTOP_FILE = 'gapir-me.desktop';

function dataHome(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
}

function configHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

/** The thing to execute: the AppImage file itself when we are one, else the binary. */
function launcher(): string {
  return process.env.APPIMAGE || process.execPath;
}

/** Desktop-entry `Exec` quoting: the path is wrapped in quotes, with `"`, `` ` ``, `$` and `\` escaped. */
function quoteExec(path: string): string {
  return `"${path.replace(/(["`$\\])/g, '\\$1')}"`;
}

/** Exported for tests. */
export function desktopEntry(exec: string, icon: string, extra: string[] = []): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=gapir me',
    'Comment=O‘zbekcha diktovka — tugmani bosib gapiring',
    `Exec=${exec}`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=Utility;Accessibility;',
    'StartupWMClass=gapir me',
    ...extra,
    ''
  ].join('\n');
}

function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, { mode: 0o755 });
  return true;
}

/**
 * Register the AppImage with the desktop: menu entry, icon, and the `gapirme://` handler.
 * Does nothing for the .deb (which has its own entry) or in dev. Never throws — a missing
 * menu entry is worth a log line, not a failed launch.
 */
export function installAppImageEntry(iconSource: string): void {
  if (process.platform !== 'linux' || !process.env.APPIMAGE) return;
  try {
    const icon = join(dataHome(), 'icons', 'hicolor', '512x512', 'apps', 'gapir-me.png');
    if (existsSync(iconSource)) {
      mkdirSync(join(icon, '..'), { recursive: true });
      copyFileSync(iconSource, icon);
    }

    const entry = desktopEntry(`${quoteExec(launcher())} %U`, 'gapir-me', [
      'MimeType=x-scheme-handler/gapirme;'
    ]);
    const applications = join(dataHome(), 'applications');
    const changed = writeIfChanged(join(applications, DESKTOP_FILE), entry);

    // Claim the scheme every launch, not only when the file changed: another app (or an old
    // copy of this one) may have taken it since. Both tools are best-effort — on a desktop
    // without them the entry still makes the menu work.
    execFile('xdg-mime', ['default', DESKTOP_FILE, 'x-scheme-handler/gapirme'], () => {});
    if (changed) {
      execFile('update-desktop-database', [applications], () => {});
      console.log(`[linux] registered ${DESKTOP_FILE} for ${launcher()}`);
    }
  } catch (err) {
    console.warn('[linux] could not write the desktop entry:', err instanceof Error ? err.message : err);
  }
}

/** Turn launch-at-login on or off. Linux's half of `app.setLoginItemSettings`. */
export function setAutostartEntry(enabled: boolean): void {
  if (process.platform !== 'linux') return;
  const path = join(configHome(), 'autostart', DESKTOP_FILE);
  try {
    if (!enabled) {
      rmSync(path, { force: true });
      return;
    }
    writeIfChanged(
      path,
      desktopEntry(`${quoteExec(launcher())} --hidden`, 'gapir-me', ['X-GNOME-Autostart-enabled=true'])
    );
  } catch (err) {
    console.warn('[linux] could not update autostart:', err instanceof Error ? err.message : err);
  }
}

export const _internals = { quoteExec };
