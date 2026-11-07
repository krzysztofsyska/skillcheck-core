'use server';
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { companyAccess } from '../../../../../lib/company-access';
import { catalogQuotes, catalogRpc, catalogUuid } from '../../../../../lib/sc19-catalog-orders';

export async function placeCatalogOrder(form: FormData) {
 const companyId = form.get('companyId');
 if (!catalogUuid(companyId)) redirect('/dashboard');
 const { client, company, user } = await companyAccess(companyId);
 const recruitment = form.get('recruitmentId');
 const base = `/dashboard/${companyId}/billing/checkout`;
 const query = new URLSearchParams();
 if (catalogUuid(recruitment)) query.set('recruitmentId', recruitment);
 let status = 'failed';
 if (company.owner_id === user.id && process.env.SC19_PACKAGES_ENABLED === 'true' &&
  process.env.SC19_CATALOG_ORDERS_ENABLED === 'true' && form.get('accepted') === 'yes') {
  try {
   const raw = form.get('quote');
   if (typeof raw !== 'string' || raw.length > 24000) throw Error('Invalid quote');
   const quote = catalogQuotes([JSON.parse(raw)])[0];
   const request = form.get('requestId');
   if (!catalogUuid(request)) throw Error('Invalid request');
   const { error } = await catalogRpc(client, 'sc19_create_catalog_order', {
    target_company: companyId, request_key: request, expected_quote: quote, accepted: true,
   });
   status = error ? (error.code === '23505' ? 'pending' : 'changed') : 'created';
  } catch { status = 'failed'; }
 }
 query.set('catalogStatus',status);
 revalidatePath(base); redirect(`${base}?${query}`);
}

export async function cancelCatalogOrder(form: FormData) {
 const companyId=form.get('companyId'), orderId=form.get('orderId');
 if (!catalogUuid(companyId) || !catalogUuid(orderId)) redirect('/dashboard');
 const { client, company, user }=await companyAccess(companyId);
 if (company.owner_id!==user.id) redirect('/dashboard');
 const { error }=await catalogRpc(client,'sc19_cancel_catalog_order',{target_company:companyId,target_order:orderId});
 const query=new URLSearchParams({catalogStatus:error?'failed':'cancelled'});
 const recruitment=form.get('recruitmentId');if(catalogUuid(recruitment))query.set('recruitmentId',recruitment);
 const base=`/dashboard/${companyId}/billing/checkout`;revalidatePath(base);redirect(`${base}?${query}`);
}
