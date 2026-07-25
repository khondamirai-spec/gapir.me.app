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
// import.meta.env, so `resolveApiKey()` reads process.env.AISHA_API_KEY instead — which
// means the value has to be injected here.
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
  env.WHISPER_UZ_MOCK_STT = '1';
  console.log('[dev] mock STT enabled — transcripts are fake');
}

// `npm run dev -- --log-frames` — dump every inbound Aisha frame verbatim.
const framesIndex = args.indexOf('--log-frames');
if (framesIndex !== -1) {
  args.splice(framesIndex, 1);
  env.WHISPER_UZ_LOG_FRAMES = '1';
  console.log('[dev] logging raw STT frames');
}

const child = spawn('npx', ['electron-vite', 'dev', ...args], {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

child.on('exit', (code) => process.exit(code ?? 0));
