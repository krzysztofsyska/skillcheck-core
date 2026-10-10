import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { salesMailTemplateV1 } from './sales-mail-template.ts';

export type MailJob = { lead_id: string; email: string; template_version: string; lease_id: string };
export type MailOutcome = 'accepted' | 'retry' | 'failed';
export function mailSignature(op: 'claim'|'finish', target: string|null, lease: string, stamp: number,
  outcome: MailOutcome|null, provider: string|null, secret: string) {
  if (!Number.isSafeInteger(stamp) || Buffer.byteLength(secret)<32) throw new Error('sales_mail_config');
  return createHmac('sha256',secret).update(['sales-mail-v1',op,target??'-',lease,String(stamp),outcome??'-',provider??'-'].join('\n')).digest('hex');
}
export function authorizedMailWorker(header: string|null, secret: string|undefined) {
  if (!secret || Buffer.byteLength(secret)<32 || !header) return false;
  const a=Buffer.from(header), b=Buffer.from(`Bearer ${secret}`);
  return a.length===b.length && timingSafeEqual(a,b);
}
export function mailEnabled(env: NodeJS.ProcessEnv=process.env) {
  return env.SALES_AUTO_REPLY_ENABLED==='true' && env.VERCEL_ENV==='production'
    && Boolean(env.RESEND_API_KEY) && Buffer.byteLength(env.SALES_MAIL_WORKER_SECRET??'')>=32;
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function sendSalesMail(job: MailJob, apiKey: string, fetcher: typeof fetch=fetch): Promise<{outcome: MailOutcome; provider: string|null}> {
  // Strictly one database-sourced address; never accept headers/body/recipients from the request.
  if (job.template_version!=='v1' || !uuid.test(job.lead_id) || !/^[^\s@<>,;:]+@[^\s@<>,;:]+\.[^\s@<>,;:]+$/.test(job.email)
    || job.email.length>254 || /[\x00-\x1f\x7f]/.test(job.email)) return {outcome:'failed',provider:null};
  try {
    const response=await fetcher('https://api.resend.com/emails',{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json','Idempotency-Key':`sales-confirmation-v1/${job.lead_id}`},
      body:JSON.stringify({...salesMailTemplateV1(),to:[job.email]}),
    });
    if (response.ok) {
      const data: unknown=await response.json();
      if (data && typeof data==='object' && 'id' in data && typeof data.id==='string' && uuid.test(data.id)) return {outcome:'accepted',provider:data.id};
      return {outcome:'retry',provider:null};
    }
    return {outcome:response.status===408 || response.status===409 || response.status===429 || response.status>=500?'retry':'failed',provider:null};
  } catch { return {outcome:'retry',provider:null}; }
}
export interface MailStore {
  claim(target: string|null, lease: string, stamp: number, signature: string): Promise<MailJob|null>;
  finish(job: MailJob, stamp: number, outcome: MailOutcome, provider: string|null, signature: string): Promise<boolean>;
}
export async function dispatchSalesMail(store: MailStore, target: string|null, env: NodeJS.ProcessEnv=process.env, fetcher: typeof fetch=fetch) {
  if (!mailEnabled(env)) return 'disabled';
  const secret=env.SALES_MAIL_WORKER_SECRET!;
  const lease=randomUUID(), stamp=Date.now();
  const job=await store.claim(target,lease,stamp,mailSignature('claim',target,lease,stamp,null,null,secret));
  if (!job) return 'empty';
  const result=await sendSalesMail(job,env.RESEND_API_KEY!,fetcher);
  const finished=Date.now();
  const saved=await store.finish(job,finished,result.outcome,result.provider,mailSignature('finish',job.lead_id,job.lease_id,finished,result.outcome,result.provider,secret));
  // Accepted means provider acceptance, not mailbox delivery. Never log addresses or provider responses.
  return saved?result.outcome:'unconfirmed';
}
