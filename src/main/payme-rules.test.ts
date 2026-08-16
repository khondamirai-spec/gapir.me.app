import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_FIELD,
  E_AMOUNT,
  E_ORDER_CANCELLED,
  E_ORDER_NOT_FOUND,
  E_ORDER_PAID,
  TIMEOUT_MS,
  isAccountError,
  isAuthorized,
  isExpired,
  orderProblem,
  parseAccountId,
  timingSafeEqual
} from '../../supabase/functions/_shared/payme-rules';

/**
 * The Payme rules that decide whether money moves.
 *
 * The endpoint itself needs the sandbox at test.paycom.uz to be verified — there is no way to
 * unit-test a JSON-RPC conversation with Payme's servers. But every rule below is a place
 * where an integration silently does the wrong thing rather than failing loudly, and the
 * sandbox reports all of them as the same handful of opaque error codes. Catching them here
 * is much cheaper than catching them there.
 *
 * Node has no `atob`, so the base64 decoder is injected — the same reason the production
 * caller passes Deno's.
 */
const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8');
const encode = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

describe('parseAccountId', () => {
  it('accepts a plain positive integer as a string', () => {
    expect(parseAccountId('197')).toBe(197);
    expect(parseAccountId('1')).toBe(1);
  });

  it('accepts a number, because Payme is not consistent about the type', () => {
    expect(parseAccountId(197)).toBe(197);
  });

  it.each([
    ['', 'empty string — Number() would make this 0'],
    ['   ', 'whitespace only'],
    ['0', 'zero is never a real order id'],
    ['-5', 'negative'],
    ['12.0', 'decimal point — a different order than intended'],
    ['1e3', 'exponent notation — Number() would accept this as 1000'],
    ['0x10', 'hex — Number() would accept this as 16'],
    ['12abc', 'trailing junk'],
    ['abc', 'not a number at all'],
    [null, 'null'],
    [undefined, 'missing'],
    [{}, 'an object']
  ])('rejects %j (%s)', (raw, _why) => {
    expect(parseAccountId(raw)).toBeNull();
  });

  it('rejects an id too large to represent exactly', () => {
    // Beyond Number.MAX_SAFE_INTEGER two different ids compare equal, which would let a
    // payment be applied to the wrong order.
    expect(parseAccountId('9007199254740993')).toBeNull();
  });
});

describe('isExpired', () => {
  const created = 1_700_000_000_000;

  it('is false well inside the window', () => {
    expect(isExpired(created, created + 60_000)).toBe(false);
  });

  it('is false at exactly the timeout', () => {
    // Strictly greater than, matching Payme's own rule. An `>=` here would cancel a
    // transaction Payme still considers live, which fails the sandbox in a confusing way.
    expect(isExpired(created, created + TIMEOUT_MS)).toBe(false);
  });

  it('is true one millisecond past the timeout', () => {
    expect(isExpired(created, created + TIMEOUT_MS + 1)).toBe(true);
  });

  it('is 12 hours', () => {
    expect(TIMEOUT_MS).toBe(12 * 60 * 60 * 1000);
  });
});

describe('orderProblem', () => {
  const order = { id: 1, amount_tiyin: 5_000_000, state: 'pending' };

  it('passes a pending order at exactly the right amount', () => {
    expect(orderProblem(order, 5_000_000)).toBeNull();
  });

  it('reports a missing order', () => {
    expect(orderProblem(null, 5_000_000)).toBe(E_ORDER_NOT_FOUND);
  });

  it.each([
    ['paid', E_ORDER_PAID],
    ['refunded', E_ORDER_PAID],
    ['cancelled', E_ORDER_CANCELLED]
  ])('refuses an order in state %s', (state, code) => {
    expect(orderProblem({ ...order, state }, 5_000_000)).toBe(code);
  });

  it('refuses so’m where tiyin was expected', () => {
    // The hundred-fold bug. 50 000 so'm is 5 000 000 tiyin; being handed 50 000 means
    // somebody converted in the wrong direction and the customer would pay 500 so'm.
    expect(orderProblem(order, 50_000)).toBe(E_AMOUNT);
  });

  it('refuses an amount that is close but not equal', () => {
    expect(orderProblem(order, 4_999_999)).toBe(E_AMOUNT);
    expect(orderProblem(order, 5_000_001)).toBe(E_AMOUNT);
  });

  it.each([[null], [undefined], ['5000000'], [NaN], [Infinity]])(
    'refuses a non-numeric amount %j rather than throwing',
    (amount) => {
      expect(orderProblem(order, amount)).toBe(E_AMOUNT);
    }
  );

  it('checks the order state before the amount', () => {
    // A paid order must report "already paid" even when the amount is also wrong — otherwise
    // a customer paying twice is told their amount is bad, which is not the useful fact.
    expect(orderProblem({ ...order, state: 'paid' }, 1)).toBe(E_ORDER_PAID);
  });
});

describe('isAccountError', () => {
  it('covers the account range that must carry a data field', () => {
    expect(isAccountError(E_ORDER_NOT_FOUND)).toBe(true);
    expect(isAccountError(E_ORDER_PAID)).toBe(true);
    expect(isAccountError(-31099)).toBe(true);
  });

  it('excludes everything else', () => {
    expect(isAccountError(E_AMOUNT)).toBe(false);
    expect(isAccountError(-31008)).toBe(false);
    expect(isAccountError(-32504)).toBe(false);
    expect(isAccountError(-31100)).toBe(false);
  });

  it('names the requisite configured in the merchant cabinet', () => {
    // If this string and the cabinet disagree, every payment fails validation with a cause
    // that is invisible from the code.
    expect(ACCOUNT_FIELD).toBe('order_id');
  });
});

describe('timingSafeEqual', () => {
  it('matches identical strings', () => {
    expect(timingSafeEqual('Paycom:secret', 'Paycom:secret')).toBe(true);
  });

  it('rejects different strings of the same length', () => {
    expect(timingSafeEqual('Paycom:secreT', 'Paycom:secret')).toBe(false);
  });

  it('rejects strings of different lengths without throwing', () => {
    expect(timingSafeEqual('short', 'considerably longer')).toBe(false);
    expect(timingSafeEqual('', 'x')).toBe(false);
  });

  it('matches two empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('compares bytes, not code units', () => {
    expect(timingSafeEqual('kalit', 'kalit')).toBe(true);
    expect(timingSafeEqual('kalıt', 'kalit')).toBe(false);
  });
});

describe('isAuthorized', () => {
  const keys = ['prod-key', 'test-key'];
  const header = (raw: string): string => `Basic ${encode(raw)}`;

  it('accepts the production key', () => {
    expect(isAuthorized(header('Paycom:prod-key'), keys, decode)).toBe(true);
  });

  it('accepts the test key too, which is what makes go-live an env change', () => {
    expect(isAuthorized(header('Paycom:test-key'), keys, decode)).toBe(true);
  });

  it('is case-insensitive about the scheme but not the key', () => {
    expect(isAuthorized(`basic ${encode('Paycom:prod-key')}`, keys, decode)).toBe(true);
    expect(isAuthorized(header('Paycom:PROD-KEY'), keys, decode)).toBe(false);
  });

  it('rejects a wrong key', () => {
    expect(isAuthorized(header('Paycom:nope'), keys, decode)).toBe(false);
  });

  it('rejects the right key under the wrong login', () => {
    // The login is always literally "Paycom".
    expect(isAuthorized(header('paycom:prod-key'), keys, decode)).toBe(false);
    expect(isAuthorized(header('prod-key'), keys, decode)).toBe(false);
  });

  it.each([
    [null, 'no header'],
    [undefined, 'undefined header'],
    ['', 'empty header'],
    ['Bearer abc', 'wrong scheme'],
    ['Basic', 'no credentials'],
    ['Basic !!!not base64!!!', 'undecodable']
  ])('rejects %j (%s)', (raw, _why) => {
    expect(isAuthorized(raw as string | null, keys, decode)).toBe(false);
  });

  it('rejects everything when no key is configured', () => {
    // A deploy that forgot the secret must reject rather than accept — an empty key list
    // matching an empty credential would be an open endpoint that moves money.
    expect(isAuthorized(header('Paycom:'), [], decode)).toBe(false);
    expect(isAuthorized(header('Paycom:prod-key'), [], decode)).toBe(false);
  });
});
