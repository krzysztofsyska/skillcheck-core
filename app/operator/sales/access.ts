import 'server-only';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '../../../lib/supabase/server';
export async function salesOperator() {
  const client = await createClient();
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) redirect('/login');
  const { data, error: checkError } = await client.rpc('platform_operator_status');
  if (checkError) throw new Error('Nie udało się sprawdzić dostępu.');
  if (data !== true) notFound();
  return client;
}
export function checkSalesError(error: { message: string } | null) {
  if (error?.message === 'sales_lead_forbidden') notFound();
  if (error) throw new Error('Nie udało się odczytać procesu sprzedaży.');
}
