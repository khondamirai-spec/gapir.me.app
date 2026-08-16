/**
 * The Payme decision rules that are pure, pulled out of the endpoint so they can be tested.
 *
 * The endpoint itself (supabase/functions/payme/index.ts) is a Deno server that talks to
 * Postgres, so it cannot be unit-tested from vitest — but almost every way a Payme
 * integration fails its sandbox run is a *decision*, not a query: an account id parsed
 * loosely, a timeout boundary off by an equals sign, an amount compared in the wrong unit, a
 * key compared with `===`. Those live here, and src/main/payme-rules.test.ts covers them.
 *
 * No Deno APIs and no imports, deliberately: that is what lets the same file be imported by
 * the Deno function and by vitest. See the same arrangement in _shared/gemini.ts.
 */

/** Payme transaction states. */
export const CREATED = 1;
export const PERFORMED = 2;
export const CANCELLED = -1;
export const REFUNDED = -2;

/** Payme's limit on how long a created transaction may sit unperformed. */
export const TIMEOUT_MS = 43_200_000; // 12 hours

export const E_AUTH = -32504;
export const E_PARSE = -32700;
export const E_METHOD = -32601;
export const E_AMOUNT = -31001;
export const E_TX_NOT_FOUND = -31003;
export const E_IMPOSSIBLE = -31008;
export const E_ORDER_NOT_FOUND = -31050;
export const E_ORDER_PAID = -31051;
export const E_ORDER_CANCELLED = -31052;

/** The account requisite configured in the merchant cabinet. Must match it exactly. */
export const ACCOUNT_FIELD = 'order_id';

/** Account errors must carry `data` naming the field; others must not. */
export function isAccountError(code: number): boolean {
  return code <= -31050 && code >= -31099;
}

/**
 * The account id, parsed strictly.
 *
 * Payme sends it as a string, and `Number()` alone is far too generous: it accepts `' 12 '`,
 * `'12.0'`, `'1e3'`, `'0x10'` and `''` (as 0). Each of those would look up a different order
 * than the customer is paying for, or none at all — so the shape is checked before the value.
 */
export function parseAccountId(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Has this transaction outlived Payme's window?
 *
 * Strictly greater than, matching Payme's own rule: a transaction at exactly 12 hours is
 * still alive. An `>=` here would cancel a transaction Payme still considers valid.
 */
export function isExpired(createTime: number, now: number): boolean {
  return now - createTime > TIMEOUT_MS;
}

export interface OrderRow {
  id: number;
  amount_tiyin: number;
  state: string;
}

/**
 * What is wrong with paying this order for this amount, or null if nothing is.
 *
 * Shared by CheckPerformTransaction and CreateTransaction, because the second must re-run
 * every check the first made — Payme is entitled to call Create without ever calling Check,
 * and an order that became unpayable in between must not slip through.
 */
export function orderProblem(order: OrderRow | null, amount: unknown): number | null {
  if (!order) return E_ORDER_NOT_FOUND;
  if (order.state === 'paid' || order.state === 'refunded') return E_ORDER_PAID;
  if (order.state === 'cancelled') return E_ORDER_CANCELLED;

  // Tiyin against tiyin, and a non-number is a mismatch rather than a crash. The classic bug
  // is a hundred-fold difference because so'm leaked in somewhere upstream.
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return E_AMOUNT;
  if (Math.round(amount) !== Number(order.amount_tiyin)) return E_AMOUNT;

  return null;
}

/**
 * Constant-time string comparison.
 *
 * A `===` would leak the merchant key one byte at a time to anyone willing to measure the
 * response, and this endpoint has to be reachable by Payme and therefore by everyone. The
 * length difference is folded into the accumulator rather than returned early, because an
 * early return on length is itself a measurable signal.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/**
 * Is this Authorization header one of our keys?
 *
 * Every configured key is accepted, which is the trick that makes sandbox → production a pure
 * environment change: during testing only the test key is set, at go-live the production key
 * is added, then the test key is removed — with no deploy in between that could fail.
 *
 * `decode` is injected because Deno and Node spell base64 differently (`atob` vs `Buffer`),
 * and a shared module may not assume either.
 */
export function isAuthorized(
  header: string | null | undefined,
  keys: readonly string[],
  decode: (b64: string) => string
): boolean {
  if (!header || keys.length === 0) return false;
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return false;

  let decoded: string;
  try {
    decoded = decode(match[1].trim());
  } catch {
    return false;
  }

  return keys.some((key) => timingSafeEqual(decoded, `Paycom:${key}`));
}
