'use client';
import { useEffect, useState } from 'react';
import { sc19OfferAmounts } from '../../../../../lib/sc19-offer-amounts';
type Offer={id:string;revision:string;amountMinor:number;currency:string;credits:number;
  termsRevision:string;termsText:string;validUntilMs:number;
  netMinor?:number|null;vatMinor?:number|null;vatBasisPoints?:number|null};
const pln=(v:number)=>new Intl.NumberFormat('pl-PL',{style:'currency',currency:'PLN'}).format(v/100);
// Gross is authoritative: it is what the server charges and what a settlement is
// matched against. Net and VAT are derived from it; the server sends them, and the
// same shared formula is the fallback so the two can never disagree.
const breakdown=(offer: Offer)=>typeof offer.netMinor==='number'&&typeof offer.vatMinor==='number'
  ?{netMinor:offer.netMinor,vatMinor:offer.vatMinor,vatBasisPoints:offer.vatBasisPoints ?? null}
  :sc19OfferAmounts(offer.amountMinor);
const paymentsPending='Płatność online jest w trakcie uruchamiania (trwa weryfikacja u operatora płatności Przelewy24). Zamówienia nie można jeszcze złożyć — cena i warunki poniżej są wiążące i nie zmienią się po włączeniu płatności.';
export default function Checkout({companyId}: {companyId:string}) {
  const [offers,setOffers]=useState<Offer[]>([]),[selected,setSelected]=useState('');
  const [accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true),[message,setMessage]=useState('');
  const [checkoutAvailable,setCheckoutAvailable]=useState(true);
  const [orderId,setOrderId]=useState(''),[paidOrder,setPaidOrder]=useState<{offerId:string;termsRevision:string}|null>(null);
  const [requestIds]=useState(()=>new Map<string,string>());
  const offer=offers.find(o=>o.id===selected);
  const amounts=offer&&breakdown(offer);
  async function loadOffers(signal?: AbortSignal) {
    setLoading(true);setAccepted(false);setOffers([]);setSelected('');
    try {
      const r=await fetch(`/api/billing/offers?companyId=${encodeURIComponent(companyId)}`,{cache:'no-store',signal});
      if(!r.ok)throw Error();const data=await r.json();
      if(!signal?.aborted){
        // Availability is never assumed: only an explicit true opens the pay button.
        setCheckoutAvailable(data.checkoutAvailable===true);
        setOffers(data.offers);setSelected(data.offers[0]?.id ?? '');
        if(data.checkoutAvailable!==true&&data.offers?.length>0)setMessage('');
      }
    } catch {
      if(!signal?.aborted){setCheckoutAvailable(false);
        setMessage('Nie udało się wczytać oferty. Odśwież stronę lub spróbuj ponownie za chwilę.');}
    } finally {if(!signal?.aborted)setLoading(false);}
  }
  useEffect(()=>{
    const abort=new AbortController();
    void loadOffers(abort.signal);
    try { setOrderId(sessionStorage.getItem(`sc19:order:${companyId}`) ?? ''); } catch { /* unavailable storage: status can be retried in this session */ }
    return ()=>abort.abort();
  },[companyId]);
  async function status(id=orderId) {
    if(!id)return;
    setBusy(true);
    try {
      const r=await fetch(`/api/billing/orders/${encodeURIComponent(id)}?companyId=${encodeURIComponent(companyId)}`,{cache:'no-store'});
      if(!r.ok)throw Error(); const data=await r.json();
      setPaidOrder(data.status==='paid'?{offerId:data.offerId,termsRevision:data.termsRevision}:null);
      setMessage(data.status==='paid' ? `Płatność potwierdzona. Przyznano ${data.credits} analiz CV.` :
        'Czekamy na potwierdzenie płatności. Kredyty zostaną przyznane po jej weryfikacji.');
    } catch {setMessage('Nie udało się sprawdzić statusu. Spróbuj ponownie.');}
    finally {setBusy(false);}
  }
  function nextPurchase() {
    if(!paidOrder||!offer)return;
    const key=`sc19:request:${companyId}:${paidOrder.offerId}:${paidOrder.termsRevision}`;
    requestIds.delete(key);
    try {
      sessionStorage.removeItem(key);
      sessionStorage.removeItem(`sc19:order:${companyId}`);
    } catch { /* Server-side order invariant does not depend on browser storage. */ }
    setOrderId('');setPaidOrder(null);setAccepted(false);setMessage('Możesz złożyć kolejne zamówienie.');
  }
  async function buy() {
    // Never post while checkout is unavailable: the server refuses it anyway
    // (SC19_PAYMENTS_DISABLED), and the button is rendered disabled.
    if(!offer||!accepted||busy||loading||paidOrder||!checkoutAvailable)return;
    setBusy(true);setMessage('');
    try {
      // Best-effort retry hint. The durable server invariant also protects new
      // tabs/devices and browsers where sessionStorage is missing or evicted.
      const key=`sc19:request:${companyId}:${offer.id}:${offer.termsRevision}`;
      let requestId=requestIds.get(key);
      try {requestId ??= sessionStorage.getItem(key) ?? undefined;} catch { /* optional */ }
      requestId ??= crypto.randomUUID();requestIds.set(key,requestId);
      try {sessionStorage.setItem(key,requestId);} catch { /* optional */ }
      const response=await fetch('/api/billing/checkout',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({companyId,offerId:offer.id,termsRevision:offer.termsRevision,requestId})});
      const data=await response.json();
      if(!response.ok){
        if(data.error==='SC19_PAYMENT_OFFER_UNAVAILABLE'){
          setMessage('Oferta wygasła lub zmieniły się jej warunki. Odświeżamy dostępne oferty. Sprawdź je i zaakceptuj ponownie.');
          await loadOffers();return;
        }
        if(data.error==='SC19_PAYMENT_PURCHASE_PENDING'){
          setMessage('Firma ma już nierozliczone zamówienie z innymi warunkami. Dokończ je lub skontaktuj się z obsługą przed kolejnym zakupem.');return;
        }
        if(data.error==='SC19_PAYMENTS_DISABLED'){
          setCheckoutAvailable(false);setMessage(paymentsPending);return;
        }
        throw Error();
      }
      setOrderId(data.orderId);
      try {sessionStorage.setItem(`sc19:order:${companyId}`,data.orderId);} catch { /* optional */ }
      if(data.status==='paid'){await status(data.orderId);return;}
      window.location.assign(data.checkoutUrl);
    } catch {setMessage('Nie udało się otworzyć płatności. Ponów próbę — serwer sprawdzi istniejące zamówienie.');}
    finally {setBusy(false);}
  }
  return <section aria-busy={loading||busy}>
    <p>Pakiet FREE nie wymaga płatności i nie korzysta z tego formularza.</p>
    {loading ? <p role="status">Wczytuję ofertę…</p> : offers.length>0 ? <>
      <label>Wariant <select value={selected} disabled={busy} onChange={e=>{setSelected(e.target.value);setAccepted(false);}}>
        {offers.map(o=><option key={o.id} value={o.id}>{o.credits} analiz CV — {pln(o.amountMinor)} brutto</option>)}
      </select></label>
      {offer&&<><h2>{pln(offer.amountMinor)} brutto</h2><p>{offer.credits} analiz CV • jednorazowo • analizy ważne 3 miesiące od przyznania</p>
        <table><caption>Podsumowanie zamówienia</caption><tbody>
          <tr><th scope="row">Pakiet</th><td>PRESELEKCJA</td></tr>
          <tr><th scope="row">Liczba analiz CV</th><td>{offer.credits}</td></tr>
          {amounts&&<tr><th scope="row">Cena netto</th><td>{pln(amounts.netMinor)}</td></tr>}
          {amounts&&<tr><th scope="row">VAT{typeof amounts.vatBasisPoints==='number'?` ${amounts.vatBasisPoints/100}%`:''}</th><td>{pln(amounts.vatMinor)}</td></tr>}
          <tr><th scope="row">Cena brutto</th><td>{pln(offer.amountMinor)}</td></tr>
        </tbody></table>
        <details open><summary>Warunki oferty · {offer.termsRevision}</summary><p style={{whiteSpace:'pre-wrap'}}>{offer.termsText}</p></details>
        <label style={{display:'block',margin:'20px 0'}}><input type="checkbox" checked={accepted} disabled={busy}
          onChange={e=>setAccepted(e.target.checked)}/> Akceptuję powyższe warunki oferty oraz <a href="/regulamin" target="_blank" rel="noopener">Regulamin</a> i potwierdzam zapoznanie się z <a href="/polityka-prywatnosci" target="_blank" rel="noopener">Polityką prywatności</a>.</label>
        <p>Płatność online obsługuje Przelewy24 (PayPro S.A., ul. Pastelowa 8, 60-198 Poznań): szybki przelew, BLIK lub karta, w zakresie metod udostępnionych przez operatora. Analizy przyznajemy po potwierdzeniu płatności przez operatora, zwykle w ciągu kilku minut. Zasady reklamacji i odstąpienia opisuje <a href="/regulamin" target="_blank" rel="noopener">Regulamin</a> (§ 10–11).</p>
        {!checkoutAvailable&&<p role="status" aria-live="polite">{paymentsPending}</p>}
        <button type="button" disabled={!checkoutAvailable||!accepted||busy||!!paidOrder} onClick={buy}>
          {busy?'Przetwarzam…':checkoutAvailable?`Zamawiam i płacę ${pln(offer.amountMinor)}`:`Zamawiam i płacę ${pln(offer.amountMinor)} — wkrótce`}</button></>}
    </> : !message&&<p>Brak zatwierdzonej oferty. Zakup jest obecnie niedostępny.</p>}
    {message&&<p role="status" aria-live="polite">{message}</p>}
    <button type="button" disabled={busy||loading} onClick={()=>{setMessage('');return loadOffers();}}>Odśwież oferty</button>
    {paidOrder&&<button type="button" disabled={busy} onClick={nextPurchase}>Kup kolejny pakiet</button>}
    {orderId&&<button type="button" disabled={busy} onClick={()=>status()}>Sprawdź status zamówienia</button>}
    <p>Powrót ze strony operatora nie jest potwierdzeniem zapłaty. Status sprawdzamy na serwerze.</p>
  </section>;
}
