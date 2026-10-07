/**
 * electron-builder `afterPack` hook: ad-hoc sign the macOS app.
 *
 * Apple Silicon will not run code without a valid signature, and the Electron binary's own
 * signature stops covering the bundle the moment electron-builder renames it, rewrites its
 * Info.plist and adds our resources. With no Developer ID certificate in the keychain,
 * electron-builder 25 does not sign at all ("skipped macOS application code signing") — and
 * it has no ad-hoc mode — so the dmg it produces opens as "“gapir me” is damaged and can't be
 * opened" on every M-series Mac, with no way past it short of the terminal.
 *
 * So we sign it ourselves, ad-hoc (`--sign -`), which turns that dead end into the ordinary
 * first-launch Gatekeeper prompt the download page explains. This runs *before*
 * electron-builder's own signing step, so when a real certificate is configured (see the mac
 * section of electron-builder.yml) electron-builder simply signs over this with --force and
 * notarizes; nothing here needs to know which case it is in.
 *
 * Only the final app is signed. For a universal build this hook also runs for the x64 and
 * arm64 halves (in `*-temp` folders); signing those is wasted work, since merging them into
 * one universal binary invalidates every signature anyway.
 *
 * No hardened runtime: it exists for notarization, which an ad-hoc signature cannot get, and
 * it would only add constraints (library validation, the audio-input entitlement) for nothing.
 */
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (/-temp$/.test(context.appOutDir)) return;

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing  file=${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
