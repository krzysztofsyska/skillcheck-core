import { authorizedMailWorker, mailEnabled } from '../../../../lib/sales-mail';
import { runSalesMail } from '../../../../lib/sales-mail-server';

export const maxDuration=60;
export const dynamic='force-dynamic';
/** Prepared for a scheduler. No cron is registered until production is approved. */
export async function GET(request: Request) {
  const headers={'Cache-Control':'no-store'};
  if (!authorizedMailWorker(request.headers.get('authorization'),process.env.SALES_MAIL_CRON_SECRET)) {
    return Response.json({error:'unauthorized'},{status:401,headers});
  }
  if (!mailEnabled()) return Response.json({status:'disabled'},{status:503,headers});
  try {
    const counts: Record<string,number>={};
    for(let n=0;n<5;n++) {
      const status=await runSalesMail();
      if(status==='empty' || status==='disabled') break;
      counts[status]=(counts[status]??0)+1;
    }
    return Response.json({counts},{headers});
  } catch {
    console.error('sales_mail_worker_failed');
    return Response.json({error:'worker_failed'},{status:503,headers});
  }
}
