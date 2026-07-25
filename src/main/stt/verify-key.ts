import { pcmToWav, SAMPLE_RATE, BYTES_PER_SAMPLE } from '../audio';
import type { Language } from '@shared/types';

/**
 * "Is this API key actually any good?" — answered before the user closes Settings, rather
 * than by a cryptic error the first time they try to dictate.
 *
 * There is no dedicated auth endpoint, so this posts the shortest possible clip to the
 * batch endpoint and reads the status code. That bills 100 ms of audio (a fraction of a
 * tiyin), which is why it's a button the user presses and not something that fires while
 * they type.
 *
 * Three outcomes, not two: a 5xx or a dead network proves nothing about the key, and
 * saying "invalid" then would be a lie the user would act on.
 */

const POST_URL = 'https://back.aisha.group/api/v1/stt/post/';
const TIMEOUT_MS = 15_000;
/** 100 ms of digital silence — the smallest thing the endpoint will accept. */
const PROBE_MS = 100;

export interface KeyCheck {
  status: 'ok' | 'invalid' | 'unknown';
  message: string;
}

export async function verifyApiKey(apiKey: string, language: Language): Promise<KeyCheck> {
  if (!apiKey.trim()) {
    return { status: 'invalid', message: 'Kalit kiritilmagan' };
  }

  const silence = Buffer.alloc((SAMPLE_RATE * BYTES_PER_SAMPLE * PROBE_MS) / 1000);
  const wav = pcmToWav(silence);

  const form = new FormData();
  form.append('audio', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'probe.wav');
  form.append('language', language);
  form.append('has_offset', 'false');
  form.append('has_diarization', 'false');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(POST_URL, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey },
      body: form,
      signal: controller.signal
    });
  } catch {
    return {
      status: 'unknown',
      message: controller.signal.aborted
        ? 'Aisha javob bermadi — internetni tekshiring'
        : 'Internetga ulanib bo‘lmadi'
    };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    return { status: 'invalid', message: 'Kalit qabul qilinmadi — qaytadan tekshiring' };
  }
  if (res.status === 429) {
    return { status: 'unknown', message: 'Aisha limitga yetdi — keyinroq urinib ko‘ring' };
  }
  if (res.status >= 500) {
    return { status: 'unknown', message: `Aisha serveri xato qaytardi (${res.status})` };
  }

  // Anything else — including a 400 about the silent clip — means auth went through.
  return { status: 'ok', message: 'Kalit ishlaydi' };
}
