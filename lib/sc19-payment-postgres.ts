/** PostgreSQL adapter for the existing SC-019 orchestration and credit journal.
 * Server-only composition: never inject a browser connection or expose this API.
 * No provider network I/O may run inside transaction callbacks (they can retry).
 */
import { createHash } from 'node:crypto';
import type { PaymentStore, PaymentTransaction, PaymentOrder, PaymentOffer } from './sc19-payments.ts';
import { Sc19PaymentError } from './sc19-payments.ts';
export interface PaymentSqlClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  release(): void;
}
export interface PaymentSqlPool { connect(): Promise<PaymentSqlClient> }
export type CheckoutOffer = PaymentOffer & Readonly<{ termsText: string }>;
const fail = (code: string): never => { throw new Sc19PaymentError(code); };
function orderRow(r: Record<string, unknown>): PaymentOrder {
  return {
    id: String(r.id), companyId: String(r.company_id), buyerId: String(r.buyer_id), requestId: String(r.request_id),
    offerId: String(r.offer_id), offerRevision: String(r.offer_revision), termsRevision: String(r.terms_revision),
    amountMinor: Number(r.amount_minor), currency: 'PLN', credits: Number(r.credits),
    scope: { provider: String(r.provider), account: String(r.account), mode: r.mode as 'test' | 'live' },
    status: r.status as PaymentOrder['status'], sessionId: r.session_id as string | null,
    checkoutUrl: r.checkout_url as string | null, paymentId: r.payment_id as string | null,
    checkoutDeadlineMs: Number(r.checkout_deadline_ms),
  };
}
function offerRow(r: Record<string, unknown>): CheckoutOffer {
  return { id: String(r.id), revision: String(r.revision), plan: 'PRESELEKCJA', active: r.active === true,
    approved: r.approved === true, amountMinor: Number(r.amount_minor), currency: 'PLN', credits: Number(r.credits),
    termsRevision: String(r.terms_revision), termsText: String(r.terms_text), validUntilMs: Number(r.valid_until_ms) };
}
export function createPostgresPaymentStore(pool: PaymentSqlPool): PaymentStore & {
  readOrder(companyId: string, userId: string, orderId: string): Promise<PaymentOrder | null>;
  listOffers(companyId: string, userId: string): Promise<CheckoutOffer[]>;
} {
  async function transaction<T>(work: (tx: PaymentTransaction, client: PaymentSqlClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const c = await pool.connect();
      try {
        await c.query('begin isolation level serializable');
        await c.query("set local lock_timeout='5s'");
        await c.query("set local statement_timeout='10s'");
        const lockCompany = async (companyId: string) => {
          // Same order as #92 spend/refund/grant: COMPANY before order/balance/journal.
          const r = await c.query('select id from public.companies where id=$1 for update', [companyId]);
          if (!r.rows.length) fail('SC19_PAYMENT_FORBIDDEN');
        };
        const tx: PaymentTransaction = {
          async companyAccess(companyId, userId) {
            await lockCompany(companyId);
            const owner = await c.query('select id from public.companies where id=$1 and owner_id=$2', [companyId,userId]);
            const approved = await c.query('select company_id from private.sc19_trial_approvals where company_id=$1 for share', [companyId]);
            return { owner: owner.rows.length === 1, verified: approved.rows.length === 1 };
          },
          async offer(id) {
            const r = await c.query('select * from private.sc19_payment_offers where id=$1 for share', [id]);
            return r.rows[0] ? offerRow(r.rows[0]) : null;
          },
          async orderByRequest(companyId, requestId) {
            await lockCompany(companyId);
            const r = await c.query('select * from private.sc19_payment_orders where company_id=$1 and request_id=$2 for update',[companyId,requestId]);
            return r.rows[0] ? orderRow(r.rows[0]) : null;
          },
          async order(id) {
            const found = await c.query('select company_id from private.sc19_payment_orders where id=$1',[id]);
            if (!found.rows[0]) return null;
            await lockCompany(String(found.rows[0].company_id));
            const r = await c.query('select * from private.sc19_payment_orders where id=$1 for update',[id]);
            return r.rows[0] ? orderRow(r.rows[0]) : null;
          },
          async insertOrder(o) {
            await c.query(`insert into private.sc19_payment_orders
              (id,company_id,buyer_id,request_id,offer_id,offer_revision,terms_revision,amount_minor,currency,credits,
               provider,account,mode,status,session_id,checkout_url,payment_id,checkout_deadline_ms)
              values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
            [o.id,o.companyId,o.buyerId,o.requestId,o.offerId,o.offerRevision,o.termsRevision,o.amountMinor,o.currency,o.credits,
              o.scope.provider,o.scope.account,o.scope.mode,o.status,o.sessionId,o.checkoutUrl,o.paymentId,o.checkoutDeadlineMs]);
          },
          async saveOrder(o) {
            const r = await c.query(`update private.sc19_payment_orders set status=$2,session_id=$3,checkout_url=$4,payment_id=$5
              where id=$1 and company_id=$6`,[o.id,o.status,o.sessionId,o.checkoutUrl,o.paymentId,o.companyId]);
            if (r.rowCount !== 1) fail('SC19_PAYMENT_ORDER_MISSING');
          },
          async grantOnce(key,o) {
            // Receipt uniqueness is global across tenants; never dedup just eventId.
            const inserted = await c.query(`insert into private.sc19_payment_grants(payment_key,order_id)
              values($1,$2) on conflict(payment_key) do nothing returning order_id`,[key,o.id]);
            if (!inserted.rows.length) {
              const previous = await c.query('select order_id from private.sc19_payment_grants where payment_key=$1',[key]);
              if (!previous.rows[0]) fail('SC19_PAYMENT_RETRY');
              return String(previous.rows[0].order_id);
            }
            // Same canonical reference must be used for any future operator recovery.
            const reference = `settlement:sc19:${createHash('sha256').update(key).digest('hex')}`;
            await c.query(`insert into private.sc19_credit_journal(company_id,reason,delta,reference)
              values($1,'paid_grant',$2,$3)`,[o.companyId,o.credits,reference]);
            await c.query(`insert into private.sc19_balances(company_id,plan,available)
              values($1,'PRESELEKCJA',$2) on conflict(company_id) do update
              set plan='PRESELEKCJA',available=private.sc19_balances.available+excluded.available,updated_at=now()`,[o.companyId,o.credits]);
            return null;
          },
        };
        const result = await work(tx,c);
        await c.query('commit');
        return result;
      } catch(error) {
        await c.query('rollback').catch(() => {});
        const code = (error as { code?: string }).code;
        const requestRace = code === '23505' && (error as { constraint?: string }).constraint === 'sc19_payment_orders_company_id_request_id_key';
        if ((!['40001','40P01'].includes(code ?? '') && !requestRace) || attempt >= 5) throw error;
      } finally { c.release(); }
      // Bounded jitter outside the connection; the retried callback contains DB work only.
      await new Promise(resolve => setTimeout(resolve, 5 + Math.random() * 20));
    }
  }
  const authorized = async (tx: PaymentTransaction, companyId: string, userId: string) => {
    const a = await tx.companyAccess(companyId,userId);
    if (!a.owner) fail('SC19_PAYMENT_FORBIDDEN');
    return a;
  };
  return {
    transaction,
    readOrder: (companyId,userId,id) => transaction(async (tx,c) => {
      await authorized(tx,companyId,userId);
      // Scope the SELECT before returning any order, including existence information.
      const r = await c.query('select * from private.sc19_payment_orders where id=$1 and company_id=$2',[id,companyId]);
      return r.rows[0] ? orderRow(r.rows[0]) : null;
    }),
    listOffers: (companyId,userId) => transaction(async (tx,c) => {
      const a = await authorized(tx,companyId,userId);
      if (!a.verified) fail('SC19_PAYMENT_FORBIDDEN');
      const r = await c.query(`select * from private.sc19_payment_offers
        where approved and active and valid_until_ms>$1 order by created_at desc limit 20`,[Date.now()]);
      return r.rows.map(offerRow);
    }),
  };
}
