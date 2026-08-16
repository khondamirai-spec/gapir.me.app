import { describe, it, expect } from 'vitest';
import { parseDeviceList, rms, pcmToWav, friendlyFfmpegError, SAMPLE_RATE } from './audio';

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
