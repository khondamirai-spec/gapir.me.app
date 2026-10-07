import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { AudioDevice } from '@shared/types';

/**
 * Audio capture via a bundled ffmpeg subprocess — DirectShow on Windows, AVFoundation on
 * macOS, ALSA on Linux.
 *
 * Why not getUserMedia? Because uiohook-napi's low-level keyboard hook is known to
 * silently stop firing on Windows once a getUserMedia stream is opened
 * (https://github.com/SnosMe/uiohook-napi/issues/54) — which is exactly this app's
 * usage pattern, and would break the hotkey after the first dictation.
 *
 * The bonus: ffmpeg gives us 16 kHz mono s16le directly, which is byte-for-byte what the
 * Gemini Live socket takes and, with a WAV header glued on, what the batch endpoint takes
 * too — so chunks pipe straight through with no conversion.
 */

export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SAMPLE = 2;
export const CHANNELS = 1;

/** 100ms of audio per chunk — small enough to feel live, big enough to not spam the socket. */
const CHUNK_MS = 100;
const CHUNK_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * CHUNK_MS) / 1000;

/**
 * If ffmpeg has produced no audio at all this long after starting, it is not going to.
 *
 * This exists for macOS, where it is the normal shape of a missing permission: with the
 * microphone not yet granted (or denied), AVFoundation neither fails nor delivers — ffmpeg
 * sits there forever holding a dictation open, and the pill would show a recording that is
 * recording nothing. permissions.ts asks before we ever get here, so this is the backstop
 * for the cases it cannot see (a grant revoked mid-session, a device that wedges). The same
 * thing can happen with a DirectShow or ALSA device that opens and then never clocks, so it
 * runs on every platform; device start-up is well under a second everywhere.
 */
const NO_AUDIO_TIMEOUT_MS = 5000;

/**
 * Which ffmpeg input device this platform captures through.
 *
 * One per OS, and each answers the same question differently — how devices are listed, what
 * a device id looks like, and what "the default microphone" means. Everything else in this
 * file (the recorder, the level meter, the WAV wrapping) is identical across all three.
 */
export type CaptureBackend = 'dshow' | 'avfoundation' | 'alsa';

export function captureBackend(platform: NodeJS.Platform = process.platform): CaptureBackend {
  if (platform === 'darwin') return 'avfoundation';
  if (platform === 'linux') return 'alsa';
  return 'dshow';
}

function ffmpegPath(): string {
  // Packaged: resources/ffmpeg(.exe) next to the app. Dev: whatever is on PATH.
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const bundled = join(process.resourcesPath ?? '', name);
  if (app.isPackaged && existsSync(bundled)) return bundled;
  return 'ffmpeg';
}

/**
 * List audio inputs.
 *
 * We return both the friendly label (for the UI) and the id ffmpeg should be given:
 *
 *   dshow         the "alternative name". Always pass this back to ffmpeg: friendly names
 *                 routinely contain Cyrillic and other non-ASCII characters that get mangled
 *                 by the console codepage, whereas alternative names are pure ASCII and
 *                 stable across reboots.
 *   avfoundation  the device's name. AVFoundation also takes an index, but indices shift
 *                 whenever a headset or an iPhone comes and goes; names do not, and macOS has
 *                 no codepage to mangle them. See parseAvfoundationList for the one exception.
 *   alsa          the ALSA PCM name, e.g. `sysdefault:CARD=PCH`.
 */
export function listDevices(): Promise<AudioDevice[]> {
  const backend = captureBackend();
  const args =
    backend === 'avfoundation'
      ? ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']
      : backend === 'alsa'
        ? ['-hide_banner', '-sources', 'alsa']
        : ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'];

  return new Promise((resolve) => {
    execFile(ffmpegPath(), args, { encoding: 'utf8', windowsHide: true }, (_err, stdout, stderr) => {
      // dshow and avfoundation always exit non-zero for this and write the list to stderr;
      // `-sources` writes to stdout. Either way the exit code says nothing useful.
      if (backend === 'avfoundation') resolve(parseAvfoundationList(stderr ?? ''));
      else if (backend === 'alsa') resolve(parseAlsaSources(stdout ?? ''));
      else resolve(parseDeviceList(stderr ?? ''));
    });
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

/**
 * The device to use when the user hasn't chosen one.
 *
 * DirectShow has no "default" alias, so on Windows this is the first device enumerated —
 * which is why a virtual cable listed first can capture silence. AVFoundation and ALSA both
 * have a real one, and it is the better answer: it is the microphone the user picked in the
 * system's own sound settings, and it follows them when they plug in a headset.
 */
export function defaultDeviceId(backend: CaptureBackend = captureBackend()): string {
  if (backend !== 'dshow') return 'default';
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

/**
 * AVFoundation's list, from stderr:
 *
 *   [AVFoundation indev @ 0x..] AVFoundation video devices:
 *   [AVFoundation indev @ 0x..] [0] FaceTime HD Camera
 *   [AVFoundation indev @ 0x..] AVFoundation audio devices:
 *   [AVFoundation indev @ 0x..] [0] MacBook Air Microphone
 *
 * Only the audio half is wanted. The id is the name, except for a name containing a colon:
 * ffmpeg splits its `-i "video:audio"` argument on the first one, so such a device has to be
 * addressed by index instead — less stable, but the only way to reach it at all.
 *
 * Exported for tests.
 */
export function parseAvfoundationList(stderr: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  let inAudio = false;
  for (const line of stderr.split(/\r?\n/)) {
    if (/AVFoundation audio devices:/.test(line)) {
      inAudio = true;
      continue;
    }
    if (/AVFoundation video devices:/.test(line)) {
      inAudio = false;
      continue;
    }
    if (!inAudio) continue;
    const match = line.match(/\]\s*\[(\d+)\]\s+(.+?)\s*$/);
    if (!match) continue;
    const [, index, label] = match;
    devices.push({ label, id: label.includes(':') ? index : label });
  }
  return devices;
}

/**
 * ALSA's capture PCMs, from `ffmpeg -sources alsa` (stdout):
 *
 *     null [Discard all samples (playback) or generate zero samples (capture)]
 *   * default [Default ALSA Output (currently PipeWire Media Server)]
 *     sysdefault:CARD=PCH [HDA Intel PCH, ALC3246 Analog
 *   Default Audio Device]
 *     hw:CARD=PCH,DEV=0 [HDA Intel PCH, ALC3246 Analog
 *   Direct hardware device without any conversions]
 *
 * Note the descriptions that run over two lines — they come from ALSA with an embedded
 * newline. Most of the list is plumbing nobody should pick (`hw:` bypasses the sound server
 * and fails with "busy" while it holds the card, `null` records silence), so this keeps one
 * row per sound card — its `sysdefault:` PCM, named by the first line of its description.
 * `default` is left out: the UI already offers it, as "Avtomatik".
 *
 * Exported for tests.
 */
export function parseAlsaSources(stdout: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  const entries: { id: string; desc: string }[] = [];
  let current: { id: string; desc: string } | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const start = line.match(/^\s*\*?\s*(\S+)\s+\[(.*)$/);
    if (start && !current) {
      current = { id: start[1], desc: start[2] };
    } else if (current) {
      current.desc += '\n' + line;
    } else {
      continue;
    }
    if (current.desc.endsWith(']')) {
      current.desc = current.desc.slice(0, -1);
      entries.push(current);
      current = null;
    }
  }

  for (const { id, desc } of entries) {
    if (!/^sysdefault:CARD=/.test(id)) continue;
    const label = desc.split('\n')[0].trim() || id.slice('sysdefault:CARD='.length);
    devices.push({ label, id });
  }
  return devices;
}

/**
 * The ffmpeg arguments that open `deviceId` on a given backend. Exported for tests — the
 * three spellings are easy to get subtly wrong and impossible to check without the device.
 */
export function captureArgs(backend: CaptureBackend, deviceId: string): string[] {
  if (backend === 'avfoundation') {
    // "video:audio" — no video, the named (or default) microphone.
    return ['-f', 'avfoundation', '-i', `:${deviceId}`];
  }
  if (backend === 'alsa') {
    return ['-f', 'alsa', '-i', deviceId];
  }
  return [
    '-f', 'dshow',
    // Keep ffmpeg's own buffering minimal; we want chunks as they happen.
    '-audio_buffer_size', '50',
    '-i', `audio=${deviceId}`
  ];
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
  private watchdog: NodeJS.Timeout | null = null;
  byteCount = 0;

  constructor(deviceId: string) {
    super();

    this.proc = spawn(
      ffmpegPath(),
      [
        '-hide_banner',
        '-loglevel', 'error',
        ...captureArgs(captureBackend(), deviceId),
        '-ar', String(SAMPLE_RATE),
        '-ac', String(CHANNELS),
        '-f', 's16le',
        '-'
      ],
      { windowsHide: true }
    );

    this.watchdog = setTimeout(() => {
      if (this.stopped || this.byteCount > 0) return;
      console.error('[audio] no audio from ffmpeg after', NO_AUDIO_TIMEOUT_MS, 'ms', this.stderrTail.trim());
      const message =
        process.platform === 'darwin'
          ? 'Mikrofondan ovoz kelmayapti — Tizim sozlamalari → Maxfiylik → Mikrofon’da ruxsat bering'
          : 'Mikrofondan ovoz kelmayapti — Sozlamalardan boshqa mikrofonni tanlang';
      this.stop();
      this.emit('error', new Error(message));
    }, NO_AUDIO_TIMEOUT_MS);

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
      // Almost always ENOENT — no bundled binary and nothing on PATH. Logged raw, shown
      // translated: "spawn ffmpeg ENOENT" in a one-line pill helps nobody.
      console.error('[audio] ffmpeg failed to start:', err.message);
      if (!this.stopped) this.emit('error', new Error(friendlyFfmpegError(err.message)));
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
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;

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
export function friendlyFfmpegError(
  stderr: string,
  platform: NodeJS.Platform = process.platform
): string {
  // dshow names the device it could not find; ALSA says "No such file or directory" for a
  // PCM that does not exist, and AVFoundation only manages "Input/output error" — which is
  // all it ever says about a device name it does not recognise.
  if (
    /Could not find audio only device/i.test(stderr) ||
    /cannot open audio device .*No such (file|device)/i.test(stderr) ||
    (platform === 'darwin' && /Error opening input.*(Input\/output|I\/O) error/i.test(stderr))
  ) {
    return 'Mikrofon topilmadi — Sozlamalardan tanlang';
  }
  if (/Device or resource busy|in use/i.test(stderr)) {
    return 'Mikrofon band — boshqa dastur ishlatyapti';
  }
  // Both spellings in full: a bare /access/ also matched "inaccessible", "Access Violation"
  // and any device whose name happens to contain the word, and told all of them to go and
  // check a privacy setting that was never the problem.
  if (/Permission denied|Access is denied|access denied/i.test(stderr)) {
    if (platform === 'darwin') return 'Mikrofonga ruxsat yo‘q — Tizim sozlamalari → Maxfiylik → Mikrofon';
    if (platform === 'linux') return 'Mikrofonga ruxsat yo‘q — tizim ovoz sozlamalarini tekshiring';
    return 'Mikrofonga ruxsat yo‘q — Windows sozlamalarini tekshiring';
  }
  if (/ENOENT|not recognized/i.test(stderr)) {
    if (platform === 'darwin') return 'ffmpeg topilmadi — ilovani qayta o‘rnating';
    if (platform === 'linux') return 'ffmpeg topilmadi — o‘rnating (sudo apt install ffmpeg)';
    return 'ffmpeg topilmadi — o‘rnating (winget install ffmpeg)';
  }
  return 'Mikrofonni ochib bo‘lmadi';
}

/**
 * Start capturing.
 *
 * `preferredId` is whatever Settings has saved; empty means "no choice made". DirectShow
 * has no "default" device alias, so on Windows an unset — or since-unplugged — preference
 * has to be resolved to a real device name from the cache before ffmpeg sees it. macOS and
 * Linux resolve it to their own `default`.
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
