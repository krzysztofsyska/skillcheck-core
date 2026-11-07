import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../../../lib/supabase/database.types';
import { catalogOrders, catalogQuotes, catalogRpc, catalogOrderName } from '../../../../../lib/sc19-catalog-orders';
import { formatGross } from '../../../../../lib/pricing/cv-pool';
import { cancelCatalogOrder, placeCatalogOrder } from './catalog-actions';

export default async function CatalogOrders({client,companyId,isOwner,recruitmentId,status}: {
 client: SupabaseClient<Database>; companyId:string; isOwner:boolean; recruitmentId?:string; status?:string;
}) {
 const [options,history]=await Promise.all([
  catalogRpc(client,'sc19_catalog_order_options',{target_company:companyId}),
  catalogRpc(client,'sc19_catalog_orders',{target_company:companyId}),
 ]);
 if(options.error||history.error)return <p role="status">Nie można teraz odczytać zamówień katalogowych. Spróbuj ponownie później.</p>;
 let quotes,orders;
 try {quotes=catalogQuotes(options.data);orders=catalogOrders(history.data);}catch{return <p role="status">Nie można teraz odczytać zamówień katalogowych.</p>;}
 const pending=orders.some(o=>o.status==='pending');
 const notices:Record<string,string>={created:'Zamówienie zapisane. Obsługa przygotuje rozliczenie; jednostki pojawią się po potwierdzeniu wpłaty.',
  pending:'Istnieje już zamówienie oczekujące na płatność albo użyto wcześniej tego numeru żądania. Sprawdź listę poniżej i płatność Przelewy24.',
  changed:'Oferta lub dostępność zmieniła się. Sprawdź aktualne warunki przed ponownym zamówieniem.',
  cancelled:'Zamówienie anulowane. Nie przyznano jednostek.',failed:'Nie udało się zapisać zmiany. Odśwież stronę i spróbuj ponownie.'};
 return <section aria-label="Zamówienia pakietów i dodatków">
  <h2>Pakiety i dodatki z katalogu</h2>
  {status&&notices[status]&&<p role="status">{notices[status]}</p>}
  <p>Zakup rozliczany przez obsługę na podstawie potwierdzonej wpłaty. Nowy pakiet kupujesz w całości — zachowujesz pozostałe jednostki, bez częściowego zwrotu za poprzedni pakiet.</p>
  {quotes.length===0?<p>Obecnie brak dodatkowych produktów gotowych do zamówienia. Niewdrożonych usług nie sprzedajemy.</p>:quotes.map(quote=><form key={`${quote.kind}:${quote.code}:${quote.packageCode}`} action={placeCatalogOrder}>
   <h3>{catalogOrderName(quote.code)}{quote.kind==='addon'?` — dodatek do ${catalogOrderName(quote.packageCode)}`:''}</h3>
   <p>{formatGross(quote.grossMinor)} brutto; {quote.cvCredits>0?`${quote.cvCredits} analiz CV. `:''}{quote.serviceUnits>0?`${quote.serviceUnits} testów kompetencji.`:''}</p>
   <p>{quote.termsText}</p>
   <input type="hidden" name="companyId" value={companyId}/><input type="hidden" name="recruitmentId" value={recruitmentId??''}/>
   <input type="hidden" name="quote" value={JSON.stringify(quote)}/><input type="hidden" name="requestId" value={randomUUID()}/>
   {isOwner?<><label><input type="checkbox" name="accepted" value="yes" required disabled={pending}/> Akceptuję podaną cenę i warunki jednorazowego zamówienia.</label>
    <button type="submit" disabled={pending}>Zamów {catalogOrderName(quote.code)}</button></>:<p>Zamówienie może złożyć właściciel firmy.</p>}
  </form>)}
  <h3>Ostatnie zamówienia</h3>
  {orders.length===0?<p>Brak zamówień katalogowych.</p>:<ul>{orders.map(order=><li key={order.id}>
   {catalogOrderName(order.code)} — {formatGross(order.gross_minor)} brutto — {order.status==='paid'?'opłacone, jednostki przyznane':order.status==='cancelled'?'anulowane':'oczekuje na potwierdzenie wpłaty'}
   {isOwner&&order.status==='pending'&&<form action={cancelCatalogOrder}>
    <input type="hidden" name="companyId" value={companyId}/><input type="hidden" name="orderId" value={order.id}/><input type="hidden" name="recruitmentId" value={recruitmentId??''}/>
    <button type="submit">Anuluj nieopłacone zamówienie</button></form>}
  </li>)}</ul>}
 </section>;
}
