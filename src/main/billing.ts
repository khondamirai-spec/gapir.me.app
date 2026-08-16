import { shell } from 'electron';
import { accessToken } from './auth';
import { SUPABASE_ANON_KEY, SUPABASE_URL, isConfigured } from './supabase-config';

/**
 * Starting a Payme payment.
 *
 * The app's entire part in taking money is: ask our server for a checkout URL, and open it.
 * It does not know the merchant id, the price, or the order number, and it must not — the
 * server fixes the amount when it creates the order (supabase/functions/checkout/index.ts),
 * and the Merchant API callback later validates what Payme reports against that. A price the
 * client chose would have nothing to be checked against.
 *
 * Nothing here can grant a plan either. The subscription is granted when Payme calls our
 * endpoint (supabase/functions/payme/index.ts) — **not** when the browser comes back, and not
 * on any signal this process can produce. That is why the UI's answer after opening the
 * checkout is "come back and refresh" rather than "you are now Pro": the app genuinely does
 * not know yet, and saying otherwise would be a guess shown as a fact.
 */

const CHECKOUT_URL = `${SUPABASE_URL}/functions/v1/checkout`;

const REQUEST_TIMEOUT_MS = 20_000;

interface CheckoutResponse {
  url?: string;
  error?: string;
}

/**
 * Open the Payme checkout in the system browser.
 *
 * Resolves with '' on success, or an Uzbek message to show the user. The server writes those
 * messages, so a new failure mode is explained properly without a client release.
 */
export async function openCheckout(): Promise<string> {
  if (!isConfigured()) return 'Ilova serverga ulanmagan — ilovani yangilang';

  const token = await accessToken();
  if (!token) return 'Avval Google bilan kiring';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let body: CheckoutResponse;
  try {
    const res = await fetch(CHECKOUT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`
      },
      body: '{}',
      signal: controller.signal
    });
    body = (await res.json()) as CheckoutResponse;
    if (!res.ok) {
      console.error(`[billing] checkout ${res.status}: ${body.error ?? ''}`);
      return body.error || `To‘lovni boshlab bo‘lmadi (${res.status})`;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[billing] checkout request failed:', message);
    return controller.signal.aborted
      ? 'Server javob bermadi — keyinroq urinib ko‘ring'
      : 'Tarmoq xatosi — internetni tekshiring';
  } finally {
    clearTimeout(timer);
  }

  // Never hand an arbitrary string to the shell, even one from our own server: a non-https
  // URL reaching `openExternal` is a code-execution path, and the same rule already guards
  // the renderer's openExternal handler in src/main/index.ts.
  const url = body.url ?? '';
  if (!/^https:\/\//i.test(url)) {
    console.error('[billing] server returned a checkout url that is not https:', url.slice(0, 80));
    return 'To‘lov manzili noto‘g‘ri — keyinroq urinib ko‘ring';
  }

  try {
    await shell.openExternal(url);
    return '';
  } catch (err) {
    console.error('[billing] could not open the checkout:', err instanceof Error ? err.message : err);
    return 'To‘lov sahifasini ochib bo‘lmadi';
  }
}
