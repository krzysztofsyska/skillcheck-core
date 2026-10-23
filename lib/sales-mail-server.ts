import 'server-only';
import { createClient } from './supabase/server';
import { dispatchSalesMail, type MailStore } from './sales-mail';

export async function runSalesMail(target: string|null=null) {
  const client=await createClient();
  const store: MailStore={
    async claim(target,lease,stamp,signature) {
      const {data,error}=await client.rpc('claim_sales_mail',{target_lead:target,request_id:lease,issued_at_ms:stamp,request_signature:signature});
      if(error) throw new Error('sales_mail_claim_failed');
      return data?.[0]??null;
    },
    async finish(job,stamp,outcome,provider,signature) {
      const {data,error}=await client.rpc('finish_sales_mail',{target_lead:job.lead_id,request_id:job.lease_id,issued_at_ms:stamp,outcome,provider_id:provider,request_signature:signature});
      if(error) throw new Error('sales_mail_finish_failed');
      return data===true;
    },
  };
  return dispatchSalesMail(store,target);
}
