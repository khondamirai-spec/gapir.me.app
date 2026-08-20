/**
 * Dev launcher.
 *
 * Exists for one reason: VS Code's integrated terminal inherits ELECTRON_RUN_AS_NODE=1
 * from the extension host. With that set, the Electron binary boots as plain Node, so
 * `require('electron')` returns the path to the executable instead of the API object and
 * the app dies with "Cannot read properties of undefined (reading 'app')".
 *
 * Running `electron-vite dev` through here strips the variable first, so `npm run dev`
 * behaves the same in VS Code, Windows Terminal and CI.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// Load .env into the child's environment. Electron's main process doesn't get Vite's
// import.meta.env, so `resolveGeminiKey()` reads process.env.GEMINI_API_KEY (or
// GOOGLE_API_KEY — Google's own SDKs read both and people already have one or the other)
// instead, which means the values have to be injected here. GAPIR_ME_GEMINI_LIVE_MODEL
// rides along the same way: it is how you try a different Live API model without a rebuild.
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match || line.trimStart().startsWith('#')) continue;
    env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

// `npm run dev:mock` — exercise the hotkey/overlay/paste loop with a fake transcriber,
// so no API key is needed and no transcription is billed.
const args = process.argv.slice(2);
const mockIndex = args.indexOf('--mock');
if (mockIndex !== -1) {
  args.splice(mockIndex, 1);
  env.GAPIR_ME_MOCK_STT = '1';
  console.log('[dev] mock STT enabled — transcripts are fake');
}

// `npm run dev -- --log-frames` — dump every inbound STT frame verbatim: Gemini Live's
// socket frames, and any Gemini batch response that parsed to no transcript.
const framesIndex = args.indexOf('--log-frames');
if (framesIndex !== -1) {
  args.splice(framesIndex, 1);
  env.GAPIR_ME_LOG_FRAMES = '1';
  console.log('[dev] logging raw STT frames');
}

const child = spawn('npx', ['electron-vite', 'dev', ...args], {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

child.on('exit', (code) => process.exit(code ?? 0));
