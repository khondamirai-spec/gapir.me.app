import { pcmToWav } from '../audio';
import { SttError, type SttAdapter, type SttSession, type SttSessionOptions } from './types';

const POST_URL = 'https://back.aisha.group/api/v1/stt/post/';
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Aisha batch STT — the fallback path.
 *
 * Buffers the whole utterance, wraps it in a WAV header and posts it as a file. Slower
 * than the socket (no transcription happens until you stop speaking) but it only needs
 * one working HTTP request, so it survives flaky networks and realtime-endpoint outages.
 * Used automatically when the socket fails, so a bad connection costs latency, not the
 * dictation itself.
 */
class AishaBatchSession implements SttSession {
  private chunks: Buffer[] = [];
  private cancelled = false;

  constructor(private opts: SttSessionOptions) {}

  pushAudio(chunk: Buffer): void {
    if (this.cancelled) return;
    this.chunks.push(chunk);
  }

  async end(): Promise<string> {
    if (this.cancelled) return '';

    const pcm = Buffer.concat(this.chunks);
    if (pcm.length === 0) return '';

    const wav = pcmToWav(pcm);
    const form = new FormData();
    // Copy into a plain Uint8Array — Node's Buffer isn't a valid BlobPart under
    // TypeScript's DOM types because its backing store may be a SharedArrayBuffer.
    form.append('audio', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
    form.append('language', this.opts.language);
    form.append('has_offset', 'false');
    form.append('has_diarization', 'false');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(POST_URL, {
        method: 'POST',
        headers: { 'X-Api-Key': this.opts.apiKey },
        body: form,
        signal: controller.signal
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SttError(
        controller.signal.aborted ? 'Aisha request timed out' : `Network error: ${msg}`,
        false
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        throw new SttError('Aisha rejected the API key — check it in Settings', false);
      }
      throw new SttError(`Aisha returned ${res.status}: ${body.slice(0, 300)}`, false);
    }

    const json = (await res.json()) as { transcript?: string; text?: string };
    return (json.transcript ?? json.text ?? '').trim();
  }

  cancel(): void {
    this.cancelled = true;
    this.chunks = [];
  }
}

export const aishaBatch: SttAdapter = {
  name: 'aisha-batch',
  async startSession(opts: SttSessionOptions): Promise<SttSession> {
    return new AishaBatchSession(opts);
  }
};
