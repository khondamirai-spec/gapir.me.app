import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  GeminiError,
  transcribe,
  type Language,
  type StyleSettings
} from '../_shared/gemini.ts';

/**
 * The transcription proxy — the reason this project has a server at all.
 *
 * The app used to hold a Gemini key and call Google directly, which made "pay for this" a
 * request rather than a rule: the key shipped inside the installer and anyone could take it.
 * Now the app holds only a Supabase session, and this function holds the key. Everything that
 * decides whether a dictation happens is on this side of the wire.
 *
 * The order below is the whole design:
 *
 *   1. who is this            — JWT, verified by Supabase before we run
 *   2. is the request sane    — validated field by field; this endpoint spends money
 *   3. may they               — reserve_dictation(), atomic, server-side, unfakeable
 *   4. transcribe             — with a key the user never sees
 *   5. settle up              — finalize on success, refund on failure
 *
 * Step 5 is not bookkeeping. A dictation that failed must cost the user nothing, because on
 * the free tier they can see every slot they have.
 */

/** Comma-separated. A pool rather than one key for the same reason the app used to ship one:
 *  free-tier keys have a daily cap, so a spent key has to be able to step aside. */
const GEMINI_KEYS = (Deno.env.get('GEMINI_API_KEYS') ?? Deno.env.get('GEMINI_API_KEY') ?? '')
  .split(/[\s,;]+/)
  .map((k) => k.trim())
  .filter(Boolean);

/** Kept in step with DEFAULT_GEMINI_MODEL in src/shared/types.ts by hand. */
const MODEL = Deno.env.get('GEMINI_MODEL')?.trim() || 'gemini-3.1-flash-lite';

/**
 * Longest audio we will accept, as base64 characters.
 *
 * Gemini's own inline limit is 20 MB, but an Edge Function request body is the tighter
 * constraint by a wide margin. 6 MB of base64 is roughly two minutes of 16 kHz mono — and a
 * dictation longer than that is a stuck hotkey, not a sentence.
 */
const MAX_AUDIO_B64 = 6_000_000;

/** How many pool keys one dictation may burn through before giving up. The user is standing
 *  there with a hotkey in their hand; the rest of the pool stays healthy for the next press. */
const MAX_KEY_ROTATIONS = 3;

/**
 * Keys benched until local midnight after a daily-cap 429.
 *
 * In memory, so it lasts as long as this Edge Function instance does. That is deliberately
 * modest: Google's allowances are the real authority and our guess is only worth having
 * inside one warm instance. A cold start rediscovering a spent key costs one round trip.
 */
const coolingUntil = new Map<string, number>();

function healthyKeys(): string[] {
  const now = Date.now();
  const healthy = GEMINI_KEYS.filter((k) => (coolingUntil.get(k) ?? 0) <= now);
  // When everything is cooling down we still try — our cooldowns are a guess, and letting the
  // request through means the user meets Google's real answer rather than ours.
  return healthy.length > 0 ? healthy : GEMINI_KEYS;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/** The app shows `error` verbatim on the pill, so it is Uzbek like the rest of the UI. */
function fail(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return json({ error, ...extra }, status);
}

interface Body {
  audio: string;
  language: Language;
  style?: StyleSettings;
  audioMs?: number;
}

const LANGUAGES = new Set(['uz', 'ru', 'en']);
const TONES = new Set(['verbatim', 'tidy', 'formal']);

/**
 * Validate the request field by field, and build a clean object rather than passing the
 * parsed body through.
 *
 * Whitelisting is the point. The client chooses a language and three style switches; it does
 * not choose a model, a prompt, a temperature or a safety setting. Anything it could smuggle
 * in by having its object spread into a Gemini request is money spent on our key.
 */
function readBody(raw: unknown): Body | string {
  if (!raw || typeof raw !== 'object') return 'So‘rov noto‘g‘ri';
  const b = raw as Record<string, unknown>;

  if (typeof b.audio !== 'string' || b.audio.length === 0) return 'Audio yuborilmadi';
  if (b.audio.length > MAX_AUDIO_B64) return 'Yozuv juda uzun — 2 daqiqadan qisqa bo‘lishi kerak';
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(b.audio)) return 'Audio formati noto‘g‘ri';

  const language = typeof b.language === 'string' && LANGUAGES.has(b.language) ? b.language : 'uz';

  let style: StyleSettings | undefined;
  const s = b.style;
  if (s && typeof s === 'object') {
    const r = s as Record<string, unknown>;
    style = {
      tone: typeof r.tone === 'string' && TONES.has(r.tone) ? (r.tone as StyleSettings['tone']) : 'verbatim',
      removeFillers: typeof r.removeFillers === 'boolean' ? r.removeFillers : true,
      punctuation: typeof r.punctuation === 'boolean' ? r.punctuation : true
    };
  }

  const audioMs = typeof b.audioMs === 'number' && Number.isFinite(b.audioMs)
    ? Math.max(0, Math.min(600_000, Math.round(b.audioMs)))
    : 0;

  return { audio: b.audio, language: language as Language, style, audioMs };
}

/** Service-role client: bypasses RLS, which is what makes the quota functions authoritative. */
function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return fail(405, 'Method not allowed');

  if (GEMINI_KEYS.length === 0) {
    // A deploy without the secret set. Say so plainly in the log — the user's pill will show
    // the Uzbek line and there is nothing they can do about it.
    console.error('[transcribe] GEMINI_API_KEYS is not set — every dictation will fail');
    return fail(503, 'Server sozlanmagan — birozdan keyin urinib ko‘ring');
  }

  // Supabase verifies the JWT before this runs (verify_jwt is on for this function), so a
  // token that got here is genuine. We still need it to learn *who* it belongs to.
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return fail(401, 'Kirish kerak');

  const db = serviceClient();

  const { data: userData, error: userErr } = await db.auth.getUser(token);
  const user = userData?.user;
  if (userErr || !user) return fail(401, 'Kirish muddati tugadi — qaytadan kiring');

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail(400, 'So‘rov noto‘g‘ri');
  }

  const body = readBody(raw);
  if (typeof body === 'string') return fail(400, body);

  // --- may they? -----------------------------------------------------------
  const { data: reservation, error: reserveErr } = await db.rpc('reserve_dictation', {
    p_user: user.id,
    p_model: MODEL
  });

  if (reserveErr) {
    console.error('[transcribe] reserve_dictation failed:', reserveErr.message);
    return fail(500, 'Server xatosi — birozdan keyin urinib ko‘ring');
  }

  const res = reservation as Record<string, unknown>;
  if (res.allowed !== true) {
    const plan = String(res.plan ?? 'free');
    if (res.reason === 'burst') {
      return fail(429, 'Juda tez — bir necha soniya kutib turing', { plan, used: res.used, limit: res.limit });
    }
    if (res.reason === 'no_profile') {
      return fail(403, 'Hisob topilmadi — chiqib, qaytadan kiring');
    }
    // 402 rather than 429: this is not "wait a moment", it is "the free plan is used up for
    // today". The app turns this into an offer to upgrade rather than a retry.
    return fail(402, plan === 'pro'
      ? 'Bugungi limit tugadi — ertaga yana ishlaydi'
      : 'Bugungi bepul limit tugadi — Pro’ga o‘ting yoki ertaga urinib ko‘ring',
      { plan, used: res.used, limit: res.limit });
  }

  const eventId = res.event_id as number;
  const plan = String(res.plan ?? 'free');
  // `used` in the reservation is the post-reservation count. When we refund the slot the
  // honest number to show the user is one less — otherwise the Hisob pane over-reports a
  // failed dictation as spent until the next refresh.
  const usedIfRefunded = Math.max(0, Number(res.used ?? 0) - 1);

  // --- clip cap ------------------------------------------------------------
  // plan_limits.max_clip_ms is the plan's ceiling; MAX_AUDIO_B64 above is only the transport
  // sanity bound. Enforced on the audio itself rather than the client-reported audioMs,
  // which is spoofable. 16 kHz mono s16le is 32 bytes per millisecond, base64 is 4/3 of
  // that; 4 KB of slack covers the WAV header and line breaks.
  const maxClipMs = Number(res.max_clip_ms ?? 0);
  if (maxClipMs > 0 && body.audio.length > Math.ceil((maxClipMs * 32 + 4096) / 3) * 4) {
    await db.rpc('refund_dictation', { p_event: eventId });
    return fail(400, `Yozuv juda uzun — eng ko‘pi ${Math.round(maxClipMs / 1000)} soniya`, {
      plan, used: usedIfRefunded, limit: res.limit
    });
  }

  // --- transcribe ----------------------------------------------------------
  const keys = healthyKeys();
  let text = '';
  let lastError: GeminiError | null = null;
  const startedAt = Date.now();

  for (let attempt = 0; attempt < Math.min(MAX_KEY_ROTATIONS, keys.length); attempt++) {
    const key = keys[attempt];
    try {
      text = await transcribe({
        model: MODEL,
        apiKey: key,
        language: body.language,
        style: body.style,
        audioBase64: body.audio
      });
      lastError = null;
      break;
    } catch (err) {
      if (!(err instanceof GeminiError)) throw err;
      lastError = err;
      if (!err.rotatable) break;

      // Bench it until local midnight — a free-tier daily cap does not clear before then, and
      // handing the next dictation the same spent key wastes a round trip the user waits for.
      const midnight = new Date();
      midnight.setHours(24, 0, 0, 0);
      coolingUntil.set(key, midnight.getTime());
      console.warn(`[transcribe] key benched, rotating (attempt ${attempt + 1})`);
    }
  }

  // --- settle up -----------------------------------------------------------
  if (lastError) {
    // Nothing came back, so the slot was never really used. Give it back before answering.
    await db.rpc('refund_dictation', { p_event: eventId });
    console.error(`[transcribe] user=${user.id} failed: ${lastError.message}`);
    return fail(lastError.status, lastError.userMessage, { plan, used: usedIfRefunded, limit: res.limit });
  }

  if (!text) {
    // A silent clip is not a failure of ours and must not cost a slot either — the sentinel
    // in _shared/gemini.ts turned an apology into an empty string, which is the honest answer.
    await db.rpc('refund_dictation', { p_event: eventId });
    return json({ text: '', plan, used: usedIfRefunded, limit: res.limit });
  }

  await db.rpc('finalize_dictation', {
    p_event: eventId,
    p_audio_ms: body.audioMs ?? 0,
    p_chars: text.length
  });

  // Deliberately **not** the transcript, unlike the equivalent line in src/main/state.ts.
  // That one prints into a log file on the speaker's own machine; this one goes into a
  // server log we can read. Character count is enough to diagnose "it returned nothing",
  // and is the most we have any business keeping about what someone said out loud.
  console.log(
    `[transcribe] user=${user.id} plan=${plan} model=${MODEL} ` +
      `audio=${((body.audioMs ?? 0) / 1000).toFixed(1)}s rtt=${Date.now() - startedAt}ms chars=${text.length}`
  );

  return json({ text, plan, used: res.used, limit: res.limit });
});
