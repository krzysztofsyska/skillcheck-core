import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../lib/supabase/database.types';
import { catalogRpc,catalogOrders,catalogOrderName } from '../../../lib/sc19-catalog-orders';
import { formatGross } from '../../../lib/pricing/cv-pool';
import { settleCatalogOrder } from './catalog-order-actions';

export default async function OperatorCatalogOrders({client,status}:{client:SupabaseClient<Database>;status?:string}) {
 const {data,error}=await catalogRpc(client,'sc19_catalog_orders');
 if(error)return <section><h2>Zamówienia katalogowe</h2><p role="status">Nie można odczytać zamówień katalogowych.</p></section>;
 let orders;try{orders=catalogOrders(data);}catch{return <p role="status">Nie można odczytać zamówień katalogowych.</p>;}
 return <section><h2>Zamówienia katalogowe — potwierdzenie wpłaty</h2>
  {status&&<p role="status">{status==='paid'?'Wpłata zapisana, jednostki przyznane dokładnie raz.':'Nie zapisano wpłaty. Sprawdź kwotę, numer rozliczenia i aktualny status zamówienia.'}</p>}
  <p>Numer rozliczenia musi wskazywać niezależnie sprawdzoną wpłatę na dokładną kwotę w PLN. Nie potwierdzaj na podstawie ekranu powrotu z płatności.</p>
  {orders.length===0?<p>Brak zamówień katalogowych.</p>:<ul>{orders.map(o=><li key={o.id}>
   <p>{catalogOrderName(o.code)} — firma {o.company_id} — {formatGross(o.gross_minor)} — {o.status==='pending'?'oczekuje na wpłatę':o.status==='paid'?'opłacone':'anulowane'}</p>
   <p>Numer zamówienia: {o.id}. {o.cv_credits} analiz CV, {o.service_units} testów kompetencji.</p>
   {o.status==='pending'&&<form action={settleCatalogOrder}>
    <input type="hidden" name="orderId" value={o.id}/>
    <label>Zweryfikowana kwota wpłaty w groszach PLN <input name="amountMinor" type="number" min="1" max="100000000" required/></label>
    <label>Unikatowy numer rozliczenia <input name="settlement" minLength={8} maxLength={160} required/></label>
    <label><input name="confirm" type="checkbox" value="yes" required/> Potwierdzam niezależnie sprawdzoną wpłatę za to zamówienie.</label>
    <button type="submit">Potwierdź wpłatę i przyznaj jednostki</button>
   </form>}
  </li>)}</ul>}
 </section>;
}
