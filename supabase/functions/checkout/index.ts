import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

/**
 * Build a Payme checkout link for the signed-in user.
 *
 * This exists as a server endpoint rather than as a URL the app assembles for one reason:
 * **the amount must be fixed by us, before the customer reaches a payment page.** The
 * checkout link carries a price, and the whole Merchant API validation chain
 * (supabase/functions/payme/index.ts) rests on comparing what Payme reports against what we
 * wrote down. If the app built the link, the price in it would be whatever the app said, and
 * there would be nothing independent to check it against.
 *
 * So: create (or reuse) a `pending` order with the price read from `plan_limits`, then hand
 * back a URL pointing at it. The merchant id and the checkout domain also stay here, which
 * means switching from the sandbox to production is an environment change on the server and
 * not a release of the desktop app.
 */

const MERCHANT_ID = Deno.env.get('PAYME_MERCHANT_ID')?.trim() ?? '';

/**
 * `https://test.paycom.uz` while the sandbox tests are being run, `https://checkout.paycom.uz`
 * once the cassa is live. An environment variable rather than a constant precisely so that
 * flipping it needs no code change and no client release.
 */
const CHECKOUT_BASE = Deno.env.get('PAYME_CHECKOUT_URL')?.trim() || 'https://checkout.paycom.uz';

/** The account requisite configured in the merchant cabinet. Must match payme/index.ts. */
const ACCOUNT_FIELD = 'order_id';

/** How many months one purchase buys. */
const MONTHS = 1;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/**
 * The most recent reusable pending order, if there is one.
 *
 * Reused rather than always creating a new row because tapping "upgrade", closing the browser
 * and tapping again is ordinary behaviour, and each tap would otherwise leave a dead order
 * behind. An order carrying an *active* transaction is skipped: Payme allows only one at a
 * time per account, so sending the customer back to that one would meet a -31008 they can do
 * nothing about.
 */
async function reusableOrder(
  db: SupabaseClient,
  userId: string,
  amountTiyin: number
): Promise<number | null> {
  const { data } = await db
    .from('payme_orders')
    .select('id, payme_transactions(state)')
    .eq('user_id', userId)
    .eq('state', 'pending')
    .eq('amount_tiyin', amountTiyin)
    .order('created_at', { ascending: false })
    .limit(5);

  for (const row of (data ?? []) as Array<{ id: number; payme_transactions: { state: number }[] }>) {
    const active = (row.payme_transactions ?? []).some((t) => t.state === 1);
    if (!active) return row.id;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (!MERCHANT_ID) {
    console.error('[checkout] PAYME_MERCHANT_ID is not set');
    return json({ error: 'To‘lov hali sozlanmagan' }, 503);
  }

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Kirish kerak' }, 401);

  const db = serviceClient();
  const { data: userData, error: userErr } = await db.auth.getUser(token);
  const user = userData?.user;
  if (userErr || !user) return json({ error: 'Kirish muddati tugadi — qaytadan kiring' }, 401);

  // The price comes from the table, never from the request. This is the line that makes the
  // amount trustworthy for the rest of the payment flow.
  const { data: limits, error: limitErr } = await db
    .from('plan_limits')
    .select('price_tiyin')
    .eq('plan', 'pro')
    .maybeSingle();

  const amountTiyin = Number(limits?.price_tiyin ?? 0);
  if (limitErr || !Number.isFinite(amountTiyin) || amountTiyin <= 0) {
    console.error('[checkout] no usable price for the pro plan:', limitErr?.message);
    return json({ error: 'Narx noma’lum — keyinroq urinib ko‘ring' }, 503);
  }

  let orderId = await reusableOrder(db, user.id, amountTiyin);

  if (orderId === null) {
    const { data, error } = await db
      .from('payme_orders')
      .insert({ user_id: user.id, months: MONTHS, amount_tiyin: amountTiyin })
      .select('id')
      .single();

    if (error || !data) {
      console.error('[checkout] could not create an order:', error?.message);
      return json({ error: 'Buyurtma yaratilmadi — keyinroq urinib ko‘ring' }, 500);
    }
    orderId = data.id as number;
  }

  // Payme takes its parameters as a base64'd `key=value;key=value` string in the path, not as
  // a query string. `a` is in **tiyin**; a factor-of-a-hundred slip here is the classic bug,
  // which is why the number is never converted anywhere but in plan_limits.
  const params = [
    `m=${MERCHANT_ID}`,
    `ac.${ACCOUNT_FIELD}=${orderId}`,
    `a=${amountTiyin}`,
    'l=uz'
  ].join(';');

  const url = `${CHECKOUT_BASE}/${btoa(params)}`;
  console.log(`[checkout] user=${user.id} order=${orderId} amount=${amountTiyin}`);

  return json({ url, orderId, amountTiyin });
});
