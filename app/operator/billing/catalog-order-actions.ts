'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { salesOperator } from '../sales/access';
import { catalogRpc, catalogUuid } from '../../../lib/sc19-catalog-orders';

export async function settleCatalogOrder(form: FormData) {
 const client=await salesOperator();
 const order=form.get('orderId'),reference=form.get('settlement'),amount=form.get('amountMinor');
 let status='invalid';
 if(catalogUuid(order)&&typeof reference==='string'&&reference.trim().length>=8&&reference.length<=160&&
  typeof amount==='string'&&/^\d{1,9}$/.test(amount)&&form.get('confirm')==='yes') {
  const {error}=await catalogRpc(client,'sc19_settle_catalog_order',{target_order:order,settlement_reference:reference,
   confirmed_gross:Number(amount),confirmed_currency:'PLN'});
  status=error?'failed':'paid';
 }
 revalidatePath('/operator/billing');redirect(`/operator/billing?catalogStatus=${status}`);
}
