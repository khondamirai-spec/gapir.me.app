import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { AudioDevice } from '@shared/types';

/**
 * Audio capture via a bundled ffmpeg subprocess reading DirectShow.
 *
 * Why not getUserMedia? Because uiohook-napi's low-level keyboard hook is known to
 * silently stop firing on Windows once a getUserMedia stream is opened
 * (https://github.com/SnosMe/uiohook-napi/issues/54) — which is exactly this app's
 * usage pattern, and would break the hotkey after the first dictation.
 *
 * The bonus: ffmpeg gives us 16 kHz mono s16le directly, which is byte-for-byte what
 * Aisha's realtime socket wants, so chunks pipe straight through with no conversion.
 */

export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SAMPLE = 2;
export const CHANNELS = 1;

/** 100ms of audio per chunk — small enough to feel live, big enough to not spam the socket. */
const CHUNK_MS = 100;
const CHUNK_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * CHUNK_MS) / 1000;

function ffmpegPath(): string {
  // Packaged: resources/ffmpeg.exe next to the app. Dev: whatever is on PATH.
  const bundled = join(process.resourcesPath ?? '', 'ffmpeg.exe');
  if (app.isPackaged && existsSync(bundled)) return bundled;
  return 'ffmpeg';
}

/**
 * List DirectShow audio inputs.
 *
 * We return both the friendly label (for the UI) and the "alternative name" (for ffmpeg).
 * Always pass the alternative name back to ffmpeg: friendly names routinely contain
 * Cyrillic and other non-ASCII characters that get mangled by the console codepage,
 * whereas alternative names are pure ASCII and stable across reboots.
 */
export function listDevices(): Promise<AudioDevice[]> {
  return new Promise((resolve) => {
    execFile(
      ffmpegPath(),
      ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
      { encoding: 'utf8', windowsHide: true },
      (_err, _stdout, stderr) => {
        // ffmpeg always exits non-zero for this command and writes the list to stderr.
        resolve(parseDeviceList(stderr ?? ''));
      }
    );
  });
}

/**
 * Cached device list.
 *
 * Enumeration shells out to ffmpeg and takes 1-2 seconds, which is far too slow to do
 * when the hotkey is pressed. We refresh at startup and whenever Settings is opened, then
 * resolve the default device from the cache synchronously.
 */
let cachedDevices: AudioDevice[] = [];

export async function refreshDevices(): Promise<AudioDevice[]> {
  cachedDevices = await listDevices();
  return cachedDevices;
}

/** The device to use when the user hasn't chosen one. DirectShow has no "default" alias. */
export function defaultDeviceId(): string {
  return cachedDevices[0]?.id ?? '';
}

/** Exported for tests — ffmpeg's device-list format has shifted between versions. */
export function parseDeviceList(stderr: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  const lines = stderr.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    // e.g.  [dshow @ 0x..] "Микрофон (DroidCam Audio)" (audio)
    //  or   [in#0 @ 0x..] "Микрофон (DroidCam Audio)" (audio)
    const nameMatch = lines[i].match(/"(.+)"\s+\(audio\)\s*$/);
    if (!nameMatch) continue;

    // The alternative name is on a following line; ffmpeg sometimes wraps it.
    let id = '';
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const altMatch = lines[j].match(/Alternative name\s*"?(.*)"?\s*$/);
      if (altMatch) {
        id = altMatch[1].replace(/^"|"$/g, '').trim();
        if (!id) {
          // Wrapped onto the next line.
          const wrapped = lines[j + 1]?.match(/^"?(@device_[^"]+)"?/);
          if (wrapped) id = wrapped[1];
        }
        break;
      }
      if (/\((audio|video)\)\s*$/.test(lines[j])) break; // hit the next device
    }

    devices.push({ label: nameMatch[1], id: id || nameMatch[1] });
  }

  return devices;
}

export interface Recorder extends EventEmitter {
  /** Raw 16 kHz mono s16le PCM, ~100ms per chunk. */
  on(event: 'data', cb: (chunk: Buffer) => void): this;
  /** Normalised 0..1 RMS for the level meter. */
  on(event: 'level', cb: (level: number) => void): this;
  on(event: 'error', cb: (err: Error) => void): this;
  stop(): void;
  /** Total bytes captured — used to reject accidental taps. */
  readonly byteCount: number;
}

class FfmpegRecorder extends EventEmitter implements Recorder {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stopped = false;
  private stderrTail = '';
  byteCount = 0;

  constructor(deviceId: string) {
    super();

    this.proc = spawn(
      ffmpegPath(),
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'dshow',
        // Keep ffmpeg's own buffering minimal; we want chunks as they happen.
        '-audio_buffer_size', '50',
        '-i', `audio=${deviceId}`,
        '-ar', String(SAMPLE_RATE),
        '-ac', String(CHANNELS),
        '-f', 's16le',
        '-'
      ],
      { windowsHide: true }
    );

    this.proc.stdout.on('data', (chunk: Buffer) => {
      if (this.stopped) return;
      this.byteCount += chunk.length;
      this.emit('data', chunk);
      this.emit('level', rms(chunk));
    });

    this.proc.stderr.on('data', (d: Buffer) => {
      // Keep only the tail; ffmpeg can be chatty and we only need the failure reason.
      this.stderrTail = (this.stderrTail + d.toString('utf8')).slice(-2000);
    });

    this.proc.on('error', (err) => {
      if (!this.stopped) this.emit('error', new Error(`ffmpeg failed to start: ${err.message}`));
    });

    this.proc.on('close', (code) => {
      // A non-zero exit after we asked it to stop is just the kill; ignore it.
      if (this.stopped || code === 0) return;
      // Log the raw stderr for diagnosis, but hand the UI something a person can read —
      // the pill is one line wide and ffmpeg's output is five.
      if (this.stderrTail) console.error('[audio] ffmpeg:', this.stderrTail.trim());
      this.emit('error', new Error(friendlyFfmpegError(this.stderrTail)));
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    const proc = this.proc;
    this.proc = null;
    if (!proc?.pid) return;

    // ffmpeg on Windows ignores a bare SIGTERM from Node, so kill the whole tree.
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { windowsHide: true }, () => {});
    } else {
      proc.kill('SIGTERM');
    }
  }
}

/**
 * Turn ffmpeg's multi-line stderr into one line a user can act on.
 * Exported for tests.
 */
export function friendlyFfmpegError(stderr: string): string {
  if (/Could not find audio only device/i.test(stderr)) {
    return 'Mikrofon topilmadi — Sozlamalardan tanlang';
  }
  if (/Device or resource busy|in use/i.test(stderr)) {
    return 'Mikrofon band — boshqa dastur ishlatyapti';
  }
  if (/Permission denied|access/i.test(stderr)) {
    return 'Mikrofonga ruxsat yo‘q — Windows sozlamalarini tekshiring';
  }
  if (/ENOENT|not recognized/i.test(stderr)) {
    return 'ffmpeg topilmadi — o‘rnating (winget install ffmpeg)';
  }
  return 'Mikrofonni ochib bo‘lmadi';
}

/**
 * Start capturing.
 *
 * `preferredId` is whatever Settings has saved; empty means "no choice made". DirectShow
 * has no "default" device alias, so an unset — or since-unplugged — preference has to be
 * resolved to a real device name from the cache before ffmpeg sees it.
 */
export function startRecording(preferredId: string): Recorder {
  let deviceId = preferredId;

  if (!deviceId) {
    deviceId = defaultDeviceId();
  } else if (cachedDevices.length > 0 && !cachedDevices.some((d) => d.id === deviceId)) {
    // Saved device is gone (unplugged headset, disabled input) — fall back rather than
    // failing, so dictation keeps working.
    console.warn('[audio] saved device no longer present, using default');
    deviceId = defaultDeviceId();
  }

  if (!deviceId) {
    throw new Error('Mikrofon topilmadi — Sozlamalardan tanlang');
  }

  return new FfmpegRecorder(deviceId);
}

/** Root-mean-square amplitude of a s16le buffer, normalised to 0..1. */
export function rms(chunk: Buffer): number {
  const samples = Math.floor(chunk.length / 2);
  if (samples === 0) return 0;

  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = chunk.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.min(1, Math.sqrt(sum / samples));
}

/** Wrap raw PCM in a WAV container — needed by the batch fallback, which posts a file. */
export function pcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format: PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32); // block align
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

export const _internals = { CHUNK_BYTES };
