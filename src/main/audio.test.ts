import { describe, it, expect } from 'vitest';
import {
  parseDeviceList,
  parseAvfoundationList,
  parseAlsaSources,
  captureArgs,
  captureBackend,
  defaultDeviceId,
  rms,
  pcmToWav,
  friendlyFfmpegError,
  SAMPLE_RATE
} from './audio';

describe('parseDeviceList', () => {
  // Captured verbatim from ffmpeg 7.x on Windows 11. Note the Cyrillic friendly names —
  // this is exactly why we pass the ASCII alternative name to ffmpeg instead.
  const REAL_OUTPUT = String.raw`[in#0 @ 000001] "DroidCam Video" (video)
[in#0 @ 000001]   Alternative name "@device_pnp_\\?\root#media#0001#{65e8773d}\global"
[in#0 @ 000001] "Набор микрофонов (2- Технология Intel® Smart Sound)" (audio)
[in#0 @ 000001]   Alternative name "@device_cm_{33D9A762}\wave_{0C8E9E5D}"
[in#0 @ 000001] "Line 1 (Virtual Audio Cable)" (audio)
[in#0 @ 000001]   Alternative name "@device_cm_{33D9A762}\wave_{2EA09780}"
[in#0 @ 000001] "Микрофон (DroidCam Audio)" (audio)
[in#0 @ 000001]   Alternative name "@device_cm_{33D9A762}\wave_{9B04835F}"`;

  it('returns only audio devices, never video ones', () => {
    const devices = parseDeviceList(REAL_OUTPUT);
    expect(devices).toHaveLength(3);
    expect(devices.some((d) => d.label.includes('DroidCam Video'))).toBe(false);
  });

  it('pairs each friendly label with its ASCII alternative name', () => {
    const devices = parseDeviceList(REAL_OUTPUT);
    expect(devices[0].label).toBe('Набор микрофонов (2- Технология Intel® Smart Sound)');
    expect(devices[0].id).toBe(String.raw`@device_cm_{33D9A762}\wave_{0C8E9E5D}`);
    expect(devices[2].id).toBe(String.raw`@device_cm_{33D9A762}\wave_{9B04835F}`);
  });

  it('handles the older [dshow @ ...] prefix', () => {
    const devices = parseDeviceList(
      String.raw`[dshow @ 0x7f] "Microphone (Realtek)" (audio)
[dshow @ 0x7f]   Alternative name "@device_cm_{ABC}\wave_{DEF}"`
    );
    expect(devices).toEqual([
      { label: 'Microphone (Realtek)', id: String.raw`@device_cm_{ABC}\wave_{DEF}` }
    ]);
  });

  it('falls back to the label when no alternative name is present', () => {
    const devices = parseDeviceList('[dshow @ 0x7f] "Some Mic" (audio)');
    expect(devices).toEqual([{ label: 'Some Mic', id: 'Some Mic' }]);
  });

  it('returns nothing for output with no devices', () => {
    expect(parseDeviceList('')).toEqual([]);
    expect(parseDeviceList('[dshow @ 0x7f] Could not enumerate audio devices')).toEqual([]);
  });
});

describe('parseAvfoundationList', () => {
  // Captured from the bundled ffmpeg 8.1 on macOS 26 with an iPhone in Continuity range.
  const REAL_OUTPUT = `[AVFoundation indev @ 0x7bc5024140] AVFoundation video devices:
[AVFoundation indev @ 0x7bc5024140] [0] FaceTime HD Camera
[AVFoundation indev @ 0x7bc5024140] [1] Xondamir Camera
[AVFoundation indev @ 0x7bc5024140] [2] Capture screen 0
[AVFoundation indev @ 0x7bc5024140] AVFoundation audio devices:
[AVFoundation indev @ 0x7bc5024140] [0] Xondamir Microphone
[AVFoundation indev @ 0x7bc5024140] [1] MacBook Air Microphone
[in#0 @ 0x7bc5024000] Error opening input: Input/output error
Error opening input file .
Error opening input files: Input/output error`;

  it('returns the audio devices only, addressed by name', () => {
    expect(parseAvfoundationList(REAL_OUTPUT)).toEqual([
      { label: 'Xondamir Microphone', id: 'Xondamir Microphone' },
      { label: 'MacBook Air Microphone', id: 'MacBook Air Microphone' }
    ]);
  });

  it('falls back to the index for a name ffmpeg would split on its colon', () => {
    const devices = parseAvfoundationList(`[x] AVFoundation audio devices:
[x] [0] Studio: Input 1`);
    expect(devices).toEqual([{ label: 'Studio: Input 1', id: '0' }]);
  });

  it('returns nothing when there are no audio devices', () => {
    expect(parseAvfoundationList('[x] AVFoundation video devices:\n[x] [0] FaceTime HD Camera')).toEqual([]);
    expect(parseAvfoundationList('')).toEqual([]);
  });
});

describe('parseAlsaSources', () => {
  // ffmpeg -sources alsa on Ubuntu 24.04 (PipeWire). Two of the descriptions run onto a second
  // line — ALSA puts a newline in them and ffmpeg prints it as-is.
  const REAL_OUTPUT = `Auto-detected sources for alsa:
  null [Discard all samples (playback) or generate zero samples (capture)]
  pipewire [PipeWire Sound Server]
  pulse [PulseAudio Sound Server]
* default [Default ALSA Output (currently PipeWire Media Server)]
  sysdefault:CARD=PCH [HDA Intel PCH, ALC3246 Analog
Default Audio Device]
  front:CARD=PCH,DEV=0 [HDA Intel PCH, ALC3246 Analog
Front output / input]
  hw:CARD=PCH,DEV=0 [HDA Intel PCH, ALC3246 Analog
Direct hardware device without any conversions]
  sysdefault:CARD=Webcam [C922 Pro Stream Webcam, USB Audio
Default Audio Device]`;

  it('keeps one row per sound card, named by its description', () => {
    expect(parseAlsaSources(REAL_OUTPUT)).toEqual([
      { label: 'HDA Intel PCH, ALC3246 Analog', id: 'sysdefault:CARD=PCH' },
      { label: 'C922 Pro Stream Webcam, USB Audio', id: 'sysdefault:CARD=Webcam' }
    ]);
  });

  it('leaves out default — the UI offers it as Avtomatik', () => {
    expect(parseAlsaSources(REAL_OUTPUT).some((d) => d.id === 'default')).toBe(false);
  });

  it('returns nothing for empty output', () => {
    expect(parseAlsaSources('')).toEqual([]);
  });
});

describe('capture backends', () => {
  it('picks one input device per OS', () => {
    expect(captureBackend('win32')).toBe('dshow');
    expect(captureBackend('darwin')).toBe('avfoundation');
    expect(captureBackend('linux')).toBe('alsa');
  });

  it('spells the input the way each device wants it', () => {
    expect(captureArgs('dshow', '@device_cm_{X}')).toEqual([
      '-f', 'dshow', '-audio_buffer_size', '50', '-i', 'audio=@device_cm_{X}'
    ]);
    // ":<audio>" — an empty video half, or AVFoundation opens the camera.
    expect(captureArgs('avfoundation', 'default')).toEqual(['-f', 'avfoundation', '-i', ':default']);
    expect(captureArgs('alsa', 'sysdefault:CARD=PCH')).toEqual([
      '-f', 'alsa', '-i', 'sysdefault:CARD=PCH'
    ]);
  });

  it('uses the system default microphone where the OS has one', () => {
    expect(defaultDeviceId('avfoundation')).toBe('default');
    expect(defaultDeviceId('alsa')).toBe('default');
  });
});

describe('friendlyFfmpegError', () => {
  // Verbatim from the bug where `audio=default` was passed to ffmpeg. DirectShow has no
  // "default" device alias, so an unconfigured microphone failed with this five-line
  // wall of text — which then got clipped to nonsense by the one-line overlay pill.
  const NO_DEVICE = `[in#0 @ 000001] Could not find audio only device with name [default] among source devices of type audio.
[in#0 @ 000001] Could not find audio only device with name [default] among source devices of type video.
[in#0 @ 000001] Error opening input: I/O error
Error opening input file audio=default.
Error opening input files: I/O error`;

  it('turns the missing-device wall of text into one actionable line', () => {
    const message = friendlyFfmpegError(NO_DEVICE);
    expect(message).toBe('Mikrofon topilmadi — Sozlamalardan tanlang');
    expect(message).not.toContain('\n');
  });

  it('recognises a microphone held by another app', () => {
    expect(friendlyFfmpegError('Device or resource busy')).toContain('band');
  });

  it('recognises a missing ffmpeg binary', () => {
    expect(friendlyFfmpegError("'ffmpeg' is not recognized")).toContain('ffmpeg');
  });

  it('recognises a genuine permission failure', () => {
    expect(friendlyFfmpegError('Access is denied')).toContain('ruxsat');
    expect(friendlyFfmpegError('Permission denied')).toContain('ruxsat');
  });

  it('does not blame permissions for merely containing the word "access"', () => {
    // The rule used to be a bare /access/, which swept up any stderr with the substring in
    // it — including a device whose own name carries it — and sent the user off to check a
    // Windows privacy setting that was never the problem.
    const message = friendlyFfmpegError('[in#0 @ 0x7f] Could not open the access point filter');
    expect(message).toBe('Mikrofonni ochib bo‘lmadi');
  });

  it('falls back to a generic message rather than leaking raw stderr', () => {
    const message = friendlyFfmpegError('[in#0 @ 0x7f] some unanticipated failure');
    expect(message).toBe('Mikrofonni ochib bo‘lmadi');
    expect(message).not.toContain('in#0');
  });

  it('names the right settings screen on each OS', () => {
    expect(friendlyFfmpegError('Permission denied', 'win32')).toContain('Windows');
    expect(friendlyFfmpegError('Permission denied', 'darwin')).toContain('Tizim sozlamalari');
    expect(friendlyFfmpegError('spawn ffmpeg ENOENT', 'linux')).toContain('apt install ffmpeg');
    expect(friendlyFfmpegError('spawn ffmpeg ENOENT', 'win32')).toContain('winget');
  });

  it('reads AVFoundation\'s bare I/O error as a missing device on macOS only', () => {
    const stderr = '[in#0 @ 0x7b] Error opening input: Input/output error';
    expect(friendlyFfmpegError(stderr, 'darwin')).toBe('Mikrofon topilmadi — Sozlamalardan tanlang');
    expect(friendlyFfmpegError(stderr, 'win32')).toBe('Mikrofonni ochib bo‘lmadi');
  });

  it('handles empty stderr', () => {
    expect(friendlyFfmpegError('')).toBe('Mikrofonni ochib bo‘lmadi');
  });
});

describe('rms', () => {
  it('is 0 for silence and for an empty buffer', () => {
    expect(rms(Buffer.alloc(1000))).toBe(0);
    expect(rms(Buffer.alloc(0))).toBe(0);
  });

  it('approaches 1 for a full-scale signal', () => {
    const buf = Buffer.alloc(200);
    for (let i = 0; i < 100; i++) buf.writeInt16LE(32767, i * 2);
    expect(rms(buf)).toBeCloseTo(1, 2);
  });

  it('treats negative amplitude the same as positive', () => {
    const positive = Buffer.alloc(200);
    const negative = Buffer.alloc(200);
    for (let i = 0; i < 100; i++) {
      positive.writeInt16LE(16000, i * 2);
      negative.writeInt16LE(-16000, i * 2);
    }
    expect(rms(positive)).toBeCloseTo(rms(negative), 5);
  });

  it('never exceeds 1, even at the negative rail', () => {
    const buf = Buffer.alloc(200);
    for (let i = 0; i < 100; i++) buf.writeInt16LE(-32768, i * 2);
    expect(rms(buf)).toBeLessThanOrEqual(1);
  });
});

describe('pcmToWav', () => {
  const pcm = Buffer.alloc(3200); // 100ms at 16 kHz mono s16le

  it('writes a valid 44-byte RIFF/WAVE header', () => {
    const wav = pcmToWav(pcm);
    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data');
  });

  it('declares the format Gemini expects: 16 kHz, mono, 16-bit PCM', () => {
    const wav = pcmToWav(pcm);
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(SAMPLE_RATE);
    expect(wav.readUInt32LE(28)).toBe(SAMPLE_RATE * 2); // byte rate
    expect(wav.readUInt16LE(32)).toBe(2); // block align
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
  });

  it('sets both length fields consistently', () => {
    const wav = pcmToWav(pcm);
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
  });

  it('preserves the audio payload byte for byte', () => {
    const noisy = Buffer.from([1, 2, 3, 4, 250, 251, 252, 253]);
    expect(pcmToWav(noisy).subarray(44)).toEqual(noisy);
  });
});
