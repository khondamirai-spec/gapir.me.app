import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  ACCOUNT_FIELD,
  CANCELLED,
  CREATED,
  E_AMOUNT,
  E_AUTH,
  E_IMPOSSIBLE,
  E_METHOD,
  E_ORDER_CANCELLED,
  E_ORDER_NOT_FOUND,
  E_ORDER_PAID,
  E_PARSE,
  E_TX_NOT_FOUND,
  PERFORMED,
  REFUNDED,
  isAccountError,
  isAuthorized,
  isExpired,
  orderProblem,
  parseAccountId,
  type OrderRow
} from '../_shared/payme-rules.ts';

/**
 * The Payme (paycom.uz) Merchant API endpoint.
 *
 * **Payme calls us; we never call Payme.** While a customer sits on the hosted checkout page,
 * Payme's billing servers POST JSON-RPC 2.0 to this URL, and the subscription is granted here
 * — on PerformTransaction — never because the customer navigated back to the app. Anything in
 * the app that looks like it grants a plan is showing a result, not producing one.
 *
 * ## The rules this file exists to obey
 *
 * Each of these is a way the sandbox at test.paycom.uz fails an integration, and each is
 * counter-intuitive enough to be worth stating rather than inferring from the code:
 *
 * - **Always HTTP 200.** Errors are a JSON body, never an HTTP status. A 4xx or a crashed
 *   500 reads to Payme as -32400 and fails the test that was actually passing.
 * - **Idempotency is mandatory.** Payme retries Create/Perform/Cancel, and a retry must
 *   return the *identical saved result* — the same create_time to the millisecond — and must
 *   not have a second effect. That is why every state change below is a compare-and-swap and
 *   every "already in that state" branch returns stored values rather than recomputing them.
 * - **Amounts are tiyin** (so'm x 100), compared against the amount fixed on the order when
 *   it was created. Never against anything the caller supplies.
 * - **A state-1 transaction older than 12 hours must be cancelled** with state -1, reason 4.
 *   Checked lazily inside Create and Perform, so there is no cron job to forget.
 * - **Auth is Basic `Paycom:<key>`**, checked before anything else, and checked against
 *   *every* configured key. Accepting both the sandbox and production keys is what makes
 *   going live a change of environment variables rather than a change of code.
 *
 * ## What it must not do
 *
 * CheckPerformTransaction must **not** fail because an active transaction exists on the
 * order. It is a pre-check; the one-active-transaction rule belongs to CreateTransaction (and
 * here is enforced by a partial unique index in the migration). Blocking it here cascades into
 * sandbox failures that look like they come from somewhere else entirely.
 *
 * And PerformTransaction must answer *success* even if granting the subscription throws.
 * Payme has been told the money moved; turning a fulfilment bug into a payment-protocol error
 * would leave a paid customer whose payment Payme believes failed. Log loudly instead.
 */

// Both keys are accepted so sandbox -> production is a pure environment change: during
// testing only PAYME_TEST_KEY is set; at go-live PAYME_KEY is added; then the test key is
// removed. The merchant *key* is a secret and lives only here, never in the app.
const KEYS = [Deno.env.get('PAYME_KEY'), Deno.env.get('PAYME_TEST_KEY')]
  .map((k) => k?.trim())
  .filter((k): k is string => !!k);

interface Localized {
  ru: string;
  uz: string;
  en: string;
}

const MESSAGES: Record<number, Localized> = {
  [E_AUTH]: { ru: 'Недостаточно привилегий', uz: 'Ruxsat yetarli emas', en: 'Insufficient privileges' },
  [E_PARSE]: { ru: 'Ошибка разбора JSON', uz: 'JSON o‘qib bo‘lmadi', en: 'JSON parse error' },
  [E_METHOD]: { ru: 'Метод не найден', uz: 'Usul topilmadi', en: 'Method not found' },
  [E_AMOUNT]: { ru: 'Неверная сумма', uz: 'Summa noto‘g‘ri', en: 'Incorrect amount' },
  [E_TX_NOT_FOUND]: { ru: 'Транзакция не найдена', uz: 'Tranzaksiya topilmadi', en: 'Transaction not found' },
  [E_IMPOSSIBLE]: {
    ru: 'Операция невозможна в текущем состоянии',
    uz: 'Bu holatda amalni bajarib bo‘lmaydi',
    en: 'Operation is not possible in the current state'
  },
  [E_ORDER_NOT_FOUND]: { ru: 'Заказ не найден', uz: 'Buyurtma topilmadi', en: 'Order not found' },
  [E_ORDER_PAID]: { ru: 'Заказ уже оплачен', uz: 'Buyurtma allaqachon to‘langan', en: 'Order is already paid' },
  [E_ORDER_CANCELLED]: { ru: 'Заказ отменён', uz: 'Buyurtma bekor qilingan', en: 'Order is cancelled' }
};

// ------------------------------------------------------------------ replies

/**
 * Every reply, success or failure, is HTTP 200 with the request's `id` echoed back.
 *
 * The status code is the single most common way an otherwise-correct integration fails its
 * sandbox run, which is why there is exactly one place in this file that builds a Response.
 */
function reply(id: unknown, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, ...payload }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function ok(id: unknown, result: Record<string, unknown>): Response {
  return reply(id, { result });
}

/**
 * Account errors (-31050…-31099) must carry `data` naming the offending account field, and
 * everything else must not — so the caller never decides, `isAccountError` does.
 */
function err(id: unknown, code: number): Response {
  const error: Record<string, unknown> = {
    code,
    message: MESSAGES[code] ?? { ru: 'Ошибка', uz: 'Xato', en: 'Error' }
  };
  if (isAccountError(code)) error.data = ACCOUNT_FIELD;
  return reply(id, { error });
}

// ----------------------------------------------------------------- database

function db(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

interface Transaction {
  id: number;
  paycom_id: string;
  order_id: number;
  amount_tiyin: number;
  state: number;
  create_time: number;
  perform_time: number;
  cancel_time: number;
  reason: number | null;
}

/** The account id out of `params.account.order_id`. Parsing rules live in _shared. */
function readOrderId(params: Record<string, unknown>): number | null {
  const account = params.account as Record<string, unknown> | undefined;
  return parseAccountId(account?.[ACCOUNT_FIELD]);
}

/** Fetch the order, then apply the pure checks CheckPerform defines and Create re-runs. */
async function validateOrder(
  client: SupabaseClient,
  orderId: number | null,
  amount: unknown
): Promise<{ order?: OrderRow; code?: number }> {
  if (orderId === null) return { code: E_ORDER_NOT_FOUND };

  const { data } = await client
    .from('payme_orders')
    .select('id, amount_tiyin, state')
    .eq('id', orderId)
    .maybeSingle();

  const order = data as OrderRow | null;
  const problem = orderProblem(order, amount);
  if (problem !== null) return { code: problem };

  return { order: order as OrderRow };
}

async function findTransaction(
  client: SupabaseClient,
  paycomId: unknown
): Promise<Transaction | null> {
  if (typeof paycomId !== 'string' || !paycomId) return null;
  const { data } = await client
    .from('payme_transactions')
    .select('*')
    .eq('paycom_id', paycomId)
    .maybeSingle();
  return (data as Transaction | null) ?? null;
}

/**
 * Cancel a transaction that outlived Payme's 12-hour window.
 *
 * Lazy rather than scheduled: it is only ever relevant when someone asks about the
 * transaction, and a cron job that must not miss a run is a worse dependency than a check
 * that runs exactly when it matters.
 */
async function cancelTimedOut(client: SupabaseClient, tx: Transaction): Promise<void> {
  await client
    .from('payme_transactions')
    .update({ state: CANCELLED, reason: 4, cancel_time: Date.now() })
    .eq('id', tx.id)
    .eq('state', CREATED);
}

function isTimedOut(tx: Transaction): boolean {
  return isExpired(Number(tx.create_time), Date.now());
}

// ------------------------------------------------------------------ methods

async function checkPerformTransaction(
  client: SupabaseClient,
  id: unknown,
  params: Record<string, unknown>
): Promise<Response> {
  const { code } = await validateOrder(client, readOrderId(params), params.amount);
  if (code) return err(id, code);
  // Note what is *not* checked: whether an active transaction exists. See the file header.
  return ok(id, { allow: true });
}

async function createTransaction(
  client: SupabaseClient,
  id: unknown,
  params: Record<string, unknown>
): Promise<Response> {
  const existing = await findTransaction(client, params.id);

  if (existing) {
    if (existing.state !== CREATED) return err(id, E_IMPOSSIBLE);
    if (isTimedOut(existing)) {
      await cancelTimedOut(client, existing);
      return err(id, E_IMPOSSIBLE);
    }
    // The retry case. Saved values, to the millisecond — recomputing `create_time` here is
    // the classic idempotency bug and Payme compares it.
    return ok(id, {
      create_time: Number(existing.create_time),
      transaction: String(existing.id),
      state: CREATED
    });
  }

  // A create that Payme itself stamped more than 12 hours ago is stale on arrival.
  const stamped = typeof params.time === 'number' ? params.time : 0;
  if (!stamped || isExpired(stamped, Date.now())) return err(id, E_IMPOSSIBLE);

  const orderId = readOrderId(params);
  const { order, code } = await validateOrder(client, orderId, params.amount);
  if (code || !order) return err(id, code ?? E_ORDER_NOT_FOUND);

  const now = Date.now();
  const { data, error } = await client
    .from('payme_transactions')
    .insert({
      paycom_id: params.id as string,
      paycom_time: stamped,
      order_id: order.id,
      amount_tiyin: order.amount_tiyin,
      state: CREATED,
      create_time: now
    })
    .select('id, create_time')
    .single();

  if (error) {
    // Two unique constraints can bite here and they mean different things. A paycom_id
    // collision is a racing duplicate of *this* request — re-read and answer idempotently. An
    // active-order collision is a different transaction already holding the order, which is
    // the one-time-account rule and a genuine -31008.
    const raced = await findTransaction(client, params.id);
    if (raced) {
      return ok(id, {
        create_time: Number(raced.create_time),
        transaction: String(raced.id),
        state: raced.state
      });
    }
    console.warn('[payme] CreateTransaction rejected:', error.message);
    return err(id, E_IMPOSSIBLE);
  }

  return ok(id, {
    create_time: Number(data.create_time),
    transaction: String(data.id),
    state: CREATED
  });
}

async function performTransaction(
  client: SupabaseClient,
  id: unknown,
  params: Record<string, unknown>
): Promise<Response> {
  const tx = await findTransaction(client, params.id);
  if (!tx) return err(id, E_TX_NOT_FOUND);

  if (tx.state === PERFORMED) {
    return ok(id, {
      transaction: String(tx.id),
      perform_time: Number(tx.perform_time),
      state: PERFORMED
    });
  }

  if (tx.state !== CREATED) return err(id, E_IMPOSSIBLE);

  if (isTimedOut(tx)) {
    await cancelTimedOut(client, tx);
    return err(id, E_IMPOSSIBLE);
  }

  const now = Date.now();
  const { data } = await client
    .from('payme_transactions')
    .update({ state: PERFORMED, perform_time: now })
    .eq('id', tx.id)
    .eq('state', CREATED)
    .select('id, perform_time');

  // Compare-and-swap: exactly one concurrent caller updates a row, and only that one grants
  // the subscription. The loser re-reads and answers with what the winner stored.
  if (!data || data.length === 0) {
    const settled = await findTransaction(client, params.id);
    if (settled?.state === PERFORMED) {
      return ok(id, {
        transaction: String(settled.id),
        perform_time: Number(settled.perform_time),
        state: PERFORMED
      });
    }
    return err(id, E_IMPOSSIBLE);
  }

  // The money has moved. From here the answer is success no matter what — see the header.
  try {
    const { error } = await client.rpc('fulfil_payme_order', { p_order: tx.order_id });
    if (error) throw new Error(error.message);
    console.log(`[payme] order ${tx.order_id} paid and fulfilled (tx ${tx.paycom_id})`);
  } catch (fulfilErr) {
    console.error(
      `[payme] PAID BUT NOT FULFILLED — order ${tx.order_id}, tx ${tx.paycom_id}: ` +
        (fulfilErr instanceof Error ? fulfilErr.message : String(fulfilErr)) +
        ' — grant this subscription by hand.'
    );
  }

  return ok(id, { transaction: String(tx.id), perform_time: now, state: PERFORMED });
}

async function cancelTransaction(
  client: SupabaseClient,
  id: unknown,
  params: Record<string, unknown>
): Promise<Response> {
  const tx = await findTransaction(client, params.id);
  if (!tx) return err(id, E_TX_NOT_FOUND);

  if (tx.state === CANCELLED || tx.state === REFUNDED) {
    return ok(id, {
      transaction: String(tx.id),
      cancel_time: Number(tx.cancel_time),
      state: tx.state
    });
  }

  const now = Date.now();
  const reason = typeof params.reason === 'number' ? params.reason : null;

  if (tx.state === CREATED) {
    const { data } = await client
      .from('payme_transactions')
      .update({ state: CANCELLED, cancel_time: now, reason })
      .eq('id', tx.id)
      .eq('state', CREATED)
      .select('id');

    if (!data || data.length === 0) {
      const settled = await findTransaction(client, params.id);
      return ok(id, {
        transaction: String(tx.id),
        cancel_time: Number(settled?.cancel_time ?? now),
        state: settled?.state ?? CANCELLED
      });
    }

    // The order stays `pending`, deliberately. No money moved, so it must remain payable —
    // the sandbox's cancel-then-recreate flow depends on this, and so does a real customer
    // whose card was declined and who is about to try another one.
    return ok(id, { transaction: String(tx.id), cancel_time: now, state: CANCELLED });
  }

  // state === PERFORMED: a refund.
  const { data } = await client
    .from('payme_transactions')
    .update({ state: REFUNDED, cancel_time: now, reason })
    .eq('id', tx.id)
    .eq('state', PERFORMED)
    .select('id');

  if (!data || data.length === 0) {
    const settled = await findTransaction(client, params.id);
    return ok(id, {
      transaction: String(tx.id),
      cancel_time: Number(settled?.cancel_time ?? now),
      state: settled?.state ?? REFUNDED
    });
  }

  try {
    const { error } = await client.rpc('refund_payme_order', { p_order: tx.order_id });
    if (error) throw new Error(error.message);
  } catch (refundErr) {
    console.error(
      `[payme] refund of order ${tx.order_id} did not revoke the plan: ` +
        (refundErr instanceof Error ? refundErr.message : String(refundErr))
    );
  }
  // Refunds deserve human eyes even when everything worked.
  console.warn(`[payme] REFUND — order ${tx.order_id}, tx ${tx.paycom_id}, reason ${reason}`);

  return ok(id, { transaction: String(tx.id), cancel_time: now, state: REFUNDED });
}

async function checkTransaction(
  client: SupabaseClient,
  id: unknown,
  params: Record<string, unknown>
): Promise<Response> {
  const tx = await findTransaction(client, params.id);
  if (!tx) return err(id, E_TX_NOT_FOUND);

  // Unset times are 0 and an unset reason is null — not undefined, and not omitted.
  return ok(id, {
    create_time: Number(tx.create_time),
    perform_time: Number(tx.perform_time),
    cancel_time: Number(tx.cancel_time),
    transaction: String(tx.id),
    state: tx.state,
    reason: tx.reason ?? null
  });
}

async function getStatement(
  client: SupabaseClient,
  id: unknown,
  params: Record<string, unknown>
): Promise<Response> {
  const from = typeof params.from === 'number' ? params.from : 0;
  const to = typeof params.to === 'number' ? params.to : Date.now();

  // Filtered on paycom_time — Payme's own stamp — rather than on our create_time. The two can
  // differ, and reconciliation is Payme comparing its records against ours by its clock.
  const { data, error } = await client
    .from('payme_transactions')
    .select('*, payme_orders!inner(id)')
    .gte('paycom_time', from)
    .lte('paycom_time', to)
    .order('paycom_time', { ascending: true });

  if (error) {
    console.error('[payme] GetStatement failed:', error.message);
    return ok(id, { transactions: [] });
  }

  const transactions = (data ?? []).map((row: Record<string, unknown>) => ({
    id: row.paycom_id,
    time: Number(row.paycom_time),
    amount: Number(row.amount_tiyin),
    account: { [ACCOUNT_FIELD]: String(row.order_id) },
    create_time: Number(row.create_time),
    perform_time: Number(row.perform_time),
    cancel_time: Number(row.cancel_time),
    transaction: String(row.id),
    state: row.state,
    reason: row.reason ?? null
  }));

  return ok(id, { transactions });
}

// ----------------------------------------------------------------- dispatch

Deno.serve(async (req) => {
  // Payme only ever POSTs. Anything else still answers 200 with a JSON-RPC error rather than
  // a 405, for the same reason everything else here does.
  if (req.method !== 'POST') return err(null, E_METHOD);

  if (KEYS.length === 0) {
    console.error('[payme] neither PAYME_KEY nor PAYME_TEST_KEY is set — every call will be rejected');
    return err(null, E_AUTH);
  }

  // Auth first, before parsing the body: an unauthorized caller learns nothing about what
  // this endpoint would have made of their request.
  // `atob` is injected because _shared/payme-rules.ts is imported by vitest too, where it
  // does not exist. Deno has it; Node spells the same thing with Buffer.
  if (!isAuthorized(req.headers.get('Authorization'), KEYS, atob)) return err(null, E_AUTH);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return err(null, E_PARSE);
  }

  const id = body.id ?? null;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = (body.params ?? {}) as Record<string, unknown>;
  const client = db();

  // Every handler runs inside this try. A thrown exception must not become an HTTP 500 —
  // Payme reads that as -32400 and the sandbox marks a test red for the wrong reason.
  try {
    switch (method) {
      case 'CheckPerformTransaction':
        return await checkPerformTransaction(client, id, params);
      case 'CreateTransaction':
        return await createTransaction(client, id, params);
      case 'PerformTransaction':
        return await performTransaction(client, id, params);
      case 'CancelTransaction':
        return await cancelTransaction(client, id, params);
      case 'CheckTransaction':
        return await checkTransaction(client, id, params);
      case 'GetStatement':
        return await getStatement(client, id, params);
      default:
        return err(id, E_METHOD);
    }
  } catch (crash) {
    console.error(
      `[payme] ${method} crashed:`,
      crash instanceof Error ? crash.stack ?? crash.message : String(crash)
    );
    return err(id, E_IMPOSSIBLE);
  }
});
